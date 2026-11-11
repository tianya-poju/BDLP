//! Retained walking cache implementation; 1.2.0 uses local straight planning.
#![cfg_attr(not(test), allow(dead_code))]
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
type Point = [f64; 2];
#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    time: u64,
    points: Vec<Point>,
}
#[derive(Default, Serialize, Deserialize)]
struct Cache(BTreeMap<String, Entry>);
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadProgress {
    pub phase: String,
    pub completed: usize,
    pub total: usize,
    pub requests: usize,
    pub cache_hits: usize,
}
pub struct Client {
    http: reqwest::Client,
    cancel: Arc<AtomicBool>,
    start: Instant,
    budget: usize,
    path: PathBuf,
    cache: Cache,
    pub progress: Arc<Mutex<RoadProgress>>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|x| x.as_secs())
        .unwrap_or(0)
}
pub(crate) fn parse_paths(v: &Value) -> Result<Vec<Point>, crate::error::ApiError> {
    let path = v["route"]["paths"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or("高德未返回可用步行道路")?;
    let steps = path["steps"].as_array().ok_or("道路数据缺少路段")?;
    let mut pts = vec![];
    for step in steps {
        let mut first = true;
        for pair in step["polyline"]
            .as_str()
            .ok_or("道路数据缺少坐标")?
            .split(';')
        {
            let a: Vec<_> = pair.split(',').collect();
            if a.len() != 2 {
                return Err("道路坐标无效".into());
            }
            let p = [
                a[1].parse::<f64>().map_err(|_| "道路坐标无效")?,
                a[0].parse::<f64>().map_err(|_| "道路坐标无效")?,
            ];
            if p.iter().any(|v| !v.is_finite()) || p[0].abs() > 90. || p[1].abs() > 180. {
                return Err("道路坐标无效".into());
            }
            if first
                && pts
                    .last()
                    .is_some_and(|last| crate::planner::distance(*last, p) > 1.)
            {
                return Err("高德返回的道路路段自身不连续，未使用直线补接".into());
            }
            first = false;
            if pts.last() != Some(&p) {
                pts.push(p)
            }
            if pts.len() > 10000 {
                return Err("单段道路超过路线容量".into());
            }
        }
    }
    if pts.len() < 2 {
        return Err("没有可用道路，未使用直线补接".into());
    }
    Ok(pts)
}
fn service_error(v: &Value) -> String {
    let code = v["infocode"].as_str().unwrap_or("UNKNOWN");
    let reason = match code {
        "10001" => "Key 无效或已失效",
        "10002" | "10005" | "10006" | "10007" | "10008" | "10009" | "10012" | "10013" => {
            "Key 平台、白名单、安全码或权限不匹配"
        }
        "10003" | "10004" | "10010" | "10014" | "10019" | "10020" | "10021" | "10029" => {
            "高德额度或频率限制"
        }
        "30000" | "30001" | "30002" | "30003" => "高德无可用步行道路",
        _ => "高德拒绝步行规划",
    };
    let safe: String = code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(24)
        .collect();
    format!("{}（{}）", reason, safe)
}
impl Client {
    pub fn new(
        store: &crate::store::Store,
        n: usize,
        cancel: Arc<AtomicBool>,
        progress: Arc<Mutex<RoadProgress>>,
        started: Instant,
    ) -> Result<Self, crate::error::ApiError> {
        let path = store
            .path
            .parent()
            .ok_or("数据目录无效")?
            .join("road-cache.dpapi");
        let cache = std::fs::read(&path)
            .ok()
            .filter(|b| b.len() < 8 * 1024 * 1024)
            .and_then(|b| crate::store::protect(&b, true).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "无法初始化高德服务")?,
            cancel,
            start: started,
            budget: 3 * n,
            path,
            cache,
            progress,
        })
    }
    fn check(&self) -> Result<(), crate::error::ApiError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err("规划已取消".into());
        }
        if self.start.elapsed() > Duration::from_secs(600) {
            return Err("道路规划超过10分钟，原路线未改变".into());
        }
        Ok(())
    }
    async fn wait(&self, d: Duration) -> Result<(), crate::error::ApiError> {
        let until = Instant::now() + d;
        while Instant::now() < until {
            self.check()?;
            tokio::time::sleep(
                until
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(100)),
            )
            .await;
        }
        self.check()
    }
    async fn pending<F: std::future::Future>(
        &self,
        f: F,
    ) -> Result<F::Output, crate::error::ApiError> {
        let mut f = Box::pin(f);
        loop {
            self.check()?;
            if let Ok(v) = tokio::time::timeout(Duration::from_millis(200), f.as_mut()).await {
                return Ok(v);
            }
        }
    }
    pub async fn leg(&mut self, a: Point, b: Point) -> Result<Vec<Point>, crate::error::ApiError> {
        self.check()?;
        let id = format!(
            "walking-v5-joined:{:.6},{:.6}>{:.6},{:.6}",
            a[1], a[0], b[1], b[0]
        );
        if let Some(e) = self.cache.0.get(&id) {
            if now().saturating_sub(e.time) < 86400
                && e.time <= now()
                && crate::store::validate_route(&e.points).is_ok()
                && e.points.len() >= 2
            {
                self.progress
                    .lock()
                    .map_err(|_| "规划状态不可用")?
                    .cache_hits += 1;
                return Ok(e.points.clone());
            }
        }
        for attempt in 0..2 {
            self.check()?;
            {
                let mut p = self.progress.lock().map_err(|_| "规划状态不可用")?;
                if p.requests >= self.budget {
                    return Err("已达到本次规划请求上限，未使用直线替代".into());
                }
                p.requests += 1;
            }
            static NEXT: OnceLock<Mutex<Instant>> = OnceLock::new();
            let delay = {
                let mut next = NEXT
                    .get_or_init(|| Mutex::new(Instant::now()))
                    .lock()
                    .map_err(|_| "地图限速状态不可用")?;
                let at = (*next).max(Instant::now());
                *next = at + Duration::from_secs(1);
                at.saturating_duration_since(Instant::now())
            };
            self.wait(delay).await?;
            let origin = format!("{:.6},{:.6}", a[1], a[0]);
            let dest = format!("{:.6},{:.6}", b[1], b[0]);
            let req = self
                .http
                .get("https://restapi.amap.com/v5/direction/walking")
                .query(&[
                    ("key", crate::map_config::WEB_SERVICE_KEY),
                    ("origin", origin.as_str()),
                    ("destination", dest.as_str()),
                    ("show_fields", "polyline"),
                ]);
            let result = self
                .pending(async {
                    let r = req.send().await.map_err(|_| "network")?;
                    if !r.status().is_success() {
                        return Err(if r.status().is_server_error() {
                            "network"
                        } else {
                            "http"
                        });
                    }
                    let bytes = r.bytes().await.map_err(|_| "network")?;
                    if bytes.len() > 2 * 1024 * 1024 {
                        return Err("size");
                    }
                    serde_json::from_slice::<Value>(&bytes).map_err(|_| "format")
                })
                .await?;
            self.check()?;
            match result {
                Ok(v) => {
                    if v["status"].as_str() != Some("1") {
                        return Err(service_error(&v).into());
                    }
                    let points = parse_paths(&v)?;
                    self.cache.0.insert(
                        id.clone(),
                        Entry {
                            time: now(),
                            points: points.clone(),
                        },
                    );
                    self.cache
                        .0
                        .retain(|_, e| now().saturating_sub(e.time) < 86400);
                    while self.cache.0.len() > 128
                        || self.cache.0.values().map(|e| e.points.len()).sum::<usize>() > 100000
                    {
                        let old = self
                            .cache
                            .0
                            .iter()
                            .min_by_key(|(_, e)| e.time)
                            .map(|(k, _)| k.clone())
                            .unwrap();
                        self.cache.0.remove(&old);
                    }
                    self.save();
                    return Ok(points);
                }
                Err("network") if attempt == 0 => self.wait(Duration::from_secs(1)).await?,
                Err("network") => return Err("高德网络失败或超时，已停止规划".into()),
                Err(_) => return Err("高德 HTTP、响应格式或大小无效，已停止规划".into()),
            }
        }
        Err("高德规划失败".into())
    }
    fn save(&self) {
        let _ = (|| -> Result<(), crate::error::ApiError> {
            let b = crate::store::protect(
                &serde_json::to_vec(&self.cache).map_err(|_| "缓存编码失败")?,
                false,
            )?;
            let tmp = self
                .path
                .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            std::fs::write(&tmp, b).map_err(|_| "缓存保存失败")?;
            crate::store::replace_file(&tmp, &self.path)
        })();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_only_returned_polyline() {
        let p=parse_paths(&serde_json::json!({"route":{"paths":[{"steps":[{"polyline":"112,28;112.01,28.01"}]}]}})).unwrap();
        assert_eq!(p[0], [28., 112.]);
        assert!(parse_paths(&serde_json::json!({})).is_err());
        assert!(parse_paths(
            &serde_json::json!({"route":{"paths":[{"steps":[{"polyline":"NaN,28;113,29"}]}]}})
        )
        .is_err());
    }
    #[test]
    fn auth_and_quota_errors_do_not_echo_server_info() {
        let e = service_error(&serde_json::json!({"infocode":"10001","info":"secret"}));
        assert!(!e.contains("secret"));
        assert!(e.contains("Key"));
        assert!(service_error(&serde_json::json!({"infocode":"10003"})).contains("额度"));
    }
}

#[cfg(test)]
mod cache_and_limits_tests {
    use super::*;
    #[test]
    fn encrypted_cache_hit_deadline_budget_and_cancellation() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        let store = crate::store::Store::open(root.join("settings.dpapi")).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Mutex::new(RoadProgress::default()));
        let a = [28., 112.];
        let b = [28., 112.001];
        let key = "walking-v5-joined:112.000000,28.000000>112.001000,28.000000".to_string();
        let mut c =
            Client::new(&store, 2, cancel.clone(), progress.clone(), Instant::now()).unwrap();
        c.cache.0.insert(
            key,
            Entry {
                time: now(),
                points: vec![a, b],
            },
        );
        c.save();
        let raw = std::fs::read(root.join("road-cache.dpapi")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("walking-v5"));
        let mut c =
            Client::new(&store, 2, cancel.clone(), progress.clone(), Instant::now()).unwrap();
        tauri::async_runtime::block_on(async {
            assert_eq!(c.leg(a, b).await.unwrap(), vec![a, b]);
            assert_eq!(progress.lock().unwrap().cache_hits, 1);
            assert_eq!(progress.lock().unwrap().requests, 0);
            c.cache.0.clear();
            c.budget = 0;
            assert!(c.leg(a, b).await.unwrap_err().message.contains("上限"));
            c.start = Instant::now() - Duration::from_secs(601);
            assert!(c.check().unwrap_err().message.contains("10分钟"));
            c.start = Instant::now();
            cancel.store(true, Ordering::Relaxed);
            assert!(c.leg(a, b).await.unwrap_err().message.contains("取消"));
        });
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn disconnected_step_data_is_rejected() {
        let v = serde_json::json!({"route":{"paths":[{"steps":[{"polyline":"112,28;112.001,28"},{"polyline":"112.1,28;112.2,28"}]}]}});
        assert!(parse_paths(&v).unwrap_err().message.contains("不连续"));
    }
}

#[cfg(test)]
mod inflight_cancel_tests {
    use super::*;
    #[test]
    fn pending_road_request_is_interrupted_without_waiting_for_response() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let store = crate::store::Store::open(root.join("settings.dpapi")).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Mutex::new(Default::default()));
        let c = Client::new(&store, 2, cancel.clone(), progress, Instant::now()).unwrap();
        tauri::async_runtime::block_on(async {
            let token = cancel.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                token.store(true, Ordering::Relaxed);
            });
            let start = Instant::now();
            let result = c.pending(tokio::time::sleep(Duration::from_secs(60))).await;
            assert!(result.unwrap_err().message.contains("取消"));
            assert!(start.elapsed() < Duration::from_secs(2));
        });
    }
}
