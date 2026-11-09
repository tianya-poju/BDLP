use serde::Serialize;
use std::sync::Mutex;
const API: &str = "https://api.github.com/repos/tianya-poju/BDLP/releases/latest";
const PAGE: &str = "https://github.com/tianya-poju/BDLP/releases/latest";
const LIMIT: usize = 256 * 1024;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    current_version: String,
    latest_version: Option<String>,
    status: String,
    release_url: &'static str,
}
impl Release {
    fn empty() -> Self {
        Self {
            current_version: env!("CARGO_PKG_VERSION").into(),
            latest_version: None,
            status: "unpublished".into(),
            release_url: PAGE,
        }
    }
}
#[derive(Default)]
pub struct Checks {
    gate: tokio::sync::Mutex<()>,
    result: Mutex<(u64, Option<Result<Release, crate::error::ApiError>>)>,
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
fn parse(bytes: &[u8], current: &str) -> Result<Release, crate::error::ApiError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "GitHub 返回格式异常，请稍后重试")?;
    if value["draft"].as_bool().is_none() || value["prerelease"].as_bool().is_none() {
        return Err("GitHub 返回格式异常，请稍后重试".into());
    }
    if value["draft"] == true || value["prerelease"] == true {
        return Ok(Release::empty());
    }
    let tag = value["tag_name"].as_str().ok_or("GitHub 版本信息缺失")?;
    let version = semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .map_err(|_| "GitHub 版本号格式异常")?;
    if !version.pre.is_empty() {
        return Ok(Release::empty());
    }
    let local = semver::Version::parse(current).map_err(|_| "本机版本信息异常")?;
    Ok(Release {
        current_version: current.into(),
        latest_version: Some(version.to_string()),
        status: if version.cmp_precedence(&local).is_gt() {
            "available"
        } else {
            "current"
        }
        .into(),
        release_url: PAGE,
    })
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
async fn fetch() -> Result<Release, crate::error::ApiError> {
    // Dedicated anonymous client: never reuse the account client's cookies or headers.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("BDLP/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "更新检查初始化失败")?;
    let mut response = client
        .get(API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(network_error)?;
    if !response_status(response.status().as_u16())? {
        return Ok(Release::empty());
    }
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err("GitHub 更新响应过大，已停止读取".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        append_limited(&mut bytes, &chunk)?;
    }
    parse(&bytes, env!("CARGO_PKG_VERSION"))
}
#[tauri::command]
pub async fn update_check(
    checks: tauri::State<'_, Checks>,
) -> Result<Release, crate::error::ApiError> {
    checks
        .coalesce(|| async {
            tokio::time::timeout(std::time::Duration::from_secs(10), fetch())
                .await
                .map_err(|_| crate::error::ApiError::network("检查更新超时，请稍后重试"))?
        })
        .await
}
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
#[cfg(test)]
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
                                    Ok(Release::empty())
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
                    .coalesce(|| async { Ok(Release::empty()) })
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
        let r = tauri::async_runtime::block_on(fetch()).unwrap();
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
