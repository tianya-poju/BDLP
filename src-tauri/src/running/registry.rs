use super::*;
pub(super) fn get(runs: &Runs, id: &str) -> Result<Arc<Job>, crate::error::ApiError> {
    runs.0
        .lock()
        .map_err(|_| "任务不可用")?
        .iter()
        .find(|j| j.id.as_str() == id)
        .cloned()
        .ok_or("任务不存在".into())
}
pub(super) fn same(a: &Data, b: &Data) -> bool {
    state::TaskContext::from(a).matches(b)
}
pub(super) fn guard(job: &Job, store: &Store) -> Result<(), crate::error::ApiError> {
    if job.cancel.load(Ordering::SeqCst) {
        return Err(crate::error::ApiError::cancelled());
    }
    if !same(&job.data, &*store.data.lock()?) {
        return Err("账号、学校、跑区或设备已切换，任务已停止".into());
    }
    Ok(())
}
pub(super) fn active(status: &TaskStatus) -> bool {
    status.active()
}
pub(crate) fn ensure_idle(runs: &Runs) -> Result<(), crate::error::ApiError> {
    if runs
        .0
        .lock()
        .map_err(|_| "任务不可用")?
        .iter()
        .any(|j| j.state.lock().map(|s| active(&s.status)).unwrap_or(true))
    {
        return Err("有任务在运行，请先结束或取消后再操作账号".into());
    }
    Ok(())
}
pub(crate) fn check_job(id: &str, app: &tauri::AppHandle) -> Result<(), crate::error::ApiError> {
    let j = get(&app.state::<Runs>(), id)?;
    guard(&j, &app.state::<Store>())
}

pub(crate) fn begin_execution(
    id: &str,
    app: &tauri::AppHandle,
) -> Result<Data, crate::error::ApiError> {
    let j = get(&app.state::<Runs>(), id)?;
    guard(&j, &app.state::<Store>())?;
    let mut s = j.state.lock().map_err(|_| "任务不可用")?;
    if s.executing || s.status != TaskStatus::Running {
        return Err("任务已经启动或结束".into());
    }
    s.executing = true;
    Ok(j.data.clone())
}
pub(crate) fn awaiting(id: &str, app: &tauri::AppHandle, value: Value) {
    if let Ok(j) = get(&app.state::<Runs>(), id) {
        if let Ok(mut s) = j.state.lock() {
            s.awaiting = value;
        }
    }
}
pub(crate) fn finish_local(id: &str, app: &tauri::AppHandle, result: Value) {
    if let Ok(j) = get(&app.state::<Runs>(), id) {
        if let Ok(mut s) = j.state.lock() {
            s.finish_photo_check(j.cancel.load(Ordering::SeqCst), result);
        }
    }
}

pub(crate) fn rules_for(id: &str, app: &tauri::AppHandle) -> Result<Value, crate::error::ApiError> {
    get(&app.state::<Runs>(), id)?
        .state
        .lock()
        .map_err(|_| "任务不可用")?
        .rules
        .clone()
        .ok_or("学校规则未加载".into())
}
pub(crate) fn mode_for(id: &str, app: &tauri::AppHandle) -> Result<String, crate::error::ApiError> {
    Ok(get(&app.state::<Runs>(), id)?.mode.clone())
}
pub(crate) fn clock_for(id: &str, app: &tauri::AppHandle) -> Result<i64, crate::error::ApiError> {
    Ok(get(&app.state::<Runs>(), id)?
        .state
        .lock()
        .map_err(|_| "任务不可用")?
        .clock)
}
