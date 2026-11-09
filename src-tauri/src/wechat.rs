use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct Sessions(Mutex<BTreeMap<String, Session>>);
struct Session {
    cancel: Arc<AtomicBool>,
    status: String,
    message: String,
}
fn pick(s: &str, pattern: &str) -> Option<String> {
    Regex::new(pattern)
        .ok()?
        .captures(s)?
        .get(1)
        .map(|m| m.as_str().to_string())
}
fn poll_code(s: &str) -> i32 {
    pick(s, r"window\.wx_errcode\s*=\s*(-?\d+)")
        .and_then(|s| s.parse().ok())
        .unwrap_or(408)
}
fn status(app: &tauri::AppHandle, id: &str, state: &str, message: &str) {
    if let Ok(mut map) = app.state::<Sessions>().0.lock() {
        if let Some(s) = map.get_mut(id) {
            s.status = state.into();
            s.message = message.into();
        }
    }
}
async fn get_text(
    client: &reqwest::Client,
    url: &str,
    query: &[(&str, &str)],
    timeout: u64,
) -> Result<String, crate::error::ApiError> {
    let r = client
        .get(url)
        .query(query)
        .timeout(Duration::from_secs(timeout))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "微信响应超时，请重试"
            } else {
                "无法访问微信，请检查网络"
            }
        })?;
    if !r.status().is_success() {
        return Err(format!("微信服务 HTTP {}", r.status().as_u16()).into());
    }
    let b = r.bytes().await.map_err(|_| "微信响应读取失败")?;
    if b.len() > 2 * 1024 * 1024 {
        return Err("微信响应异常过大".into());
    }
    String::from_utf8(b.to_vec()).map_err(|_| "微信响应编码无效".into())
}
#[tauri::command]
pub async fn wechat_login_start(
    attempt_id: String,
    app: tauri::AppHandle,
) -> Result<Value, crate::error::ApiError> {
    app.state::<crate::login::Attempts>().check(
        &attempt_id,
        "wechat",
        &app.state::<crate::store::Store>(),
    )?;
    crate::running::ensure_idle(&app.state::<crate::running::Runs>())?;
    {
        let sessions = app.state::<Sessions>();
        let mut map = sessions.0.lock().map_err(|_| "扫码状态不可用")?;
        for s in map.values() {
            s.cancel.store(true, Ordering::SeqCst)
        }
        map.clear();
    }
    let d = crate::network::snapshot(&app.state::<crate::store::Store>())?;
    let mut login_d = d.clone();
    crate::store::apply_pending(&mut login_d);
    let device = crate::store::device_view(&login_d);
    let ua=format!("Mozilla/5.0 (Linux; Android {}; {} Build/5a6ecfb.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/104.0.5112.97 Mobile Safari/537.36 MicroMessenger/8.0.42.2460(0x28002A37) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64",device["osVersion"].as_str().unwrap_or("16"),device["model"].as_str().unwrap_or("25113PN0EC"));
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .user_agent(ua)
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() > 5 {
                a.stop()
            } else if a.url().scheme() == "https"
                && a.url().host_str().is_some_and(|h| h.ends_with(".qq.com"))
            {
                a.follow()
            } else {
                a.stop()
            }
        }))
        .build()
        .map_err(|_| "无法初始化微信登录")?;
    let c = crate::network::cfg();
    let page = get_text(
        &client,
        "https://open.weixin.qq.com/connect/app/qrconnect",
        &[
            ("appid", &c.wx_app_id),
            ("bundleid", &c.wx_bundle_id),
            ("scope", &c.wx_scope),
            ("state", &c.wx_state),
        ],
        15,
    )
    .await?;
    let uuid = pick(&page, r#"uuid:\s*"([A-Za-z0-9_-]+)""#)
        .or_else(|| pick(&page, r"/connect/qrcode/([A-Za-z0-9_-]+)"))
        .ok_or("微信授权页未返回二维码，请重试")?;
    let response = client
        .get(format!("https://open.weixin.qq.com/connect/qrcode/{uuid}"))
        .header("Referer", "https://open.weixin.qq.com/")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "微信二维码下载失败")?;
    if !response.status().is_success() {
        return Err("微信二维码下载失败".into());
    }
    let img = response.bytes().await.map_err(|_| "微信二维码读取失败")?;
    if img.len() < 16 || img.len() > 1024 * 1024 {
        return Err("微信二维码图片无效".into());
    }
    let mime = if img.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if img.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        "image/png"
    } else {
        return Err("微信返回的不是有效二维码图片".into());
    };
    let id = attempt_id;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<Sessions>();
        app.state::<crate::login::Attempts>().check(
            &id,
            "wechat",
            &app.state::<crate::store::Store>(),
        )?;
        state.0.lock().map_err(|_| "扫码状态不可用")?.insert(
            id.clone(),
            Session {
                cancel: cancel.clone(),
                status: "waiting".into(),
                message: "等待微信扫码…".into(),
            },
        );
    }
    let task_app = app.clone();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let result = wait(&task_app, &task_id, &client, &uuid, c, cancel.clone()).await;
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        match result {
            Ok(()) => {
                status(&task_app, &task_id, "done", "登录成功");
                let _ = task_app.emit_to(
                    "main",
                    "login-result",
                    json!({"ok":true,"attemptId":task_id}),
                );
            }
            Err(e) => status(&task_app, &task_id, "error", &e.message),
        }
    });
    Ok(
        json!({"sid":id,"platform":"wechat","qrImage":format!("data:{mime};base64,{}",STANDARD.encode(img)),"appName":pick(&page,r#"auth_nickname">([^<]*)<"#).unwrap_or_default()}),
    )
}
async fn wait(
    app: &tauri::AppHandle,
    id: &str,
    client: &reqwest::Client,
    uuid: &str,
    c: &'static crate::protocol_config::ProtocolConfig,
    cancel: Arc<AtomicBool>,
) -> Result<(), crate::error::ApiError> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut last = 408;
    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".into());
        }
        app.state::<crate::login::Attempts>().check(
            id,
            "wechat",
            &app.state::<crate::store::Store>(),
        )?;
        tokio::time::sleep(Duration::from_secs(if last == 404 { 1 } else { 3 })).await;
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".into());
        }
        app.state::<crate::login::Attempts>().check(
            id,
            "wechat",
            &app.state::<crate::store::Store>(),
        )?;
        let last_string = last.to_string();
        let body = get_text(
            client,
            "https://long.open.weixin.qq.com/connect/l/qrconnect",
            &[("uuid", uuid), ("f", "url"), ("last", &last_string)],
            70,
        )
        .await?;
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".into());
        }
        app.state::<crate::login::Attempts>().check(
            id,
            "wechat",
            &app.state::<crate::store::Store>(),
        )?;
        last = poll_code(&body);
        match last {
            405 => {
                let redirect = pick(&body, r#"window\.wx_redirecturl\s*=\s*'([^']*)'"#)
                    .ok_or("微信授权回调缺失")?;
                let url = url::Url::parse(&redirect).map_err(|_| "微信授权回调无效")?;
                let code = url
                    .query_pairs()
                    .find(|(k, _)| k == "code")
                    .map(|(_, v)| v.into_owned())
                    .ok_or("微信授权码缺失")?;
                let text = get_text(
                    client,
                    "https://api.weixin.qq.com/sns/oauth2/access_token",
                    &[
                        ("appid", &c.wx_app_id),
                        ("secret", &c.wx_app_secret),
                        ("code", &code),
                        ("grant_type", "authorization_code"),
                    ],
                    15,
                )
                .await?;
                let token: Value = serde_json::from_str(&text).map_err(|_| "微信凭据响应无效")?;
                let openid = token["openid"]
                    .as_str()
                    .ok_or("微信未返回账号凭据，请重新扫码")?;
                let access = token["access_token"]
                    .as_str()
                    .ok_or("微信未返回授权凭据，请重新扫码")?;
                if cancel.load(Ordering::SeqCst) {
                    return Err("已取消".into());
                }
                return crate::network::finish(app.clone(), openid.into(), access.into(), "3", id)
                    .await;
            }
            402 => return Err("二维码已过期，请重新获取".into()),
            403 => return Err("已取消微信授权".into()),
            500 => return Err("微信服务暂时异常，请重试".into()),
            404 => status(app, id, "scanned", "已扫码，请在手机上确认…"),
            _ => status(app, id, "waiting", "等待微信扫码…"),
        }
    }
    Err("等待扫码超时，请重新获取二维码".into())
}
#[tauri::command]
pub fn wechat_login_poll(
    sid: String,
    state: tauri::State<Sessions>,
) -> Result<Value, crate::error::ApiError> {
    let map = state.0.lock().map_err(|_| "扫码状态不可用")?;
    let s = map.get(&sid).ok_or("扫码会话不存在或已取消")?;
    Ok(json!({"status":s.status,"message":s.message}))
}
#[tauri::command]
pub fn wechat_login_cancel(
    sid: String,
    state: tauri::State<Sessions>,
    app: tauri::AppHandle,
) -> Result<(), crate::error::ApiError> {
    app.state::<crate::login::Attempts>().cancel(&sid)?;
    let mut map = state.0.lock().map_err(|_| "扫码状态不可用")?;
    if let Some(s) = map.remove(&sid) {
        s.cancel.store(true, Ordering::SeqCst)
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_wx_status() {
        assert_eq!(poll_code("window.wx_errcode=405;"), 405);
        assert_eq!(poll_code("window.wx_errcode = 402;"), 402);
        assert_eq!(poll_code("bad"), 408);
        assert_eq!(
            pick("uuid: \"abc_123\"", r#"uuid:\s*"([A-Za-z0-9_-]+)""#),
            Some("abc_123".into())
        );
    }
}
#[cfg(test)]
mod live_qr_tests {
    use super::*;
    #[test]
    #[ignore]
    fn wechat_qr_fetch_only() {
        tauri::async_runtime::block_on(async {
            let c = crate::network::cfg();
            let client=reqwest::Client::builder().cookie_store(true).user_agent("Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/5a6ecfb.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/104.0.5112.97 Mobile Safari/537.36 MicroMessenger/8.0.42.2460(0x28002A37) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64").build().unwrap();
            let page = get_text(
                &client,
                "https://open.weixin.qq.com/connect/app/qrconnect",
                &[
                    ("appid", &c.wx_app_id),
                    ("bundleid", &c.wx_bundle_id),
                    ("scope", &c.wx_scope),
                    ("state", &c.wx_state),
                ],
                15,
            )
            .await
            .unwrap();
            let id = pick(&page, r#"uuid:\s*"([A-Za-z0-9_-]+)""#)
                .or_else(|| pick(&page, r"/connect/qrcode/([A-Za-z0-9_-]+)"))
                .expect("微信未返回二维码标识");
            let r = client
                .get(format!("https://open.weixin.qq.com/connect/qrcode/{id}"))
                .header("Referer", "https://open.weixin.qq.com/")
                .send()
                .await
                .unwrap();
            assert!(r.status().is_success());
            let b = r.bytes().await.unwrap();
            assert!(b.starts_with(&[0xff, 0xd8, 0xff]) || b.starts_with(&[137, 80, 78, 71]));
            println!("微信授权页和二维码图片获取成功；未扫码、未换取登录凭据");
        });
    }
}
