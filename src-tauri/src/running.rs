//! Native-only account snapshots, scoped run operations and single-shot commit.
use crate::receipts::{JobId, Receipt, ReceiptStatus, RecordId};
use crate::{
    network::{self, snapshot, text},
    store::{Data, Store},
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
mod protocol;
mod registry;
mod state;
#[cfg(test)]
mod tests;
mod validation;
use protocol::*;
use registry::{active, get, guard, same};
pub(crate) use registry::{
    awaiting, begin_execution, check_job, clock_for, ensure_idle, finish_local, mode_for, rules_for,
};
use state::{Job, Progress, TaskStatus};
pub use state::{Point, Runs};
pub(crate) use validation::validate_points;
use validation::*;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn map(v: Value) -> BTreeMap<String, String> {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                if let Some(s) = v.as_str() {
                    s.to_string()
                } else {
                    v.to_string()
                },
            )
        })
        .collect()
}
fn number(v: &Value, k: &str) -> f64 {
    v[k].as_f64()
        .or_else(|| v[k].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.)
}
fn receipt(d: &Data) -> Value {
    serde_json::to_value(d.run_receipts.get(&d.account.uid.clone())).unwrap_or(Value::Null)
}
fn pending_receipt(d: &Data) -> bool {
    d.run_receipts
        .get(&d.account.uid.clone())
        .is_some_and(|r| r.status == ReceiptStatus::Pending)
}
fn run_config(
    v: &crate::models::RunConfig,
) -> Result<crate::models::RunConfig, crate::error::ApiError> {
    v.normalized()
}
#[tauri::command]
pub fn run_current(
    store: tauri::State<Store>,
    runs: tauri::State<Runs>,
) -> Result<Value, crate::error::ApiError> {
    let d = snapshot(&store)?;
    let uid = d.account.uid.clone();
    let jobs = runs.0.lock().map_err(|_| "任务不可用")?;
    let current = jobs
        .iter()
        .rev()
        .find(|j| {
            j.data.account.uid.clone() == uid
                && j.state.lock().map(|s| active(&s.status)).unwrap_or(false)
        })
        .map(|j| json!({"id":j.id,"mode":j.mode}));
    let latest = jobs
        .iter()
        .rev()
        .find(|j| j.data.account.uid.clone() == uid)
        .map(|j| json!({"id":j.id,"mode":j.mode}));
    Ok(json!({"current":current,"latest":latest,"pending":false,"receipt":receipt(&d)}))
}
#[tauri::command]
pub fn run_resolve(
    uid: String,
    store: tauri::State<Store>,
    runs: tauri::State<Runs>,
) -> Result<(), crate::error::ApiError> {
    let jobs = runs.0.lock().map_err(|_| "任务不可用")?;
    if jobs
        .iter()
        .any(|j| j.state.lock().map(|s| active(&s.status)).unwrap_or(true))
    {
        return Err("任务仍在处理，请等待结果".into());
    }
    store.try_update(|d| {
        if uid != d.account.uid.clone() {
            return Err("账号已切换".into());
        }
        if pending_receipt(d) {
            if let Some(r) = d.run_receipts.get_mut(&uid) {
                r.status = ReceiptStatus::Reviewed;
            }
        }
        Ok(())
    })
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst)
    }
}

#[tauri::command]
pub fn run_open(
    mode: String,
    uid: String,
    store: tauri::State<Store>,
    runs: tauri::State<Runs>,
) -> Result<Value, crate::error::ApiError> {
    if !["free", "campus"].contains(&mode.as_str()) {
        return Err("跑步类型无效".into());
    }
    let mut d = snapshot(&store)?;
    if uid != d.account.uid.clone() || d.account.token.clone().is_empty() {
        return Err("账号已变化，请刷新后重试".into());
    }
    d.run_config = run_config(&d.run_config)?;
    if d.school_id.parse::<u32>().ok().filter(|v| *v > 0).is_none() {
        return Err("请先选择学校".into());
    }
    crate::store::validate_route(&d.route)?;
    if d.route.len() < 2 {
        return Err("请先设置路线".into());
    }
    if mode == "campus" && d.zone.id.clone().is_empty() {
        return Err("请先选择跑区".into());
    }
    let mut jobs = runs.0.lock().map_err(|_| "任务不可用")?;
    if jobs
        .iter()
        .any(|j| j.state.lock().map(|s| active(&s.status)).unwrap_or(true))
    {
        return Err("已有跑步任务，请等待结束或取消".into());
    }
    let photos = crate::faces::run_photos(&store, &uid)?.len();
    let id = uuid::Uuid::new_v4().to_string();
    let reply = json!({"jobId":id,"points":d.route,"runConfig":d.run_config,"fence":d.zone.fence,"faceCount":photos,"mode":mode});
    jobs.push_back(Arc::new(Job {
        id: JobId(id),
        data: d,
        mode,
        cancel: AtomicBool::new(false),
        busy: AtomicBool::new(false),
        state: Mutex::new(Progress {
            status: TaskStatus::Running,
            ..Default::default()
        }),
    }));
    while jobs.len() > 8 {
        jobs.pop_front();
    }
    Ok(reply)
}
#[tauri::command]
pub fn run_status(
    id: String,
    store: tauri::State<Store>,
    runs: tauri::State<Runs>,
) -> Result<Value, crate::error::ApiError> {
    let j = get(&runs, &id)?;
    if store.data.lock()?.account.uid != j.data.account.uid.clone() {
        return Err("任务属于其他账号".into());
    }
    let s = j.state.lock().map_err(|_| "任务不可用")?;
    Ok(
        json!({"id":id,"status":s.status,"logs":s.logs,"logStart":s.log_start,"error":s.error,"result":s.result,"awaiting":s.awaiting}),
    )
}
#[tauri::command]
pub fn run_cancel(id: String, runs: tauri::State<Runs>) -> Result<Value, crate::error::ApiError> {
    let j = get(&runs, &id)?;
    let mut s = j.state.lock().map_err(|_| "任务不可用")?;
    if matches!(s.status, TaskStatus::Submitting | TaskStatus::Submitted) {
        return Err("记录已进入提交阶段，无法撤销；请等待结果并核对记录，勿重复提交".into());
    }
    if active(&s.status) {
        j.cancel.store(true, Ordering::SeqCst);
        s.status = TaskStatus::Cancelled;
        s.error = "已取消；已发送的心跳或文件无法撤回，未继续提交记录".into();
    }
    Ok(json!({"ok":true}))
}

#[tauri::command]
pub async fn face_validate(app: tauri::AppHandle) -> Result<Value, crate::error::ApiError> {
    let store = app.state::<Store>();
    let d = snapshot(&store)?;
    if d.account.token.clone().is_empty() {
        return Err("请先登录".into());
    }
    let names = crate::faces::photo_names(&store, &d.account.uid.clone())?;
    if names.is_empty() {
        return Err("照片库为空，请先添加本人照片".into());
    }
    let runs = app.state::<Runs>();
    ensure_idle(&runs)?;
    let id = uuid::Uuid::new_v4().to_string();
    let job = Arc::new(Job {
        id: JobId(id.clone()),
        data: d,
        mode: "photo_check".into(),
        cancel: AtomicBool::new(false),
        busy: AtomicBool::new(false),
        state: Mutex::new(Progress {
            status: TaskStatus::Running,
            rules: Some(json!({})),
            time_str: "photo-check".into(),
            ..Default::default()
        }),
    });
    {
        let mut jobs = runs.0.lock().map_err(|_| "任务不可用")?;
        if jobs
            .iter()
            .any(|j| j.state.lock().map(|s| active(&s.status)).unwrap_or(true))
        {
            return Err("已有任务正在运行".into());
        }
        jobs.push_back(job);
        while jobs.len() > 8 {
            jobs.pop_front();
        }
    }
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        for (index, name) in names.iter().enumerate() {
            let _ = run_action(
                task_id.clone(),
                "log".into(),
                json!({"message":format!("正在校验第 {}/{} 张",index+1,names.len())}),
                app.clone(),
            )
            .await;
            match run_action(
                task_id.clone(),
                "face".into(),
                json!({"verifyType":0,"priorId":"","photoIndex":index}),
                app.clone(),
            )
            .await
            {
                Ok(_) => {}
                Err(e) => {
                    if check_job(&task_id, &app).is_err() {
                        return;
                    }
                    if crate::session::auth_error(&e) {
                        let _ = run_action(
                            task_id.clone(),
                            "fail".into(),
                            json!({"error":e.message}),
                            app.clone(),
                        )
                        .await;
                        return;
                    }
                    finish_local(
                        &task_id,
                        &app,
                        json!({"phase":"retake","name":name,"message":format!("第 {} 张未通过：{}",index+1,crate::session::ApiError::from(e).message)}),
                    );
                    return;
                }
            }
        }
        finish_local(
            &task_id,
            &app,
            json!({"phase":"done","message":format!("全部 {} 张照片通过本次核验；正式任务仍需按学校规则核验",names.len())}),
        );
    });
    Ok(json!({"status":1,"jobId":id}))
}

#[tauri::command]
pub async fn run_action(
    id: String,
    action: String,
    args: Value,
    app: tauri::AppHandle,
) -> Result<Value, crate::error::ApiError> {
    let expected = get(&app.state::<Runs>(), &id).ok();
    let r = run_action_inner(id.clone(), action, args, app.clone()).await;
    if let Err(e) = &r {
        if crate::session::auth_error(e) {
            if let Some(d) = expected {
                let _ = crate::session::invalidate(&app.state::<Store>(), &d.data);
            }
        }
    }
    let _ = app.emit_to("main", "job-updated", &id);
    r
}
