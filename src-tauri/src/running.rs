//! Native-only account snapshots, scoped run operations and single-shot commit.
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

#[derive(Default)]
pub struct Runs(Mutex<VecDeque<Arc<Job>>>);
struct Job {
    id: String,
    data: Data,
    mode: String,
    cancel: AtomicBool,
    busy: AtomicBool,
    state: Mutex<Progress>,
}
#[derive(Default)]
struct Progress {
    status: String,
    logs: Vec<String>,
    log_start: u64,
    rules: Option<Value>,
    clock: i64,
    time_str: String,
    track_key: String,
    image_key: String,
    sensor_key: String,
    capture_key: String,
    points: Vec<Point>,
    submit: Option<Value>,
    gyro_linked: bool,
    error: String,
    result: Value,
    awaiting: Value,
    executing: bool,
}
impl Progress {
    fn finish_photo_check(&mut self, cancelled: bool, result: Value) {
        if !cancelled && self.status == "running" {
            self.status = "done".into();
            self.result = result;
        }
    }
    fn push_log(&mut self, message: String) {
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
fn get(runs: &Runs, id: &str) -> Result<Arc<Job>, String> {
    runs.0
        .lock()
        .map_err(|_| "任务不可用")?
        .iter()
        .find(|j| j.id == id)
        .cloned()
        .ok_or("任务不存在".into())
}
fn same(a: &Data, b: &Data) -> bool {
    network::same_account(a, b)
        && a.school_id == b.school_id
        && a.zone["id"] == b.zone["id"]
        && a.device_id == b.device_id
}
fn guard(job: &Job, store: &Store) -> Result<(), String> {
    if job.cancel.load(Ordering::SeqCst) {
        return Err("已取消任务".into());
    }
    if !same(&job.data, &snapshot(store)?) {
        return Err("账号、学校、跑区或设备已切换，任务已停止".into());
    }
    Ok(())
}
pub(crate) fn active(status: &str) -> bool {
    matches!(status, "running" | "submitting" | "submitted")
}
fn receipt(d: &Data) -> Value {
    d.run_receipts
        .get(&text(&d.account, "uid"))
        .cloned()
        .unwrap_or(Value::Null)
}
fn pending_receipt(d: &Data) -> bool {
    receipt(d)["status"] == "pending"
}
fn run_config(v: &Value) -> Result<Value, String> {
    let mut out = json!({});
    for (k, default, min, max) in [
        ("straightSpeed", 4.1, 1., 5.),
        ("curveSpeed", 3.3, 0.5, 5.),
        ("maxAccel", 0.4, 0.05, 3.),
        ("gpsIntervalMs", 2000., 500., 10000.),
        ("warmupTime", 10., 0., 60.),
        ("cooldownTime", 8., 0., 60.),
        ("cadenceSpm", 160., 100., 220.),
        ("sensorIntensity", 1., 0.7, 1.15),
        ("replayDelayMs", 20., 0., 5000.),
    ] {
        let n = if v.get(k).is_some() {
            v[k].as_f64().ok_or(format!("跑步参数 {k} 无效"))?
        } else {
            default
        };
        if !n.is_finite() || n < min || n > max {
            return Err(format!("跑步参数 {k} 应在 {min}~{max} 之间"));
        }
        out[k] = json!(n);
    }
    Ok(out)
}
#[tauri::command]
pub fn run_current(store: tauri::State<Store>, runs: tauri::State<Runs>) -> Result<Value, String> {
    let d = snapshot(&store)?;
    let uid = text(&d.account, "uid");
    let jobs = runs.0.lock().map_err(|_| "任务不可用")?;
    let current = jobs
        .iter()
        .rev()
        .find(|j| {
            text(&j.data.account, "uid") == uid
                && j.state.lock().map(|s| active(&s.status)).unwrap_or(false)
        })
        .map(|j| json!({"id":j.id,"mode":j.mode}));
    let latest = jobs
        .iter()
        .rev()
        .find(|j| text(&j.data.account, "uid") == uid)
        .map(|j| json!({"id":j.id,"mode":j.mode}));
    Ok(json!({"current":current,"latest":latest,"pending":false,"receipt":receipt(&d)}))
}
#[tauri::command]
pub fn run_resolve(
    uid: String,
    store: tauri::State<Store>,
    runs: tauri::State<Runs>,
) -> Result<(), String> {
    let jobs = runs.0.lock().map_err(|_| "任务不可用")?;
    if jobs
        .iter()
        .any(|j| j.state.lock().map(|s| active(&s.status)).unwrap_or(true))
    {
        return Err("任务仍在处理，请等待结果".into());
    }
    store.try_update(|d| {
        if uid != text(&d.account, "uid") {
            return Err("账号已切换".into());
        }
        if pending_receipt(d) {
            if let Some(r) = d.run_receipts.get_mut(&uid) {
                r["status"] = json!("reviewed");
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
) -> Result<Value, String> {
    if !["free", "campus"].contains(&mode.as_str()) {
        return Err("跑步类型无效".into());
    }
    let mut d = snapshot(&store)?;
    if uid != text(&d.account, "uid") || text(&d.account, "token").is_empty() {
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
    if mode == "campus" && text(&d.zone, "id").is_empty() {
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
    let reply = json!({"jobId":id,"points":d.route,"runConfig":d.run_config,"fence":d.zone["fence"],"faceCount":photos,"mode":mode});
    jobs.push_back(Arc::new(Job {
        id,
        data: d,
        mode,
        cancel: AtomicBool::new(false),
        busy: AtomicBool::new(false),
        state: Mutex::new(Progress {
            status: "running".into(),
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
) -> Result<Value, String> {
    let j = get(&runs, &id)?;
    if text(&snapshot(&store)?.account, "uid") != text(&j.data.account, "uid") {
        return Err("任务属于其他账号".into());
    }
    let s = j.state.lock().map_err(|_| "任务不可用")?;
    Ok(
        json!({"id":id,"status":s.status,"logs":s.logs,"logStart":s.log_start,"error":s.error,"result":s.result,"awaiting":s.awaiting}),
    )
}
#[tauri::command]
pub fn run_cancel(id: String, runs: tauri::State<Runs>) -> Result<Value, String> {
    let j = get(&runs, &id)?;
    let mut s = j.state.lock().map_err(|_| "任务不可用")?;
    if matches!(s.status.as_str(), "submitting" | "submitted") {
        return Err("记录已进入提交阶段，无法撤销；请等待结果并核对记录，勿重复提交".into());
    }
    if active(&s.status) {
        j.cancel.store(true, Ordering::SeqCst);
        s.status = "cancelled".into();
        s.error = "已取消；已发送的心跳或文件无法撤回，未继续提交记录".into();
    }
    Ok(json!({"ok":true}))
}

fn gates(rules: &Value, mode: &str) -> Result<(), String> {
    if text(rules, "game_id").is_empty() {
        return Err("学校未返回有效跑区编号".into());
    }
    if mode != "campus" {
        return Ok(());
    }
    if text(rules, "term_id").is_empty() {
        return Err("未获取学期编号".into());
    }
    for (key, label) in [
        ("is_check_geetest", "极验滑块"),
        ("is_check_geedevice", "极验设备"),
        ("is_check_deepknow", "数美"),
        ("is_check_deepkonw", "数美"),
        ("is_check_shumeng", "数盟"),
    ] {
        if number(rules, key) == 1. {
            return Err(format!("本校需要{label}核验，桌面端尚无可验证的授权流程。请使用官方应用完成；本次未提交记录"));
        }
    }
    let fc = &rules["run_face_verify_config"];
    let required = ["start_status", "middle_status", "stop_status"]
        .iter()
        .any(|k| number(fc, k) == 1.);
    if required && ![1., 2.].contains(&number(fc, "face_verify_type")) {
        return Err("学校使用未知人脸核验方式，请使用官方应用".into());
    }

    if number(&rules["capture_config"], "capture_type") == 2. {
        return Err("本跑区需要实体摄像头抓拍，请使用官方应用完成；本次未提交记录".into());
    }
    Ok(())
}
pub(crate) fn validate_points(points: &[Point]) -> Result<(), String> {
    if points.len() < 2 || points.len() > 40000 {
        return Err("轨迹点数量无效".into());
    }
    for (i, p) in points.iter().enumerate() {
        if ![p.lat, p.lng, p.speed, p.t].iter().all(|v| v.is_finite())
            || p.lat.abs() > 85.
            || p.lng.abs() > 180.
            || p.speed < 0.
            || p.speed > 8.
            || p.t < 0.
            || p.t > 14400.
            || i > 0 && p.t <= points[i - 1].t
        {
            return Err("轨迹坐标、速度或时间无效".into());
        }
    }
    if points[0].t != 0. || distance(points) > 20000. {
        return Err("轨迹超出本地支持范围".into());
    }
    Ok(())
}
fn segment(a: &Point, b: &Point) -> f64 {
    ((b.lat - a.lat) * 111320.).hypot((b.lng - a.lng) * 111320. * b.lat.to_radians().cos())
}
fn distance(points: &[Point]) -> f64 {
    points.windows(2).map(|p| segment(&p[0], &p[1])).sum()
}
fn round(x: f64, n: i32) -> f64 {
    let m = 10f64.powi(n);
    (x * m).round() / m
}
fn track_json(points: &[Point]) -> Value {
    let mut out = vec![];
    let (mut cum, mut km, mut last_km, mut next100, mut last100) = (0., 0, 0., 100., 0.);
    for (i, p) in points.iter().enumerate() {
        if i > 0 {
            cum += segment(&points[i - 1], p)
        }
        let mut v = json!({"o":round(p.lng,8),"a":round(p.lat,8),"s":round(p.speed,2)});
        if cum >= next100 {
            v["d"] = json!(round(next100 / 1000., 3));
            v["e"] = json!(round((p.t - last100).max(1.), 1));
            last100 = p.t;
            next100 += 100.;
        }
        if cum >= ((km + 1) * 1000) as f64 {
            km += 1;
            v["b"] = json!(km);
            v["c"] = json!(round((p.t - last_km).max(60.), 1));
            last_km = p.t;
        }
        out.push(v)
    }
    json!(out)
}
fn encrypted(value: &str) -> Result<Vec<u8>, String> {
    let c = network::cfg();
    Ok(network::encrypt(
        value,
        c["KEY_TRK"].as_str().unwrap(),
        c["IV_TRK"].as_str().unwrap(),
    )?
    .into_bytes())
}
fn key(kind: &str, ext: &str) -> String {
    let day = (now() + 28800) / 86400;
    let (y, m, d) = civil(day);
    format!(
        "Public/Upload/{kind}/{y:04}-{m:02}-{d:02}/{}/{}.{ext}",
        1 + uuid::Uuid::new_v4().as_u128() % 999,
        uuid::Uuid::new_v4()
    )
}
// Gregorian civil date, avoiding a new date/time runtime dependency.
fn civil(day: i64) -> (i64, i64, i64) {
    let z = day + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    if m <= 2 {
        y += 1
    }
    (y, m, d)
}
async fn job_call(
    job: &Job,
    endpoint: &str,
    extra: BTreeMap<String, String>,
    nonce: Option<u32>,
) -> Result<Value, String> {
    let clock = job.state.lock().map_err(|_| "任务不可用")?.clock;
    network::call_with_clock(&job.data, endpoint, extra, nonce, clock).await
}
async fn upload(job: &Job, key: &str, bytes: Vec<u8>, mime: &str) -> Result<(), String> {
    let sts = job_call(job, "report/getOssSts", BTreeMap::new(), None).await?;
    let s = &sts["data"];
    let bucket = text(s, "bucket");
    let bucket = if bucket.is_empty() {
        "lptiyu-data".to_string()
    } else {
        bucket
    };
    if bucket.len() > 63
        || !bucket
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err("存储桶无效".into());
    }
    let token = text(s, "SecurityToken");
    let ak = text(s, "AccessKeyId");
    let secret = text(s, "AccessKeySecret");
    if [token.as_str(), ak.as_str(), secret.as_str()]
        .iter()
        .any(|s| s.is_empty())
    {
        return Err("上传凭据缺失".into());
    }
    let date = httpdate::fmt_http_date(SystemTime::now());
    let canonical = format!("PUT\n\n{mime}\n{date}\nx-oss-security-token:{token}\n/{bucket}/{key}");
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).map_err(|_| "上传签名失败")?;
    mac.update(canonical.as_bytes());
    let sig = B64.encode(mac.finalize().into_bytes());
    let r = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(40))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "上传初始化失败")?
        .put(format!(
            "https://{bucket}.oss-cn-hangzhou.aliyuncs.com/{key}"
        ))
        .header("Date", date)
        .header("Content-Type", mime)
        .header("x-oss-security-token", token)
        .header("Authorization", format!("OSS {ak}:{sig}"))
        .body(bytes)
        .send()
        .await
        .map_err(|_| "文件上传失败，请检查网络")?;
    if r.status() != reqwest::StatusCode::OK {
        return Err(format!("文件上传被拒绝 HTTP {}", r.status().as_u16()));
    }
    Ok(())
}
fn record_str(data: &Data, time: &str) -> Result<String, String> {
    let uid = text(&data.account, "uid")
        .parse::<i64>()
        .map_err(|_| "账号编号无效")?;
    let sid = data.school_id.parse::<i64>().map_err(|_| "学校编号无效")?;
    let c = network::cfg();
    let w = c["W8"][uid.rem_euclid(10) as usize]
        .as_str()
        .ok_or("缺少提交协议参数")?;
    let sum = (sid as i32).wrapping_add(uid as i32);
    Ok(format!(
        "{:x}",
        Md5::digest(format!("{sum}{time}{w}").as_bytes())
    ))
}
fn step_info(duration: u64, steps: u64) -> String {
    let count = (duration / 60).max(1) as usize;
    let mut list = vec![steps / count as u64; count];
    for n in list.iter_mut().take((steps % count as u64) as usize) {
        *n += 1
    }
    json!({"interval":60,"list":list}).to_string()
}
fn run_check(uid: &str, rules: &Value, steps: u64, points: &[Point]) -> Result<String, String> {
    let Some(rules) = rules.as_array().filter(|r| !r.is_empty()) else {
        return Ok(json!([{"uid":uid,"plan":0,"inteval_result":"0","inteval_value":"0","is_stop":0,"is_cheat":0}]).to_string());
    };
    if rules.len() > 50 {
        return Err("跑步检查规则数量异常".into());
    }
    let mut out = vec![];
    for r in rules {
        let n = number(r, "check_num").max(1.) as usize;
        if n > 1000 {
            return Err("跑步检查区间过多".into());
        }
        let values = (0..n)
            .map(|i| {
                let f = if n == 1 {
                    0.5
                } else {
                    0.15 + 0.7 * i as f64 / (n - 1) as f64
                };
                format!(
                    "{}-{:.1}",
                    steps / n as u64,
                    points[(f * (points.len() - 1) as f64).floor() as usize].speed
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        out.push(json!({"uid":uid,"plan":r.get("plan").cloned().unwrap_or(json!(1)),"inteval_result":vec!["0";n].join(","),"inteval_value":values,"is_stop":0,"is_cheat":0}))
    }
    Ok(json!(out).to_string())
}

async fn run_action_inner(
    id: String,
    action: String,
    args: Value,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let runs = app.state::<Runs>();
    let j = get(&runs, &id)?;
    let store = app.state::<Store>();
    if action == "log" {
        let msg = text(&args, "message");
        if msg.len() > 1500 {
            return Err("日志过长".into());
        }
        let mut s = j.state.lock().map_err(|_| "任务不可用")?;
        s.push_log(msg);
        return Ok(json!({"ok":true}));
    }
    if action == "fail" {
        let mut s = j.state.lock().map_err(|_| "任务不可用")?;
        if s.status != "done" && s.status != "cancelled" {
            s.status = if matches!(s.status.as_str(), "submitting" | "unknown") {
                "unknown"
            } else {
                "failed"
            }
            .into();
            s.error = crate::session::ApiError::from(text(&args, "error")).message;
        }
        return Ok(json!({"ok":true}));
    }
    if j.busy.swap(true, Ordering::SeqCst) {
        return Err("上一任务步骤仍在执行".into());
    }
    let _busy = Busy(&j.busy);
    guard(&j, &store)?;
    {
        let s = j.state.lock().map_err(|_| "任务不可用")?;
        if !active(&s.status) {
            return Err("任务已结束".into());
        }
        if s.status == "submitting" {
            return Err("提交结果待确认，禁止重复提交".into());
        }
        if s.submit.is_some() && !matches!(action.as_str(), "gyro_link" | "complete") {
            return Err("记录已经提交，禁止重复操作".into());
        }
        if action != "before_run" && s.rules.is_none() {
            return Err("请先获取学校规则".into());
        }
        if !matches!(action.as_str(), "before_run" | "timestamp") && s.time_str.is_empty() {
            return Err("请先同步服务端时间".into());
        }
    }
    let data = &j.data;
    let result = match action.as_str() {
        "before_run" => {
            let r = job_call(&j, "Run2/beforeRunV260", map(json!({"type":"1"})), None).await?;
            gates(&r["data"], &j.mode)?;
            if j.mode == "campus" && text(&r["data"], "game_id") != text(&data.zone, "id") {
                return Err("服务端跑区已变化，请重新选择跑区".into());
            }
            j.state.lock().unwrap().rules = Some(r["data"].clone());
            r
        }
        "timestamp" => {
            let rules = j.state.lock().unwrap().rules.clone().unwrap();
            let r = job_call(
                &j,
                "Run/getTimestampV278",
                map(json!({"game_id":text(&rules,"game_id")})),
                None,
            )
            .await?;
            let server = number(&r["data"], "timestamp") as i64;
            if server <= 0 || (server - now()).abs() >= 86400 {
                return Err("服务端时间无效，请检查系统时钟".into());
            }
            let mut s = j.state.lock().unwrap();
            s.clock = server - now();
            s.time_str = text(&r["data"], "str");
            if s.time_str.is_empty() {
                return Err("服务端未返回提交校验字符串".into());
            }
            r
        }
        "device_check" => job_call(&j, "Run2/checkUserDeviceV278", BTreeMap::new(), None).await?,
        "register_points" => {
            let ids = args["pointIds"].as_array().ok_or("打卡点无效")?;
            if ids.len() > 100 || ids.iter().any(|v| v.as_u64().is_none()) {
                return Err("打卡点无效".into());
            }
            job_call(
                &j,
                "Run2/getStudentVenaPoint",
                map(json!({"point_info":ids.to_vec()})),
                None,
            )
            .await?
        }
        "location" => {
            let lat = number(&args, "lat");
            let lng = number(&args, "lng");
            if !lat.is_finite() || !lng.is_finite() || lat.abs() > 85. || lng.abs() > 180. {
                return Err("心跳坐标无效".into());
            }
            let rules = j.state.lock().unwrap().rules.clone().unwrap();
            job_call(&j,"Run/setRunLocationRecord",map(json!({"latitude":format!("{lat:.5}"),"longitude":format!("{lng:.5}"),"game_id":text(&rules,"game_id"),"point_ids":text(&args,"pointIds")})),None).await?
        }
        "upload_track" | "replace_track" => {
            let points: Vec<Point> =
                serde_json::from_value(args["points"].clone()).map_err(|_| "轨迹格式无效")?;
            validate_points(&points)?;
            let k = if action == "replace_track" {
                let k = j.state.lock().unwrap().track_key.clone();
                if k.is_empty() {
                    return Err("未找到待更新轨迹".into());
                }
                k
            } else {
                key("file/run_record", "txt")
            };
            let mut encoded = track_json(&points);
            if let Some(indices) = args["pauseIndices"].as_array() {
                for i in indices {
                    let index = i.as_u64().ok_or("暂停点无效")? as usize;
                    if index >= points.len() {
                        return Err("暂停点超出轨迹".into());
                    }
                    encoded[index]["p"] = json!(1);
                }
            }
            upload(&j, &k, encrypted(&encoded.to_string())?, "text/plain").await?;
            guard(&j, &store)?;
            let mut img = String::new();
            if action == "upload_track" {
                let png = text(&args, "previewPng");
                if !png.is_empty() {
                    let raw = png.strip_prefix("data:image/png;base64,").unwrap_or(&png);
                    if raw.len() > 3 * 1024 * 1024 {
                        return Err("预览图过大".into());
                    }
                    let bytes = B64.decode(raw).map_err(|_| "预览图编码无效")?;
                    if !bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
                        return Err("预览图必须为 PNG".into());
                    }
                    img = key("pic/run_photo_screenshotImage", "png");
                    upload(&j, &img, bytes, "image/png").await?;
                }
            }
            let mut s = j.state.lock().unwrap();
            s.track_key = k.clone();
            s.points = points;
            if !img.is_empty() {
                s.image_key = img.clone()
            }
            json!({"recordFileKey":k,"fileImgKey":s.image_key,"ok":true})
        }
        "upload_sensor" => {
            let raw = text(&args, "sensorJson");
            validate_sensor(&raw)?;
            let k = key("file/run_gyroscope", "txt");
            upload(&j, &k, encrypted(&raw)?, "text/plain").await?;
            j.state.lock().unwrap().sensor_key = k.clone();
            json!({"key":k})
        }
        "face" => {
            let photos = crate::faces::run_photos(&store, &text(&data.account, "uid"))?;
            if photos.is_empty() {
                return Err("请先添加本人照片".into());
            }
            let index = number(&args, "photoIndex") as usize % photos.len();
            let (bytes, mime) = &photos[index];
            if mime != "image/jpeg" {
                return Err("人脸核验需要 JPEG 照片，请重新添加照片".into());
            }
            let typ = number(&args, "verifyType") as u8;
            if typ > 3 {
                return Err("人脸核验阶段无效".into());
            }
            let bytes = exif_comment(bytes, &text(&data.account, "uid"))?;
            let k = key("pic/face_verify", "jpg");
            upload(&j, &k, bytes, "image/jpeg").await?;
            guard(&j, &store)?;
            let mut p = map(json!({"face_file":k,"type":typ.to_string()}));
            let prior = text(&args, "priorId");
            if !prior.is_empty() {
                p.insert("run_face_verify_id".into(), prior);
            }
            let r = job_call(&j, "Run2/faceVerify", p, None).await?;
            let id = text(&r["data"], "run_face_verify_id");
            if id.is_empty() {
                return Err("核验响应缺少有效编号".into());
            }
            json!({"id":id})
        }
        "capture" => {
            let photos = crate::faces::run_photos(&store, &text(&data.account, "uid"))?;
            if photos.is_empty() {
                return Err("本跑区需要本人抓拍照片，请先添加照片".into());
            }
            let (bytes, mime) = &photos[number(&args, "photoIndex") as usize % photos.len()];
            let k = key(
                "pic/run_photo",
                if mime == "image/jpeg" { "jpg" } else { "png" },
            );
            upload(&j, &k, bytes.clone(), mime).await?;
            j.state.lock().unwrap().capture_key = k.clone();
            let mut miss = Value::Null;
            if args["isCaptureZone"] == true {
                let r=job_call(&j,"Run2/getCaptureStatus",map(json!({"start_time":args["startTime"],"distance":text(&args,"distance"),"game_id":text(&args,"gameId"),"point_ids":args["pointIds"].as_array().map(|a|a.iter().map(Value::to_string).collect::<Vec<_>>().join(",")).unwrap_or_default()})),None).await?;
                miss = r["data"]["miss_num"].clone();
            }
            json!({"key":k,"miss":miss})
        }
        "submit_free" | "submit_campus" => {
            if (action == "submit_campus") != (j.mode == "campus") {
                return Err("提交类型不匹配".into());
            }
            let p = submit_fields(&j, &args)?;
            guard(&j, &store)?;
            {
                let mut s = j.state.lock().unwrap();
                if s.status != "running" {
                    return Err("提交已发出，不能重复发送".into());
                }
                store.try_update(|v| {
                    if !same(v, data) {
                        return Err("账号已变化，未提交".into());
                    }
                    v.run_receipts.insert(
                        text(&data.account, "uid"),
                        json!({"jobId":id,"mode":j.mode,"time":now(),"status":"pending"}),
                    );
                    Ok(())
                })?;
                s.status = "submitting".into();
            }
            let endpoint = if j.mode == "campus" {
                "Run/stopRunV278"
            } else {
                "Run/stopFreeRunV220"
            };
            match job_call(&j, endpoint, p, None).await {
                Ok(r) => {
                    let mut s = j.state.lock().unwrap();
                    s.submit = Some(r.clone());
                    s.status = "submitted".into();
                    store.update(|v| {
                        if let Some(receipt) = v.run_receipts.get_mut(&text(&data.account, "uid")) {
                            if receipt["jobId"] == id {
                                receipt["recordId"] = r["data"]["record_id"].clone();
                            }
                        }
                    })?;
                    r
                }
                Err(e) => {
                    let mut s = j.state.lock().unwrap();
                    s.status = "unknown".into();
                    s.error = format!(
                        "提交请求已发出，但未得到可确认结果：{e}。请先检查服务端记录，勿重复提交"
                    );
                    return Err(s.error.clone());
                }
            }
        }
        "gyro_link" => {
            let (sid, k) = {
                let s = j.state.lock().unwrap();
                (
                    s.submit
                        .as_ref()
                        .map(|r| text(&r["data"], "record_id"))
                        .unwrap_or_default(),
                    s.sensor_key.clone(),
                )
            };
            if sid.is_empty() || k.is_empty() {
                return Err("记录编号或传感器文件缺失".into());
            }
            let r = job_call(
                &j,
                "Run2/gyroscope",
                map(json!({"record_id":sid,"gyroscope_file":k})),
                None,
            )
            .await?;
            j.state.lock().unwrap().gyro_linked = true;
            r
        }
        "complete" => {
            let submitted = j.state.lock().unwrap().submit.clone();
            let mut result = if let Some(r) = submitted {
                r
            } else {
                let mut s = j.state.lock().unwrap();
                s.status = "failed".into();
                s.error = crate::session::ApiError::from(text(&args, "error")).message;
                return Ok(json!({"status":0,"info":s.error}));
            };
            let id = text(&result["data"], "record_id");
            let mut verified = false;
            if !id.is_empty() {
                if let Ok(detail) = job_call(
                    &j,
                    "Run/recordDetailV270",
                    map(json!({"record_id":id})),
                    None,
                )
                .await
                {
                    if !text(&detail["data"], "record_status").is_empty() {
                        result["data"]["record_status"] = detail["data"]["record_status"].clone();
                        verified = true;
                    }
                }
            }
            let status = text(&result["data"], "record_status");
            let gyro_ok = {
                let s = j.state.lock().unwrap();
                number(s.rules.as_ref().unwrap(), "gyroscope_type") <= 0.
                    || s.gyro_linked
                    || j.mode == "free"
            };
            result["recordOk"] = json!(status == "1" && gyro_ok);
            result["verified"] = json!(verified);
            result["humanStatus"] = json!(if !gyro_ok {
                format!("记录 #{id} 已提交，但传感器关联失败，请复查成绩，勿重复提交")
            } else if status == "1" {
                format!("已提交，服务端返回有效成绩，记录 #{id}")
            } else if status.is_empty() {
                format!("已提交，成绩状态待确认，请到记录页复查 #{id}")
            } else {
                format!("已提交，但服务端成绩状态为 {status}，记录 #{id}")
            });
            let mut s = j.state.lock().unwrap();
            s.status = "done".into();
            s.result = result.clone();
            store.update(|v| {
                if let Some(receipt) = v.run_receipts.get_mut(&text(&data.account, "uid")) {
                    if receipt["jobId"] == id {
                        receipt["status"] = json!("done");
                        receipt["result"] = result.clone();
                    }
                }
            })?;
            result
        }
        _ => return Err("未开放的任务操作".into()),
    };
    if !matches!(
        action.as_str(),
        "submit_free" | "submit_campus" | "gyro_link" | "complete"
    ) {
        guard(&j, &store)?;
    }
    Ok(result)
}

fn validate_sensor(raw: &str) -> Result<(), String> {
    if raw.len() > 32 * 1024 * 1024 {
        return Err("传感器文件过大".into());
    }
    let arr: Vec<Value> = serde_json::from_str(raw).map_err(|_| "传感器文件格式无效")?;
    if arr.len() < 51 || arr.len() > 240000 {
        return Err("传感器样本数量无效".into());
    }
    for v in &arr {
        for k in ["t", "ax", "ay", "az", "gx", "gy", "gz", "a", "n"] {
            if !v[k].is_number()
                && v[k]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| v.is_finite())
                    .is_none()
            {
                return Err("传感器样本无效".into());
            }
        }
    }
    Ok(())
}
fn submit_fields(j: &Job, o: &Value) -> Result<BTreeMap<String, String>, String> {
    let s = j.state.lock().map_err(|_| "任务不可用")?;
    let rules = s.rules.as_ref().ok_or("规则未获取")?;
    let duration = number(o, "durationS");
    let start = number(o, "startTs");
    let end = number(o, "endTs");
    let steps = number(o, "stepNum");
    let dist = number(o, "distanceM");
    if s.track_key.is_empty()
        || s.points.len() < 2
        || ![duration, start, end, steps, dist]
            .iter()
            .all(|v| v.is_finite())
        || duration < 1.
        || duration > 14400.
        || steps < 1.
        || steps > 100000.
        || (end - start - duration).abs() > 1.
        || end > (now() + s.clock) as f64
        || end < (now() + s.clock - 300) as f64
        || (distance(&s.points) - dist).abs() > 2.
        || (s.points.last().unwrap().t - duration).abs() > 2.
    {
        return Err("提交时间、轨迹或统计数据不一致，未发送记录".into());
    }
    let uid = text(&j.data.account, "uid");
    let mut p = map(
        json!({"distance":format!("{:.2}",dist/1000.),"start_time":start as i64,"end_time":end as i64,"used_time":duration as u64,"step_num":steps as u64,"student_num":text(&j.data.account,"studentNum"),"step_info":step_info(duration as u64,steps as u64),"record_file":s.track_key,"file_img":if s.image_key.is_empty(){"1"}else{&s.image_key},"record_img":"","newMobileDeviceId":"","record_str":record_str(&j.data,&s.time_str)?,"run_check_res":run_check(&uid,&rules["run_check"],steps as u64,&s.points)?,"gee_token":"","ip":crate::store::device_view(&j.data)["localIp"],"pass_total":"0","pass_effective_num":"0"}),
    );
    if j.mode == "campus" {
        if number(rules, "gyroscope_type") > 0. && s.sensor_key.is_empty() {
            return Err("学校要求传感器文件，但尚未上传".into());
        }
        for k in ["termId", "gameId"] {
            let expected = text(rules, if k == "termId" { "term_id" } else { "game_id" });
            if text(o, k) != expected {
                return Err("学期或跑区不一致".into());
            }
        }
        p.extend(map(json!({"school_id":j.data.school_id,"term_id":text(rules,"term_id"),"game_id":text(rules,"game_id"),"log_data":text(o,"logData"),"pass_total":o["passTotal"],"pass_effective_num":o["passEffectiveNum"],"is_running_area_valid":text(o,"isRunningAreaValid"),"record_img":s.capture_key,"is_timeout_zfb":"0"})));
        let fc = &rules["run_face_verify_config"];
        let face = text(o, "faceVerifyId");
        if ["start_status", "middle_status", "stop_status"]
            .iter()
            .any(|k| number(fc, k) == 1.)
            && number(fc, "face_verify_type") == 1.
            && face.is_empty()
        {
            return Err("缺少学校要求的人脸核验结果".into());
        }
        p.insert(
            "run_face_verify_id".into(),
            if face.is_empty() {
                "1231231231231".into()
            } else {
                face
            },
        );
        if number(rules, "is_check_device") == 1. {
            let dev = crate::store::device_view(&j.data);
            for k in ["oaid", "mac"] {
                let v = text(&dev, k);
                if !v.is_empty() {
                    p.insert(k.into(), v);
                }
            }
        }
    }
    Ok(p)
}
fn exif_comment(jpeg: &[u8], uid: &str) -> Result<Vec<u8>, String> {
    if !jpeg.starts_with(&[255, 216]) {
        return Err("人脸照片必须为 JPEG".into());
    }
    let mut body = b"ASCII\0\0\0".to_vec();
    body.extend_from_slice(format!("{:x}", Md5::digest(uid.trim().as_bytes())).as_bytes());
    let mut tiff = vec![];
    tiff.extend_from_slice(b"MM\0*\0\0\0\x08\0\x01\x92\x86\0\x07");
    tiff.extend_from_slice(&(body.len() as u32).to_be_bytes());
    tiff.extend_from_slice(&26u32.to_be_bytes());
    tiff.extend_from_slice(&0u32.to_be_bytes());
    tiff.extend(body);
    let mut seg = b"Exif\0\0".to_vec();
    seg.extend(tiff);
    let mut out = vec![255, 216, 255, 225];
    out.extend_from_slice(&((seg.len() + 2) as u16).to_be_bytes());
    out.extend(seg);
    let mut off = 2;
    while off + 4 <= jpeg.len() {
        if jpeg[off] != 255 {
            return Err("JPEG 结构无效".into());
        }
        let marker = jpeg[off + 1];
        if marker == 218 {
            out.extend_from_slice(&jpeg[off..]);
            return Ok(out);
        }
        let len = u16::from_be_bytes([jpeg[off + 2], jpeg[off + 3]]) as usize;
        if len < 2 || off + 2 + len > jpeg.len() {
            return Err("JPEG 段无效".into());
        }
        if !(marker == 225 && jpeg.get(off + 4..off + 10) == Some(b"Exif\0\0")) {
            out.extend_from_slice(&jpeg[off..off + 2 + len]);
        }
        off += 2 + len;
    }
    Err("JPEG 数据不完整".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn points() -> Vec<Point> {
        vec![
            Point {
                lat: 28.,
                lng: 112.,
                speed: 3.,
                t: 0.,
            },
            Point {
                lat: 28.001,
                lng: 112.,
                speed: 3.,
                t: 40.,
            },
        ]
    }
    fn job() -> Job {
        let mut data = Data::default();
        data.account = json!({"uid":"2468","token":"test"});
        data.school_id = "297".into();
        Job {
            id: "test".into(),
            data,
            mode: "free".into(),
            cancel: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            state: Mutex::new(Progress {
                status: "running".into(),
                rules: Some(json!({"game_id":"z","term_id":"t"})),
                time_str: "mock-time".into(),
                track_key: "mock-file".into(),
                points: points(),
                ..Default::default()
            }),
        }
    }
    #[test]
    fn record_signature_matches_supplied_exe_including_i32_wrapping() {
        let v: Value = serde_json::from_str(include_str!("run-vectors.json")).unwrap();
        for row in v["recordStrings"].as_array().unwrap() {
            let mut d = Data::default();
            d.account = json!({"uid":row["uid"].to_string()});
            d.school_id = row["school"].to_string();
            assert_eq!(
                record_str(&d, row["time"].as_str().unwrap()).unwrap(),
                row["expected"]
            );
        }
    }
    #[test]
    fn route_encoding_marks_distance_and_does_not_export_timestamps() {
        let p = points();
        let v = track_json(&p);
        assert!(v[1]["d"].as_f64().unwrap() > 0.);
        assert!(v[1].get("t").is_none());
        let enc = encrypted(&v.to_string()).unwrap();
        let c = network::cfg();
        assert_eq!(
            network::decrypt(
                std::str::from_utf8(&enc).unwrap(),
                c["KEY_TRK"].as_str().unwrap(),
                c["IV_TRK"].as_str().unwrap()
            )
            .unwrap(),
            v.to_string()
        );
    }
    #[test]
    fn invalid_tracks_and_sensors_rejected() {
        let mut p = points();
        assert!(validate_points(&p).is_ok());
        p[1].t = 0.;
        assert!(validate_points(&p).is_err());
        p[1].t = 40.;
        p[0].lat = f64::NAN;
        assert!(validate_points(&p).is_err());
        assert!(validate_sensor("[]").is_err());
        assert!(validate_sensor("not json").is_err());
    }
    #[test]
    fn step_info_sums_exactly_to_total() {
        for (d, s) in [(1, 2), (61, 165), (1199, 3201)] {
            let v: Value = serde_json::from_str(&step_info(d, s)).unwrap();
            assert_eq!(
                v["list"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap())
                    .sum::<u64>(),
                s
            );
        }
    }
    #[test]
    fn extra_verification_is_blocked_before_upload() {
        let base = json!({"game_id":"z","term_id":"t"});
        assert!(gates(&base, "campus").is_ok());
        for key in [
            "is_check_geetest",
            "is_check_geedevice",
            "is_check_deepknow",
            "is_check_shumeng",
        ] {
            let mut v = base.clone();
            v[key] = json!(1);
            assert!(gates(&v, "campus").is_err());
        }
        let mut v = base;
        v["run_face_verify_config"] = json!({"start_status":1,"face_verify_type":2});
        assert!(gates(&v, "campus").is_ok());
        v["run_face_verify_config"]["face_verify_type"] = json!(3);
        assert!(gates(&v, "campus").is_err());
    }
    #[test]
    fn account_changes_and_cancellation_stop_frozen_job() {
        let j = job();
        let store = Store {
            path: std::path::PathBuf::new(),
            data: Mutex::new(j.data.clone()),
        };
        assert!(guard(&j, &store).is_ok());
        store.data.lock().unwrap().account["uid"] = json!("other");
        assert!(guard(&j, &store).is_err());
        *store.data.lock().unwrap() = j.data.clone();
        j.cancel.store(true, Ordering::SeqCst);
        assert!(guard(&j, &store).is_err());
    }
    #[test]
    fn submit_payload_uses_owned_files_and_rejects_inconsistent_duration() {
        let j = job();
        let end = now() - 5;
        let o = json!({"durationS":40,"startTs":end-40,"endTs":end,"stepNum":100,"distanceM":distance(&points()),"recordFile":"untrusted"});
        let p = submit_fields(&j, &o).unwrap();
        assert_eq!(p["record_file"], "mock-file");
        let mut bad = o;
        bad["durationS"] = json!(400);
        assert!(submit_fields(&j, &bad).is_err());
    }
    #[test]
    fn interrupted_receipts_are_account_scoped() {
        let mut d = Data::default();
        d.account = json!({"uid":"A"});
        d.run_receipts
            .insert("A".into(), json!({"status":"pending","jobId":"one"}));
        assert!(pending_receipt(&d));
        d.account["uid"] = json!("B");
        d.run_receipts.insert("B".into(), json!({"status":"done"}));
        assert!(!pending_receipt(&d));
        d.account["uid"] = json!("A");
        assert!(pending_receipt(&d));
    }
    #[test]
    fn jpeg_comment_matches_uid_digest_and_replaces_old_exif() {
        let src = [255, 216, 255, 218, 0, 2, 255, 217];
        let once = exif_comment(&src, "2468").unwrap();
        assert!(once
            .windows(32)
            .any(|s| s == format!("{:x}", Md5::digest(b"2468")).as_bytes()));
        assert_eq!(once, exif_comment(&once, "2468").unwrap());
        assert!(exif_comment(b"invalid", "2468").is_err());
    }
    #[test]
    fn date_conversion() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(20761), (2026, 11, 4));
    }
    #[test]
    fn run_settings_have_finite_bounds() {
        assert_eq!(run_config(&Value::Null).unwrap()["straightSpeed"], 4.1);
        assert!(run_config(&json!({"straightSpeed":0})).is_err());
        assert!(run_config(&json!({"replayDelayMs":5001})).is_err());
    }
}

#[cfg(test)]
mod live_preflight {
    use super::*;
    #[test]
    #[ignore]
    fn saved_account_rules_without_submission() {
        let path = crate::data_root::root().unwrap().join("settings.dpapi");
        let store = Store::open(path).unwrap();
        let d = snapshot(&store).unwrap();
        tauri::async_runtime::block_on(async {
            let r = network::call(&d, "Run2/beforeRunV260", map(json!({"type":"1"})), None)
                .await
                .unwrap();
            let rules = &r["data"];
            assert!(!text(rules, "game_id").is_empty());
            let t = network::call(
                &d,
                "Run/getTimestampV278",
                map(json!({"game_id":text(rules,"game_id")})),
                None,
            )
            .await
            .unwrap();
            assert!(number(&t["data"], "timestamp") > 0.);
            assert!(!text(&t["data"], "str").is_empty());
            println!(
                "只读规则与校时成功；校园跑所需人工核验限制：{}；未发送心跳、照片、轨迹或成绩",
                gates(rules, "campus")
                    .err()
                    .unwrap_or_else(|| "未发现已知限制，仍需本人主动提交验收".into())
            );
        });
    }
}

pub(crate) fn ensure_idle(runs: &Runs) -> Result<(), String> {
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
pub(crate) fn check_job(id: &str, app: &tauri::AppHandle) -> Result<(), String> {
    let j = get(&app.state::<Runs>(), id)?;
    guard(&j, &app.state::<Store>())
}

pub(crate) fn begin_execution(id: &str, app: &tauri::AppHandle) -> Result<Data, String> {
    let j = get(&app.state::<Runs>(), id)?;
    guard(&j, &app.state::<Store>())?;
    let mut s = j.state.lock().map_err(|_| "任务不可用")?;
    if s.executing || s.status != "running" {
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

pub(crate) fn rules_for(id: &str, app: &tauri::AppHandle) -> Result<Value, String> {
    get(&app.state::<Runs>(), id)?
        .state
        .lock()
        .map_err(|_| "任务不可用")?
        .rules
        .clone()
        .ok_or("学校规则未加载".into())
}
pub(crate) fn mode_for(id: &str, app: &tauri::AppHandle) -> Result<String, String> {
    Ok(get(&app.state::<Runs>(), id)?.mode.clone())
}
pub(crate) fn clock_for(id: &str, app: &tauri::AppHandle) -> Result<i64, String> {
    Ok(get(&app.state::<Runs>(), id)?
        .state
        .lock()
        .map_err(|_| "任务不可用")?
        .clock)
}

#[tauri::command]
pub async fn face_validate(app: tauri::AppHandle) -> Result<Value, String> {
    let store = app.state::<Store>();
    let d = snapshot(&store)?;
    if text(&d.account, "token").is_empty() {
        return Err("请先登录".into());
    }
    let names = crate::faces::photo_names(&store, &text(&d.account, "uid"))?;
    if names.is_empty() {
        return Err("照片库为空，请先添加本人照片".into());
    }
    let runs = app.state::<Runs>();
    ensure_idle(&runs)?;
    let id = uuid::Uuid::new_v4().to_string();
    let job = Arc::new(Job {
        id: id.clone(),
        data: d,
        mode: "photo_check".into(),
        cancel: AtomicBool::new(false),
        busy: AtomicBool::new(false),
        state: Mutex::new(Progress {
            status: "running".into(),
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
                            json!({"error":e}),
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
) -> Result<Value, String> {
    let expected = get(&app.state::<Runs>(), &id).ok().map(|j| j.data.clone());
    let r = run_action_inner(id.clone(), action, args, app.clone()).await;
    if let Err(e) = &r {
        if crate::session::auth_error(e) {
            if let Some(d) = expected {
                let _ = crate::session::invalidate(&app.state::<Store>(), &d);
            }
        }
    }
    let _ = app.emit_to("main", "job-updated", &id);
    r
}

#[cfg(test)]
mod progress_retention_tests {
    use super::*;
    #[test]
    fn rolling_logs_keep_monotonic_cursor() {
        let mut s = Progress::default();
        for i in 0..2007 {
            s.push_log(i.to_string());
        }
        assert_eq!(s.logs.len(), 2000);
        assert_eq!(s.log_start, 7);
        assert_eq!(s.logs[0], "7");
        assert_eq!(s.logs.last().unwrap(), "2006");
    }
}

#[cfg(test)]
mod finish_race_tests {
    use super::*;
    #[test]
    fn photo_reply_cannot_revive_cancelled_or_failed_job() {
        for status in ["cancelled", "failed", "done"] {
            let mut s = Progress {
                status: status.into(),
                ..Default::default()
            };
            s.finish_photo_check(false, json!({"ok":true}));
            assert_eq!(s.status, status);
            assert!(s.result.is_null());
        }
        let mut s = Progress {
            status: "running".into(),
            ..Default::default()
        };
        s.finish_photo_check(true, json!({"ok":true}));
        assert!(s.result.is_null());
        s.finish_photo_check(false, json!({"ok":true}));
        assert_eq!(s.status, "done");
    }
}
