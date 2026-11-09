use serde::Serialize;
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Business,
    Network,
    AuthExpired,
    InvalidData,
    Storage,
    Cancelled,
    VerificationPending,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ApiError {
    pub kind: ErrorKind,
    pub message: String,
    pub code: Option<String>,
}
impl ApiError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            code: None,
        }
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, message)
    }
    pub fn storage(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Storage, message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidData, message)
    }
    pub fn cancelled() -> Self {
        Self::new(ErrorKind::Cancelled, "已取消任务")
    }
}
impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self::new(ErrorKind::Business, message)
    }
}
impl From<&str> for ApiError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ApiError {}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn category_never_depends_on_message() {
        let e = ApiError::new(ErrorKind::Network, "服务暂不可用");
        assert_eq!(serde_json::to_value(&e).unwrap()["kind"], "network");
        assert_eq!(ApiError::from("网络主题设置").kind, ErrorKind::Business);
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(_: serde_json::Error) -> Self {
        Self::invalid("数据结构无效，未使用默认值替代")
    }
}
