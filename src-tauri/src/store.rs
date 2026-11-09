use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::Manager;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Data {
    pub school_cache: std::collections::BTreeMap<String, String>,
    pub close_behavior: String,
    pub run_receipts: std::collections::BTreeMap<String, serde_json::Value>,
    pub profiles: std::collections::BTreeMap<String, crate::accounts::Profile>,
    pub school_id: String,
    pub school_name: String,
    pub route: Vec<[f64; 2]>,
    pub amap_key: String,
    pub run_config: serde_json::Value,
    pub account: serde_json::Value,
    pub device_id: String,
    pub zone: serde_json::Value,
    pub auto_device_id: String,
    pub device: serde_json::Value,
    pub pending_device: serde_json::Value,
    pub device_history: Vec<serde_json::Value>,
}
pub struct Store {
    pub path: PathBuf,
    pub data: Mutex<Data>,
}
#[repr(C)]
struct Blob {
    len: u32,
    ptr: *mut u8,
}
#[link(name = "crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        input: *const Blob,
        desc: *const u16,
        entropy: *const Blob,
        res: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        out: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const Blob,
        desc: *mut *mut u16,
        entropy: *const Blob,
        res: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        out: *mut Blob,
    ) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(p: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
}
pub(crate) fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    let input = Blob {
        len: bytes.len().try_into().map_err(|_| "数据过大")?,
        ptr: bytes.as_ptr() as *mut u8,
    };
    let mut out = Blob {
        len: 0,
        ptr: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut out,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut out,
            )
        }
    };
    if ok == 0 {
        return Err("无法处理本地加密数据，请使用原 Windows 用户账户".into());
    }
    let result = unsafe { std::slice::from_raw_parts(out.ptr, out.len as usize).to_vec() };
    unsafe {
        LocalFree(out.ptr.cast());
    }
    Ok(result)
}
impl Store {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let data = if path.exists() {
            let b = fs::read(&path).map_err(|_| "无法读取本地数据")?;
            serde_json::from_slice(&protect(&b, true)?).map_err(|_| "本地数据格式无效")?
        } else {
            Data::default()
        };
        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }
    pub(crate) fn update(&self, change: impl FnOnce(&mut Data)) -> Result<(), String> {
        self.try_update(|d| {
            change(d);
            Ok(())
        })
    }
    pub(crate) fn try_update(
        &self,
        change: impl FnOnce(&mut Data) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|_| "数据正在恢复")?;
        let mut next = data.clone();
        change(&mut next)?;
        let b = protect(
            &serde_json::to_vec(&next).map_err(|_| "数据编码失败")?,
            false,
        )?;
        if let Some(p) = self.path.parent() {
            fs::create_dir_all(p).map_err(|_| "无法创建数据目录")?;
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, b).map_err(|_| "无法保存本地数据")?;
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = self.path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
            return Err("无法替换本地数据文件".into());
        }
        *data = next;
        Ok(())
    }
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let path = crate::data_root::root()?.join("settings.dpapi");
    let store = Store::open(path).map_err(std::io::Error::other)?;
    let needs_init = {
        let d = store
            .data
            .lock()
            .map_err(|_| std::io::Error::other("数据不可用"))?;
        d.auto_device_id.is_empty() || d.device_id.is_empty()
    };
    if needs_init {
        store
            .update(|d| {
                if d.device_id.is_empty() {
                    d.device_id = uuid::Uuid::new_v4().to_string()
                }
                if d.auto_device_id.is_empty() {
                    d.auto_device_id = d.device_id.clone()
                }
            })
            .map_err(std::io::Error::other)?;
    }
    app.manage(store);
    Ok(())
}
#[derive(Serialize)]
pub struct PublicData {
    version: &'static str,
    accounts: Vec<serde_json::Value>,
    school_id: String,
    school_name: String,
    route: Vec<[f64; 2]>,
    run_config: serde_json::Value,
    account: serde_json::Value,
    zone: serde_json::Value,
    device: serde_json::Value,
    login_device: serde_json::Value,
    device_history: Vec<serde_json::Value>,
}
#[tauri::command]
pub fn local_state(store: tauri::State<Store>) -> Result<PublicData, String> {
    let d = store.data.lock().map_err(|_| "数据不可用")?;
    Ok(PublicData {
        version: env!("CARGO_PKG_VERSION"),
        accounts: crate::accounts::list(&d),
        school_id: d.school_id.clone(),
        school_name: d.school_name.clone(),
        route: d.route.clone(),
        run_config: d.run_config.clone(),
        zone: d.zone.clone(),
        device: device_view(&d),
        login_device: if d.pending_device.is_object() {
            d.pending_device.clone()
        } else {
            device_view(&d)
        },
        device_history: d.device_history.clone(),
        account: serde_json::json!({"uid":d.account["uid"],"label":d.account["label"],"hasToken":!d.account["token"].as_str().unwrap_or("").is_empty(),"realName":d.account["realName"],"nickname":d.account["nickname"],"studentNum":d.account["studentNum"]}),
    })
}
pub(crate) fn validate_route(points: &[[f64; 2]]) -> Result<(), String> {
    if points.len() > 10000 {
        return Err("路线最多一万个点".into());
    }
    if points.len() == 1 {
        return Err("路线至少需要两个点".into());
    }
    if points
        .iter()
        .any(|p| !p[0].is_finite() || !p[1].is_finite() || p[0].abs() > 90. || p[1].abs() > 180.)
    {
        return Err("路线坐标无效，格式应为 [纬度,经度]".into());
    }
    Ok(())
}
#[tauri::command]
pub fn route_save(points: Vec<[f64; 2]>, store: tauri::State<Store>) -> Result<(), String> {
    validate_route(&points)?;
    store.update(|d| d.route = points)
}
#[tauri::command]
pub fn school_save(id: String, store: tauri::State<Store>) -> Result<(), String> {
    let schools = crate::schools::merged(&store)?;
    let name = schools.get(&id).ok_or("学校不存在")?.clone();
    store.update(|d| {
        if d.school_id != id {
            d.route.clear();
            d.zone = serde_json::Value::Null;
        }
        d.school_id = id;
        d.school_name = name;
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_bad_routes() {
        assert!(validate_route(&[[91., 1.], [0., 0.]]).is_err());
        assert!(validate_route(&[[f64::NAN, 0.], [0., 0.]]).is_err());
        assert!(validate_route(&[[1., 1.]]).is_err());
        assert!(validate_route(&[]).is_ok());
    }
    #[test]
    fn encrypted_roundtrip_and_corruption() {
        let plain = b"private-key-for-test";
        let b = protect(plain, false).unwrap();
        assert!(!b.windows(plain.len()).any(|v| v == plain));
        assert_eq!(protect(&b, true).unwrap(), plain);
        assert!(protect(b"broken", true).is_err());
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    #[test]
    fn persists_without_plaintext() {
        let path = std::env::temp_dir().join(format!(
            "lepao-store-{}-{}.dpapi",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let s = Store::open(path.clone()).unwrap();
        s.update(|d| d.amap_key = "test-only-secret-key".into())
            .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.windows(20).any(|b| b == b"test-only-secret-key"));
        let reopened = Store::open(path.clone()).unwrap();
        assert_eq!(
            reopened.data.lock().unwrap().amap_key,
            "test-only-secret-key"
        );
        std::fs::remove_file(path).unwrap();
    }
}

#[tauri::command]
pub fn config_save(config: serde_json::Value, store: tauri::State<Store>) -> Result<(), String> {
    let obj = config.as_object().ok_or("参数应为对象")?;
    let allowed = [
        "straightSpeed",
        "curveSpeed",
        "maxAccel",
        "gpsIntervalMs",
        "stepLengthM",
        "cadenceSpm",
        "weightKg",
        "sensorIntensity",
        "middleFaceType",
        "paceLevel",
        "warmupTime",
        "cooldownTime",
        "replayDelayMs",
    ];
    if obj.iter().any(|(k, v)| {
        !allowed.contains(&k.as_str())
            || v.as_f64()
                .is_none_or(|n| !n.is_finite() || n < 0. || n > 10000.)
    }) {
        return Err("参数名称或数值无效".into());
    }
    store.update(|d| {
        if !d.run_config.is_object() {
            d.run_config = serde_json::json!({})
        }
        for (k, v) in obj {
            d.run_config[k] = v.clone();
        }
    })
}

#[tauri::command]
pub fn account_logout(
    remove_local: bool,
    store: tauri::State<Store>,
    runs: tauri::State<crate::running::Runs>,
) -> Result<(), String> {
    crate::running::ensure_idle(&runs)?;
    store.try_update(|d| {
        if remove_local {
            crate::faces::clear(&store, &crate::accounts::uid(d))?;
        }
        crate::accounts::logout(d, remove_local);
        Ok(())
    })
}
pub(crate) fn device_view(d: &Data) -> serde_json::Value {
    let mut v = if d.device.is_object() {
        d.device.clone()
    } else {
        serde_json::json!({})
    };
    v["id"] = serde_json::json!(d.device_id);
    v["autoId"] = serde_json::json!(if d.auto_device_id.is_empty() {
        &d.device_id
    } else {
        &d.auto_device_id
    });
    if v["model"].as_str().unwrap_or("").is_empty() {
        v["model"] = serde_json::json!("25113PN0EC")
    }
    if v["osVersion"].as_str().unwrap_or("").is_empty() {
        v["osVersion"] = serde_json::json!("16")
    }
    v["localIp"] = serde_json::json!(std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|sock| {
            sock.connect("223.5.5.5:80")?;
            sock.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_default());
    v["source"] = serde_json::json!(if v["override"].as_str().unwrap_or("").is_empty() {
        "自动派生（机器级）"
    } else {
        "登录前自定义"
    });
    v
}
fn validate_device(device: &serde_json::Value) -> Result<(), String> {
    for (k, max) in [("override", 128), ("model", 100), ("osVersion", 30)] {
        let s = device[k].as_str().ok_or("设备信息格式无效")?;
        if s.len() > max || s.chars().any(char::is_control) {
            return Err("设备字段过长或包含控制字符".into());
        }
        if k != "override" && s.trim().is_empty() {
            return Err("机型与系统版本不能为空".into());
        }
    }
    Ok(())
}
#[tauri::command]
pub fn device_save(
    device: serde_json::Value,
    store: tauri::State<Store>,
) -> Result<serde_json::Value, String> {
    validate_device(&device)?;
    let clean = serde_json::json!({"override":device["override"].as_str().unwrap().trim(),"model":device["model"].as_str().unwrap().trim(),"osVersion":device["osVersion"].as_str().unwrap().trim()});
    store.update(|d| d.pending_device = clean.clone())?;
    Ok(serde_json::json!({"device":clean}))
}
#[tauri::command]
pub fn device_new_id() -> serde_json::Value {
    serde_json::json!({"id":uuid::Uuid::new_v4().to_string()})
}
#[tauri::command]
pub fn device_history_update(
    id: String,
    clear: bool,
    store: tauri::State<Store>,
) -> Result<serde_json::Value, String> {
    store.update(|d| {
        if clear {
            d.device_history.clear()
        } else {
            d.device_history.retain(|v| v["id"].as_str() != Some(&id))
        }
    })?;
    let d = store.data.lock().map_err(|_| "数据不可用")?;
    Ok(serde_json::json!({"history":d.device_history}))
}
pub(crate) fn apply_pending(d: &mut Data) {
    if d.pending_device.is_object() {
        let id = d.pending_device["override"].as_str().unwrap_or("");
        if !id.is_empty() {
            d.device_id = id.to_string()
        } else if !d.auto_device_id.is_empty() {
            d.device_id = d.auto_device_id.clone()
        }
        let current = device_view(d);
        let mut next = d.pending_device.clone();
        for key in ["oaid", "mac"] {
            next[key] = current[key].clone()
        }
        d.device = next;
    }
}
#[cfg(test)]
mod device_tests {
    use super::*;
    #[test]
    fn pending_device_is_isolated() {
        let mut d = Data::default();
        d.device_id = "stable".into();
        d.device = serde_json::json!({"model":"old","osVersion":"15"});
        d.pending_device =
            serde_json::json!({"override":"new-device","model":"new","osVersion":"16"});
        assert_eq!(device_view(&d)["model"], "old");
        assert_eq!(d.device_id, "stable");
        apply_pending(&mut d);
        assert_eq!(d.device_id, "new-device");
        assert_eq!(device_view(&d)["model"], "new");
    }
    #[test]
    fn invalid_device_fields_rejected() {
        assert!(
            validate_device(&serde_json::json!({"override":"","model":"","osVersion":"16"}))
                .is_err()
        );
        assert!(validate_device(
            &serde_json::json!({"override":"\n","model":"a","osVersion":"16"})
        )
        .is_err());
    }
}

#[tauri::command]
pub fn device_extra_save(
    oaid: String,
    mac: String,
    store: tauri::State<Store>,
) -> Result<(), String> {
    if [&oaid, &mac]
        .iter()
        .any(|s| s.len() > 128 || s.chars().any(char::is_control))
    {
        return Err("补充字段格式无效".into());
    }
    store.update(|d| {
        if !d.device.is_object() {
            d.device = serde_json::json!({})
        }
        d.device["oaid"] = serde_json::json!(oaid.trim());
        d.device["mac"] = serde_json::json!(mac.trim());
    })
}

pub(crate) fn replace_file(
    from_path: &std::path::Path,
    to_path: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let from: Vec<u16> = from_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to_path.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
        Err("文件保存失败".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn map_center_save(lat: f64, lng: f64, store: tauri::State<Store>) -> Result<(), String> {
    validate_route(&[[lat, lng], [lat, lng]])?;
    store.update(|d| {
        if !d.zone.is_object() {
            d.zone = serde_json::json!({})
        }
        d.zone["mapCenter"] = serde_json::json!([lat, lng]);
    })
}
