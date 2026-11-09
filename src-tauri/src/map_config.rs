include!(concat!(env!("OUT_DIR"), "/map_credentials.rs"));
#[tauri::command]
pub fn map_config() -> Result<serde_json::Value, crate::error::ApiError> {
    if JS_API_KEY.is_empty() || SECURITY_JS_CODE.is_empty() {
        return Err("官方地图配置未完成，缺少 JS API Key 或配套安全密钥".into());
    }
    Ok(serde_json::json!({"jsApiKey":JS_API_KEY,"securityJsCode":SECURITY_JS_CODE}))
}
