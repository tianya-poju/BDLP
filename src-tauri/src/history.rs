use crate::{
    network::{call, cfg, decrypt, snapshot, text},
    store::Store,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;
use std::collections::BTreeMap;
fn download_url(file: &str) -> Result<url::Url, crate::error::ApiError> {
    let url = if file.starts_with("https://") {
        url::Url::parse(file)
    } else if file.contains("://") || file.starts_with("//") {
        return Err("轨迹下载地址不受支持".into());
    } else {
        url::Url::parse(&format!(
            "https://lptiyu-data.oss-cn-hangzhou.aliyuncs.com/{}",
            file.trim_start_matches('/')
        ))
    }
    .map_err(|_| "轨迹地址无效")?;
    if url.scheme() != "https"
        || !url
            .host_str()
            .is_some_and(|s| s == "data.lptiyu.com" || s.ends_with(".aliyuncs.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("轨迹下载域名不受支持".into());
    }
    Ok(url)
}
fn decode(raw: &str) -> Result<Vec<Value>, crate::error::ApiError> {
    let c = cfg();
    let plain = decrypt(
        raw,
        c["KEY_TRK"].as_str().unwrap(),
        c["IV_TRK"].as_str().unwrap(),
    )?;
    let values: Vec<Value> = serde_json::from_str(&plain).map_err(|_| "轨迹文件格式无效")?;
    if values.len() > 100000 {
        return Err("轨迹点过多".into());
    }
    let num = |v: &Value| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    };
    let mut out = vec![];
    for p in values {
        let lat = num(&p["a"]).ok_or("轨迹纬度无效")?;
        let lng = num(&p["o"]).ok_or("轨迹经度无效")?;
        if lat == 0. && lng == 0. {
            continue;
        }
        if !lat.is_finite() || !lng.is_finite() || lat.abs() > 90. || lng.abs() > 180. {
            return Err("轨迹坐标无效".into());
        }
        out.push(json!({"lat":lat,"lng":lng,"speed":num(&p["s"])}));
    }
    if out.len() < 2 {
        return Err("轨迹有效点不足".into());
    }
    Ok(out)
}
async fn read_limited(response: reqwest::Response) -> Result<String, crate::error::ApiError> {
    if !response.status().is_success() {
        return Err(format!("轨迹下载 HTTP {}", response.status().as_u16()).into());
    }
    let mut r = response;
    let mut b = vec![];
    while let Some(chunk) = r.chunk().await.map_err(|_| "轨迹下载中断")? {
        if b.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("轨迹文件过大".into());
        }
        b.extend_from_slice(&chunk)
    }
    String::from_utf8(b).map_err(|_| "轨迹文件编码无效".into())
}
async fn load(
    d: &crate::store::Data,
    record_id: &str,
) -> Result<Vec<Value>, crate::error::ApiError> {
    let result = call(
        d,
        "Run/recordDetailV270",
        BTreeMap::from([("record_id".into(), record_id.into())]),
        None,
    )
    .await?;
    let file = text(&result["data"], "file");
    if file.is_empty() || file == "1" {
        return Err("该记录没有轨迹文件".into());
    }
    let url = download_url(&file).map_err(|e| {
        #[cfg(test)]
        if let Ok(u) = url::Url::parse(&file) {
            println!(
                "轨迹服务类型：{}；主机：{}",
                u.scheme(),
                u.host_str().unwrap_or("无")
            );
        }
        e
    })?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "网络初始化失败")?;
    if let Ok(r) = client.get(url.clone()).send().await {
        if r.status().is_success() {
            return decode(&read_limited(r).await?);
        }
    }
    let sts = call(d, "report/getOssSts", BTreeMap::new(), None).await?;
    let data = &sts["data"];
    let mut bucket = text(data, "bucket");
    if bucket.is_empty() {
        bucket = "lptiyu-data".into()
    }
    if !bucket
        .bytes()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err("存储桶格式无效".into());
    }
    let key = url.path().trim_start_matches('/');
    let token = text(data, "SecurityToken");
    let ak = text(data, "AccessKeyId");
    let secret = text(data, "AccessKeySecret");
    if token.is_empty() || ak.is_empty() || secret.is_empty() {
        return Err("服务未返回有效轨迹下载凭据".into());
    }
    let date = httpdate::fmt_http_date(std::time::SystemTime::now());
    let canonical = format!("GET\n\n\n{date}\nx-oss-security-token:{token}\n/{bucket}/{key}");
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).map_err(|_| "下载签名失败")?;
    mac.update(canonical.as_bytes());
    let sig = STANDARD.encode(mac.finalize().into_bytes());
    let download = format!("https://{bucket}.oss-cn-hangzhou.aliyuncs.com/{key}");
    let response = client
        .get(download)
        .header("Date", date)
        .header("x-oss-security-token", token)
        .header("Authorization", format!("OSS {ak}:{sig}"))
        .send()
        .await
        .map_err(|_| "轨迹下载失败")?;
    decode(&read_limited(response).await?)
}
#[tauri::command]
pub async fn record_track(
    id: String,
    store: tauri::State<'_, Store>,
) -> Result<Value, crate::error::ApiError> {
    let d = snapshot(&store)?;
    if d.account.token.clone().is_empty() {
        return Err("请先登录".into());
    }
    let points = load(&d, &id).await?;
    Ok(json!({"track":points}))
}
#[tauri::command]
pub async fn record_import(
    id: String,
    store: tauri::State<'_, Store>,
) -> Result<Value, crate::error::ApiError> {
    let d = snapshot(&store)?;
    if d.account.token.clone().is_empty() {
        return Err("请先登录".into());
    }
    let points = load(&d, &id).await?;
    let step = (points.len() / 300).max(1);
    let mut route: Vec<[f64; 2]> = points
        .iter()
        .step_by(step)
        .map(|p| [p["lat"].as_f64().unwrap(), p["lng"].as_f64().unwrap()])
        .collect();
    let last = points.last().unwrap();
    let last = [last["lat"].as_f64().unwrap(), last["lng"].as_f64().unwrap()];
    if route.last() != Some(&last) {
        route.push(last)
    }
    let count = route.len();
    store.try_update(|v| {
        if v.account.uid != d.account.uid || v.school_id != d.school_id || v.zone.id != d.zone.id {
            return Err("账号、学校或跑区已切换，未导入路线".into());
        }
        v.route = route;
        Ok(())
    })?;
    Ok(json!({"status":1,"points":count,"trackPoints":points.len()}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls_are_restricted() {
        assert!(download_url("a/b.txt").is_ok());
        for u in [
            "http://a.aliyuncs.com/a",
            "https://evil.test/a",
            "https://user@a.aliyuncs.com/a",
            "https://a.aliyuncs.com:123/a",
            "//localhost/a",
        ] {
            assert!(download_url(u).is_err())
        }
    }
    #[test]
    fn invalid_track_rejected() {
        assert!(decode("bad-data").is_err());
    }
}
#[cfg(test)]
mod live_history {
    use super::*;
    #[test]
    #[ignore]
    fn existing_record_readonly() {
        let path = crate::data_root::root().unwrap().join("settings.dpapi");
        let store = Store::open(path).unwrap();
        let d = snapshot(&store).unwrap();
        tauri::async_runtime::block_on(async {
            let reply = call(
                &d,
                "Run2/allRecordList",
                BTreeMap::from([("year".into(), "2026".into()), ("page".into(), "1".into())]),
                None,
            )
            .await
            .unwrap();
            let list = reply["data"]["list"].as_array().expect("记录列表格式无效");
            let Some(record) = list.first() else {
                println!("当前年份没有记录，未验证真实轨迹下载");
                return;
            };
            let id = record
                .get("record_id")
                .or_else(|| record.get("id"))
                .unwrap();
            let id = id
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| id.to_string());
            let points = load(&d, &id).await.unwrap();
            assert!(points.len() >= 2);
            println!("真实历史轨迹下载解密成功；未保存路线、未提交跑步");
        });
    }
}
