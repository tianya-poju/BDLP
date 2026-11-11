use serde::Serialize;
use std::sync::Mutex;
#[cfg(not(target_os = "android"))]
const API: &str = "https://api.github.com/repos/tianya-poju/BDLP/releases/latest";
#[cfg(not(target_os = "android"))]
const PAGE: &str = "https://github.com/tianya-poju/BDLP/releases/latest";
#[cfg(target_os = "android")]
const ANDROID_API: &str = "https://api.github.com/repos/tianya-poju/BDLP/releases?per_page=20";
#[cfg(any(target_os = "android", test))]
const RELEASES_PAGE: &str = "https://github.com/tianya-poju/BDLP/releases";
const LIMIT: usize = 256 * 1024;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    current_version: String,
    latest_version: Option<String>,
    status: String,
    release_url: String,
}
impl Release {
    fn empty(current: &str, page: &str) -> Self {
        Self {
            current_version: current.into(),
            latest_version: None,
            status: "unpublished".into(),
            release_url: page.into(),
        }
    }

    fn compare(
        current: &str,
        latest: semver::Version,
        release_url: String,
    ) -> Result<Self, crate::error::ApiError> {
        let local = semver::Version::parse(current).map_err(|_| "本机版本信息异常")?;
        Ok(Self {
            current_version: current.into(),
            latest_version: Some(latest.to_string()),
            status: if latest.cmp_precedence(&local).is_gt() {
                "available"
            } else {
                "current"
            }
            .into(),
            release_url,
        })
    }
}
#[derive(Default)]
pub struct Checks {
    gate: tokio::sync::Mutex<()>,
    result: Mutex<(u64, Option<Result<Release, crate::error::ApiError>>)>,
    #[cfg(target_os = "android")]
    release_url: Mutex<Option<String>>,
}
impl Checks {
    async fn coalesce<F, Fut>(&self, fetch: F) -> Result<Release, crate::error::ApiError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Release, crate::error::ApiError>>,
    {
        let generation = self.result.lock().map_err(|_| "更新检查状态不可用")?.0;
        let _gate = self.gate.lock().await;
        {
            let last = self.result.lock().map_err(|_| "更新检查状态不可用")?;
            if generation != last.0 {
                return last
                    .1
                    .clone()
                    .ok_or_else(|| "更新检查状态不可用".to_string())?;
            }
        }
        let result = fetch().await;
        let mut last = self.result.lock().map_err(|_| "更新检查状态不可用")?;
        *last = (last.0.wrapping_add(1), Some(result.clone()));
        result
    }
}
#[cfg(not(target_os = "android"))]
fn parse(bytes: &[u8], current: &str) -> Result<Release, crate::error::ApiError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "GitHub 返回格式异常，请稍后重试")?;
    if value["draft"].as_bool().is_none() || value["prerelease"].as_bool().is_none() {
        return Err("GitHub 返回格式异常，请稍后重试".into());
    }
    if value["draft"] == true || value["prerelease"] == true {
        return Ok(Release::empty(current, PAGE));
    }
    let tag = value["tag_name"].as_str().ok_or("GitHub 版本信息缺失")?;
    let version = semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .map_err(|_| "GitHub 版本号格式异常")?;
    if !version.pre.is_empty() {
        return Ok(Release::empty(current, PAGE));
    }
    Release::compare(current, version, PAGE.into())
}

#[cfg(any(target_os = "android", test))]
fn parse_android(bytes: &[u8], current: &str) -> Result<Release, crate::error::ApiError> {
    let entries: Vec<serde_json::Value> =
        serde_json::from_slice(bytes).map_err(|_| "GitHub 返回格式异常，请稍后重试")?;
    let latest = entries
        .iter()
        .take(20)
        .filter_map(|entry| {
            if entry["draft"].as_bool() != Some(false)
                || entry["prerelease"].as_bool() != Some(false)
            {
                return None;
            }
            let tag = entry["tag_name"].as_str()?;
            let version = semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()?;
            if !version.pre.is_empty() {
                return None;
            }
            let filename = format!("BDLP-{version}-android-arm64.apk");
            entry["assets"]
                .as_array()?
                .iter()
                .any(|asset| {
                    asset["name"].as_str() == Some(filename.as_str()) && asset["state"] == "uploaded"
                })
                .then_some((version, tag))
        })
        .max_by(|(left, _), (right, _)| left.cmp_precedence(right));
    match latest {
        Some((version, tag)) => {
            Release::compare(current, version, format!("{RELEASES_PAGE}/tag/{tag}"))
        }
        None => Ok(Release::empty(current, RELEASES_PAGE)),
    }
}
fn response_status(status: u16) -> Result<bool, crate::error::ApiError> {
    match status {
        200 => Ok(true),
        404 => Ok(false),
        403 | 429 => Err("GitHub 请求受限，请稍后重试".into()),
        401 => Err("无法访问 GitHub 更新信息".into()),
        _ => Err("GitHub 更新服务暂不可用，请稍后重试".into()),
    }
}
fn network_error(error: reqwest::Error) -> crate::error::ApiError {
    crate::error::ApiError::network(if error.is_timeout() {
        "检查更新超时，请稍后重试"
    } else {
        "无法连接 GitHub，请检查网络后重试"
    })
}
fn append_limited(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), crate::error::ApiError> {
    if bytes.len() + chunk.len() > LIMIT {
        return Err("GitHub 更新响应过大，已停止读取".into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
async fn fetch_bytes(api: &str) -> Result<Option<Vec<u8>>, crate::error::ApiError> {
    // Dedicated anonymous client: never reuse the account client's cookies or headers.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("BDLP/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "更新检查初始化失败")?;
    let mut response = client
        .get(api)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(network_error)?;
    if !response_status(response.status().as_u16())? {
        return Ok(None);
    }
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err("GitHub 更新响应过大，已停止读取".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        append_limited(&mut bytes, &chunk)?;
    }
    Ok(Some(bytes))
}

#[cfg(not(target_os = "android"))]
async fn fetch(current: &str) -> Result<Release, crate::error::ApiError> {
    match fetch_bytes(API).await? {
        Some(bytes) => parse(&bytes, current),
        None => Ok(Release::empty(current, PAGE)),
    }
}

#[cfg(target_os = "android")]
async fn fetch(current: &str) -> Result<Release, crate::error::ApiError> {
    match fetch_bytes(ANDROID_API).await? {
        Some(bytes) => parse_android(&bytes, current),
        None => Ok(Release::empty(current, RELEASES_PAGE)),
    }
}

#[tauri::command]
pub async fn update_check(
    checks: tauri::State<'_, Checks>,
    app: tauri::AppHandle,
) -> Result<Release, crate::error::ApiError> {
    checks
        .coalesce(|| async {
            let current = app.package_info().version.to_string();
            let release = tokio::time::timeout(std::time::Duration::from_secs(10), fetch(&current))
                .await
                .map_err(|_| crate::error::ApiError::network("检查更新超时，请稍后重试"))??;
            #[cfg(target_os = "android")]
            {
                *checks.release_url.lock().map_err(|_| "更新检查状态不可用")? =
                    Some(release.release_url.clone());
            }
            Ok(release)
        })
        .await
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn update_open(checks: tauri::State<'_, Checks>) -> Result<(), crate::error::ApiError> {
    let url = checks
        .release_url
        .lock()
        .map_err(|_| "更新检查状态不可用")?
        .clone()
        .unwrap_or_else(|| RELEASES_PAGE.into());
    crate::android::open_update_page(&url).await
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn update_open() -> Result<(), crate::error::ApiError> {
    use std::os::windows::ffi::OsStrExt;
    let wide = |s: &str| {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            h: *mut std::ffi::c_void,
            op: *const u16,
            file: *const u16,
            args: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            wide("open").as_ptr(),
            wide(PAGE).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err("无法打开系统浏览器，请手动访问仓库发行页".into())
    } else {
        Ok(())
    }
}
#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    fn release(tag: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"tag_name":tag,"draft":false,"prerelease":false,"html_url":"https://untrusted.invalid"})).unwrap()
    }
    #[test]
    fn semantic_versions_not_strings() {
        assert_eq!(
            parse(&release("v1.10.0"), "1.2.0").unwrap().status,
            "available"
        );
        for tag in ["v1.0.0", "1.0.0", "v0.9.9", "v1.0.0+build.2"] {
            let r = parse(&release(tag), "1.0.0").unwrap();
            assert_eq!(r.status, "current");
            assert_eq!(r.release_url, PAGE);
        }
        assert!(parse(&release("oops"), "1.0.0").is_err());
    }
    #[test]
    fn prerelease_draft_and_malformed_never_claim_latest() {
        for b in [
            br#"{"draft":true,"prerelease":false}"#.as_slice(),
            br#"{"draft":false,"prerelease":true}"#,
            &release("v2.0.0-beta.1"),
        ] {
            assert_eq!(parse(b, "1.0.0").unwrap().status, "unpublished");
        }
        for b in [b"{}".as_slice(), b"invalid", b"[]"] {
            assert!(parse(b, "1.0.0").is_err());
        }
        assert_eq!(response_status(404).unwrap(), false);
        for n in [403, 429, 500] {
            assert!(response_status(n).is_err());
        }
    }
    #[test]
    fn android_selects_highest_formal_release_with_an_uploaded_arm64_apk() {
        let entries = serde_json::json!([
            {"tag_name":"v1.10.0","draft":false,"prerelease":false,"assets":[
                {"name":"BDLP-1.10.0-android-arm64.apk","state":"uploaded"}
            ],"html_url":"https://untrusted.invalid"},
            {"tag_name":"v2.0.0","draft":false,"prerelease":false,"assets":[
                {"name":"BDLP-2.0.0-windows-x64-setup.exe","state":"uploaded"}
            ]},
            {"tag_name":"v1.9.0","draft":false,"prerelease":false,"assets":[
                {"name":"BDLP-1.9.0-android-arm64.apk","state":"uploaded"}
            ]},
            {"tag_name":"v2.1.0","draft":false,"prerelease":true,"assets":[
                {"name":"BDLP-2.1.0-android-arm64.apk","state":"uploaded"}
            ]},
            {"tag_name":"v2.2.0","draft":true,"prerelease":false,"assets":[
                {"name":"BDLP-2.2.0-android-arm64.apk","state":"uploaded"}
            ]},
            {"tag_name":"v2.3.0","draft":false,"prerelease":false,"assets":[
                {"name":"BDLP-2.3.0-android-arm64.apk","state":"starter"}
            ]},
            {"tag_name":"v2.4.0-beta.1","draft":false,"prerelease":false,"assets":[
                {"name":"BDLP-2.4.0-beta.1-android-arm64.apk","state":"uploaded"}
            ]}
        ]);
        let bytes = serde_json::to_vec(&entries).unwrap();
        for (current, status) in [("1.1.2", "available"), ("1.10.0", "current")] {
            let result = parse_android(&bytes, current).unwrap();
            assert_eq!(result.status, status);
            assert_eq!(result.latest_version.as_deref(), Some("1.10.0"));
            assert_eq!(result.release_url, format!("{RELEASES_PAGE}/tag/v1.10.0"));
        }
        let windows_only = serde_json::to_vec(&vec![entries[1].clone(); 20]).unwrap();
        let result = parse_android(&windows_only, "1.1.2").unwrap();
        assert_eq!(result.status, "unpublished");
        assert_eq!(result.release_url, RELEASES_PAGE);
        assert!(parse_android(b"{}", "1.1.2").is_err());
    }

    #[test]
    fn concurrent_checks_share_success_or_failure_but_later_can_retry() {
        tauri::async_runtime::block_on(async {
            for fail in [false, true] {
                let state = std::sync::Arc::new(Checks::default());
                let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
                let mut jobs = vec![];
                for _ in 0..4 {
                    let state = state.clone();
                    let calls = calls.clone();
                    jobs.push(tauri::async_runtime::spawn(async move {
                        state
                            .coalesce(|| async {
                                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                                if fail {
                                    Err("timeout".into())
                                } else {
                                    Ok(Release::empty("1.1.2", PAGE))
                                }
                            })
                            .await
                    }));
                }
                for job in jobs {
                    assert_eq!(job.await.unwrap().is_err(), fail);
                }
                assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
                assert!(state
                    .coalesce(|| async { Ok(Release::empty("1.1.2", PAGE)) })
                    .await
                    .is_ok());
            }
        });
    }
    #[test]
    fn response_size_is_bounded_without_extending_on_error() {
        let mut b = vec![0; LIMIT - 1];
        append_limited(&mut b, &[1]).unwrap();
        assert!(append_limited(&mut b, &[1]).is_err());
        assert_eq!(b.len(), LIMIT);
    }
    #[test]
    fn actual_network_timeout_has_safe_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
        let error = tauri::async_runtime::block_on(async {
            reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_millis(60))
                .build()
                .unwrap()
                .get(format!("http://{address}"))
                .send()
                .await
                .err()
                .unwrap()
        });
        let error = network_error(error);
        assert_eq!(error.kind, crate::error::ErrorKind::Network);
        assert!(error.message.contains("超时"));
        server.join().unwrap();
    }
    #[test]
    #[ignore]
    fn published_release_readonly() {
        let r = tauri::async_runtime::block_on(fetch(env!("CARGO_PKG_VERSION"))).unwrap();
        assert_eq!(r.latest_version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
        assert_eq!(r.status, "current");
        let response = reqwest::Client::new();
        let bytes = tauri::async_runtime::block_on(async {
            response
                .get(API)
                .header("User-Agent", "BDLP-release-verification")
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap()
        });
        assert_eq!(parse(&bytes, "1.1.1").unwrap().status, "available");
        println!(
            "Published release confirmed: {}; 1.1.1 detects available update",
            env!("CARGO_PKG_VERSION")
        );
    }
}
