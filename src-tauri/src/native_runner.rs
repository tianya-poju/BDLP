//! Tasks are owned by Rust. Web Workers prepare immutable geometry once, before submission.
use crate::{
    network::{self, text},
    running,
    store::{Data, Store},
};
use serde_json::{json, Value};
use tauri::Manager;
async fn action(
    app: &tauri::AppHandle,
    id: &str,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    running::run_action(id.into(), name.into(), args, app.clone()).await
}
async fn log(app: &tauri::AppHandle, id: &str, message: impl Into<String>) {
    let _ = action(app, id, "log", json!({"message":message.into()})).await;
}
fn n(v: &Value, k: &str) -> f64 {
    v[k].as_f64()
        .or_else(|| v[k].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.)
}
async fn sleep(app: &tauri::AppHandle, id: &str, ms: u64) -> Result<(), String> {
    let mut left = ms;
    while left > 0 {
        running::check_job(id, app)?;
        let step = left.min(250);
        tokio::time::sleep(std::time::Duration::from_millis(step)).await;
        left -= step;
    }
    running::check_job(id, app)
}
#[tauri::command]
pub async fn run_prepare(
    id: String,
    app: tauri::AppHandle,
) -> Result<Value, crate::session::ApiError> {
    let r = action(&app, &id, "before_run", json!({})).await?;
    let t = action(&app, &id, "timestamp", json!({})).await?;
    if n(&r["data"], "is_check_time") == 1. && running::clock_for(&id, &app)?.abs() > 600 {
        return Err("设备时间与服务端相差超过10分钟，请校准后重试".into());
    }
    Ok(json!({"rules":r["data"],"timestamp":t["data"]}))
}
#[tauri::command]
pub fn run_execute(id: String, plan: Value, app: tauri::AppHandle) -> Result<(), String> {
    let points: Vec<running::Point> =
        serde_json::from_value(plan["points"].clone()).map_err(|_| "轨迹格式无效")?;
    running::validate_points(&points)?;
    let sensor = text(&plan, "sensorJson");
    if sensor.len() > 32 * 1024 * 1024 {
        return Err("传感器数据过大".into());
    }
    let d = running::begin_execution(&id, &app)?;
    tauri::async_runtime::spawn(async move {
        if let Err(e) = execute(&app, &id, &d, plan).await {
            if crate::session::auth_error(&e) {
                let _ = crate::session::invalidate(&app.state::<Store>(), &d);
            }
            let _ = action(&app, &id, "fail", json!({"error":e})).await;
        }
        running::awaiting(&id, &app, Value::Null);
    });
    Ok(())
}
async fn face(
    app: &tauri::AppHandle,
    id: &str,
    d: &Data,
    position: u8,
    prior: &str,
    cursor: &mut u32,
) -> Result<(String, i64), String> {
    log(app, id, format!("等待本人完成人脸核验，阶段 {position}")).await;
    // beforeRun uses face_verify_type=2 for the official Alipay flow.
    let rules = task_rules(app, id)?;
    if n(&rules["run_face_verify_config"], "face_verify_type") == 2. {
        if position == 0 {
            if let Ok(r) = crate::alipay::check(app, d, 0).await {
                if r["done"] == true {
                    return Ok((
                        String::new(),
                        r["startTime"].as_i64().unwrap_or(now()) - running::clock_for(id, app)?,
                    ));
                }
            }
        }
        let ticket = crate::alipay::create(app, d, position, false).await?;
        running::awaiting(id, app, ticket.clone());
        for _ in 0..150 {
            running::check_job(id, app)?;
            match crate::alipay::check(app, d, position).await {
                Ok(r) if r["done"] == true => {
                    running::awaiting(id, app, Value::Null);
                    log(app, id, "支付宝核验已由服务端确认，继续任务").await;
                    return Ok((
                        String::new(),
                        r["startTime"].as_i64().unwrap_or(now()) - running::clock_for(id, app)?,
                    ));
                }
                Ok(_) => {}
                Err(e) => {
                    if crate::session::auth_error(&e) || e.contains("过期") || e.contains("不匹配")
                    {
                        return Err(e);
                    }
                }
            }
            sleep(app, id, 2000).await?;
        }
        return Err("支付宝核验等待超时，任务已停止，未跳过核验".into());
    }
    let mut last = String::new();
    for _ in 0..3 {
        let sent = now();
        let r = action(
            app,
            id,
            "face",
            json!({"verifyType":position,"priorId":prior,"photoIndex":*cursor}),
        )
        .await;
        *cursor += 1;
        match r {
            Ok(v) => return Ok((text(&v, "id"), sent)),
            Err(e) => {
                if crate::session::auth_error(&e) {
                    return Err(e);
                }
                last = e;
                log(app, id, "本张照片未通过，检查下一张本人照片").await;
            }
        }
    }
    Err(last)
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn task_rules(app: &tauri::AppHandle, id: &str) -> Result<Value, String> {
    running::rules_for(id, app)
}
fn indices(v: &Value, len: usize) -> Result<Vec<usize>, String> {
    let a = v.as_array().ok_or("任务调度数据缺失")?;
    if a.len() > 40000 {
        return Err("任务调度数量过大".into());
    }
    a.iter()
        .map(|v| {
            v.as_u64()
                .filter(|i| (*i as usize) < len)
                .map(|i| i as usize)
                .ok_or("任务调度位置无效".into())
        })
        .collect()
}
async fn execute(app: &tauri::AppHandle, id: &str, d: &Data, mut p: Value) -> Result<(), String> {
    let rules = task_rules(app, id)?;
    let campus = running::mode_for(id, app)? == "campus";
    let fc = &rules["run_face_verify_config"];
    let mut cursor = 0;
    let (mut face_id, mut first_face) = (String::new(), 0i64);
    let clock = running::clock_for(id, app)?;
    let mut points: Vec<running::Point> =
        serde_json::from_value(p["points"].clone()).map_err(|_| "轨迹格式无效")?;
    let len = points.len();
    let hb = indices(&p["heartbeats"], len)?;
    let mid = indices(&p["faceIdx"], len)?;
    let captures = indices(&p["captureIdx"], len)?;
    log(app, id, "后台任务已启动，切页或挂起托盘不会停止任务").await;
    if campus && n(&rules, "is_check_device") == 1. {
        action(app, id, "device_check", json!({})).await?;
    }
    if campus && n(fc, "start_status") == 1. {
        let r = face(app, id, d, 0, &face_id, &mut cursor).await?;
        face_id = r.0;
        first_face = r.1 + clock;
    }
    let ids = p["plan"]["points"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| text(v, "id").parse::<u64>().ok())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if campus && !ids.is_empty() {
        action(app, id, "register_points", json!({"pointIds":ids})).await?;
    }
    let cfg = &d.run_config;
    let delay = n(cfg, "replayDelayMs") as u64;
    let mut capture_key = String::new();
    for (i, point) in points.iter().enumerate() {
        sleep(app, id, delay).await?;
        if i % 20 == 0 {
            log(app, id, format!("轨迹进度 {}/{}", i + 1, len)).await;
        }
        if campus && captures.contains(&i) {
            let distance = p["cum"][i].as_f64().unwrap_or(0.);
            let r=action(app,id,"capture",json!({"photoIndex":cursor,"gameId":text(&rules,"game_id"),"pointIds":ids,"startTime":now()+clock-(n(&p,"duration")-point.t).max(0.)as i64,"distance":format!("{:.2}",distance/1000.),"isCaptureZone":n(&rules,"is_capture_zone")==1.})).await?;
            cursor += 1;
            capture_key = text(&r, "key");
            if r["miss"].as_i64().is_some_and(|n| n > 0) && i == *captures.last().unwrap() {
                return Err("服务端仍提示抓拍不足，未继续提交".into());
            }
        }
        if campus && mid.contains(&i) {
            let r = face(app, id, d, 2, &face_id, &mut cursor).await?;
            face_id = r.0;
            if first_face == 0 {
                first_face = r.1 + clock;
            }
        }
        if hb.contains(&i) {
            action(app,id,"location",json!({"lat":point.lat,"lng":point.lng,"pointIds":ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",")})).await?;
        }
    }
    if campus && n(fc, "stop_status") == 1. {
        let r = face(app, id, d, 1, &face_id, &mut cursor).await?;
        face_id = r.0;
        if first_face == 0 {
            first_face = r.1 + clock;
        }
    }
    log(app, id, "等待时间轴收尾").await;
    sleep(app, id, 12000).await?;
    let original = n(&p, "duration") as i64;
    let end = now() + clock - 3;
    let mut start = end - original;
    if first_face > 0 {
        start = start.min(first_face - 5);
    }
    let duration = end - start;
    if duration <= 0 || duration > 14400 {
        return Err("提交时间窗无效".into());
    }
    let scale = duration as f64 / original.max(1) as f64;
    for point in &mut points {
        point.t *= scale;
    }
    validate_window(&p["rule"], &rules, start, end, n(&p, "distance"))?;
    log(app, id, "上传轨迹与预览图").await;
    action(
        app,
        id,
        "upload_track",
        json!({"points":points,"previewPng":text(&p,"previewPng"),"pauseIndices":mid}),
    )
    .await?;
    if campus {
        let mut sensor: Vec<Value> =
            serde_json::from_str(&text(&p, "sensorJson")).map_err(|_| "传感器数据无效")?;
        for sample in &mut sensor {
            let relative = n(sample, "t");
            sample["t"] = json!(start * 1000 + (relative * scale).round() as i64);
        }
        action(
            app,
            id,
            "upload_sensor",
            json!({"sensorJson":serde_json::to_string(&sensor).map_err(|_|"传感器编码失败")?}),
        )
        .await?;
    }
    let logs=p["plan"]["points"].as_array().cloned().unwrap_or_default().iter().map(|v|json!({"point_id":text(v,"id").parse::<u64>().map(|v|json!(v)).unwrap_or_else(|_|json!(text(v,"id"))),"time":if v["passed"]==true{start+(n(v,"timeOffsetS")*scale).trunc()as i64}else{0},"latitude":if v["passed"]==true{n(v,"passLat")}else{0.},"longtitude":if v["passed"]==true{n(v,"passLng")}else{0.},"distance":n(v,"distanceM")})).collect::<Vec<_>>();
    let fence = network::parse_fence(&rules["run_zone_latlng"]);
    let inside = hb
        .iter()
        .filter(|i| point_in_fence(points[**i].lat, points[**i].lng, &fence))
        .count();
    let total = hb.len();
    let valid = if fence.len() < 3 {
        true
    } else {
        match n(&rules, "log_logic") as i32 {
            2 => inside as f64 >= n(&rules, "pass_num"),
            3 => inside as f64 / total.max(1) as f64 >= n(&rules, "pass_rate"),
            _ => inside > 0,
        }
    };
    if campus && !valid {
        return Err("跑区心跳围栏校验未通过，未提交记录".into());
    }
    let step_num = ((duration as f64 / 60.) * n(cfg, "cadenceSpm")).trunc() as u64;
    log(app, id, "正在提交记录，请等待结果").await;
    let payload = json!({"distanceM":n(&p,"distance"),"durationS":duration,"stepNum":step_num,"startTs":start,"endTs":end,"termId":text(&rules,"term_id"),"gameId":text(&rules,"game_id"),"logData":serde_json::to_string(&logs).unwrap(),"passTotal":total,"passEffectiveNum":inside,"isRunningAreaValid":if valid{"1"}else{"0"},"faceVerifyId":face_id,"recordImg":capture_key});
    let r = action(
        app,
        id,
        if campus {
            "submit_campus"
        } else {
            "submit_free"
        },
        payload,
    )
    .await?;
    if campus && n(&rules, "gyroscope_type") > 0. && !text(&r["data"], "record_id").is_empty() {
        if action(app, id, "gyro_link", json!({})).await.is_err() {
            log(app, id, "记录已提交，但传感器关联失败，请到记录页复查").await;
        }
    }
    action(app, id, "complete", json!({})).await?;
    p = Value::Null;
    drop(p);
    Ok(())
}
fn point_in_fence(lat: f64, lng: f64, f: &[[f64; 2]]) -> bool {
    if f.len() < 3 {
        return true;
    }
    let mut inside = false;
    let mut j = f.len() - 1;
    for i in 0..f.len() {
        if (f[i][0] > lat) != (f[j][0] > lat)
            && lng < (f[j][1] - f[i][1]) * (lat - f[i][0]) / (f[j][0] - f[i][0]) + f[i][1]
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}
fn validate_window(
    rule: &Value,
    br: &Value,
    start: i64,
    end: i64,
    distance: f64,
) -> Result<(), String> {
    if n(br, "term_start_time") > 0. && start < (n(br, "term_start_time") as i64)
        || n(br, "term_end_time") > 0. && end > n(br, "term_end_time") as i64
    {
        return Err("时间窗超出学期范围".into());
    }
    if rule.is_object() {
        let sod = |t: i64| (t + 28800).rem_euclid(86400);
        if sod(start) > sod(end)
            || sod(start) < n(rule, "startSecOfDay") as i64
            || sod(end) > n(rule, "endSecOfDay") as i64
        {
            return Err("时间窗超出学校开放时段".into());
        }
        let pace = (end - start) as f64 * 1000. / distance.max(1.);
        if n(rule, "minPaceSec") > 0. && pace > n(rule, "minPaceSec")
            || n(rule, "maxPaceSec") > 0. && pace < n(rule, "maxPaceSec")
        {
            return Err("最终配速超出学校要求，未提交".into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_guards_reject_outside_time_and_pace() {
        let rule =
            json!({"startSecOfDay":18000,"endSecOfDay":81000,"minPaceSec":600,"maxPaceSec":180});
        let day = 1700006400i64 / 86400 * 86400;
        assert!(validate_window(&rule, &Value::Null, day + 3600, day + 4200, 2000.).is_ok());
        assert!(validate_window(&rule, &Value::Null, day - 28800, day - 28200, 2000.).is_err());
    }
    #[test]
    fn polygon_membership() {
        let f = [[0., 0.], [0., 2.], [2., 2.], [2., 0.]];
        assert!(point_in_fence(1., 1., &f));
        assert!(!point_in_fence(3., 1., &f));
    }
}
