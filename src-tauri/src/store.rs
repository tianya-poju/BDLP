use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
};
use tauri::Manager;
#[cfg(test)]
#[path = "store_tests.rs"]
mod snapshot_tests;
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Data {
    pub receipt_history: std::collections::BTreeMap<String, Vec<crate::receipts::Receipt>>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
    pub pending_deletions: std::collections::BTreeSet<String>,
    pub school_cache: std::collections::BTreeMap<String, String>,
    pub close_behavior: String,
    pub run_receipts: std::collections::BTreeMap<String, crate::receipts::Receipt>,
    pub profiles: std::collections::BTreeMap<String, crate::accounts::Profile>,
    pub school_id: String,
    pub school_name: String,
    pub route: Vec<[f64; 2]>,
    pub amap_key: String,
    #[serde(deserialize_with = "crate::models::null_default")]
    pub run_config: crate::models::RunConfig,
    #[serde(deserialize_with = "crate::models::null_default")]
    pub account: crate::models::Account,
    pub device_id: String,
    #[serde(deserialize_with = "crate::models::null_default")]
    pub zone: crate::models::Zone,
    pub auto_device_id: String,
    #[serde(deserialize_with = "crate::models::null_default")]
    pub device: crate::models::Device,
    #[serde(deserialize_with = "crate::models::null_default")]
    pub pending_device: crate::models::Device,
    pub device_history: Vec<serde_json::Value>,
}
pub struct Published(RwLock<Arc<Data>>);
impl Published {
    pub fn lock(&self) -> Result<Arc<Data>, crate::error::ApiError> {
        self.0
            .read()
            .map(|d| d.clone())
            .map_err(|_| "数据不可用".into())
    }
}
pub struct Store {
    pub path: PathBuf,
    pub data: Published,
    writer: Mutex<()>,
    pub(crate) files: Mutex<()>,
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
pub(crate) fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, crate::error::ApiError> {
    let input = Blob {
        len: bytes
            .len()
            .try_into()
            .map_err(|_| crate::error::ApiError::storage("数据过大"))?,
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
    pub fn open(path: PathBuf) -> Result<Self, crate::error::ApiError> {
        let data = if path.exists() {
            let b =
                fs::read(&path).map_err(|_| crate::error::ApiError::storage("无法读取本地数据"))?;
            serde_json::from_slice(&protect(&b, true)?)
                .map_err(|_| crate::error::ApiError::storage("本地数据格式无效"))?
        } else {
            Data::default()
        };
        Ok(Self {
            path,
            data: Published(RwLock::new(Arc::new(data))),
            writer: Mutex::new(()),
            files: Mutex::new(()),
        })
    }
    pub(crate) fn update(
        &self,
        change: impl FnOnce(&mut Data),
    ) -> Result<(), crate::error::ApiError> {
        self.try_update(|d| {
            change(d);
            Ok(())
        })
    }
    pub(crate) fn try_update(
        &self,
        change: impl FnOnce(&mut Data) -> Result<(), crate::error::ApiError>,
    ) -> Result<(), crate::error::ApiError> {
        let _writer = self
            .writer
            .lock()
            .map_err(|_| crate::error::ApiError::storage("数据正在恢复"))?;
        let data = self.data.lock()?;
        let mut next = (*data).clone();
        change(&mut next)?;
        if next == *data {
            return Ok(());
        }
        let b = protect(
            &serde_json::to_vec(&next)
                .map_err(|_| crate::error::ApiError::storage("数据编码失败"))?,
            false,
        )?;
        if let Some(p) = self.path.parent() {
            fs::create_dir_all(p)
                .map_err(|_| crate::error::ApiError::storage("无法创建数据目录"))?;
        }
        let tmp = self.path.with_extension("tmp");
        use std::io::Write;
        let mut file = fs::File::create(&tmp)
            .map_err(|_| crate::error::ApiError::storage("无法保存本地数据"))?;
        file.write_all(&b)
            .and_then(|_| file.sync_all())
            .map_err(|_| crate::error::ApiError::storage("无法保存本地数据"))?;
        drop(file);
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = self.path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
            return Err(crate::error::ApiError::storage("无法替换本地数据文件"));
        }
        *self
            .data
            .0
            .write()
            .map_err(|_| crate::error::ApiError::storage("数据不可用"))? = Arc::new(next);
        Ok(())
    }
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let path = crate::data_root::root()?.join("settings.dpapi");
    let store = Store::open(path).map_err(std::io::Error::other)?;
    crate::deletions::recover(&store).map_err(std::io::Error::other)?;
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
#[serde(rename_all = "camelCase")]
pub struct PublicAccount {
    uid: String,
    label: Option<String>,
    real_name: Option<String>,
    nickname: Option<String>,
    student_num: Option<String>,
    has_token: bool,
}
#[derive(Serialize)]
pub struct PublicData {
    cleanup_pending: bool,
    version: &'static str,
    accounts: Vec<serde_json::Value>,
    school_id: String,
    school_name: String,
    route: Vec<[f64; 2]>,
    run_config: crate::models::RunConfig,
    account: PublicAccount,
    zone: crate::models::Zone,
    device: serde_json::Value,
    login_device: serde_json::Value,
    device_history: Vec<serde_json::Value>,
}
#[tauri::command]
pub fn local_state(store: tauri::State<Store>) -> Result<PublicData, crate::error::ApiError> {
    let d = store
        .data
        .lock()
        .map_err(|_| crate::error::ApiError::storage("数据不可用"))?;
    Ok(PublicData {
        cleanup_pending: !d.pending_deletions.is_empty(),
        version: env!("CARGO_PKG_VERSION"),
        accounts: crate::accounts::list(&d),
        school_id: d.school_id.clone(),
        school_name: d.school_name.clone(),
        route: d.route.clone(),
        run_config: d.run_config.clone(),
        zone: d.zone.clone(),
        device: device_view(&d),
        login_device: if d.pending_device.model.is_some() {
            crate::models::value(&d.pending_device)
        } else {
            device_view(&d)
        },
        device_history: d.device_history.clone(),
        account: PublicAccount {
            uid: d.account.uid.clone(),
            label: d.account.label.clone(),
            real_name: d.account.real_name.clone(),
            nickname: d.account.nickname.clone(),
            student_num: d.account.student_num.clone(),
            has_token: !d.account.token.is_empty(),
        },
    })
}
pub(crate) fn validate_route(points: &[[f64; 2]]) -> Result<(), crate::error::ApiError> {
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
pub fn route_save(
    points: Vec<[f64; 2]>,
    store: tauri::State<Store>,
) -> Result<(), crate::error::ApiError> {
    validate_route(&points)?;
    store.update(|d| d.route = points)
}
#[tauri::command]
pub fn school_save(id: String, store: tauri::State<Store>) -> Result<(), crate::error::ApiError> {
    let schools = crate::schools::merged(&store)?;
    let name = schools.get(&id).ok_or("学校不存在")?.clone();
    store.update(|d| {
        if d.school_id != id {
            d.route.clear();
            d.zone = Default::default();
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
pub fn config_save(
    config: serde_json::Value,
    store: tauri::State<Store>,
) -> Result<(), crate::error::ApiError> {
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
    store.try_update(|d| {
        let mut merged = crate::models::value(&d.run_config);
        for (k, v) in obj {
            merged[k] = v.clone();
        }
        let config: crate::models::RunConfig = serde_json::from_value(merged)?;
        d.run_config = config.normalized()?;
        Ok(())
    })
}

#[tauri::command]
pub fn account_logout(
    remove_local: bool,
    store: tauri::State<Store>,
    runs: tauri::State<crate::running::Runs>,
    attempts: tauri::State<crate::login::Attempts>,
) -> Result<serde_json::Value, crate::error::ApiError> {
    let pending = runs.idle(|| {
        attempts.invalidate()?;
        let pending = if remove_local {
            crate::deletions::remove(&store, &crate::accounts::uid(&*store.data.lock()?))?
        } else {
            store.update(|d| crate::accounts::logout(d, false))?;
            false
        };
        Ok(pending)
    })?;
    Ok(serde_json::json!({"cleanupPending":pending}))
}
pub(crate) fn device_view(d: &Data) -> serde_json::Value {
    let mut v = crate::models::value(&d.device);
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
fn validate_device(device: &serde_json::Value) -> Result<(), crate::error::ApiError> {
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
) -> Result<serde_json::Value, crate::error::ApiError> {
    validate_device(&device)?;
    let clean = serde_json::json!({"override":device["override"].as_str().unwrap().trim(),"model":device["model"].as_str().unwrap().trim(),"osVersion":device["osVersion"].as_str().unwrap().trim()});
    let typed = serde_json::from_value(clean.clone())?;
    store.update(|d| d.pending_device = typed)?;
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
) -> Result<serde_json::Value, crate::error::ApiError> {
    store.update(|d| {
        if clear {
            d.device_history.clear()
        } else {
            d.device_history.retain(|v| v["id"].as_str() != Some(&id))
        }
    })?;
    let d = store
        .data
        .lock()
        .map_err(|_| crate::error::ApiError::storage("数据不可用"))?;
    Ok(serde_json::json!({"history":d.device_history}))
}
pub(crate) fn apply_pending(d: &mut Data) {
    if d.pending_device.model.is_some() {
        let id = d.pending_device.override_id.as_deref().unwrap_or("");
        if !id.is_empty() {
            d.device_id = id.to_owned()
        } else if !d.auto_device_id.is_empty() {
            d.device_id = d.auto_device_id.clone()
        }
        let mut next = d.pending_device.clone();
        next.oaid = d.device.oaid.clone();
        next.mac = d.device.mac.clone();
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
        d.device =
            serde_json::from_value(serde_json::json!({"model":"old","osVersion":"15"})).unwrap();
        d.pending_device = serde_json::from_value(
            serde_json::json!({"override":"new-device","model":"new","osVersion":"16"}),
        )
        .unwrap();
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
) -> Result<(), crate::error::ApiError> {
    if [&oaid, &mac]
        .iter()
        .any(|s| s.len() > 128 || s.chars().any(char::is_control))
    {
        return Err("补充字段格式无效".into());
    }
    store.update(|d| {
        d.device.oaid = Some(oaid.trim().to_owned());
        d.device.mac = Some(mac.trim().to_owned());
    })
}

pub(crate) fn replace_file(
    from_path: &std::path::Path,
    to_path: &std::path::Path,
) -> Result<(), crate::error::ApiError> {
    use std::os::windows::ffi::OsStrExt;
    let from: Vec<u16> = from_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to_path.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
        Err(crate::error::ApiError::storage("文件保存失败"))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn map_center_save(
    lat: f64,
    lng: f64,
    store: tauri::State<Store>,
) -> Result<(), crate::error::ApiError> {
    validate_route(&[[lat, lng], [lat, lng]])?;
    store.update(|d| {
        d.zone.map_center = Some([lat, lng]);
    })
}
