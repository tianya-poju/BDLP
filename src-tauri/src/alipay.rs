use crate::{
    network::{self, text},
    store::{Data, Store},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
#[derive(Clone)]
struct Ticket {
    uid: String,
    token: String,
    school: String,
    position: u8,
    time: i64,
    done: bool,
    clock: i64,
}
#[derive(Default)]
pub struct Tickets(
    Mutex<BTreeMap<String, Ticket>>,
    Mutex<BTreeMap<String, String>>,
);
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn uri(d: &Data, position: u8, time: i64) -> Result<String, String> {
    let value=format!("{{\"uid\":{},\"start_time\":{time},\"position\":{position},\"token\":{},\"school_id\":{}}}",serde_json::to_string(&text(&d.account,"uid")).unwrap(),serde_json::to_string(&text(&d.account,"token")).unwrap(),serde_json::to_string(&d.school_id).unwrap());
    let encrypted = network::encrypt(&value, "tG8xUo2fRq4nYvZ1", "Mw5eHp7jLs9BzXcK")?;
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    Ok(format!("alipays://platformapi/startapp?appId=2021006131634466&thirdPartSchema=lptiyu://&page={}&query=data={}",enc("pages/login/index"),enc(&encrypted)))
}
async fn notify(d: &Data, status: u8, time: i64) -> Result<(), String> {
    network::call(
        d,
        "Run2/updateZfbStatus",
        BTreeMap::from([
            ("status".into(), status.to_string()),
            ("start_time".into(), time.to_string()),
        ]),
        None,
    )
    .await?;
    Ok(())
}
pub async fn create(
    app: &tauri::AppHandle,
    d: &Data,
    position: u8,
    dry: bool,
) -> Result<Value, String> {
    if position > 2 {
        return Err("核验阶段无效".into());
    }
    let uid = text(&d.account, "uid");
    if uid.is_empty() || text(&d.account, "token").is_empty() || d.school_id.is_empty() {
        return Err("请先登录并选择学校".into());
    }
    let clock = if dry {
        0
    } else {
        let zone = text(&d.zone, "id");
        if zone.is_empty() {
            return Err("请先选择跑区，再发起正式核验".into());
        }
        let t = network::call(
            d,
            "Run/getTimestampV278",
            BTreeMap::from([("game_id".into(), zone)]),
            None,
        )
        .await?;
        let server = text(&t["data"], "timestamp")
            .parse::<i64>()
            .map_err(|_| "服务端时间无效")?;
        if (server - now()).abs() > 86400 {
            return Err("服务端时间无效".into());
        }
        server - now()
    };
    let time = now() + clock;
    let url = uri(d, position, time)?;
    if !dry {
        notify(d, 1, time).await?;
        app.state::<Tickets>()
            .0
            .lock()
            .map_err(|_| "核验会话不可用")?
            .insert(
                uid.clone(),
                Ticket {
                    uid,
                    token: text(&d.account, "token"),
                    school: d.school_id.clone(),
                    position,
                    time,
                    done: false,
                    clock,
                },
            );
    }
    app.state::<Tickets>()
        .1
        .lock()
        .map_err(|_| "拉起状态不可用")?
        .insert(
            format!("{}:{}", text(&d.account, "uid"), text(&d.account, "token")),
            url.clone(),
        );
    Ok(json!({"status":1,"url":url,"position":position,"startTime":time,"dryRun":dry}))
}
pub async fn check(app: &tauri::AppHandle, d: &Data, position: u8) -> Result<Value, String> {
    let uid = text(&d.account, "uid");
    let t = app
        .state::<Tickets>()
        .0
        .lock()
        .map_err(|_| "核验会话不可用")?
        .get(&uid)
        .cloned()
        .ok_or("还没有发起过刷脸，请先点去刷脸")?;
    if t.uid != uid
        || t.token != text(&d.account, "token")
        || t.school != d.school_id
        || t.position != position
    {
        return Err("核验阶段或账号不匹配，请重新发起".into());
    }
    if now() + t.clock - t.time > if position == 0 { 300 } else { 600 } {
        return Err("本次核验已过期，请重新发起".into());
    }
    let r = network::call(
        d,
        "Run2/getZfbFaceVerifyRecord",
        BTreeMap::from([
            ("position".into(), position.to_string()),
            ("start_time".into(), t.time.to_string()),
        ]),
        None,
    )
    .await?;
    let done = r["data"].as_array().is_some_and(|a| {
        a.iter()
            .any(|v| text(v, "position") == position.to_string() && text(v, "status") == "1")
    });
    if done {
        notify(d, 9, t.time).await?;
        if let Some(ticket) = app
            .state::<Tickets>()
            .0
            .lock()
            .map_err(|_| "核验会话不可用")?
            .get_mut(&uid)
        {
            if ticket.time == t.time {
                ticket.done = true
            }
        }
    }
    Ok(
        json!({"status":1,"done":done,"position":position,"startTime":t.time,"info":if done{"刷脸已完成，服务端已确认"}else{"尚未完成，请在手机完成后再查询"}}),
    )
}
#[tauri::command]
pub async fn alipay_url(
    position: u8,
    dry_run: bool,
    app: tauri::AppHandle,
) -> Result<Value, crate::session::ApiError> {
    let d = network::snapshot(&app.state::<Store>())?;
    Ok(create(&app, &d, position, dry_run).await?)
}
#[tauri::command]
pub async fn alipay_check(
    position: u8,
    app: tauri::AppHandle,
) -> Result<Value, crate::session::ApiError> {
    let d = network::snapshot(&app.state::<Store>())?;
    Ok(check(&app, &d, position).await?)
}
#[tauri::command]
pub async fn alipay_opened(app: tauri::AppHandle) -> Result<(), String> {
    let d = network::snapshot(&app.state::<Store>())?;
    let uid = text(&d.account, "uid");
    let time = app
        .state::<Tickets>()
        .0
        .lock()
        .map_err(|_| "核验会话不可用")?
        .get(&uid)
        .map(|t| t.time)
        .ok_or("请先发起核验")?;
    notify(&d, 2, time).await
}
#[tauri::command]
pub fn alipay_launch(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let d = network::snapshot(&app.state::<Store>())?;
    let uid = text(&d.account, "uid");
    let expected = app
        .state::<Tickets>()
        .1
        .lock()
        .map_err(|_| "拉起状态不可用")?
        .get(&format!("{}:{}", uid, text(&d.account, "token")))
        .cloned()
        .ok_or("请先生成本次二维码")?;
    if expected != url {
        return Err("二维码已更新，请重新生成本次链接".into());
    }
    use std::os::windows::ffi::OsStrExt;
    let wide = |s: &str| {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            h: *mut std::ffi::c_void,
            op: *const u16,
            file: *const u16,
            args: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            wide("open").as_ptr(),
            wide(&url).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        return Err("本机没有注册支付宝协议，请使用手机支付宝扫码".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_payload_has_stage_and_no_plain_token() {
        let mut d = Data::default();
        d.account = json!({"uid":"42","token":"secret"});
        d.school_id = "297".into();
        let u = uri(&d, 2, 123).unwrap();
        assert!(u.starts_with("alipays://platformapi/startapp?appId=2021006131634466"));
        assert!(!u.contains("secret"));
        let v: Value = serde_json::from_str(include_str!("alipay-vector.json")).unwrap();
        d.account["token"] = json!("test-token");
        assert_eq!(uri(&d, 2, 123).unwrap(), v["expected"]);
    }
}
