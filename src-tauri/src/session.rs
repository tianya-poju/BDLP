pub use crate::error::ApiError;
use crate::{network, store::Store};
use serde_json::{json, Value};
pub fn auth_error(error: &ApiError) -> bool {
    error.kind == crate::error::ErrorKind::AuthExpired
}
pub fn invalidate(
    store: &Store,
    expected: &crate::store::Data,
) -> Result<(), crate::error::ApiError> {
    store.update(|d| {
        let uid = expected.account.uid.clone();
        if network::same_account(d, expected) {
            d.account.token = "".to_string();
        }
        if let Some(p) = d.profiles.get_mut(&uid) {
            if p.account.token == expected.account.token {
                p.account.token = "".to_string();
            }
        }
    })
}
#[tauri::command]
pub async fn session_check(store: tauri::State<'_, Store>) -> Result<Value, ApiError> {
    let d = network::snapshot(&store)?;
    if d.account.token.clone().is_empty() {
        return Ok(json!({"status":1,"loggedIn":false,"message":"当前账号未登录"}));
    }
    match network::call(&d, "User/User", Default::default(), None).await {
        Ok(_) => Ok(json!({"status":1,"loggedIn":true,"message":"登录状态正常"})),
        Err(e) => {
            if auth_error(&e) {
                invalidate(&store, &d)?;
                Ok(json!({"status":1,"loggedIn":false,"message":"登录已失效，请重新扫码"}))
            } else {
                Err(e.into())
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_error_is_not_logout() {
        assert!(!auth_error(&ApiError::network("请求超时")));
        assert!(auth_error(&ApiError::new(
            crate::error::ErrorKind::AuthExpired,
            "expired"
        )));
    }
    #[test]
    fn stale_token_does_not_clear_new_login() {
        let root = std::env::temp_dir().join(format!("session-{}", uuid::Uuid::new_v4()));
        let s = Store::open(root.join("settings.dpapi")).unwrap();
        s.update(|d| d.account = serde_json::from_value(json!({"uid":"A","token":"old"})).unwrap())
            .unwrap();
        let old = network::snapshot(&s).unwrap();
        s.update(|d| d.account.token = "new".into()).unwrap();
        invalidate(&s, &old).unwrap();
        assert_eq!(network::snapshot(&s).unwrap().account.token, "new");
        std::fs::remove_file(root.join("settings.dpapi")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
