use crate::{
    network::{self, text},
    store::{Data, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Checkpoint {
    pub id: String,
    pub point: [f64; 2],
    pub radius_m: f64,
    pub radius_source: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub id: String,
    pub distance_m: f64,
    pub radius_m: f64,
    pub radius_source: String,
    pub covered: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub points: Vec<[f64; 2]>,
    pub order: Vec<Checkpoint>,
    pub distance_m: f64,
    pub exact: bool,
    pub order_exact: bool,
    pub outside_segments: Vec<usize>,
    pub fence: Vec<[f64; 2]>,
    pub fence_available: bool,
    pub minimum_m: f64,
    pub covered: usize,
    pub can_apply: bool,
    pub source: String,
    pub coverage: Vec<Coverage>,
    pub road_segments: Vec<Vec<[f64; 2]>>,
    pub continuous: bool,
    pub request_count: usize,
    pub cache_hits: usize,
    pub anchor_count: usize,
    pub jitter_max_m: f64,
}
#[derive(Clone)]
struct Saved {
    candidate: Candidate,
    context: Value,
    checkpoints: Vec<Checkpoint>,
    fence: Vec<[f64; 2]>,
    minimum: f64,
}
struct Pending {
    created: std::time::Instant,
    id: String,
    cancel: Arc<AtomicBool>,
    saved: Option<Saved>,
    progress: Arc<Mutex<crate::amap::RoadProgress>>,
}
fn fresh(p: &Pending, id: &str) -> bool {
    p.id == id && p.created.elapsed() < std::time::Duration::from_secs(900)
}
#[derive(Default)]
pub struct Plans(Mutex<Option<Pending>>);
fn context(d: &Data) -> Value {
    json!([
        d.account["uid"],
        d.account["token"],
        d.school_id,
        d.zone["id"]
    ])
}
fn current(d: &Data, c: &Value) -> Result<(), String> {
    if &context(d) != c {
        return Err("账号或跑区已改变，请重新规划".into());
    }
    Ok(())
}
fn check(c: &AtomicBool) -> Result<(), String> {
    if c.load(Ordering::Relaxed) {
        Err("规划已取消".into())
    } else {
        Ok(())
    }
}
pub(crate) fn distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    let p = (b[0] - a[0]).to_radians();
    let q = (b[1] - a[1]).to_radians();
    let h = (p / 2.).sin().powi(2)
        + a[0].to_radians().cos() * b[0].to_radians().cos() * (q / 2.).sin().powi(2);
    6371000. * 2. * h.clamp(0., 1.).sqrt().asin()
}
fn parse_points(v: &Value) -> Result<Vec<Checkpoint>, String> {
    let a = v["data"]["point_list"]
        .as_array()
        .or_else(|| v["data"]["pointList"].as_array())
        .ok_or("学校未返回打卡点列表")?;
    if a.is_empty() {
        return Err("学校没有返回打卡点".into());
    }
    if a.len() > 9999 {
        return Err("打卡点超过路线容量，未进行部分规划".into());
    }
    let mut ids = BTreeSet::new();
    let mut out = vec![];
    for p in a {
        let id = text(p, "point_id");
        let id = if id.is_empty() { text(p, "id") } else { id };
        if id.is_empty() || !ids.insert(id.clone()) {
            return Err("打卡点 ID 缺失或重复".into());
        }
        let s = text(p, "jingwei");
        let xy: Vec<_> = s.split(',').collect();
        if xy.len() != 2 {
            return Err("打卡点坐标缺失".into());
        }
        let lat = xy[0].trim().parse::<f64>().map_err(|_| "打卡点坐标无效")?;
        let lng = xy[1].trim().parse::<f64>().map_err(|_| "打卡点坐标无效")?;
        crate::store::validate_route(&[[lat, lng], [lat, lng]])?;
        let radius = p["radius_m"]
            .as_f64()
            .or_else(|| p["radius_m"].as_str().and_then(|s| s.parse().ok()))
            .or_else(|| p["pass_radius_m"].as_f64());
        out.push(Checkpoint {
            id,
            point: [lat, lng],
            radius_m: radius.filter(|r| r.is_finite() && *r > 0.).unwrap_or(30.),
            radius_source: if radius.is_some_and(|r| r.is_finite() && r > 0.) {
                "server_meters"
            } else {
                "local_default"
            }
            .into(),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}
fn tour(points: &[[f64; 2]], cancel: &AtomicBool) -> Result<(Vec<usize>, bool), String> {
    let n = points.len();
    if n < 2 {
        return Err("至少需要两个不同位置才能形成闭环".into());
    }
    if n > 256 {
        return Err("本版最多优化 256 个不同位置，未遗漏或截断打卡点".into());
    }
    let d: Vec<Vec<f64>> = points
        .iter()
        .map(|a| points.iter().map(|b| distance(*a, *b)).collect())
        .collect();
    if n <= 12 {
        let m = 1usize << (n - 1);
        let mut dp = vec![vec![f64::INFINITY; n]; m];
        let mut parent = vec![vec![0; n]; m];
        for j in 1..n {
            dp[1 << (j - 1)][j] = d[0][j]
        }
        for mask in 1..m {
            check(cancel)?;
            for j in 1..n {
                if mask & (1 << (j - 1)) == 0 {
                    continue;
                }
                let prev = mask ^ (1 << (j - 1));
                if prev == 0 {
                    continue;
                }
                for k in 1..n {
                    if prev & (1 << (k - 1)) != 0 {
                        let cost = dp[prev][k] + d[k][j];
                        if cost < dp[mask][j] {
                            dp[mask][j] = cost;
                            parent[mask][j] = k;
                        }
                    }
                }
            }
        }
        let mut j = (1..n)
            .min_by(|&a, &b| (dp[m - 1][a] + d[a][0]).total_cmp(&(dp[m - 1][b] + d[b][0])))
            .unwrap();
        let mut mask = m - 1;
        let mut path = vec![];
        while mask != 0 {
            path.push(j);
            let k = parent[mask][j];
            mask ^= 1 << (j - 1);
            j = k;
        }
        path.reverse();
        path.insert(0, 0);
        path.push(0);
        return Ok((path, true));
    }
    let mut best = vec![];
    let mut best_len = f64::INFINITY;
    for start in (0..n).step_by((n / 32).max(1)) {
        check(cancel)?;
        let mut order = vec![start];
        let mut used = vec![false; n];
        used[start] = true;
        while order.len() < n {
            let last = *order.last().unwrap();
            let next = (0..n)
                .filter(|i| !used[*i])
                .min_by(|&a, &b| d[last][a].total_cmp(&d[last][b]))
                .unwrap();
            used[next] = true;
            order.push(next)
        }
        for _ in 0..n {
            check(cancel)?;
            let mut improved = false;
            for i in 0..n - 1 {
                for k in i + 2..n {
                    let a = order[i];
                    let b = order[(i + 1) % n];
                    let c = order[k];
                    let e = order[(k + 1) % n];
                    if d[a][c] + d[b][e] + 1e-7 < d[a][b] + d[c][e] {
                        order[i + 1..=k].reverse();
                        improved = true
                    }
                }
            }
            if !improved {
                break;
            }
        }
        let len = (0..n).map(|i| d[order[i]][order[(i + 1) % n]]).sum();
        if len < best_len {
            best_len = len;
            best = order
        }
    }
    let pos = best.iter().position(|i| *i == 0).unwrap();
    best.rotate_left(pos);
    best.push(best[0]);
    Ok((best, false))
}
fn cross(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}
fn inside(p: [f64; 2], f: &[[f64; 2]]) -> bool {
    let mut yes = false;
    for i in 0..f.len() {
        let a = f[i];
        let b = f[(i + 1) % f.len()];
        if cross(a, b, p).abs() < 1e-10
            && p[0] >= a[0].min(b[0]) - 1e-10
            && p[0] <= a[0].max(b[0]) + 1e-10
            && p[1] >= a[1].min(b[1]) - 1e-10
            && p[1] <= a[1].max(b[1]) + 1e-10
        {
            return true;
        }
        if (a[0] > p[0]) != (b[0] > p[0])
            && p[1] < (b[1] - a[1]) * (p[0] - a[0]) / (b[0] - a[0]) + a[1]
        {
            yes = !yes
        }
    }
    yes
}
// Split a segment at every polygon intersection, then test each open interval (concave fences included).
fn segment_inside(a: [f64; 2], b: [f64; 2], f: &[[f64; 2]]) -> bool {
    if !inside(a, f) || !inside(b, f) {
        return false;
    }
    let r = [b[0] - a[0], b[1] - a[1]];
    let mut ts = vec![0., 1.];
    for i in 0..f.len() {
        let c = f[i];
        let e = f[(i + 1) % f.len()];
        let s = [e[0] - c[0], e[1] - c[1]];
        let den = r[0] * s[1] - r[1] * s[0];
        if den.abs() > 1e-15 {
            let q = [c[0] - a[0], c[1] - a[1]];
            let t = (q[0] * s[1] - q[1] * s[0]) / den;
            let u = (q[0] * r[1] - q[1] * r[0]) / den;
            if (0. ..=1.).contains(&t) && (0. ..=1.).contains(&u) {
                ts.push(t)
            }
        } else {
            for p in [c, e] {
                if cross(a, b, p).abs() < 1e-10 {
                    let axis = if r[0].abs() > r[1].abs() { 0 } else { 1 };
                    if r[axis] != 0. {
                        let t = (p[axis] - a[axis]) / r[axis];
                        if t > 0. && t < 1. {
                            ts.push(t)
                        }
                    }
                }
            }
        }
    }
    ts.sort_by(f64::total_cmp);
    ts.windows(2).all(|w| {
        let t = (w[0] + w[1]) / 2.;
        inside([a[0] + t * r[0], a[1] + t * r[1]], f)
    })
}
fn calculate(
    id: String,
    cps: &[Checkpoint],
    fence: &[[f64; 2]],
    minimum: f64,
    cancel: &AtomicBool,
) -> Result<Candidate, String> {
    let mut pts = vec![];
    for cp in cps {
        if !pts.contains(&cp.point) {
            pts.push(cp.point)
        }
    }
    let (order, exact) = tour(&pts, cancel)?;
    let points: Vec<_> = order.iter().map(|i| pts[*i]).collect();
    let mut ordered = vec![];
    for i in order.iter().take(order.len() - 1) {
        ordered.extend(cps.iter().filter(|c| c.point == pts[*i]).cloned())
    }
    let outside: Vec<usize> = if fence.len() < 3 {
        vec![]
    } else {
        points
            .windows(2)
            .enumerate()
            .filter_map(|(i, w)| (!segment_inside(w[0], w[1], fence)).then_some(i))
            .collect()
    };
    check(cancel)?;
    Ok(Candidate {
        id,
        order: ordered,
        distance_m: points.windows(2).map(|w| distance(w[0], w[1])).sum(),
        exact,
        order_exact: exact,
        can_apply: outside.is_empty(),
        source: "order_only".into(),
        coverage: vec![],
        road_segments: vec![],
        continuous: false,
        request_count: 0,
        cache_hits: 0,
        anchor_count: 0,
        jitter_max_m: 0.,
        outside_segments: outside,
        fence: fence.to_vec(),
        fence_available: fence.len() >= 3,
        minimum_m: minimum,
        covered: cps.len(),
        points,
    })
}
fn minimum_distance(r: &Value) -> f64 {
    let arr = r["time_rule_arr"]
        .as_array()
        .filter(|a| !a.is_empty())
        .or_else(|| r["running_time"].as_array());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|n| (n.as_secs() + 28800) % 86400)
        .unwrap_or(0) as f64;
    let num = |v: &Value, k: &str| text(v, k).parse::<f64>().unwrap_or(0.);
    if let Some(a) = arr {
        let hit = a
            .iter()
            .find(|v| num(v, "start_time") <= now && num(v, "end_time") >= now)
            .or_else(|| {
                a.iter()
                    .filter(|v| num(v, "start_time") > now)
                    .min_by(|a, b| num(a, "start_time").total_cmp(&num(b, "start_time")))
            })
            .or_else(|| a.first());
        if let Some(h) = hit {
            return (num(h, "min_distance") * 1000.).max(0.);
        }
    }
    0.
}
async fn pending<F: std::future::Future>(cancel: &AtomicBool, f: F) -> Result<F::Output, String> {
    let mut f = Box::pin(f);
    loop {
        check(cancel)?;
        if let Ok(v) = tokio::time::timeout(std::time::Duration::from_millis(200), f.as_mut()).await
        {
            check(cancel)?;
            return Ok(v);
        }
    }
}
async fn fetch(
    d: &Data,
    cancel: &AtomicBool,
) -> Result<(Vec<Checkpoint>, Vec<[f64; 2]>, f64), String> {
    let zone = text(&d.zone, "id");
    if zone.is_empty() || text(&d.account, "token").is_empty() {
        return Err("请先登录并选择跑区".into());
    }
    let rules = pending(
        cancel,
        network::call(
            d,
            "Run2/beforeRunV260",
            BTreeMap::from([("type".into(), "1".into())]),
            None,
        ),
    )
    .await??;
    let r = &rules["data"];
    if zone != text(r, "game_id") && zone != text(r, "run_zone_id") {
        return Err("服务端跑区已改变，请刷新跑区".into());
    }
    let reply = pending(
        cancel,
        network::call(
            d,
            "Run/GetZonePoints",
            BTreeMap::from([("zone_id".into(), zone)]),
            None,
        ),
    )
    .await??;
    let cps = parse_points(&reply)?;
    let f = network::parse_fence(&r["run_zone_latlng"]);
    let raw = &r["run_zone_latlng"];
    if !raw.is_null() && raw != &json!([]) && raw != &json!("") && f.len() < 3 {
        return Err("学校围栏数据无效，不能安全检查越界".into());
    }
    let minimum = minimum_distance(r);
    Ok((cps, f, minimum))
}
fn offset(anchor: [f64; 2], dx: f64, dy: f64) -> [f64; 2] {
    let p = [
        anchor[0] + dy / 111320.,
        anchor[1] + dx / (111320. * anchor[0].to_radians().cos().abs().max(0.01)),
    ];
    if p[0].abs() > 90. || p[1].abs() > 180. {
        anchor
    } else {
        p
    }
}
fn straight_candidate(
    id: String,
    cps: &[Checkpoint],
    fence: &[[f64; 2]],
    minimum: f64,
    cancel: &AtomicBool,
) -> Result<Candidate, String> {
    let base = calculate(id, cps, fence, minimum, cancel)?;
    let anchors = base.points[..base.points.len() - 1].to_vec();
    let n = anchors.len();
    let mut scales = vec![1.; n];
    let mut cluster = vec![];
    for _ in 0..6 {
        check(cancel)?;
        cluster.clear();
        for (i, anchor) in anchors.iter().enumerate() {
            let mut hash = 14695981039346656037u64;
            for byte in anchor[0]
                .to_bits()
                .to_le_bytes()
                .into_iter()
                .chain(anchor[1].to_bits().to_le_bytes())
            {
                hash ^= byte as u64;
                hash = hash.wrapping_mul(1099511628211);
            }
            let angle = (hash % 36000) as f64 / 100. * std::f64::consts::PI / 180.;
            let dx = angle.cos() * 1.8 * scales[i];
            let dy = angle.sin() * 1.8 * scales[i];
            cluster.push((offset(*anchor, dx, dy), i, true));
            cluster.push((*anchor, i, false));
            cluster.push((offset(*anchor, -dx, -dy), i, true));
        }
        cluster.push(cluster[0]);
        if fence.len() < 3 {
            break;
        }
        let mut shrink = BTreeSet::new();
        for pair in cluster.windows(2) {
            if !segment_inside(pair[0].0, pair[1].0, fence) {
                for item in pair {
                    if item.2 && scales[item.1] > 0. {
                        shrink.insert(item.1);
                    }
                }
            }
        }
        if shrink.is_empty() {
            break;
        }
        for i in shrink {
            scales[i] = if scales[i] > 0.125 {
                scales[i] * 0.5
            } else {
                0.
            };
        }
    }
    let max_jitter = cluster
        .iter()
        .filter(|(_, _, aux)| *aux)
        .map(|(p, i, _)| distance(*p, anchors[*i]))
        .fold(0., f64::max);
    let points: Vec<_> = cluster.into_iter().map(|(p, _, _)| p).collect();
    let mut result = assess(base, cps, fence, vec![points], true)?;
    result.source = "straight_checkpoint".into();
    result.anchor_count = n;
    result.jitter_max_m = max_jitter;
    Ok(result)
}
fn nearest(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let scale = 111320. * p[0].to_radians().cos();
    let x = (a[1] - p[1]) * scale;
    let y = (a[0] - p[0]) * 111320.;
    let dx = (b[1] - a[1]) * scale;
    let dy = (b[0] - a[0]) * 111320.;
    let t = if dx * dx + dy * dy == 0. {
        0.
    } else {
        (-(x * dx + y * dy) / (dx * dx + dy * dy)).clamp(0., 1.)
    };
    ((x + t * dx).powi(2) + (y + t * dy).powi(2)).sqrt()
}
fn assess(
    mut candidate: Candidate,
    cps: &[Checkpoint],
    fence: &[[f64; 2]],
    segments: Vec<Vec<[f64; 2]>>,
    continuous: bool,
) -> Result<Candidate, String> {
    let mut points = vec![];
    let mut outside = vec![];
    let mut meters = 0.;
    for segment in &segments {
        for (j, p) in segment.iter().enumerate() {
            if points.last() == Some(p) {
                continue;
            }
            if j > 0 {
                meters += distance(segment[j - 1], *p);
                if fence.len() >= 3 && !segment_inside(segment[j - 1], *p, fence) {
                    outside.push(points.len().saturating_sub(1))
                }
            }
            points.push(*p)
        }
    }
    crate::store::validate_route(&points)?;
    let coverage: Vec<_> = cps
        .iter()
        .map(|cp| {
            let d = segments
                .iter()
                .flat_map(|s| s.windows(2))
                .map(|w| nearest(cp.point, w[0], w[1]))
                .fold(f64::INFINITY, f64::min);
            Coverage {
                id: cp.id.clone(),
                distance_m: d,
                radius_m: cp.radius_m,
                radius_source: cp.radius_source.clone(),
                covered: d <= cp.radius_m,
            }
        })
        .collect();
    candidate.exact = false;
    candidate.covered = coverage.iter().filter(|c| c.covered).count();
    candidate.can_apply = continuous && coverage.iter().all(|c| c.covered) && outside.is_empty();
    candidate.points = points;
    candidate.distance_m = meters;
    candidate.outside_segments = outside;
    candidate.coverage = coverage;
    candidate.continuous = continuous;
    candidate.source = "amap_walking".into();
    candidate.road_segments = segments;
    Ok(candidate)
}
#[cfg(test)]
fn attach(previous: [f64; 2], next: [f64; 2], connector: &mut [[f64; 2]]) -> bool {
    if connector.len() < 2
        || distance(previous, connector[0]) > 1.
        || distance(next, *connector.last().unwrap()) > 1.
    {
        return false;
    }
    connector[0] = previous;
    let n = connector.len();
    connector[n - 1] = next;
    true
}
#[cfg(test)]
async fn roads(
    candidate: Candidate,
    cps: &[Checkpoint],
    fence: &[[f64; 2]],
    store: &Store,
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<crate::amap::RoadProgress>>,
    started: std::time::Instant,
) -> Result<Candidate, String> {
    let nodes = candidate.points.clone();
    let n = nodes.len() - 1;
    {
        let mut p = progress.lock().map_err(|_| "规划状态不可用")?;
        p.phase = "查询步行道路".into();
        p.total = n;
    }
    let mut client = crate::amap::Client::new(store, n, cancel.clone(), progress.clone(), started)?;
    let mut segments: Vec<Vec<[f64; 2]>> = vec![];
    let mut continuous = true;
    for (i, w) in nodes.windows(2).enumerate() {
        check(&cancel)?;
        let mut leg = client
            .leg(w[0], w[1])
            .await
            .map_err(|e| format!("第 {} 段道路查询失败：{}", i + 1, e))?;
        if let Some(end) = segments.last().and_then(|s| s.last()).copied() {
            if distance(end, leg[0]) > 1. {
                progress.lock().map_err(|_| "规划状态不可用")?.phase =
                    format!("连接第 {} 段道路", i + 1);
                let mut connector = client
                    .leg(end, leg[0])
                    .await
                    .map_err(|e| format!("第 {} 段道路无法连接：{}", i + 1, e))?;
                continuous &= attach(end, leg[0], &mut connector);
                segments.push(connector);
            } else {
                leg[0] = end;
            }
        }
        segments.push(leg);
        let mut p = progress.lock().map_err(|_| "规划状态不可用")?;
        p.completed = i + 1;
        p.phase = "查询步行道路".into();
    }
    let first = segments[0][0];
    let last = *segments.last().unwrap().last().unwrap();
    if distance(first, last) > 1. {
        progress.lock().map_err(|_| "规划状态不可用")?.phase = "连接回起点".into();
        let mut connector = client
            .leg(last, first)
            .await
            .map_err(|e| format!("道路无法闭环：{}", e))?;
        continuous &= attach(last, first, &mut connector);
        segments.push(connector);
    } else {
        *segments.last_mut().unwrap().last_mut().unwrap() = first;
    }
    check(&cancel)?;
    let mut result = assess(candidate, cps, fence, segments, continuous)?;
    let mut p = progress.lock().map_err(|_| "规划状态不可用")?;
    result.request_count = p.requests;
    result.cache_hits = p.cache_hits;
    p.phase = "已完成道路与覆盖检查".into();
    Ok(result)
}
#[tauri::command]
pub fn route_plan_status(
    id: String,
    plans: tauri::State<Plans>,
) -> Result<crate::amap::RoadProgress, String> {
    let p = plans.0.lock().map_err(|_| "规划状态不可用")?;
    let p = p
        .as_ref()
        .filter(|p| fresh(p, &id))
        .ok_or("规划已过期或取消")?;
    let result = p.progress.lock().map_err(|_| "规划状态不可用")?.clone();
    Ok(result)
}
#[tauri::command]
pub async fn route_plan(
    id: String,
    store: tauri::State<'_, Store>,
    plans: tauri::State<'_, Plans>,
) -> Result<Candidate, String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "规划请求 ID 无效")?;
    let cancel = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Mutex::new(crate::amap::RoadProgress {
        phase: "读取学校规则与打卡点".into(),
        ..Default::default()
    }));
    {
        let mut p = plans.0.lock().map_err(|_| "规划状态不可用")?;
        if let Some(old) = p.take() {
            old.cancel.store(true, Ordering::Relaxed)
        }
        *p = Some(Pending {
            created: std::time::Instant::now(),
            id: id.clone(),
            cancel: cancel.clone(),
            saved: None,
            progress: progress.clone(),
        });
    }
    let d = network::snapshot(&store)?;
    let ctx = context(&d);
    let (cps, fence, minimum) = fetch(&d, &cancel).await?;
    check(&cancel)?;
    let cp = cps.clone();
    let f = fence.clone();
    let c = cancel.clone();
    let ident = id.clone();
    let candidate = tauri::async_runtime::spawn_blocking(move || {
        straight_candidate(ident, &cp, &f, minimum, &c)
    })
    .await
    .map_err(|_| "规划计算失败")??;
    {
        let mut p = progress.lock().map_err(|_| "规划状态不可用")?;
        p.phase = "直线闭环与点位覆盖检查完成".into();
        p.total = cps.len();
        p.completed = candidate.covered;
    }
    current(&network::snapshot(&store)?, &ctx)?;
    let mut p = plans.0.lock().map_err(|_| "规划状态不可用")?;
    let pending = p.as_mut().filter(|p| fresh(p, &id)).ok_or("规划已过期")?;
    check(&pending.cancel)?;
    pending.saved = Some(Saved {
        candidate: candidate.clone(),
        context: ctx,
        checkpoints: cps,
        fence,
        minimum,
    });
    Ok(candidate)
}
#[tauri::command]
pub fn route_plan_cancel(id: String, plans: tauri::State<Plans>) -> Result<(), String> {
    let mut p = plans.0.lock().map_err(|_| "规划状态不可用")?;
    if p.as_ref().is_some_and(|p| p.id == id) {
        if let Some(p) = p.take() {
            p.cancel.store(true, Ordering::Relaxed)
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn route_plan_apply(
    id: String,
    store: tauri::State<'_, Store>,
    plans: tauri::State<'_, Plans>,
    runs: tauri::State<'_, crate::running::Runs>,
) -> Result<(), String> {
    crate::running::ensure_idle(&runs)?;
    let (saved, cancel) = {
        let p = plans.0.lock().map_err(|_| "规划状态不可用")?;
        let p = p
            .as_ref()
            .filter(|p| fresh(p, &id))
            .ok_or("规划已过期，请重新规划")?;
        check(&p.cancel)?;
        (p.saved.clone().ok_or("规划未完成")?, p.cancel.clone())
    };
    if !saved.candidate.can_apply {
        return Err("路线不连续、打卡点未覆盖或存在越界，不能应用".into());
    }
    let d = network::snapshot(&store)?;
    current(&d, &saved.context)?;
    let (cps, fence, minimum) = fetch(&d, &cancel).await?;
    if cps != saved.checkpoints || fence != saved.fence || minimum != saved.minimum {
        return Err("打卡点或学校规则已改变，请重新规划".into());
    }
    let mut p = plans.0.lock().map_err(|_| "规划状态不可用")?;
    let pending = p
        .as_ref()
        .filter(|p| fresh(p, &id))
        .ok_or("规划已取消或过期")?;
    check(&pending.cancel)?;
    crate::running::ensure_idle(&runs)?;
    store.try_update(|d| {
        current(d, &saved.context)?;
        d.route = saved.candidate.points;
        Ok(())
    })?;
    *p = None;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn cp(id: &str, p: [f64; 2]) -> Checkpoint {
        Checkpoint {
            id: id.into(),
            point: p,
            radius_m: 30.,
            radius_source: "local_default".into(),
        }
    }
    #[test]
    fn triangle_rectangle_and_duplicate_coverage() {
        let c = AtomicBool::new(false);
        let p = vec![
            cp("a", [0., 0.]),
            cp("b", [0., 1.]),
            cp("c", [1., 1.]),
            cp("d", [1., 0.]),
            cp("e", [1., 0.]),
        ];
        let r = calculate("x".into(), &p, &[], 0., &c).unwrap();
        assert_eq!(r.covered, 5);
        assert_eq!(r.points.len(), 5);
        assert_eq!(r.points.first(), r.points.last());
        assert!(r.exact);
        assert!(r.can_apply);
        assert!(calculate("x".into(), &p[..1], &[], 0., &c).is_err());
        assert!(calculate("x".into(), &p[..3], &[], 0., &c).is_ok());
    }
    #[test]
    fn exact_matches_exhaustive() {
        let p = [[0., 0.], [0.3, 1.], [1., 1.], [0.7, 0.2], [0.2, 0.4]];
        let (order, exact) = tour(&p, &AtomicBool::new(false)).unwrap();
        fn perm(v: &mut [usize], k: usize, p: &[[f64; 2]], best: &mut f64) {
            if k == v.len() {
                let mut path = vec![0];
                path.extend_from_slice(v);
                path.push(0);
                let d = path
                    .windows(2)
                    .map(|w| distance(p[w[0]], p[w[1]]))
                    .sum::<f64>();
                *best = best.min(d);
            } else {
                for i in k..v.len() {
                    v.swap(k, i);
                    perm(v, k + 1, p, best);
                    v.swap(k, i)
                }
            }
        }
        let mut best = f64::INFINITY;
        perm(&mut [1, 2, 3, 4], 0, &p, &mut best);
        let d = order
            .windows(2)
            .map(|w| distance(p[w[0]], p[w[1]]))
            .sum::<f64>();
        assert!((d - best).abs() < 1e-5);
        assert!(exact);
    }
    #[test]
    fn cancel_and_large() {
        let p: Vec<_> = (0..20)
            .map(|i| [(i as f64).sin(), (i as f64).cos()])
            .collect();
        let (o, e) = tour(&p, &AtomicBool::new(false)).unwrap();
        assert!(!e);
        assert_eq!(o.len(), 21);
        assert!(tour(&p, &AtomicBool::new(true)).is_err());
    }
    #[test]
    fn concave_crossing_and_boundary() {
        let f = [
            [0., 0.],
            [0., 3.],
            [3., 3.],
            [3., 2.],
            [1., 2.],
            [1., 1.],
            [3., 1.],
            [3., 0.],
        ];
        assert!(!segment_inside([2., 0.5], [2., 2.5], &f));
        assert!(segment_inside([0., 0.], [0., 3.], &f));
    }
    #[test]
    fn invalid_ids_and_coords_and_stale_account() {
        assert!(
            parse_points(&json!({"data":{"point_list":[{"id":"a","jingwei":"bad"}]}})).is_err()
        );
        assert!(parse_points(&json!({"data":{"point_list":[{"jingwei":"1,2"}]}})).is_err());
        let mut d = Data::default();
        d.account = json!({"uid":"a","token":"old"});
        let c = context(&d);
        d.account["token"] = json!("new");
        assert!(current(&d, &c).is_err());
    }
}

#[cfg(test)]
mod expiry_tests {
    use super::*;
    #[test]
    fn candidate_cannot_be_used_after_timeout_or_for_another_request() {
        let mut p = Pending {
            created: std::time::Instant::now(),
            id: "one".into(),
            cancel: Arc::new(AtomicBool::new(false)),
            saved: None,
            progress: Arc::new(Mutex::new(Default::default())),
        };
        assert!(fresh(&p, "one"));
        assert!(!fresh(&p, "two"));
        p.created -= std::time::Duration::from_secs(901);
        assert!(!fresh(&p, "one"));
    }
}

#[cfg(test)]
mod road_validation_tests {
    use super::*;
    fn cp(id: &str, p: [f64; 2]) -> Checkpoint {
        Checkpoint {
            id: id.into(),
            point: p,
            radius_m: 30.,
            radius_source: "local_default".into(),
        }
    }
    #[test]
    fn actual_road_coverage_not_visit_order_decides_success() {
        let cps = vec![
            cp("a", [28., 112.]),
            cp("b", [28., 112.001]),
            cp("co-located", [28., 112.001]),
        ];
        let candidate = calculate("test".into(), &cps, &[], 0., &AtomicBool::new(false)).unwrap();
        let roads = vec![vec![[28., 112.], [28., 112.001], [28., 112.]]];
        let r = assess(candidate.clone(), &cps, &[], roads, true).unwrap();
        assert_eq!(r.covered, 3);
        assert!(r.can_apply);
        let missed = assess(
            candidate,
            &cps,
            &[],
            vec![vec![[28.01, 112.], [28.01, 112.001]]],
            true,
        )
        .unwrap();
        assert_eq!(missed.covered, 0);
        assert!(!missed.can_apply);
    }
    #[test]
    fn returned_snap_gaps_and_unclosed_paths_cannot_apply() {
        let cps = vec![cp("a", [28., 112.]), cp("b", [28., 112.001])];
        let candidate = calculate("test".into(), &cps, &[], 0., &AtomicBool::new(false)).unwrap();
        let r = assess(
            candidate,
            &cps,
            &[],
            vec![vec![[28., 112.], [28., 112.001]]],
            false,
        )
        .unwrap();
        assert!(!r.can_apply);
        let mut wrong = vec![[28.1, 112.], [28., 112.001]];
        assert!(!attach([28., 112.], [28., 112.001], &mut wrong));
        let mut close = vec![[28.000001, 112.], [28., 112.001001]];
        assert!(attach([28., 112.], [28., 112.001], &mut close));
        assert_eq!(close[0], [28., 112.]);
    }
    #[test]
    fn road_outside_concave_fence_stays_blocked() {
        let cps = vec![cp("a", [0.5, 0.5]), cp("b", [0.5, 1.5])];
        let f = [[0., 0.], [0., 2.], [1., 2.], [1., 0.]];
        let c = calculate("test".into(), &cps, &f, 0., &AtomicBool::new(false)).unwrap();
        let r = assess(
            c,
            &cps,
            &f,
            vec![vec![[0.5, 0.5], [2., 1.], [0.5, 1.5], [0.5, 0.5]]],
            true,
        )
        .unwrap();
        assert!(!r.can_apply);
        assert!(!r.outside_segments.is_empty());
    }
    #[test]
    fn only_explicit_meter_radius_is_used() {
        let v = json!({"data":{"point_list":[{"id":"a","jingwei":"28,112","radius_m":"12"},{"id":"b","jingwei":"28,112.001","radius":999}]}});
        let cps = parse_points(&v).unwrap();
        assert_eq!(cps[0].radius_m, 12.);
        assert_eq!(cps[1].radius_m, 30.);
    }
}

#[cfg(test)]
mod live_fixed_roads {
    use super::*;
    #[test]
    #[ignore]
    fn two_fixed_coordinates_without_personal_account() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        let store = Store::open(root.join("settings.dpapi")).unwrap();
        let cps = vec![
            Checkpoint {
                id: "fixed-a".into(),
                point: [28.060, 112.998],
                radius_m: 30.,
                radius_source: "local_default".into(),
            },
            Checkpoint {
                id: "fixed-b".into(),
                point: [28.061, 112.999],
                radius_m: 30.,
                radius_source: "local_default".into(),
            },
        ];
        let cancel = Arc::new(AtomicBool::new(false));
        let candidate = calculate("fixed-test".into(), &cps, &[], 0., &cancel).unwrap();
        let progress = Arc::new(Mutex::new(Default::default()));
        let result = tauri::async_runtime::block_on(roads(
            candidate,
            &cps,
            &[],
            &store,
            cancel,
            progress,
            std::time::Instant::now(),
        ));
        std::fs::remove_dir_all(root).unwrap();
        let r = result.unwrap();
        assert_eq!(r.source, "amap_walking");
        assert!(!r.exact);
        assert!(r.points.len() > 2);
        println!(
            "固定坐标道路解析完成：点数={} 覆盖={}/{} 连续={} 可应用={} 请求={}",
            r.points.len(),
            r.covered,
            cps.len(),
            r.continuous,
            r.can_apply,
            r.request_count
        );
    }
}

#[cfg(test)]
mod straight_tests {
    use super::*;
    fn cp(id: &str, p: [f64; 2]) -> Checkpoint {
        Checkpoint {
            id: id.into(),
            point: p,
            radius_m: 30.,
            radius_source: "local_default".into(),
        }
    }
    #[test]
    fn exact_anchors_offsets_and_duplicate_ids_are_preserved() {
        let cps = vec![
            cp("a", [28., 112.]),
            cp("b", [28., 112.001]),
            cp("c", [28.001, 112.001]),
            cp("same", [28., 112.]),
        ];
        let r = straight_candidate("one".into(), &cps, &[], 0., &AtomicBool::new(false)).unwrap();
        let r2 = straight_candidate("two".into(), &cps, &[], 0., &AtomicBool::new(false)).unwrap();
        assert_eq!(r.points, r2.points);
        assert_eq!(r.points.first(), r.points.last());
        assert_eq!(r.covered, 4);
        assert_eq!(r.anchor_count, 3);
        assert!(r.jitter_max_m <= 2.);
        assert!(r.can_apply);
        for c in cps {
            assert!(r.points.contains(&c.point));
        }
        assert_eq!(r.request_count, 0);
        assert_eq!(r.cache_hits, 0);
    }
    #[test]
    fn boundary_offsets_shrink_without_moving_anchors() {
        let cps = vec![
            cp("a", [28., 112.]),
            cp("b", [28., 112.001]),
            cp("c", [28.001, 112.001]),
        ];
        let f = [
            [28., 112.],
            [28., 112.001],
            [28.001, 112.001],
            [28.001, 112.],
        ];
        let r = straight_candidate("test".into(), &cps, &f, 0., &AtomicBool::new(false)).unwrap();
        assert!(r.can_apply);
        assert!(r.outside_segments.is_empty());
        for cp in cps {
            assert!(r.points.contains(&cp.point));
        }
    }
    #[test]
    #[ignore]
    fn installed_account_readonly_straight_preview() {
        use std::io::Write;
        let path = std::path::PathBuf::from(
            std::env::var("BUDAO_READONLY_PROFILE").expect("Provide installed profile path"),
        );
        let before = std::fs::read(&path).unwrap();
        let store = Store::open(path.clone()).unwrap();
        let d = network::snapshot(&store).unwrap();
        let cancel = AtomicBool::new(false);
        let fetched = tauri::async_runtime::block_on(fetch(&d, &cancel));
        let (cps, fence, minimum) = match fetched {
            Ok(v) => v,
            Err(_) => panic!("真实学校规则或打卡点读取失败（请本人检查登录状态和跑区）"),
        };
        let r = straight_candidate("readonly".into(), &cps, &fence, minimum, &cancel).unwrap();
        assert_eq!(before, std::fs::read(path).unwrap());
        assert!(r.jitter_max_m <= 2.);
        for c in &cps {
            assert!(r.points.contains(&c.point));
        }
        let payload = json!({"points":r.points,"order":r.order,"coverage":r.coverage,"fence":r.fence,"config":d.run_config});
        let mut child = std::process::Command::new("node")
            .arg("tools/check-checkpoint-preview.mjs")
            .current_dir(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap(),
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(serde_json::to_string(&payload).unwrap().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "预览采样检查执行失败");
        let sampled: Value = serde_json::from_slice(&output.stdout).unwrap();
        println!("只读真实点位：打卡点={} 不同位置={} 几何覆盖={} 越界线段={} 最大偏移={:.3}m 长度={:.1}m 可应用={}；预览={}",cps.len(),r.anchor_count,r.covered,r.outside_segments.len(),r.jitter_max_m,r.distance_m,r.can_apply,sampled);
    }
}
