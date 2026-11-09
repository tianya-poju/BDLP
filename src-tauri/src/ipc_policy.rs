pub fn local(url: &url::Url) -> bool {
    url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("http" | "https", Some("tauri.localhost")) | ("tauri", Some("localhost"))
        )
}
pub fn allowed(label: &str, url: &url::Url) -> bool {
    label == "main" && local(url)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_local_main_can_invoke() {
        for value in [
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "tauri://localhost/",
        ] {
            let u = url::Url::parse(value).unwrap();
            assert!(allowed("main", &u));
            assert!(!allowed("qq-login", &u));
            assert!(!allowed("face-registration", &u));
        }
        for value in [
            "https://qq.com/",
            "https://tauri.localhost.evil.test/",
            "http://localhost:3000/",
            "https://example.com/",
        ] {
            assert!(!allowed("main", &url::Url::parse(value).unwrap()));
        }
    }
}
