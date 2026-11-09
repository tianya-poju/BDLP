#[allow(dead_code)]
#[path = "src/protocol_config.rs"]
mod protocol_config;
use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-changed=src/protocol-config.json");
    println!("cargo:rerun-if-changed=src/protocol_config.rs");
    protocol_config::parse(include_str!("src/protocol-config.json")).expect("协议构建配置校验失败");
    println!("cargo:rerun-if-env-changed=BUD_MAP_CONFIG_PATH");
    let path = env::var_os("BUD_MAP_CONFIG_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../map-secrets.local.json")
        });
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rerun-if-env-changed=BUD_TEST_MAP_CONFIG");
    let v: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let test = env::var("BUD_TEST_MAP_CONFIG").as_deref() == Ok("1")
        && env::var("PROFILE").as_deref() != Ok("release");
    let mut code = String::new();
    for (field, name) in [
        ("webServiceKey", "WEB_SERVICE_KEY"),
        ("jsApiKey", "JS_API_KEY"),
        ("securityJsCode", "SECURITY_JS_CODE"),
    ] {
        let value = v[field].as_str().unwrap_or("").trim();
        if !test && (value.len() != 32 || !value.bytes().all(|c| c.is_ascii_hexdigit())) {
            panic!("地图构建配置缺失或无效：请在 map-secrets.local.json 填写 {}；不会生成空 Key 安装包",field)
        }
        code.push_str(&format!(
            "#[allow(dead_code)]\npub const {}:&str={};\n",
            name,
            serde_json::to_string(value).unwrap()
        ));
    }
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("map_credentials.rs"),
        code,
    )
    .unwrap();
    tauri_build::build();
}
