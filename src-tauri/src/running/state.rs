use super::*;
#[derive(Default)]
pub struct Runs(pub(super) Mutex<VecDeque<Arc<Job>>>);
pub(super) struct Job {
    pub(super) id: JobId,
    pub(super) data: Data,
    pub(super) mode: String,
    pub(super) cancel: AtomicBool,
    pub(super) busy: AtomicBool,
    pub(super) state: Mutex<Progress>,
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
