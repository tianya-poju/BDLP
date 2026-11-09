use super::*;
#[derive(Default)]
pub struct Runs(pub(super) Mutex<VecDeque<Arc<Job>>>);
impl Runs {
    pub(crate) fn idle<T>(
        &self,
        action: impl FnOnce() -> Result<T, crate::error::ApiError>,
    ) -> Result<T, crate::error::ApiError> {
        let jobs = self
            .0
            .lock()
            .map_err(|_| crate::error::ApiError::invalid("任务不可用"))?;
        if jobs.iter().any(|j| j.blocking()) {
            return Err("有任务在运行，请先结束或取消后再操作账号".into());
        }
        action()
    }
}
pub(super) struct Job {
    pub(super) id: JobId,
    pub(super) data: Data,
    pub(super) mode: String,
    pub(super) state: Mutex<Progress>,
}
impl Job {
    /// Poisoned data may be inspected for diagnosis, but can never resume execution.
    pub(super) fn progress(&self) -> std::sync::MutexGuard<'_, Progress> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poison) => {
                let mut state = poison.into_inner();
                state.stop_fault();
                self.state.clear_poison();
                state
            }
        }
    }
    pub(super) fn blocking(&self) -> bool {
        let state = self.progress();
        state.status.active() || state.busy || state.executing
    }
    pub(super) fn step(&self) -> Result<Step<'_>, crate::error::ApiError> {
        let mut state = self.progress();
        state.check()?;
        if state.busy {
            return Err("上一任务步骤仍在执行".into());
        }
        state.busy = true;
        Ok(Step(self))
    }
    pub(super) fn cancel(&self) -> Result<(), crate::error::ApiError> {
        let mut state = self.progress();
        if matches!(state.status, TaskStatus::Submitting | TaskStatus::Submitted) {
            return Err("记录已进入提交阶段，无法撤销；请等待结果并核对记录，勿重复提交".into());
        }
        if state.status.active() {
            state.cancelled = true;
            state.status = TaskStatus::Cancelled;
            state.error = "已取消；已发送的心跳或文件无法撤回，未继续提交记录".into();
        }
        Ok(())
    }
}
pub(super) struct Step<'a>(&'a Job);
impl Drop for Step<'_> {
    fn drop(&mut self) {
        let mut state = self.0.progress();
        if std::thread::panicking() {
            state.stop_fault()
        }
        state.busy = false;
    }
}
pub(crate) struct Execution(pub(super) Arc<Job>);
impl Drop for Execution {
    fn drop(&mut self) {
        let mut state = self.0.progress();
        if state.status.active() {
            state.stop_fault()
        }
        state.executing = false;
    }
}
/// A task check compares only its immutable identity, never profiles, photos or routes.
pub(super) struct TaskContext<'a> {
    uid: &'a str,
    token: &'a str,
    school: &'a str,
    zone: &'a str,
    device: &'a str,
}
impl<'a> From<&'a Data> for TaskContext<'a> {
    fn from(d: &'a Data) -> Self {
        Self {
            uid: &d.account.uid,
            token: &d.account.token,
            school: &d.school_id,
            zone: &d.zone.id,
            device: &d.device_id,
        }
    }
}
impl TaskContext<'_> {
    pub(super) fn matches(&self, d: &Data) -> bool {
        self.uid == d.account.uid
            && self.token == d.account.token
            && self.school == d.school_id
            && self.zone == d.zone.id
            && self.device == d.device_id
    }
}
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TaskStatus {
    #[default]
    Running,
    Submitting,
    Submitted,
    Done,
    Cancelled,
    Failed,
    Unknown,
}
impl TaskStatus {
    pub(super) fn active(self) -> bool {
        matches!(self, Self::Running | Self::Submitting | Self::Submitted)
    }
}

#[derive(Default)]
pub(super) struct Progress {
    pub(super) busy: bool,
    pub(super) cancelled: bool,
    pub(super) faulted: bool,
    pub(super) status: TaskStatus,
    pub(super) logs: Vec<String>,
    pub(super) log_start: u64,
    pub(super) rules: Option<Value>,
    pub(super) clock: i64,
    pub(super) time_str: String,
    pub(super) track_key: String,
    pub(super) image_key: String,
    pub(super) sensor_key: String,
    pub(super) capture_key: String,
    pub(super) points: Vec<Point>,
    pub(super) submit: Option<Value>,
    pub(super) gyro_linked: bool,
    pub(super) error: String,
    pub(super) result: Value,
    pub(super) awaiting: Value,
    pub(super) executing: bool,
}
impl Progress {
    pub(super) fn submission_ready(&self) -> Result<(), crate::error::ApiError> {
        self.check()?;
        if self.status != TaskStatus::Running {
            return Err("提交已发出，不能重复发送".into());
        }
        Ok(())
    }
    pub(super) fn stop_fault(&mut self) {
        self.faulted = true;
        self.cancelled = true;
        self.awaiting = Value::Null;
        self.status = if self.submit.is_some()
            || matches!(
                self.status,
                TaskStatus::Submitting | TaskStatus::Submitted | TaskStatus::Unknown
            ) {
            TaskStatus::Unknown
        } else {
            TaskStatus::Failed
        };
        self.error = if self.status == TaskStatus::Unknown {
            "任务异常，提交结果未确认；请核对记录，勿重复提交"
        } else {
            "任务内部状态异常，已停止；未继续提交"
        }
        .into();
    }
    pub(super) fn check(&self) -> Result<(), crate::error::ApiError> {
        if self.faulted {
            return Err(crate::error::ApiError::invalid("任务内部状态异常，已停止"));
        }
        if self.cancelled {
            return Err(crate::error::ApiError::cancelled());
        }
        if !self.status.active() {
            return Err("任务已结束".into());
        }
        Ok(())
    }
    pub(super) fn finish_photo_check(&mut self, cancelled: bool, result: Value) {
        if !cancelled && self.status == TaskStatus::Running {
            self.status = TaskStatus::Done;
            self.result = result;
        }
    }
    pub(super) fn push_log(&mut self, message: String) {
        if self.logs.len() >= 2000 {
            self.logs.remove(0);
            self.log_start += 1;
        }
        self.logs.push(message);
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Point {
    pub(crate) lat: f64,
    pub(crate) lng: f64,
    pub(crate) speed: f64,
    pub(crate) t: f64,
}
