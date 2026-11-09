use crate::store::{Data, Store};
use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use md5::{Digest, Md5};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
pub(crate) fn cfg() -> &'static crate::protocol_config::ProtocolConfig {
    crate::protocol_config::get()
}
fn md5(s: &str) -> String {
    format!("{:x}", Md5::digest(s.as_bytes()))
}
pub(crate) fn encrypt(text: &str, key: &str, iv: &str) -> Result<String, crate::error::ApiError> {
    let e = cbc::Encryptor::<aes::Aes128>::new_from_slices(key.as_bytes(), iv.as_bytes())
        .map_err(|_| "加密参数无效")?;
    Ok(B64.encode(e.encrypt_padded_vec_mut::<Pkcs7>(text.as_bytes())))
}
pub(crate) fn decrypt(text: &str, key: &str, iv: &str) -> Result<String, crate::error::ApiError> {
    let bytes = B64
        .decode(text.split_whitespace().collect::<String>())
        .map_err(|_| "响应编码无效")?;
    let d = cbc::Decryptor::<aes::Aes128>::new_from_slices(key.as_bytes(), iv.as_bytes())
        .map_err(|_| "解密参数无效")?;
    String::from_utf8(
        d.decrypt_padded_vec_mut::<Pkcs7>(&bytes)
            .map_err(|_| "响应解密失败")?,
    )
    .map_err(|_| "响应字符无效".into())
}
fn sign(p: &BTreeMap<String, String>, protected: bool, login: bool) -> String {
    let c = cfg();
    let body = p
        .iter()
        .filter(|(k, _)| {
            !protected
                || (*k != "mobileDeviceId" && (!login || (*k != "nick_name" && *k != "avatar_url")))
        })
        .map(|(k, v)| format!("{k}{v}"))
        .collect::<String>();
    if protected {
        md5(&format!("{}{body}", &c.salt_p))
    } else {
        md5(&format!("{body}{}", &c.salt_n))
    }
}
pub(crate) fn text<T: serde::Serialize + ?Sized>(v: &T, key: &str) -> String {
    let value = serde_json::to_value(v).unwrap_or(Value::Null);
    match &value[key] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
pub(crate) fn same_account(a: &Data, b: &Data) -> bool {
    a.account.uid == b.account.uid && a.account.token == b.account.token
}
pub(crate) fn snapshot(store: &Store) -> Result<Data, crate::error::ApiError> {
    store
        .data
        .lock()
        .map(|d| (*d).clone())
        .map_err(|_| "本地数据不可用".into())
}
fn client(login: bool) -> &'static reqwest::Client {
    static BUSINESS: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    static LOGIN: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let pool = if login { &LOGIN } else { &BUSINESS };
    pool.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("fixed HTTP client configuration")
    })
}
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
fn append_response(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), crate::error::ApiError> {
    if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
        return Err(crate::error::ApiError::invalid("服务响应过大"));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
fn checked(v: Value) -> Result<Value, crate::error::ApiError> {
    if v["status"].as_i64() == Some(1) || v["status"].as_str() == Some("1") {
        Ok(v)
    } else {
        let status = text(&v, "status");
        let hint = if status == "101" || status == "102" {
            "，请重新登录"
        } else {
            ""
        };
        Err(crate::error::ApiError {
            kind: if status == "101" || status == "102" {
                crate::error::ErrorKind::AuthExpired
            } else {
                crate::error::ErrorKind::Business
            },
            message: format!("服务端拒绝请求：{}（{}）{}", text(&v, "info"), status, hint),
            code: Some(status),
        })
    }
}
fn encode_form(
    mut p: BTreeMap<String, String>,
    endpoint: &str,
    n: u32,
) -> Result<BTreeMap<String, String>, crate::error::ApiError> {
    let c = cfg();
    let login = endpoint == "Login/quickLoginV339";
    let encrypted = login || endpoint == "Run2/beforeRunV260" || endpoint == "report/getOssSts";
    let protected = encrypted
        || matches!(
            endpoint,
            "Run/stopRunV278" | "Run2/gyroscope" | "Run/setRunLocationRecord"
        );
    if login {
        p.remove("token");
        let pair = &c.t15[n as usize % 15];
        let lp = encrypt(
            &format!("{}{}", c.umid.clone(), md5(&n.to_string())),
            &pair[0],
            &pair[1],
        )?;
        p.insert("lp47".into(), lp + "\n");
    }
    let signature = sign(&p, protected, login);
    p.insert("sign".into(), signature);
    let form = if encrypted || endpoint == "Run/stopFreeRunV220" {
        let body = serde_json::to_string(&p).map_err(|_| "参数编码失败")?;
        BTreeMap::from([(
            "key".to_string(),
            encrypt(
                &body,
                if endpoint == "Run/stopFreeRunV220" {
                    &c.key_trk
                } else {
                    &c.key_ng
                },
                if endpoint == "Run/stopFreeRunV220" {
                    &c.iv_trk
                } else {
                    &c.iv_ng
                },
            )?,
        )])
    } else {
        p
    };
    Ok(form)
}
#[cfg(test)]
mod run_protocol_tests {
    use super::*;
    #[test]
    fn submitted_exe_request_vectors() {
        let vectors: Value = serde_json::from_str(include_str!("run-vectors.json")).unwrap();
        for item in vectors["fixtures"].as_array().unwrap() {
            let p: BTreeMap<String, String> =
                serde_json::from_value(item["params"].clone()).unwrap();
            let form = encode_form(p, item["endpoint"].as_str().unwrap(), 234567).unwrap();
            assert_eq!(
                serde_json::to_value(form).unwrap(),
                item["expected"],
                "{}",
                item["endpoint"]
            );
        }
    }
}
pub(crate) async fn call(
    d: &Data,
    endpoint: &str,
    extra: BTreeMap<String, String>,
    nonce: Option<u32>,
) -> Result<Value, crate::error::ApiError> {
    call_with_clock(d, endpoint, extra, nonce, 0).await
}
pub(crate) async fn call_with_clock(
    d: &Data,
    endpoint: &str,
    extra: BTreeMap<String, String>,
    nonce: Option<u32>,
    clock: i64,
) -> Result<Value, crate::error::ApiError> {
    let c = cfg();
    let n = nonce.unwrap_or_else(|| 100000 + (uuid::Uuid::new_v4().as_u128() % 900000) as u32);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间无效")?
        .as_secs() as i64
        + clock;
    let a = &d.account;
    let dev = crate::store::device_view(d);
    let mut p: BTreeMap<String, String> = [
        ("version", c.version.clone()),
        ("version_name", c.version_name.clone()),
        ("mobileModel", text(&dev, "model")),
        ("mobileDeviceId", d.device_id.clone()),
        ("mobileOsVersion", text(&dev, "osVersion")),
        ("ostype", "1".into()),
        ("school_id", d.school_id.clone()),
        ("uid", {
            let u = a.uid.clone();
            if u.is_empty() {
                "1".into()
            } else {
                u
            }
        }),
        ("token", a.token.clone()),
        ("timestamp", now.to_string()),
        ("nonce", n.to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    let student = a.student_num.clone().unwrap_or_default();
    if !student.is_empty() {
        p.insert("student_num".into(), student);
    }
    p.extend(extra);
    let form = encode_form(p, endpoint, n)?;
    let client = client(endpoint == "Login/quickLoginV339");
    let mut response = client
        .post(format!("https://api2.lptiyu.com/v3/api.php/{endpoint}"))
        .header("User-Agent", "okhttp/3.12")
        .form(&form)
        .send()
        .await
        .map_err(|e| {
            crate::error::ApiError::network(if e.is_timeout() {
                "请求超时，请检查网络"
            } else {
                "无法连接乐跑服务，请检查网络"
            })
        })?;
    if !response.status().is_success() {
        return Err(crate::error::ApiError::network(format!(
            "乐跑服务 HTTP {}",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_LIMIT as u64)
    {
        return Err(crate::error::ApiError::invalid("服务响应过大"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| crate::error::ApiError::network("响应读取失败"))?
    {
        append_response(&mut bytes, &chunk)?;
    }
    let mut v: Value = serde_json::from_slice(&bytes).map_err(|_| "服务返回的不是有效 JSON")?;
    if v["is_encrypt"].as_i64() == Some(1) || v["is_encrypt"].as_str() == Some("1") {
        let raw = v["data"].as_str().ok_or("加密响应格式无效")?;
        let dec =
            decrypt(raw, &c.key_trk, &c.iv_trk).or_else(|_| decrypt(raw, &c.key_ng, &c.iv_ng))?;
        v["data"] = serde_json::from_str(&dec).map_err(|_| "解密响应不是 JSON")?;
    }
    checked(v)
}
pub(crate) async fn finish(
    app: tauri::AppHandle,
    openid: String,
    token: String,
    login_type: &str,
    attempt_id: &str,
) -> Result<(), crate::error::ApiError> {
    let store = app.state::<Store>();
    let platform = if login_type == "3" { "wechat" } else { "qq" };
    app.state::<crate::login::Attempts>()
        .check(attempt_id, platform, &store)?;
    let mut d = snapshot(&store)?;
    crate::store::apply_pending(&mut d);
    let c = cfg();
    let n = 100000 + (uuid::Uuid::new_v4().as_u128() % 900000) as u32;
    let pair = &c.z8[n as usize % 10];
    let inner = |s: &str| encrypt(s, &pair[0], &pair[1]).map(|s| s + "\n");
    let extra = BTreeMap::from([
        ("openid".into(), inner(&openid)?),
        ("accesstoken".into(), inner(&token)?),
        ("type".into(), login_type.into()),
        ("uid".into(), "1".into()),
        ("school_id".into(), "0".into()),
        ("nick_name".into(), "".into()),
        ("avatar_url".into(), "".into()),
    ]);
    let reply = call(&d, "Login/quickLoginV339", extra, Some(n)).await?;
    let a = &reply["data"];
    let uid = text(a, "uid");
    let token = text(a, "access_token");
    if uid.is_empty() || token.is_empty() {
        return Err("登录响应缺少有效账号信息".into());
    }
    d.school_id = text(a, "school_id");
    d.account = serde_json::from_value(json!({"uid":uid,"token":token,"studentNum":text(a,"student_num"),"loginType":if login_type=="3"{"wechat"}else{"qq"}})).unwrap();
    let profile = call(&d, "User/User", BTreeMap::new(), None).await?;
    let user = &profile["data"];
    let name = text(user, "real_name");
    let name = if name.is_empty() {
        let real = text(user, "student_name");
        if real.is_empty() {
            text(user, "name")
        } else {
            real
        }
    } else {
        name
    };
    d.account.real_name = Some(name);
    d.account.nickname = Some(text(user, "nick_name"));
    d.account.student_num = Some(text(user, "student_num"));
    let sid = text(user, "school_id");
    if !sid.is_empty() {
        d.school_id = sid
    }
    if d.school_id.is_empty() || d.school_id == "0" {
        let schools: std::collections::BTreeMap<String, String> =
            serde_json::from_str(crate::SCHOOLS).map_err(|_| "学校表无效")?;
        if let Some((id, _)) = schools
            .iter()
            .find(|(_, name)| **name == text(user, "school_name"))
        {
            d.school_id = id.clone();
        }
    }
    d.school_name = text(user, "school_name");
    app.state::<crate::login::Attempts>().commit(attempt_id,platform,&store,&app.state::<crate::running::Runs>(),|v|{crate::accounts::save_active(v);if let Some(existing)=v.profiles.get(&uid).cloned(){if existing.school_id==d.school_id{v.route=existing.route;v.zone=existing.zone;}else{v.route.clear();v.zone=Default::default();}v.run_config=existing.run_config;d.account.label=existing.account.label.clone();}else{v.route.clear();v.zone=Default::default();v.run_config=Default::default();}let entry=json!({"id":d.device_id,"model":crate::store::device_view(&d)["model"],"osVersion":crate::store::device_view(&d)["osVersion"],"uid":uid,"time":SystemTime::now().duration_since(UNIX_EPOCH).map(|t|t.as_millis() as u64).unwrap_or(0)});v.device_history.retain(|h|h["id"]!=entry["id"]);v.device_history.insert(0,entry);v.device_history.truncate(6);v.device_id=d.device_id;v.device=d.device;v.pending_device=Default::default();v.account=d.account;v.school_id=d.school_id;v.school_name=d.school_name;Ok(())})?;
    Ok(())
}
#[tauri::command]
pub async fn qq_login_start(
    attempt_id: String,
    app: tauri::AppHandle,
) -> Result<(), crate::error::ApiError> {
    let store = app.state::<Store>();
    app.state::<crate::login::Attempts>()
        .check(&attempt_id, "qq", &store)?;
    crate::running::ensure_idle(&app.state::<crate::running::Runs>())?;
    let label = format!("qq-login-{attempt_id}");
    if app.get_webview_window(&label).is_some() {
        return Err("QQ 授权窗口已打开".into());
    }
    let url: url::Url = cfg().qq_url.parse().map_err(|_| "授权地址无效")?;
    let handle = app.clone();
    let ident = attempt_id.clone();
    let window_label = label.clone();
    let once = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .data_directory(
            crate::data_root::root()
                .map_err(|_| "数据目录不可用")?
                .join("webview/qq-login"),
        )
        .title("不道乐跑 · QQ 扫码授权")
        .inner_size(560., 680.)
        .on_navigation(move |url| {
            if handle
                .state::<crate::login::Attempts>()
                .check(&ident, "qq", &handle.state::<Store>())
                .is_err()
            {
                return false;
            }
            match crate::login::qq_credentials(url) {
                Ok(Some((id, token))) => {
                    if !once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        let h = handle.clone();
                        let ident = ident.clone();
                        let label = window_label.clone();
                        tauri::async_runtime::spawn(async move {
                            let result = finish(h.clone(), id, token, "2", &ident).await;
                            let payload = match result {
                                Ok(()) => json!({"ok":true,"attemptId":ident}),
                                Err(e) => json!({"ok":false,"attemptId":ident,"error":e.message}),
                            };
                            let _ = h.emit_to("main", "login-result", payload);
                            if let Some(w) = h.get_webview_window(&label) {
                                let _ = w.close();
                            }
                        });
                    }
                    false
                }
                Err(_) => false,
                Ok(None) => {
                    url.scheme() == "https"
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.port().is_none()
                        && url
                            .host_str()
                            .is_some_and(|h| h == "qq.com" || h.ends_with(".qq.com"))
                }
            }
        })
        .build()
        .map_err(|_| "无法打开 QQ 授权窗口")?;
    let h = app.clone();
    let closed_id = attempt_id.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            h.state::<crate::login::Attempts>()
                .cancel_pending(&closed_id);
        }
    });
    if app
        .state::<crate::login::Attempts>()
        .check(&attempt_id, "qq", &store)
        .is_err()
    {
        let _ = window.close();
        return Err(crate::error::ApiError::cancelled());
    }
    Ok(())
}

async fn network_read_inner(
    kind: String,
    params: Value,
    store: tauri::State<'_, Store>,
    d: Data,
) -> Result<Value, crate::error::ApiError> {
    if d.account.token.clone().is_empty() {
        return Err("请先登录账号".into());
    }
    let (endpoint, extra) = match kind.as_str() {
        "profile" => ("User/User", BTreeMap::new()),
        "rank" => {
            let category = text(&params, "category");
            let typ = text(&params, "type");
            let period = text(&params, "period");
            let page = text(&params, "page");
            if !["1", "2"].contains(&category.as_str())
                || !(if category == "1" {
                    ["1", "2", "3"].contains(&typ.as_str())
                } else {
                    ["2", "3", "4"].contains(&typ.as_str())
                })
                || page
                    .parse::<u32>()
                    .ok()
                    .filter(|n| *n > 0 && *n <= 100)
                    .is_none()
            {
                return Err("排行榜参数无效".into());
            }
            let mut p = BTreeMap::from([
                ("category".into(), category.clone()),
                ("type".into(), typ),
                ("page".into(), page),
            ]);
            if category == "2" {
                if !["1", "2", "3"].contains(&period.as_str()) {
                    return Err("排行周期无效".into());
                }
                p.insert("period".into(), period);
            }
            ("Run/getTotalRank", p)
        }
        "zone_points" => (
            "Run/GetZonePoints",
            BTreeMap::from([("zone_id".into(), text(&params, "zoneId"))]),
        ),
        "zone_select" => (
            "Run/setRunZone",
            BTreeMap::from([("run_zone_id".into(), text(&params, "zoneId"))]),
        ),
        "rules" | "term_requirements" => (
            "Run2/beforeRunV260",
            BTreeMap::from([("type".into(), "1".into())]),
        ),
        "records" => (
            "Run2/allRecordList",
            BTreeMap::from([
                ("year".into(), text(&params, "year")),
                ("page".into(), text(&params, "page")),
            ]),
        ),
        "scores" => ("RunStat/getAllScore", BTreeMap::new()),
        "term_score" => (
            "RunStat/getMyTermScore",
            BTreeMap::from([("term_id".into(), text(&params, "termId"))]),
        ),
        "record_detail" => (
            "Run/recordDetailV270",
            BTreeMap::from([("record_id".into(), text(&params, "id"))]),
        ),
        _ => return Err("未开放的联网操作".into()),
    };
    let reply = call(&d, endpoint, extra, None).await?;
    let latest = snapshot(&store)?;
    if !same_account(&latest, &d) || latest.school_id != d.school_id {
        return Err("账号或学校已变化，已丢弃旧请求结果".into());
    }
    if kind == "term_requirements" {
        return Ok(
            json!({"status":1,"data":{"term_id":reply["data"]["term_id"],"term_num":reply["data"]["term_num"]}}),
        );
    }
    if kind == "profile" {
        let u = &reply["data"];
        store.update(|v| {
            if same_account(v, &d) {
                v.account.real_name = Some(text(u, "name"));
                v.account.student_num = Some(text(u, "student_num"));
                let school = text(u, "school_name");
                if !school.is_empty() {
                    v.school_name = school.clone();
                    if let Ok(schools) =
                        serde_json::from_str::<BTreeMap<String, String>>(crate::SCHOOLS)
                    {
                        if let Some((id, _)) = schools.iter().find(|(_, name)| **name == school) {
                            v.school_id = id.clone();
                        }
                    }
                }
            }
        })?;
    }
    if kind == "rules" {
        let data = &reply["data"];
        let fence = parse_fence(&data["run_zone_latlng"]);
        let center = if fence.is_empty() {
            Value::Null
        } else {
            json!([
                fence.iter().map(|p| p[0]).sum::<f64>() / fence.len() as f64,
                fence.iter().map(|p| p[1]).sum::<f64>() / fence.len() as f64
            ])
        };
        let zone = serde_json::from_value(json!({"id":({let id=text(data,"game_id");if id.is_empty(){text(data,"run_zone_id")}else{id}}),"name":text(data,"run_zone_name"),"fence":fence,"center":center})).unwrap();
        store.update(|v| {
            if same_account(v, &d) && v.school_id == d.school_id && v.zone.id == d.zone.id {
                v.zone = zone
            }
        })?;
    }
    Ok(reply)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_latest_exe_vectors() {
        let v: Value = serde_json::from_str(include_str!("protocol-vectors.json")).unwrap();
        let p = BTreeMap::from([
            ("a".into(), "1".into()),
            ("b".into(), "测试".into()),
            ("mobileDeviceId".into(), "DEVICE".into()),
        ]);
        assert_eq!(sign(&p, false, false), v["normal"]);
        assert_eq!(sign(&p, true, false), v["protected"]);
        let c = cfg();
        let encrypted = encrypt("协议测试", &c.key_ng, &c.iv_ng).unwrap();
        assert_eq!(encrypted, v["aes"]);
        assert_eq!(
            decrypt(&encrypted, &c.key_ng, &c.iv_ng).unwrap(),
            "协议测试"
        );
    }
}

pub(crate) fn parse_fence(v: &Value) -> Vec<[f64; 2]> {
    let mut out = vec![];
    if let Some(arr) = v.as_array() {
        for item in arr {
            if let Some(s) = item.as_str() {
                for pair in s.split([';', '|']) {
                    let coords: Vec<f64> = pair
                        .split(',')
                        .filter_map(|s| s.trim().parse().ok())
                        .collect();
                    if coords.len() == 2 {
                        let (a, b) = (coords[0], coords[1]);
                        let p = if a.abs() > 54. { [b, a] } else { [a, b] };
                        if p[0].is_finite()
                            && p[1].is_finite()
                            && p[0].abs() <= 90.
                            && p[1].abs() <= 180.
                        {
                            out.push(p)
                        }
                    }
                }
            }
        }
    }
    out
}
#[cfg(test)]
mod live_checks {
    use super::*;
    #[test]
    #[ignore]
    fn readonly_shapes() {
        let path = crate::data_root::root().unwrap().join("settings.dpapi");
        let store = Store::open(path).unwrap();
        let d = snapshot(&store).unwrap();
        assert!(!d.account.token.clone().is_empty(), "需要用户已登录");
        tauri::async_runtime::block_on(async {
            for endpoint in ["User/User", "Run2/beforeRunV260", "RunStat/getAllScore"] {
                let extra = if endpoint.contains("beforeRun") {
                    BTreeMap::from([("type".into(), "1".into())])
                } else {
                    BTreeMap::new()
                };
                let result = call(&d, endpoint, extra, None).await.unwrap();
                println!(
                    "{} data fields {:?}",
                    endpoint,
                    result["data"]
                        .as_object()
                        .map(|o| o.keys().collect::<Vec<_>>())
                );
                if endpoint.contains("Score") {
                    if let Some(term) = result["data"]["term_list"]
                        .as_array()
                        .and_then(|a| a.first())
                    {
                        for key in ["term_info", "score_info"] {
                            println!(
                                "{} fields {:?}",
                                key,
                                term[key].as_object().map(|o| o.keys().collect::<Vec<_>>())
                            );
                        }
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod live_rank {
    use super::*;
    #[test]
    #[ignore]
    fn current_account_rank_readonly() {
        let path = crate::data_root::root().unwrap().join("settings.dpapi");
        let s = Store::open(path).unwrap();
        let d = snapshot(&s).unwrap();
        tauri::async_runtime::block_on(async {
            for (category, typ, period) in [
                ("1", "1", None),
                ("1", "2", None),
                ("1", "3", None),
                ("2", "4", Some("1")),
            ] {
                let mut p = BTreeMap::from([
                    ("category".into(), category.into()),
                    ("type".into(), typ.into()),
                    ("page".into(), "1".into()),
                ]);
                if let Some(period) = period {
                    p.insert("period".into(), period.into());
                }
                let r = call(&d, "Run/getTotalRank", p, None).await.unwrap();
                assert!(r["data"]["rank_list"].is_array());
                println!("排行榜类别={} 范围={} 只读验证成功", category, typ);
            }
        });
    }
}

#[tauri::command]
pub async fn network_read(
    kind: String,
    params: Value,
    store: tauri::State<'_, Store>,
) -> Result<Value, crate::session::ApiError> {
    let expected = snapshot(&store)?;
    let r = network_read_inner(kind, params, store.clone(), expected.clone()).await;
    if let Err(e) = &r {
        if crate::session::auth_error(e) {
            crate::session::invalidate(&store, &expected)?
        }
    }
    r
}

#[cfg(test)]
mod live_term_schema {
    use super::*;
    #[test]
    #[ignore]
    fn term_count_fields_readonly() {
        let path = crate::data_root::root().unwrap().join("settings.dpapi");
        let s = Store::open(path).unwrap();
        let d = snapshot(&s).unwrap();
        tauri::async_runtime::block_on(async {
            let all = call(&d, "RunStat/getAllScore", BTreeMap::new(), None)
                .await
                .unwrap();
            let terms = all["data"]["term_list"].as_array().unwrap();
            let t = terms
                .iter()
                .find(|t| text(&t["term_info"], "is_this_term") == "1")
                .unwrap_or(&terms[0]);
            let id = text(&t["term_info"], "term_id");
            let score = call(
                &d,
                "RunStat/getMyTermScore",
                BTreeMap::from([("term_id".into(), id)]),
                None,
            )
            .await
            .unwrap();
            fn shape(v: &Value, depth: usize) -> Value {
                if depth > 4 {
                    return json!("nested");
                };
                match v {
                    Value::Object(o) => Value::Object(
                        o.iter()
                            .map(|(k, v)| (k.clone(), shape(v, depth + 1)))
                            .collect(),
                    ),
                    Value::Array(a) => json!(a.first().map(|v| shape(v, depth + 1))),
                    _ => json!("scalar"),
                }
            }
            println!("term score schema {}", shape(&score["data"], 0));
            let rules = call(
                &d,
                "Run2/beforeRunV260",
                BTreeMap::from([("type".into(), "1".into())]),
                None,
            )
            .await
            .unwrap();
            for k in [
                "term_num",
                "run_num",
                "total_num",
                "max_num",
                "total_log_num",
                "run_score",
                "term_id",
            ] {
                let v = &rules["data"][k];
                if v.as_f64().is_some() || v.as_str().is_some_and(|s| s.parse::<f64>().is_ok()) {
                    println!("rule {}={}", k, v)
                }
            }
        });
    }
}

#[cfg(test)]
mod response_guard_tests {
    use super::*;
    #[test]
    fn response_stream_stops_before_extending_over_limit() {
        let mut bytes = vec![0; RESPONSE_LIMIT - 1];
        append_response(&mut bytes, &[1]).unwrap();
        assert!(append_response(&mut bytes, &[2]).is_err());
        assert_eq!(bytes.len(), RESPONSE_LIMIT);
    }
    #[test]
    fn login_and_business_pools_are_distinct_and_reused() {
        assert!(std::ptr::eq(client(false), client(false)));
        assert!(std::ptr::eq(client(true), client(true)));
        assert!(!std::ptr::eq(client(false), client(true)));
    }
    #[test]
    fn same_uid_with_new_token_is_a_different_request_owner() {
        let mut a = Data::default();
        a.account = serde_json::from_value(json!({"uid":"a","token":"first"})).unwrap();
        let mut b = a.clone();
        assert!(same_account(&a, &b));
        b.account.token = "second".to_string();
        assert!(!same_account(&a, &b));
    }
}
