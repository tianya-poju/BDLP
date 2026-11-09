use crate::store::{protect, Store};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
const MAX: usize = 8;
const MAX_BYTES: usize = 2 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
struct Photo {
    data: String,
    fingerprint: String,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn directory(store: &Store, uid: &str) -> Result<PathBuf, crate::error::ApiError> {
    if uid.is_empty() {
        return Err("请先登录或选择账号档案".into());
    }
    Ok(store
        .path
        .parent()
        .ok_or("数据目录无效")?
        .join("faces")
        .join(hash(uid.as_bytes())))
}
pub(crate) fn valid_name(name: &str) -> bool {
    name.len() == 68 && name.ends_with(".bin") && name[..64].bytes().all(|b| b.is_ascii_hexdigit())
}
fn parse(data: &str, fingerprint: &str) -> Result<Photo, crate::error::ApiError> {
    if data.len() > MAX_BYTES * 4 / 3 + 256 {
        return Err("照片不能超过 2 MiB".into());
    }
    let (prefix, b64) = data.split_once(',').ok_or("照片格式无效")?;
    let b = STANDARD.decode(b64).map_err(|_| "照片编码无效")?;
    if b.len() > MAX_BYTES || b.len() < 16 {
        return Err("照片大小无效".into());
    }
    let mime = if b.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if b.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        "image/png"
    } else {
        return Err("仅支持 JPEG 或 PNG 照片".into());
    };
    if prefix != format!("data:{mime};base64") {
        return Err("照片类型与内容不符".into());
    }
    let fingerprint =
        if fingerprint.len() == 64 && fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
            fingerprint.to_ascii_lowercase()
        } else {
            hash(&b)
        };
    Ok(Photo {
        data: format!("data:{mime};base64,{}", STANDARD.encode(b)),
        fingerprint,
    })
}
fn read(path: &Path) -> Result<Photo, crate::error::ApiError> {
    let bytes = fs::read(path).map_err(|_| "照片读取失败")?;
    if bytes.len() > MAX_BYTES * 2 {
        return Err("照片文件过大".into());
    }
    serde_json::from_slice(&protect(&bytes, true)?).map_err(|_| "照片数据损坏".into())
}
fn files(dir: &Path) -> Result<Vec<PathBuf>, crate::error::ApiError> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in fs::read_dir(dir).map_err(|_| "照片目录读取失败")? {
        let entry = entry.map_err(|_| "照片目录读取失败")?;
        if entry.file_type().map_err(|_| "照片文件不可用")?.is_file()
            && valid_name(&entry.file_name().to_string_lossy())
        {
            out.push(entry.path())
        }
    }
    out.sort();
    if out.len() > MAX {
        return Err("照片库文件数量异常".into());
    }
    Ok(out)
}
fn write(dir: &Path, name: &str, photo: &Photo) -> Result<(), crate::error::ApiError> {
    fs::create_dir_all(dir).map_err(|_| "无法创建照片目录")?;
    let b = protect(
        &serde_json::to_vec(photo).map_err(|_| "照片编码失败")?,
        false,
    )?;
    let temp = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, b).map_err(|_| "照片保存失败")?;
    let target = dir.join(name);
    let result = crate::store::replace_file(&temp, &target);
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn add(dir: &Path, photo: Photo, replace: Option<&str>) -> Result<String, crate::error::ApiError> {
    let existing = files(dir)?;
    if let Some(name) = replace {
        if !valid_name(name) || !dir.join(name).is_file() {
            return Err("待替换照片不存在".into());
        }
    } else if existing.len() >= MAX {
        return Err("照片库已满，最多 8 张".into());
    }
    for p in existing {
        if replace.is_some_and(|n| p.file_name().unwrap().to_string_lossy() == n) {
            continue;
        }
        let stored = read(&p)?;
        if stored.fingerprint == photo.fingerprint || stored.data == photo.data {
            return Err("这张照片已存在，无需重复添加".into());
        }
    }
    let name = replace
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}.bin", hash(photo.data.as_bytes())));
    write(dir, &name, &photo)?;
    Ok(name)
}
#[tauri::command]
pub fn face_photos(store: tauri::State<Store>) -> Result<Value, crate::error::ApiError> {
    let _files = store.files.lock().map_err(|_| "照片库正在处理")?;
    let d = store.data.lock().map_err(|_| "数据不可用")?;
    let uid = crate::accounts::uid(&d);
    if uid.is_empty() {
        return Ok(json!({"photos":[],"max":MAX,"hasReference":false}));
    }
    let dir = directory(&store, &uid)?;
    let mut photos = vec![];
    for p in files(&dir)? {
        let photo = read(&p)?;
        photos.push(json!({"name":p.file_name().unwrap().to_string_lossy(),"url":photo.data}))
    }
    let reference = dir.join("reference.bin");
    let reference_url = if reference.exists() {
        Some(read(&reference)?.data)
    } else {
        None
    };
    Ok(
        json!({"photos":photos,"max":MAX,"hasReference":reference_url.is_some(),"referenceUrl":reference_url}),
    )
}
#[tauri::command]
pub fn face_add(
    data_base64: String,
    fingerprint: String,
    uid: String,
    store: tauri::State<Store>,
) -> Result<Value, crate::error::ApiError> {
    let _files = store.files.lock().map_err(|_| "照片库正在处理")?;
    let photo = parse(&data_base64, &fingerprint)?;
    let d = store.data.lock().map_err(|_| "数据不可用")?;
    ensure_account(&d, &uid)?;
    let dir = directory(&store, &uid)?;
    add(&dir, photo, None)?;
    Ok(json!({"status":1,"info":"已加密保存照片，仅保存在本机","count":files(&dir)?.len()}))
}
#[tauri::command]
pub fn face_replace(
    name: String,
    data_base64: String,
    uid: String,
    store: tauri::State<Store>,
) -> Result<Value, crate::error::ApiError> {
    let _files = store.files.lock().map_err(|_| "照片库正在处理")?;
    let photo = parse(&data_base64, "")?;
    let d = store.data.lock().map_err(|_| "数据不可用")?;
    ensure_account(&d, &uid)?;
    let dir = directory(&store, &uid)?;
    add(&dir, photo, Some(&name))?;
    Ok(json!({"status":1}))
}
#[tauri::command]
pub fn face_remove(
    name: String,
    uid: String,
    store: tauri::State<Store>,
) -> Result<Value, crate::error::ApiError> {
    let _files = store.files.lock().map_err(|_| "照片库正在处理")?;
    if !valid_name(&name) {
        return Err("照片名称无效".into());
    }
    let d = store.data.lock().map_err(|_| "数据不可用")?;
    ensure_account(&d, &uid)?;
    let dir = directory(&store, &uid)?;
    let p = dir.join(name);
    if p.exists() {
        fs::remove_file(p).map_err(|_| "照片删除失败")?
    }
    Ok(json!({"status":1}))
}
#[cfg(test)]
fn clear(store: &Store, uid: &str) -> Result<(), crate::error::ApiError> {
    if uid.is_empty() {
        return Ok(());
    }
    let dir = directory(store, uid)?;
    for p in files(&dir)? {
        fs::remove_file(p).map_err(|_| "部分照片删除失败")?
    }
    let reference = dir.join("reference.bin");
    if reference.exists() {
        fs::remove_file(reference).map_err(|_| "登记照删除失败")?
    }
    if dir.exists() {
        fs::remove_dir(&dir).map_err(|_| "照片目录清理失败")?
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    const PNG:&str="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYXcAAAAASUVORK5CYII=";
    #[test]
    fn rejects_unsafe_photo_inputs() {
        assert!(!valid_name("../a.bin"));
        assert!(parse("data:image/svg+xml;base64,PHN2Zy8+", "").is_err());
        assert!(parse("bad", "").is_err());
    }
    #[test]
    fn encrypted_gallery_roundtrip() {
        let dir = std::env::temp_dir().join(format!("budao-photo-test-{}", uuid::Uuid::new_v4()));
        let p = parse(PNG, "").unwrap();
        let name = add(&dir, p, None).unwrap();
        let bytes = fs::read(dir.join(&name)).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("data:image"));
        assert_eq!(read(&dir.join(&name)).unwrap().data, PNG);
        assert!(add(&dir, parse(PNG, "").unwrap(), None).is_err());
        fs::remove_file(dir.join(name)).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
async fn query_info(
    d: &crate::store::Data,
) -> Result<(reqwest::Client, Value), crate::error::ApiError> {
    let uid = crate::accounts::uid(d);
    let token = d.account.token.as_str();
    if token.is_empty() {
        return Err("请先登录".into());
    }
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "X-Requested-With",
        reqwest::header::HeaderValue::from_static("XMLHttpRequest"),
    );
    headers.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_static(
            "https://api2.lptiyu.com/bdlp_h5_fitness_test/view/main/user.html",
        ),
    );
    let client=reqwest::Client::builder().default_headers(headers).cookie_store(true).timeout(std::time::Duration::from_secs(25)).redirect(reqwest::redirect::Policy::none()).user_agent("Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/104.0.0.0 Mobile Safari/537.36").build().map_err(|_|"无法初始化登记信息查询")?;
    let base = "https://api2.lptiyu.com/bdlp_h5_fitness_test/public/index.php/";
    let login_response = client
        .post(format!("{base}index/Index/checkLogin"))
        .form(&[("login_type", "1"), ("token", token), ("uid", uid.as_str())])
        .send()
        .await
        .map_err(|_| "登记信息登录请求失败")?
        .error_for_status()
        .map_err(|_| "登记信息服务异常")?;
    let raw_cookie = login_response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|s| s.split(';').next())
        .collect::<Vec<_>>()
        .join("; ");
    let cookie = normalize_session_cookie(&raw_cookie);
    let login: Value = login_response
        .json()
        .await
        .map_err(|_| "登记信息登录响应无效")?;
    if crate::network::text(&login, "status") != "1" {
        return Err("登记信息会话建立失败，请重新登录后重试".into());
    }
    let response: Value = client
        .post(format!("{base}index/User/getUserFaceInfo"))
        .header(reqwest::header::COOKIE, cookie)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body("")
        .send()
        .await
        .map_err(|_| "登记信息查询失败")?
        .error_for_status()
        .map_err(|_| "登记信息服务异常")?
        .json()
        .await
        .map_err(|_| "登记信息响应无效")?;
    Ok((client, response))
}
#[tauri::command]
pub async fn face_info(
    auto_pull: bool,
    store: tauri::State<'_, Store>,
) -> Result<Value, crate::error::ApiError> {
    let d = crate::network::snapshot(&store)?;
    let uid = crate::accounts::uid(&d);
    let (client, response) = query_info(&d).await?;
    let code = crate::network::text(&response, "status");
    if auto_pull && (code == "2" || is_not_opened(&response) || is_unregistered(&response)) {
        let current = store.data.lock().map_err(|_| "数据不可用")?;
        if crate::accounts::uid(&current) != uid {
            return Err("账号已切换，未更新登记信息".into());
        }
        clear_reference(&store, &uid)?;
    }
    if is_unregistered(&response) {
        return Ok(
            json!({"status":1,"info":{"notOpened":false,"hasFace":false,"statusText":"未录入"},"message":"服务端提示尚未注册人脸，可打开人脸信息窗口录入","pulled":false}),
        );
    }
    if code == "2" || is_not_opened(&response) {
        return Ok(
            json!({"status":1,"info":{"notOpened":true,"hasFace":false,"statusText":"该校未开通人脸注册"},"message":"该校未开通人脸注册","pulled":false}),
        );
    }
    if code != "1" {
        return Err("服务端未返回有效登记信息".into());
    }
    let data = &response["data"];
    let mut url = String::new();
    for key in [
        "student_face_url",
        "face_url",
        "face_img",
        "face_img_url",
        "student_face",
        "face_pic",
        "img",
        "url",
        "picture",
    ] {
        let v = crate::network::text(data, key);
        if !v.is_empty() {
            url = v;
            break;
        }
    }
    let number = |k: &str| crate::network::text(data, k).parse::<i32>().unwrap_or(-1);
    let face_status = number("student_face_status");
    let has_face = !url.is_empty() || number("is_register") == 1 || face_status >= 0;
    let status_text = if !has_face {
        "未录入"
    } else {
        match face_status {
            1 => "已录入 · 正常",
            0 => "已录入 · 待审核",
            2 => "已录入 · 已抓拍",
            _ => "已录入",
        }
    };
    let mut pulled = false;
    let mut pull_error = String::new();
    if auto_pull && !url.is_empty() {
        let result: Result<Photo, crate::error::ApiError> = async {
            let u = url::Url::parse(&url).map_err(|_| "登记照地址无效")?;
            if u.scheme() != "https"
                || !u.host_str().is_some_and(|h| {
                    h == "data.lptiyu.com" || h == "api2.lptiyu.com" || h.ends_with(".aliyuncs.com")
                })
                || !u.username().is_empty()
                || u.password().is_some()
                || u.port().is_some()
            {
                return Err("登记照下载地址不受支持".into());
            }
            let mut r = client
                .get(u)
                .send()
                .await
                .map_err(|_| "登记照下载失败")?
                .error_for_status()
                .map_err(|_| "登记照下载被服务端拒绝")?;
            let mut bytes = vec![];
            while let Some(chunk) = r.chunk().await.map_err(|_| "登记照下载中断")? {
                if bytes.len() + chunk.len() > MAX_BYTES {
                    return Err("登记照过大".into());
                }
                bytes.extend_from_slice(&chunk)
            }
            let mime = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
                "image/jpeg"
            } else {
                "image/png"
            };
            parse(
                &format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
                "",
            )
        }
        .await;
        match result {
            Ok(photo) => {
                let _files = store
                    .files
                    .lock()
                    .map_err(|_| crate::error::ApiError::storage("照片库正在处理"))?;
                let current = store.data.lock().map_err(|_| "数据不可用")?;
                if !crate::network::same_account(&current, &d) {
                    return Err("账号已切换，未保存登记照".into());
                }
                write(&directory(&store, &uid)?, "reference.bin", &photo)?;
                pulled = true
            }
            Err(e) => pull_error = e.message,
        }
    }
    let message = if pulled {
        "已拉取登记照，仅供对照，不参与核验上传".to_string()
    } else if !pull_error.is_empty() {
        format!("登记信息已查询；{pull_error}")
    } else if has_face {
        "登记信息已查询".into()
    } else {
        "尚无登记照，可打开人脸注册页录入".into()
    };
    Ok(
        json!({"status":1,"info":{"notOpened":false,"hasFace":has_face,"statusText":status_text,"studentName":data["student_name"],"studentNum":data["student_num"]},"message":message,"pulled":pulled}),
    )
}
#[tauri::command]
pub async fn face_registration_open(
    app: tauri::AppHandle,
    store: tauri::State<'_, Store>,
    registration: tauri::State<'_, crate::face_window::Registration>,
) -> Result<crate::face_window::Status, crate::error::ApiError> {
    crate::face_window::open(app, &store, &registration).await
}
#[cfg(test)]
mod isolation_tests {
    use super::*;
    const PNG:&str="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYXcAAAAASUVORK5CYII=";
    #[test]
    fn cleanup_is_account_scoped() {
        let root =
            std::env::temp_dir().join(format!("budao-gallery-isolation-{}", uuid::Uuid::new_v4()));
        let store = Store::open(root.join("settings.dpapi")).unwrap();
        let a = directory(&store, "A").unwrap();
        let b = directory(&store, "B").unwrap();
        add(&a, parse(PNG, "").unwrap(), None).unwrap();
        add(&b, parse(PNG, "").unwrap(), None).unwrap();
        write(&a, "reference.bin", &parse(PNG, "").unwrap()).unwrap();
        clear(&store, "A").unwrap();
        assert!(!a.exists());
        assert_eq!(files(&b).unwrap().len(), 1);
        clear(&store, "B").unwrap();
        fs::remove_dir(root.join("faces")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
#[cfg(test)]
mod live_face_info {
    use super::*;
    #[test]
    #[ignore]
    fn registered_info_readonly() {
        let path = crate::data_root::root().unwrap().join("settings.dpapi");
        let store = Store::open(path).unwrap();
        let d = crate::network::snapshot(&store).unwrap();
        let (_, reply) = tauri::async_runtime::block_on(query_info(&d)).unwrap();
        assert!(
            ["1", "2"].contains(&crate::network::text(&reply, "status").as_str())
                || is_unregistered(&reply)
                || is_not_opened(&reply),
            "登记查询未返回有效状态（状态={}，提示属于登录类={}）",
            crate::network::text(&reply, "status"),
            crate::network::text(&reply, "info").contains("登录")
        );
        println!("学校人脸登记信息只读查询成功；未下载照片、未上传或核验");
    }
}

fn normalize_session_cookie(raw: &str) -> String {
    let mut pairs: std::collections::BTreeMap<String, String> = raw
        .split(';')
        .filter_map(|s| s.trim().split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    if !pairs.contains_key("PHPSESSID") {
        if let Some(value) = pairs.get("BJYSESSION").cloned() {
            pairs.insert("PHPSESSID".into(), value);
        }
    }
    pairs
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}
#[cfg(test)]
mod cookie_tests {
    use super::*;
    #[test]
    fn matches_official_h5_session_alias() {
        assert_eq!(
            normalize_session_cookie("BJYSESSION=abc"),
            "BJYSESSION=abc; PHPSESSID=abc"
        );
        assert_eq!(
            normalize_session_cookie("PHPSESSID=x; BJYSESSION=y"),
            "BJYSESSION=y; PHPSESSID=x"
        );
    }
}

fn is_unregistered(v: &Value) -> bool {
    crate::network::text(v, "status") == "-100"
        && crate::network::text(v, "info").contains("未注册")
}
#[cfg(test)]
mod registration_status_tests {
    use super::*;
    #[test]
    fn distinguishes_missing_face_from_access_errors() {
        assert!(is_unregistered(&json!({"status":-100,"info":"未注册人脸"})));
        assert!(!is_unregistered(&json!({"status":-100,"info":"请求无效"})));
    }
}

fn is_not_opened(v: &Value) -> bool {
    crate::network::text(v, "status") == "-100"
        && crate::network::text(v, "info").contains("未开通人脸注册")
}
#[cfg(test)]
mod not_opened_tests {
    use super::*;
    #[test]
    fn distinguishes_school_registration_disabled() {
        assert!(is_not_opened(
            &json!({"status":-100,"info":"暂未开通人脸注册"})
        ));
        assert!(!is_not_opened(&json!({"status":-100,"info":"权限不足"})));
    }
}

pub(crate) fn clear_reference(store: &Store, uid: &str) -> Result<(), crate::error::ApiError> {
    if uid.is_empty() {
        return Ok(());
    }
    let path = directory(store, uid)?.join("reference.bin");
    if path.exists() {
        fs::remove_file(path).map_err(|_| "登记照清理失败")?
    }
    Ok(())
}
#[cfg(test)]
mod capacity_tests {
    use super::*;
    #[test]
    fn capacity_and_replace() {
        let root = std::env::temp_dir().join(format!("budao-gallery-cap-{}", uuid::Uuid::new_v4()));
        let base=STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYXcAAAAASUVORK5CYII=").unwrap();
        let photo = |i: u8| {
            let mut b = base.clone();
            b.push(i);
            parse(&format!("data:image/png;base64,{}", STANDARD.encode(b)), "").unwrap()
        };
        let first = add(&root, photo(0), None).unwrap();
        for i in 1..8 {
            add(&root, photo(i), None).unwrap();
        }
        assert!(add(&root, photo(8), None).is_err());
        add(&root, photo(8), Some(&first)).unwrap();
        assert_eq!(files(&root).unwrap().len(), 8);
        for path in files(&root).unwrap() {
            fs::remove_file(path).unwrap();
        }
        fs::remove_dir(root).unwrap();
    }
}

fn ensure_account(d: &crate::store::Data, expected: &str) -> Result<(), crate::error::ApiError> {
    if expected.is_empty() || crate::accounts::uid(d) != expected {
        Err("账号已切换，未修改照片".into())
    } else {
        Ok(())
    }
}
#[cfg(test)]
mod account_guard_tests {
    use super::*;
    #[test]
    fn stale_account_cannot_modify_photos() {
        let mut d = crate::store::Data::default();
        d.account = serde_json::from_value(json!({"uid":"B"})).unwrap();
        assert!(ensure_account(&d, "A").is_err());
        assert!(ensure_account(&d, "").is_err());
        assert!(ensure_account(&d, "B").is_ok());
    }
}

pub(crate) fn run_photos(
    store: &Store,
    uid: &str,
) -> Result<Vec<(Vec<u8>, String)>, crate::error::ApiError> {
    let _files = store.files.lock().map_err(|_| "照片库正在处理")?;
    let d = store.data.lock().map_err(|_| "数据不可用")?;
    ensure_account(&d, uid)?;
    files(&directory(store, uid)?)?
        .iter()
        .map(|p| {
            let photo = read(p)?;
            let (head, b64) = photo.data.split_once(',').ok_or("照片格式无效")?;
            let bytes = STANDARD.decode(b64).map_err(|_| "照片格式无效")?;
            Ok((
                bytes,
                if head.contains("jpeg") {
                    "image/jpeg".into()
                } else {
                    "image/png".into()
                },
            ))
        })
        .collect()
}

pub(crate) fn photo_names(store: &Store, uid: &str) -> Result<Vec<String>, crate::error::ApiError> {
    let _files = store.files.lock().map_err(|_| "照片库正在处理")?;
    Ok(files(&directory(store, uid)?)?
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
        .collect())
}
#[tauri::command]
pub fn face_reference_remove(
    uid: String,
    store: tauri::State<Store>,
) -> Result<(), crate::error::ApiError> {
    let _files = store.files.lock().map_err(|_| "照片库正在处理")?;
    let d = store.data.lock().map_err(|_| "数据不可用")?;
    ensure_account(&d, &uid)?;
    clear_reference(&store, &uid)
}
