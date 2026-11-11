//! A single authorization generation shared by QQ, WeChat and account mutations.
use crate::{
    error::ApiError,
    running::Runs,
    store::{Data, Store},
};
use sha2::{Digest, Sha256};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
#[derive(Default)]
pub struct Attempts(Mutex<Option<Attempt>>);
struct Attempt {
    id: String,
    platform: String,
    context: String,
    created: Instant,
    completed: bool,
}
fn context(d: &Data) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::json!([
                d.account.uid,
                d.account.token,
                d.school_id,
                d.zone.id,
                d.device_id,
                d.pending_device
            ])
            .to_string()
            .as_bytes()
        )
    )
}
impl Attempts {
    pub(crate) fn begin(
        &self,
        id: &str,
        platform: &str,
        store: &Store,
        runs: &Runs,
    ) -> Result<(), ApiError> {
        uuid::Uuid::parse_str(id).map_err(|_| ApiError::invalid("登录尝试编号无效"))?;
        if !["qq", "wechat"].contains(&platform) {
            return Err(ApiError::invalid("登录方式无效"));
        }
        runs.idle(|| {
            let mut active = self
                .0
                .lock()
                .map_err(|_| ApiError::invalid("登录状态不可用"))?;
            if active.as_ref().is_some_and(|a| a.id == id) {
                return Err(ApiError::invalid("登录尝试不能重复开始"));
            }
            *active = Some(Attempt {
                id: id.into(),
                platform: platform.into(),
                context: context(&*store.data.lock()?),
                created: Instant::now(),
                completed: false,
            });
            Ok(())
        })
    }
    pub(crate) fn check(&self, id: &str, platform: &str, store: &Store) -> Result<(), ApiError> {
        let active = self
            .0
            .lock()
            .map_err(|_| ApiError::invalid("登录状态不可用"))?;
        validate(active.as_ref(), id, platform, &*store.data.lock()?)
    }
    pub(crate) fn cancel(&self, id: &str) -> Result<(), ApiError> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| ApiError::invalid("登录状态不可用"))?;
        if active.as_ref().is_some_and(|a| a.id == id) {
            *active = None;
        }
        Ok(())
    }
    pub(crate) fn invalidate(&self) -> Result<(), ApiError> {
        *self
            .0
            .lock()
            .map_err(|_| ApiError::invalid("登录状态不可用"))? = None;
        Ok(())
    }
    pub(crate) fn cancel_pending(&self, id: &str) {
        if let Ok(mut active) = self.0.lock() {
            if active.as_ref().is_some_and(|a| a.id == id && !a.completed) {
                *active = None;
            }
        }
    }
    pub(crate) fn commit(
        &self,
        id: &str,
        platform: &str,
        store: &Store,
        runs: &Runs,
        change: impl FnOnce(&mut Data) -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        runs.idle(|| {
            let mut active = self
                .0
                .lock()
                .map_err(|_| ApiError::invalid("登录状态不可用"))?;
            store.try_update(|d| {
                validate(active.as_ref(), id, platform, d)?;
                change(d)
            })?;
            if let Some(a) = active.as_mut() {
                a.completed = true;
            }
            Ok(())
        })
    }
}
fn validate(active: Option<&Attempt>, id: &str, platform: &str, d: &Data) -> Result<(), ApiError> {
    if active.is_some_and(|a| {
        a.id == id
            && a.platform == platform
            && !a.completed
            && a.context == context(d)
            && a.created.elapsed() < Duration::from_secs(600)
    }) {
        Ok(())
    } else {
        Err(ApiError::cancelled())
    }
}
#[tauri::command]
pub fn login_begin(id: String, platform: String, app: tauri::AppHandle) -> Result<(), ApiError> {
    app.state::<Attempts>()
        .begin(&id, &platform, &app.state::<Store>(), &app.state::<Runs>())?;
    // Destroy the superseded desktop QQ surface. Each attempt has its own label, so an old
    // window or callback can never close a newer authorization window.
    #[cfg(desktop)]
    for (label, w) in app.webview_windows() {
        if label.starts_with("qq-login-") {
            let _ = w.close();
        }
    }
    Ok(())
}
#[tauri::command]
pub fn login_cancel(id: String, app: tauri::AppHandle) -> Result<(), ApiError> {
    uuid::Uuid::parse_str(&id).map_err(|_| ApiError::invalid("登录尝试编号无效"))?;
    app.state::<Attempts>().cancel(&id)?;
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window(&format!("qq-login-{id}")) {
        let _ = w.close();
    }
    Ok(())
}
pub(crate) fn qq_credentials(url: &url::Url) -> Result<Option<(String, String)>, ApiError> {
    let permitted = url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && (url.scheme() == "https"
            && url.host_str() == Some("imgcache.qq.com")
            && url.path() == "/open/connect/widget/mobile/login/proxy.htm"
            || url.scheme() == "auth"
                && url.host_str() == Some("tauth.qq.com")
                && matches!(url.path(), "" | "/"));
    let mut pairs = std::collections::BTreeMap::new();
    for (k, v) in url.query_pairs().chain(
        url.fragment()
            .into_iter()
            .flat_map(|s| url::form_urlencoded::parse(s.trim_start_matches('&').as_bytes())),
    ) {
        if ["openid", "access_token"].contains(&k.as_ref())
            && pairs.insert(k.into_owned(), v.into_owned()).is_some()
        {
            return Err(ApiError::invalid("授权回调包含重复凭据"));
        }
    }
    if pairs.is_empty() {
        return Ok(None);
    }
    if !permitted {
        return Err(ApiError::invalid("授权回调地址不受支持"));
    }
    let id = pairs
        .remove("openid")
        .filter(|s| !s.is_empty() && s.len() <= 2048)
        .ok_or("授权账号信息缺失")?;
    let token = pairs
        .remove("access_token")
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or("授权凭据缺失")?;
    if id.chars().chain(token.chars()).any(char::is_control) {
        return Err(ApiError::invalid("授权凭据格式无效"));
    }
    Ok(Some((id, token)))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, Store, Attempts, Runs) {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let store = Store::open(root.join("settings.dpapi")).unwrap();
        store
            .update(|d| {
                d.account.uid = "a".into();
                d.account.token = "synthetic".into();
            })
            .unwrap();
        (root, store, Attempts::default(), Runs::default())
    }
    #[test]
    fn task_admission_waits_until_login_is_durably_committed() {
        use std::sync::{mpsc, Arc};
        let (root, s, a, r) = fixture();
        let s = Arc::new(s);
        let a = Arc::new(a);
        let r = Arc::new(r);
        let id = uuid::Uuid::new_v4().to_string();
        a.begin(&id, "qq", &s, &r).unwrap();
        let (entered, waiting) = mpsc::channel();
        let (resume, release) = mpsc::channel();
        let ss = s.clone();
        let aa = a.clone();
        let rr = r.clone();
        let writer = std::thread::spawn(move || {
            aa.commit(&id, "qq", &ss, &rr, |d| {
                entered.send(()).unwrap();
                release.recv().unwrap();
                d.account.uid = "b".into();
                Ok(())
            })
            .unwrap()
        });
        waiting.recv().unwrap();
        let (ready, result) = mpsc::channel();
        let ss = s.clone();
        let rr = r.clone();
        let task = std::thread::spawn(move || {
            ready
                .send(rr.idle(|| Ok(ss.data.lock()?.account.uid.clone())))
                .unwrap()
        });
        assert!(result.recv_timeout(Duration::from_millis(50)).is_err());
        resume.send(()).unwrap();
        writer.join().unwrap();
        assert_eq!(
            result
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap(),
            "b"
        );
        task.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn newer_platform_cancel_and_context_changes_reject_late_completion() {
        let (root, s, a, r) = fixture();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        a.begin(&first, "qq", &s, &r).unwrap();
        a.begin(&second, "wechat", &s, &r).unwrap();
        assert!(a
            .commit(&first, "qq", &s, &r, |d| {
                d.account.uid = "wrong".into();
                Ok(())
            })
            .is_err());
        a.cancel(&first).unwrap();
        assert!(a.check(&second, "wechat", &s).is_ok());
        assert!(a.check(&second, "qq", &s).is_err());
        s.update(|d| d.device_id = "changed".into()).unwrap();
        assert!(a.commit(&second, "wechat", &s, &r, |_| Ok(())).is_err());
        assert_eq!(s.data.lock().unwrap().account.uid, "a");
        a.begin(&first, "qq", &s, &r).unwrap();
        a.invalidate().unwrap();
        assert!(a.check(&first, "qq", &s).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn completion_is_single_use_and_failed_write_preserves_account() {
        let (root, s, a, r) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        a.begin(&id, "qq", &s, &r).unwrap();
        std::fs::rename(&s.path, root.join("old")).unwrap();
        std::fs::create_dir(&s.path).unwrap();
        assert!(a
            .commit(&id, "qq", &s, &r, |d| {
                d.account.uid = "b".into();
                Ok(())
            })
            .is_err());
        assert_eq!(s.data.lock().unwrap().account.uid, "a");
        assert!(a.check(&id, "qq", &s).is_ok());
        std::fs::remove_dir(&s.path).unwrap();
        a.commit(&id, "qq", &s, &r, |d| {
            d.account.uid = "b".into();
            Ok(())
        })
        .unwrap();
        assert!(a
            .commit(&id, "qq", &s, &r, |d| {
                d.account.uid = "wrong".into();
                Ok(())
            })
            .is_err());
        assert_eq!(s.data.lock().unwrap().account.uid, "b");
        a.cancel_pending(&id);
        assert!(a.0.lock().unwrap().as_ref().unwrap().completed);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_before_commit_wins_and_expired_attempt_is_rejected() {
        let (root, s, a, r) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        a.begin(&id, "wechat", &s, &r).unwrap();
        a.cancel(&id).unwrap();
        assert!(a.commit(&id, "wechat", &s, &r, |_| Ok(())).is_err());
        a.begin(&id, "qq", &s, &r).unwrap();
        a.0.lock().unwrap().as_mut().unwrap().created = Instant::now() - Duration::from_secs(601);
        assert!(a.check(&id, "qq", &s).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn qq_callbacks_match_upstream_endpoints_and_reject_other_origins_paths_and_duplicate_fields() {
        for value in ["https://imgcache.qq.com/open/connect/widget/mobile/login/proxy.htm?#&t=1#&openid=synthetic&access_token=test","auth://tauth.qq.com/#access_token=test&openid=synthetic"]{assert_eq!(qq_credentials(&url::Url::parse(value).unwrap()).unwrap(),Some(("synthetic".into(),"test".into())));}
        for value in ["http://imgcache.qq.com/open/connect/widget/mobile/login/proxy.htm#openid=x&access_token=t","https://imgcache.qq.com/wrong#openid=x&access_token=t","https://imgcache.qq.com.evil.test/open/connect/widget/mobile/login/proxy.htm#openid=x&access_token=t","auth://tauth.qq.com/wrong#openid=x&access_token=t","https://user@imgcache.qq.com/open/connect/widget/mobile/login/proxy.htm#openid=x&access_token=t","auth://tauth.qq.com/?openid=first#openid=second&access_token=t"]{assert!(qq_credentials(&url::Url::parse(value).unwrap()).is_err());}
        assert!(qq_credentials(
            &url::Url::parse("https://openmobile.qq.com/oauth2.0/m_authorize").unwrap()
        )
        .unwrap()
        .is_none());
    }
}
