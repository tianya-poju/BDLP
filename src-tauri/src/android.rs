use crate::error::ApiError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::json;
use std::sync::OnceLock;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Wry,
};

static BRIDGE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("bdlp-android")
        .setup(|_, api| {
            let handle = api.register_android_plugin("com.poju.budaolepao", "AndroidBridge")?;
            let _ = BRIDGE.set(handle);
            Ok(())
        })
        .build()
}

fn bridge() -> Result<&'static PluginHandle<Wry>, ApiError> {
    BRIDGE
        .get()
        .ok_or_else(|| "Android 系统组件未初始化".into())
}

#[derive(Deserialize)]
struct Bytes {
    bytes: String,
}

pub(crate) fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, ApiError> {
    let response: Bytes = bridge()?
        .run_mobile_plugin(
            "protect",
            json!({ "bytes": STANDARD.encode(bytes), "decrypt": decrypt }),
        )
        .map_err(|_| ApiError::storage("无法处理 Android 本地加密数据"))?;
    STANDARD
        .decode(response.bytes)
        .map_err(|_| ApiError::storage("Android 加密数据格式无效"))
}

pub(crate) fn open_alipay(url: &str) -> Result<(), ApiError> {
    bridge()?
        .run_mobile_plugin("openAlipay", json!({ "url": url }))
        .map_err(|_| "无法打开支付宝，请确认已安装支付宝或使用另一台设备扫码".into())
}

pub(crate) async fn open_update_page(url: &str) -> Result<(), ApiError> {
    bridge()?
        .run_mobile_plugin_async("openUpdatePage", json!({ "url": url }))
        .await
        .map_err(|_| "无法打开系统浏览器，请手动访问仓库发行页".into())
}

#[tauri::command]
pub async fn android_photo(camera: bool) -> Result<Option<String>, ApiError> {
    #[derive(Deserialize)]
    struct Photo {
        image: Option<String>,
    }

    let photo: Photo = bridge()?
        .run_mobile_plugin_async("selectPhoto", json!({ "camera": camera }))
        .await
        .map_err(|_| ApiError::from("无法读取照片，请重试或从相册选择"))?;
    Ok(photo.image)
}

#[tauri::command]
pub async fn android_first_page_ready() -> Result<(), ApiError> {
    bridge()?
        .run_mobile_plugin_async("firstPageReady", ())
        .await
        .map_err(|_| "无法结束 Android 启动画面".into())
}

#[derive(Deserialize)]
pub struct AuthResult {
    pub callback: Option<String>,
    pub phase: String,
}

pub async fn open_qq(id: &str, url: &str) -> Result<AuthResult, ApiError> {
    bridge()?
        .run_mobile_plugin_async("openAuthorization", json!({ "id": id, "url": url }))
        .await
        .map_err(|_| "无法打开 QQ 授权页".into())
}

pub async fn open_face(id: &str, url: &str) -> Result<(), ApiError> {
    bridge()?
        .run_mobile_plugin_async("openRegistration", json!({ "id": id, "url": url }))
        .await
        .map_err(|_| "无法打开人脸登记页".into())
}

pub async fn face_phase(id: &str) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    struct Registration {
        phase: String,
    }

    let state: Registration = bridge()?
        .run_mobile_plugin_async("registrationStatus", json!({ "id": id }))
        .await
        .map_err(|_| ApiError::from("无法读取人脸登记页状态"))?;
    Ok(state.phase)
}

pub fn close_page(kind: &'static str, id: String) {
    tauri::async_runtime::spawn(async move {
        if let Ok(handle) = bridge() {
            let _ = handle
                .run_mobile_plugin_async::<()>("closePage", json!({ "kind": kind, "id": id }))
                .await;
        }
    });
}
