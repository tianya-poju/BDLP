use crate::store::Store;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Status {
    pub id: String,
    pub phase: String,
}
struct Page {
    owner: String,
    status: Status,
}
#[derive(Default)]
pub struct Registration {
    gate: tokio::sync::Mutex<()>,
    page: Mutex<Option<Page>>,
}
fn owner(store: &Store) -> Result<String, crate::error::ApiError> {
    let d = crate::network::snapshot(store)?;
    let uid = crate::accounts::uid(&d);
    let token = d.account.token.as_str();
    if token.is_empty() {
        return Err("请先登录".into());
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("{}:{}", uid, token))
    ))
}
fn transition(page: &mut Option<Page>, id: &str, phase: &str) -> Option<Status> {
    let p = page.as_mut().filter(|p| p.status.id == id)?;
    if phase == "timeout" && p.status.phase != "loading" {
        return None;
    }
    if phase == "loading" && p.status.phase == "loaded" {
        return None;
    }
    p.status.phase = phase.into();
    Some(p.status.clone())
}
fn update(app: &tauri::AppHandle, id: &str, phase: &str) {
    if let Ok(mut p) = app.state::<Registration>().page.lock() {
        if let Some(s) = transition(&mut p, id, phase) {
            let _ = app.emit_to("main", "face-registration-status", s);
        }
    }
}
pub async fn open(
    app: tauri::AppHandle,
    store: &Store,
    registration: &Registration,
) -> Result<Status, crate::error::ApiError> {
    // Window creation must run outside a synchronous Tauri command on Windows.
    let _gate = registration.gate.lock().await;
    let identity = owner(store)?;
    let old = registration
        .page
        .lock()
        .map_err(|_| "注册窗口状态不可用")?
        .as_ref()
        .map(|p| (p.owner.clone(), p.status.clone()));
    if let Some((who, status)) = old {
        if let Some(w) = app.get_webview_window(&status.id) {
            if who == identity && status.phase != "timeout" && status.phase != "failed" {
                w.show().map_err(|_| "无法显示注册窗口")?;
                let _ = w.unminimize();
                let _ = w.set_focus();
                return Ok(status);
            }
            let _ = w.close();
        }
    }
    let id = format!("face-registration-{}", uuid::Uuid::new_v4());
    let status = Status {
        id: id.clone(),
        phase: "creating".into(),
    };
    *registration.page.lock().map_err(|_| "注册窗口状态不可用")? = Some(Page {
        owner: identity.clone(),
        status,
    });
    let d = crate::network::snapshot(store)?;
    let mut url =
        url::Url::parse("https://api2.lptiyu.com/bdlp_h5_fitness_test/view/main/user.html")
            .map_err(|_| "注册地址无效")?;
    url.query_pairs_mut()
        .append_pair("login_type", "1")
        .append_pair("token", d.account.token.as_str())
        .append_pair("uid", &crate::accounts::uid(&d));
    let handle = app.clone();
    let label = id.clone();
    let result = tauri::WebviewWindowBuilder::new(&app, &id, tauri::WebviewUrl::External(url))
        .data_directory(
            crate::data_root::root()
                .map_err(|_| "数据目录不可用")?
                .join("webview/face-registration")
                .join(&identity),
        )
        .title("不道乐跑 · 人脸信息")
        .inner_size(650., 760.)
        .on_navigation(|u| u.scheme() == "https" && u.host_str() == Some("api2.lptiyu.com"))
        .on_page_load(move |_, payload| {
            if payload.url().host_str() == Some("api2.lptiyu.com")
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                update(&handle, &label, "loaded");
            }
        })
        .build();
    let window = match result {
        Ok(w) => w,
        Err(_) => {
            update(&app, &id, "failed");
            return Err("注册窗口创建失败，请关闭后重试".into());
        }
    };
    if owner(store).ok().as_ref() != Some(&identity) {
        let _ = window.close();
        update(&app, &id, "failed");
        return Err("账号已改变，请重新打开注册页".into());
    }
    update(&app, &id, "loading");
    let monitor = app.clone();
    let monitor_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let mut warned = false;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let Some(w) = monitor.get_webview_window(&monitor_id) else {
                break;
            };
            if owner(&monitor.state::<Store>()).ok().as_ref() != Some(&identity) {
                let _ = w.close();
                update(&monitor, &monitor_id, "failed");
                break;
            }
            if !warned && started.elapsed().as_secs() >= 15 {
                update(&monitor, &monitor_id, "timeout");
                warned = true;
            }
        }
    });
    registration
        .page
        .lock()
        .map_err(|_| "注册窗口状态不可用")?
        .as_ref()
        .map(|p| p.status.clone())
        .ok_or_else(|| "注册窗口状态不可用".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn page() -> Option<Page> {
        Some(Page {
            owner: "account-a".into(),
            status: Status {
                id: "new".into(),
                phase: "creating".into(),
            },
        })
    }
    #[test]
    fn stale_window_callback_is_ignored() {
        let mut p = page();
        assert!(transition(&mut p, "old", "loaded").is_none());
        assert_eq!(p.unwrap().status.phase, "creating");
    }
    #[test]
    fn loaded_callback_before_build_return_is_preserved() {
        let mut p = page();
        transition(&mut p, "new", "loaded");
        assert!(transition(&mut p, "new", "loading").is_none());
        assert!(transition(&mut p, "new", "timeout").is_none());
    }
    #[test]
    fn timeout_only_for_pending_load() {
        let mut p = page();
        transition(&mut p, "new", "loading");
        assert_eq!(
            transition(&mut p, "new", "timeout").unwrap().phase,
            "timeout"
        );
        transition(&mut p, "new", "loaded");
        assert_eq!(p.unwrap().status.phase, "loaded");
    }
}
