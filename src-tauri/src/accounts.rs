use crate::store::{Data, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    pub account: Value,
    pub school_id: String,
    pub school_name: String,
    pub route: Vec<[f64; 2]>,
    pub run_config: Value,
    pub zone: Value,
    pub device: Value,
    pub device_id: String,
}
pub fn uid(d: &Data) -> String {
    d.account["uid"].as_str().unwrap_or("").to_string()
}
pub fn save_active(d: &mut Data) {
    let id = uid(d);
    if !id.is_empty() {
        d.profiles.insert(
            id,
            Profile {
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
    copy.profiles.iter().map(|(id,p)|{let name=p.account["label"].as_str().filter(|s|!s.is_empty()).or_else(||p.account["realName"].as_str().filter(|s|!s.is_empty())).or_else(||p.account["nickname"].as_str().filter(|s|!s.is_empty())).unwrap_or(id);json!({"uid":id,"label":name,"realName":p.account["realName"],"schoolId":p.school_id,"schoolName":p.school_name,"hasToken":!p.account["token"].as_str().unwrap_or("").is_empty(),"active":id==&active,"loginTypeText":if p.account["loginType"].as_str()==Some("wechat"){"微信扫码"}else{"QQ 扫码"}})}).collect()
}
pub fn select(d: &mut Data, id: &str) -> Result<(), String> {
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
) -> Result<(), String> {
    crate::running::ensure_idle(&runs)?;
    store.try_update(|d| select(d, &uid))
}
#[tauri::command]
pub fn account_rename(
    uid: String,
    label: String,
    store: tauri::State<Store>,
) -> Result<(), String> {
    let label = label.trim();
    if label.len() > 120 || label.chars().any(char::is_control) {
        return Err("备注过长或包含控制字符".into());
    }
    let mut found = false;
    store.update(|d| {
        if self::uid(d) == uid {
            d.account["label"] = json!(label);
            found = true
        }
        if let Some(p) = d.profiles.get_mut(&uid) {
            p.account["label"] = json!(label);
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
) -> Result<(), String> {
    crate::running::ensure_idle(&runs)?;
    store.try_update(|d| {
        crate::faces::clear(&store, &uid)?;
        if self::uid(d) == uid {
            logout(d, true)
        } else {
            d.profiles.remove(&uid);
            d.run_receipts.remove(&uid);
        }
        Ok(())
    })
}

pub fn logout(d: &mut Data, remove: bool) {
    let id = uid(d);
    save_active(d);
    if remove {
        d.profiles.remove(&id);
        d.run_receipts.remove(&id);
    } else if let Some(p) = d.profiles.get_mut(&id) {
        p.account["token"] = json!("");
        p.account["refreshToken"] = json!("");
    }
    d.pending_device = d.device.clone();
    if let Some(o) = d.pending_device.as_object_mut() {
        o.insert("override".into(), json!(d.device_id));
    }
    d.account = Value::Null;
    d.route.clear();
    d.zone = Value::Null;
    d.run_config = Value::Null;
    d.school_id.clear();
    d.school_name.clear();
    d.device = Value::Null;
    d.device_id = d.auto_device_id.clone();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profiles_isolate_and_hide_tokens() {
        let mut d = Data::default();
        d.account = json!({"uid":"A","token":"secret-a"});
        d.route = vec![[1., 2.], [2., 3.]];
        d.device_id = "device-a".into();
        save_active(&mut d);
        d.account = json!({"uid":"B","token":"secret-b"});
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
        assert_eq!(d.account["token"], "");
        logout(&mut d, true);
        assert!(!d.profiles.contains_key("B"));
        assert!(d.profiles.contains_key("A"));
    }
}
