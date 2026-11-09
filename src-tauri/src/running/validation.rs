use super::*;
pub(super) fn gates(rules: &Value, mode: &str) -> Result<(), crate::error::ApiError> {
    if text(rules, "game_id").is_empty() {
        return Err("学校未返回有效跑区编号".into());
    }
    if mode != "campus" {
        return Ok(());
    }
    if text(rules, "term_id").is_empty() {
        return Err("未获取学期编号".into());
    }
    for (key, label) in [
        ("is_check_geetest", "极验滑块"),
        ("is_check_geedevice", "极验设备"),
        ("is_check_deepknow", "数美"),
        ("is_check_deepkonw", "数美"),
        ("is_check_shumeng", "数盟"),
    ] {
        if number(rules, key) == 1. {
            return Err(format!("本校需要{label}核验，桌面端尚无可验证的授权流程。请使用官方应用完成；本次未提交记录").into());
        }
    }
    let fc = &rules["run_face_verify_config"];
    let required = ["start_status", "middle_status", "stop_status"]
        .iter()
        .any(|k| number(fc, k) == 1.);
    if required && ![1., 2.].contains(&number(fc, "face_verify_type")) {
        return Err("学校使用未知人脸核验方式，请使用官方应用".into());
    }

    if number(&rules["capture_config"], "capture_type") == 2. {
        return Err("本跑区需要实体摄像头抓拍，请使用官方应用完成；本次未提交记录".into());
    }
    Ok(())
}
pub(crate) fn validate_points(points: &[Point]) -> Result<(), crate::error::ApiError> {
    if points.len() < 2 || points.len() > 40000 {
        return Err("轨迹点数量无效".into());
    }
    for (i, p) in points.iter().enumerate() {
        if ![p.lat, p.lng, p.speed, p.t].iter().all(|v| v.is_finite())
            || p.lat.abs() > 85.
            || p.lng.abs() > 180.
            || p.speed < 0.
            || p.speed > 8.
            || p.t < 0.
            || p.t > 14400.
            || i > 0 && p.t <= points[i - 1].t
        {
            return Err("轨迹坐标、速度或时间无效".into());
        }
    }
    if points[0].t != 0. || distance(points) > 20000. {
        return Err("轨迹超出本地支持范围".into());
    }
    Ok(())
}
pub(super) fn validate_sensor(raw: &str) -> Result<(), crate::error::ApiError> {
    if raw.len() > 32 * 1024 * 1024 {
        return Err("传感器文件过大".into());
    }
    let arr: Vec<Value> = serde_json::from_str(raw).map_err(|_| "传感器文件格式无效")?;
    if arr.len() < 51 || arr.len() > 240000 {
        return Err("传感器样本数量无效".into());
    }
    for v in &arr {
        for k in ["t", "ax", "ay", "az", "gx", "gy", "gz", "a", "n"] {
            if !v[k].is_number()
                && v[k]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| v.is_finite())
                    .is_none()
            {
                return Err("传感器样本无效".into());
            }
        }
    }
    Ok(())
}
