//! Shared build/runtime schema. Configuration is bundled, never loaded from user data.
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolConfig {
    #[serde(rename = "SALT_N")]
    pub salt_n: String,
    #[serde(rename = "SALT_P")]
    pub salt_p: String,
    #[serde(rename = "KEY_NG")]
    pub key_ng: String,
    #[serde(rename = "IV_NG")]
    pub iv_ng: String,
    #[serde(rename = "KEY_TRK")]
    pub key_trk: String,
    #[serde(rename = "IV_TRK")]
    pub iv_trk: String,
    #[serde(rename = "Z8")]
    pub z8: [[String; 2]; 10],
    #[serde(rename = "T15")]
    pub t15: [[String; 2]; 15],
    #[serde(rename = "W8")]
    pub w8: [String; 10],
    #[serde(rename = "UMID")]
    pub umid: String,
    pub qq_url: String,
    pub version: String,
    pub version_name: String,
    #[serde(rename = "WX_APP_ID")]
    pub wx_app_id: String,
    #[serde(rename = "WX_APP_SECRET")]
    pub wx_app_secret: String,
    #[serde(rename = "WX_BUNDLE_ID")]
    pub wx_bundle_id: String,
    #[serde(rename = "WX_SCOPE")]
    pub wx_scope: String,
    #[serde(rename = "WX_STATE")]
    pub wx_state: String,
    #[serde(rename = "ALIPAY_KEY")]
    pub alipay_key: String,
    #[serde(rename = "ALIPAY_IV")]
    pub alipay_iv: String,
}
pub fn parse(raw: &str) -> Result<ProtocolConfig, &'static str> {
    let c: ProtocolConfig =
        serde_json::from_str(raw).map_err(|_| "协议配置字段、类型或数组长度无效")?;
    for value in [
        &c.key_ng,
        &c.iv_ng,
        &c.key_trk,
        &c.iv_trk,
        &c.alipay_key,
        &c.alipay_iv,
    ]
    .into_iter()
    .chain(c.z8.iter().chain(c.t15.iter()).flat_map(|pair| pair.iter()))
    {
        if value.len() != 16 {
            return Err("协议 AES 参数必须为16字节");
        }
    }
    if [
        &c.salt_n,
        &c.salt_p,
        &c.umid,
        &c.version,
        &c.version_name,
        &c.wx_app_id,
        &c.wx_app_secret,
        &c.wx_bundle_id,
        &c.wx_scope,
        &c.wx_state,
    ]
    .into_iter()
    .chain(c.w8.iter())
    .any(|s| s.is_empty() || s.chars().any(char::is_control))
    {
        return Err("协议文本参数无效");
    }
    let u = url::Url::parse(&c.qq_url).map_err(|_| "固定授权地址无效")?;
    if u.scheme() != "https"
        || u.host_str() != Some("openmobile.qq.com")
        || u.path() != "/oauth2.0/m_authorize"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || u.fragment().is_some()
    {
        return Err("固定授权地址不符合要求");
    }
    Ok(c)
}
pub fn get() -> &'static ProtocolConfig {
    static CONFIG: std::sync::OnceLock<ProtocolConfig> = std::sync::OnceLock::new();
    CONFIG.get_or_init(|| {
        parse(include_str!("protocol-config.json"))
            .expect("bundled protocol configuration validated by build.rs")
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_configuration_is_valid_and_cached() {
        assert!(std::ptr::eq(get(), get()));
    }
    #[test]
    fn rejects_missing_wrong_types_lengths_keys_and_authorization_origin() {
        let base: serde_json::Value =
            serde_json::from_str(include_str!("protocol-config.json")).unwrap();
        for field in ["SALT_N", "KEY_TRK", "W8", "qq_url"] {
            let mut c = base.clone();
            c.as_object_mut().unwrap().remove(field);
            assert!(parse(&c.to_string()).is_err());
        }
        for (key, value) in [
            ("KEY_TRK", serde_json::json!(123)),
            ("IV_NG", serde_json::json!("short")),
            ("Z8", serde_json::json!([])),
            ("W8", serde_json::json!(["x"])),
            (
                "qq_url",
                serde_json::json!("https://openmobile.qq.com.evil.test/oauth2.0/m_authorize"),
            ),
        ] {
            let mut c = base.clone();
            c[key] = value;
            assert!(parse(&c.to_string()).is_err());
        }
    }
}
