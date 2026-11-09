use crate::store::{Data, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, Value>,
    #[serde(deserialize_with = "crate::models::null_default")]
    pub account: crate::models::Account,
    pub school_id: String,
    pub school_name: String,
    pub route: Vec<[f64; 2]>,
    #[serde(deserialize_with = "crate::models::null_default")]
    pub run_config: crate::models::RunConfig,
    #[serde(deserialize_with = "crate::models::null_default")]
    pub zone: crate::models::Zone,
    #[serde(deserialize_with = "crate::models::null_default")]
    pub device: crate::models::Device,
    pub device_id: String,
}
pub fn uid(d: &Data) -> String {
    d.account.uid.clone()
}
pub fn save_active(d: &mut Data) {
    let id = uid(d);
    if !id.is_empty() {
        let extra = d
            .profiles
            .get(&id)
            .map(|p| p.extra.clone())
            .unwrap_or_default();
        d.profiles.insert(
            id,
            Profile {
                extra,
                account: d.account.clone(),
                school_id: d.school_id.clone(),
                school_name: d.school_name.clone(),
                route: d.route.clone(),
                run_config: d.run_config.clone(),
                zone: d.zone.clone(),
                device: d.device.clone(),
                device_id: d.device_id.clone(),
            },
        );
    }
}
fn restore(d: &mut Data, p: Profile) {
    d.account = p.account;
    d.school_id = p.school_id;
    d.school_name = p.school_name;
    d.route = p.route;
    d.run_config = p.run_config;
    d.zone = p.zone;
    d.device = p.device;
    d.device_id = p.device_id;
}
pub fn list(d: &Data) -> Vec<Value> {
    let mut copy = d.clone();
    save_active(&mut copy);
    let active = uid(d);
    copy.profiles.iter().map(|(id,p)|{
        let name=p.account.label.as_deref().filter(|s|!s.is_empty()).or(p.account.real_name.as_deref().filter(|s|!s.is_empty())).or(p.account.nickname.as_deref().filter(|s|!s.is_empty())).unwrap_or(id);
        json!({"uid":id,"label":name,"realName":p.account.real_name,"schoolId":p.school_id,"schoolName":p.school_name,"hasToken":!p.account.token.is_empty(),"active":id==&active,"loginTypeText":if p.account.login_type.as_deref()==Some("wechat"){"微信扫码"}else{"QQ 扫码"}})
    }).collect()
}
pub fn select(d: &mut Data, id: &str) -> Result<(), crate::error::ApiError> {
    save_active(d);
    let p = d.profiles.get(id).cloned().ok_or("账号不存在")?;
    restore(d, p);
    Ok(())
}
#[tauri::command]
pub fn account_select(
    uid: String,
    store: tauri::State<Store>,
    runs: tauri::State<crate::running::Runs>,
) -> Result<(), crate::error::ApiError> {
    crate::running::ensure_idle(&runs)?;
    store.try_update(|d| select(d, &uid))
}
#[tauri::command]
pub fn account_rename(
    uid: String,
    label: String,
    store: tauri::State<Store>,
) -> Result<(), crate::error::ApiError> {
    let label = label.trim();
    if label.len() > 120 || label.chars().any(char::is_control) {
        return Err("备注过长或包含控制字符".into());
    }
    let mut found = false;
    store.update(|d| {
        if self::uid(d) == uid {
            d.account.label = Some(label.to_string());
            found = true
        }
        if let Some(p) = d.profiles.get_mut(&uid) {
            p.account.label = Some(label.to_string());
            found = true
        }
    })?;
    if found {
        Ok(())
    } else {
        Err("账号不存在".into())
    }
}
#[tauri::command]
pub fn account_remove(
    uid: String,
    store: tauri::State<Store>,
    runs: tauri::State<crate::running::Runs>,
) -> Result<serde_json::Value, crate::error::ApiError> {
    crate::running::ensure_idle(&runs)?;
    let pending = crate::deletions::remove(&store, &uid)?;
    Ok(json!({"cleanupPending":pending}))
}

pub fn logout(d: &mut Data, remove: bool) {
    let id = uid(d);
    save_active(d);
    if remove {
        d.profiles.remove(&id);
        d.run_receipts.remove(&id);
    } else if let Some(p) = d.profiles.get_mut(&id) {
        p.account.token = "".to_string();
        p.account.refresh_token = Some("".to_string());
    }
    d.pending_device = d.device.clone();
    d.pending_device.override_id = Some(d.device_id.clone());
    d.account = Default::default();
    d.route.clear();
    d.zone = Default::default();
    d.run_config = Default::default();
    d.school_id.clear();
    d.school_name.clear();
    d.device = Default::default();
    d.device_id = d.auto_device_id.clone();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profiles_isolate_and_hide_tokens() {
        let mut d = Data::default();
        d.account = serde_json::from_value(json!({"uid":"A","token":"secret-a"})).unwrap();
        d.route = vec![[1., 2.], [2., 3.]];
        d.device_id = "device-a".into();
        save_active(&mut d);
        d.account = serde_json::from_value(json!({"uid":"B","token":"secret-b"})).unwrap();
        d.route = vec![[4., 5.], [5., 6.]];
        d.device_id = "device-b".into();
        select(&mut d, "A").unwrap();
        assert_eq!(d.device_id, "device-a");
        assert_eq!(d.route[0], [1., 2.]);
        assert!(!serde_json::to_string(&list(&d)).unwrap().contains("secret"));
        select(&mut d, "B").unwrap();
        assert_eq!(d.route[0], [4., 5.]);
        logout(&mut d, false);
        assert!(uid(&d).is_empty());
        select(&mut d, "B").unwrap();
        assert_eq!(d.account.token, "");
        logout(&mut d, true);
        assert!(!d.profiles.contains_key("B"));
        assert!(d.profiles.contains_key("A"));
    }
}
