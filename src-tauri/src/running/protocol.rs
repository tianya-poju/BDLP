use super::*;
pub(super) fn segment(a: &Point, b: &Point) -> f64 {
    ((b.lat - a.lat) * 111320.).hypot((b.lng - a.lng) * 111320. * b.lat.to_radians().cos())
}
pub(super) fn distance(points: &[Point]) -> f64 {
    points.windows(2).map(|p| segment(&p[0], &p[1])).sum()
}
pub(super) fn round(x: f64, n: i32) -> f64 {
    let m = 10f64.powi(n);
    (x * m).round() / m
}
pub(super) fn track_json(points: &[Point]) -> Value {
    let mut out = vec![];
    let (mut cum, mut km, mut last_km, mut next100, mut last100) = (0., 0, 0., 100., 0.);
    for (i, p) in points.iter().enumerate() {
        if i > 0 {
            cum += segment(&points[i - 1], p)
        }
        let mut v = json!({"o":round(p.lng,8),"a":round(p.lat,8),"s":round(p.speed,2)});
        if cum >= next100 {
            v["d"] = json!(round(next100 / 1000., 3));
            v["e"] = json!(round((p.t - last100).max(1.), 1));
            last100 = p.t;
            next100 += 100.;
        }
        if cum >= ((km + 1) * 1000) as f64 {
            km += 1;
            v["b"] = json!(km);
            v["c"] = json!(round((p.t - last_km).max(60.), 1));
            last_km = p.t;
        }
        out.push(v)
    }
    json!(out)
}
pub(super) fn encrypted(value: &str) -> Result<Vec<u8>, crate::error::ApiError> {
    let c = network::cfg();
    Ok(network::encrypt(value, &c.key_trk, &c.iv_trk)?.into_bytes())
}
pub(super) fn key(kind: &str, ext: &str) -> String {
    let day = (now() + 28800) / 86400;
    let (y, m, d) = civil(day);
    format!(
        "Public/Upload/{kind}/{y:04}-{m:02}-{d:02}/{}/{}.{ext}",
        1 + uuid::Uuid::new_v4().as_u128() % 999,
        uuid::Uuid::new_v4()
    )
}
// Gregorian civil date, avoiding a new date/time runtime dependency.
pub(super) fn civil(day: i64) -> (i64, i64, i64) {
    let z = day + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    if m <= 2 {
        y += 1
    }
    (y, m, d)
}
pub(super) async fn job_call(
    job: &Job,
    endpoint: &str,
    extra: BTreeMap<String, String>,
    nonce: Option<u32>,
) -> Result<Value, crate::error::ApiError> {
    let clock = {
        let state = job.progress();
        state.check()?;
        state.clock
    };
    network::call_with_clock(&job.data, endpoint, extra, nonce, clock).await
}
pub(super) async fn upload(
    job: &Job,
    key: &str,
    bytes: Vec<u8>,
    mime: &str,
) -> Result<(), crate::error::ApiError> {
    let sts = job_call(job, "report/getOssSts", BTreeMap::new(), None).await?;
    let s = &sts["data"];
    let bucket = text(s, "bucket");
    let bucket = if bucket.is_empty() {
        "lptiyu-data".to_string()
    } else {
        bucket
    };
    if bucket.len() > 63
        || !bucket
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err("存储桶无效".into());
    }
    let token = text(s, "SecurityToken");
    let ak = text(s, "AccessKeyId");
    let secret = text(s, "AccessKeySecret");
    if [token.as_str(), ak.as_str(), secret.as_str()]
        .iter()
        .any(|s| s.is_empty())
    {
        return Err("上传凭据缺失".into());
    }
    let date = httpdate::fmt_http_date(SystemTime::now());
    let canonical = format!("PUT\n\n{mime}\n{date}\nx-oss-security-token:{token}\n/{bucket}/{key}");
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).map_err(|_| "上传签名失败")?;
    mac.update(canonical.as_bytes());
    let sig = B64.encode(mac.finalize().into_bytes());
    let r = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(40))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "上传初始化失败")?
        .put(format!(
            "https://{bucket}.oss-cn-hangzhou.aliyuncs.com/{key}"
        ))
        .header("Date", date)
        .header("Content-Type", mime)
        .header("x-oss-security-token", token)
        .header("Authorization", format!("OSS {ak}:{sig}"))
        .body(bytes)
        .send()
        .await
        .map_err(|_| "文件上传失败，请检查网络")?;
    if r.status() != reqwest::StatusCode::OK {
        return Err(format!("文件上传被拒绝 HTTP {}", r.status().as_u16()).into());
    }
    Ok(())
}
pub(super) fn record_str(data: &Data, time: &str) -> Result<String, crate::error::ApiError> {
    let uid = data
        .account
        .uid
        .clone()
        .parse::<i64>()
        .map_err(|_| "账号编号无效")?;
    let sid = data.school_id.parse::<i64>().map_err(|_| "学校编号无效")?;
    let c = network::cfg();
    let w = &c.w8[uid.rem_euclid(10) as usize];
    let sum = (sid as i32).wrapping_add(uid as i32);
    Ok(format!(
        "{:x}",
        Md5::digest(format!("{sum}{time}{w}").as_bytes())
    ))
}
pub(super) fn step_info(duration: u64, steps: u64) -> String {
    let count = (duration / 60).max(1) as usize;
    let mut list = vec![steps / count as u64; count];
    for n in list.iter_mut().take((steps % count as u64) as usize) {
        *n += 1
    }
    json!({"interval":60,"list":list}).to_string()
}
pub(super) fn run_check(
    uid: &str,
    rules: &Value,
    steps: u64,
    points: &[Point],
) -> Result<String, crate::error::ApiError> {
    let Some(rules) = rules.as_array().filter(|r| !r.is_empty()) else {
        return Ok(json!([{"uid":uid,"plan":0,"inteval_result":"0","inteval_value":"0","is_stop":0,"is_cheat":0}]).to_string());
    };
    if rules.len() > 50 {
        return Err("跑步检查规则数量异常".into());
    }
    let mut out = vec![];
    for r in rules {
        let n = number(r, "check_num").max(1.) as usize;
        if n > 1000 {
            return Err("跑步检查区间过多".into());
        }
        let values = (0..n)
            .map(|i| {
                let f = if n == 1 {
                    0.5
                } else {
                    0.15 + 0.7 * i as f64 / (n - 1) as f64
                };
                format!(
                    "{}-{:.1}",
                    steps / n as u64,
                    points[(f * (points.len() - 1) as f64).floor() as usize].speed
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        out.push(json!({"uid":uid,"plan":r.get("plan").cloned().unwrap_or(json!(1)),"inteval_result":vec!["0";n].join(","),"inteval_value":values,"is_stop":0,"is_cheat":0}))
    }
    Ok(json!(out).to_string())
}

pub(super) async fn run_action_inner(
    id: String,
    action: String,
    args: Value,
    app: tauri::AppHandle,
) -> Result<Value, crate::error::ApiError> {
    let runs = app.state::<Runs>();
    let j = get(&runs, &id)?;
    let store = app.state::<Store>();
    if action == "log" {
        let msg = text(&args, "message");
        if msg.len() > 1500 {
            return Err("日志过长".into());
        }
        let mut s = j.progress();
        s.push_log(msg);
        return Ok(json!({"ok":true}));
    }
    if action == "fail" {
        let mut s = j.progress();
        if s.status != TaskStatus::Done && s.status != TaskStatus::Cancelled {
            s.status = if matches!(
                s.status,
                TaskStatus::Submitting | TaskStatus::Submitted | TaskStatus::Unknown
            ) {
                TaskStatus::Unknown
            } else {
                TaskStatus::Failed
            };
            s.error = crate::session::ApiError::from(text(&args, "error")).message;
        }
        return Ok(json!({"ok":true}));
    }
    let _step = j.step()?;
    guard(&j, &store)?;
    {
        let s = j.progress();
        if !active(&s.status) {
            return Err("任务已结束".into());
        }
        if s.status == TaskStatus::Submitting {
            return Err("提交结果待确认，禁止重复提交".into());
        }
        if s.submit.is_some() && !matches!(action.as_str(), "gyro_link" | "complete") {
            return Err("记录已经提交，禁止重复操作".into());
        }
        if action != "before_run" && s.rules.is_none() {
            return Err("请先获取学校规则".into());
        }
        if !matches!(action.as_str(), "before_run" | "timestamp") && s.time_str.is_empty() {
            return Err("请先同步服务端时间".into());
        }
    }
    let data = &j.data;
    let result = match action.as_str() {
        "before_run" => {
            let r = job_call(&j, "Run2/beforeRunV260", map(json!({"type":"1"})), None).await?;
            gates(&r["data"], &j.mode)?;
            if j.mode == "campus" && text(&r["data"], "game_id") != data.zone.id.clone() {
                return Err("服务端跑区已变化，请重新选择跑区".into());
            }
            j.progress().rules = Some(r["data"].clone());
            r
        }
        "timestamp" => {
            let rules = j.progress().rules.clone().ok_or("学校规则未加载")?;
            let r = job_call(
                &j,
                "Run/getTimestampV278",
                map(json!({"game_id":text(&rules,"game_id")})),
                None,
            )
            .await?;
            let server = number(&r["data"], "timestamp") as i64;
            if server <= 0 || (server - now()).abs() >= 86400 {
                return Err("服务端时间无效，请检查系统时钟".into());
            }
            let mut s = j.progress();
            s.clock = server - now();
            s.time_str = text(&r["data"], "str");
            if s.time_str.is_empty() {
                return Err("服务端未返回提交校验字符串".into());
            }
            r
        }
        "device_check" => job_call(&j, "Run2/checkUserDeviceV278", BTreeMap::new(), None).await?,
        "register_points" => {
            let ids = args["pointIds"].as_array().ok_or("打卡点无效")?;
            if ids.len() > 100 || ids.iter().any(|v| v.as_u64().is_none()) {
                return Err("打卡点无效".into());
            }
            job_call(
                &j,
                "Run2/getStudentVenaPoint",
                map(json!({"point_info":ids.to_vec()})),
                None,
            )
            .await?
        }
        "location" => {
            let lat = number(&args, "lat");
            let lng = number(&args, "lng");
            if !lat.is_finite() || !lng.is_finite() || lat.abs() > 85. || lng.abs() > 180. {
                return Err("心跳坐标无效".into());
            }
            let rules = j.progress().rules.clone().ok_or("学校规则未加载")?;
            job_call(&j,"Run/setRunLocationRecord",map(json!({"latitude":format!("{lat:.5}"),"longitude":format!("{lng:.5}"),"game_id":text(&rules,"game_id"),"point_ids":text(&args,"pointIds")})),None).await?
        }
        "upload_track" | "replace_track" => {
            let points: Vec<Point> =
                serde_json::from_value(args["points"].clone()).map_err(|_| "轨迹格式无效")?;
            validate_points(&points)?;
            let k = if action == "replace_track" {
                let k = j.progress().track_key.clone();
                if k.is_empty() {
                    return Err("未找到待更新轨迹".into());
                }
                k
            } else {
                key("file/run_record", "txt")
            };
            let mut encoded = track_json(&points);
            if let Some(indices) = args["pauseIndices"].as_array() {
                for i in indices {
                    let index = i.as_u64().ok_or("暂停点无效")? as usize;
                    if index >= points.len() {
                        return Err("暂停点超出轨迹".into());
                    }
                    encoded[index]["p"] = json!(1);
                }
            }
            upload(&j, &k, encrypted(&encoded.to_string())?, "text/plain").await?;
            guard(&j, &store)?;
            let mut img = String::new();
            if action == "upload_track" {
                let png = text(&args, "previewPng");
                if !png.is_empty() {
                    let raw = png.strip_prefix("data:image/png;base64,").unwrap_or(&png);
                    if raw.len() > 3 * 1024 * 1024 {
                        return Err("预览图过大".into());
                    }
                    let bytes = B64.decode(raw).map_err(|_| "预览图编码无效")?;
                    if !bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
                        return Err("预览图必须为 PNG".into());
                    }
                    img = key("pic/run_photo_screenshotImage", "png");
                    upload(&j, &img, bytes, "image/png").await?;
                }
            }
            let mut s = j.progress();
            s.track_key = k.clone();
            s.points = points;
            if !img.is_empty() {
                s.image_key = img.clone()
            }
            json!({"recordFileKey":k,"fileImgKey":s.image_key,"ok":true})
        }
        "upload_sensor" => {
            let raw = text(&args, "sensorJson");
            validate_sensor(&raw)?;
            let k = key("file/run_gyroscope", "txt");
            upload(&j, &k, encrypted(&raw)?, "text/plain").await?;
            j.progress().sensor_key = k.clone();
            json!({"key":k})
        }
        "face" => {
            let photos = crate::faces::run_photos(&store, &data.account.uid.clone())?;
            if photos.is_empty() {
                return Err("请先添加本人照片".into());
            }
            let index = number(&args, "photoIndex") as usize % photos.len();
            let (bytes, mime) = &photos[index];
            if mime != "image/jpeg" {
                return Err("人脸核验需要 JPEG 照片，请重新添加照片".into());
            }
            let typ = number(&args, "verifyType") as u8;
            if typ > 3 {
                return Err("人脸核验阶段无效".into());
            }
            let bytes = exif_comment(bytes, &data.account.uid.clone())?;
            let k = key("pic/face_verify", "jpg");
            upload(&j, &k, bytes, "image/jpeg").await?;
            guard(&j, &store)?;
            let mut p = map(json!({"face_file":k,"type":typ.to_string()}));
            let prior = text(&args, "priorId");
            if !prior.is_empty() {
                p.insert("run_face_verify_id".into(), prior);
            }
            let r = job_call(&j, "Run2/faceVerify", p, None).await?;
            let id = text(&r["data"], "run_face_verify_id");
            if id.is_empty() {
                return Err("核验响应缺少有效编号".into());
            }
            json!({"id":id})
        }
        "capture" => {
            let photos = crate::faces::run_photos(&store, &data.account.uid.clone())?;
            if photos.is_empty() {
                return Err("本跑区需要本人抓拍照片，请先添加照片".into());
            }
            let (bytes, mime) = &photos[number(&args, "photoIndex") as usize % photos.len()];
            let k = key(
                "pic/run_photo",
                if mime == "image/jpeg" { "jpg" } else { "png" },
            );
            upload(&j, &k, bytes.clone(), mime).await?;
            j.progress().capture_key = k.clone();
            let mut miss = Value::Null;
            if args["isCaptureZone"] == true {
                let r=job_call(&j,"Run2/getCaptureStatus",map(json!({"start_time":args["startTime"],"distance":text(&args,"distance"),"game_id":text(&args,"gameId"),"point_ids":args["pointIds"].as_array().map(|a|a.iter().map(Value::to_string).collect::<Vec<_>>().join(",")).unwrap_or_default()})),None).await?;
                miss = r["data"]["miss_num"].clone();
            }
            json!({"key":k,"miss":miss})
        }
        "submit_free" | "submit_campus" => {
            if (action == "submit_campus") != (j.mode == "campus") {
                return Err("提交类型不匹配".into());
            }
            let p = submit_fields(&j, &args)?;
            guard(&j, &store)?;
            {
                let mut s = j.progress();
                s.submission_ready()?;
                store.try_update(|v| {
                    if !same(v, data) {
                        return Err("账号已变化，未提交".into());
                    }
                    crate::receipts::replace(
                        v,
                        data.account.uid.clone(),
                        Receipt {
                            job_id: JobId(id.clone()),
                            mode: j.mode.clone(),
                            time: now(),
                            ..Default::default()
                        },
                    );
                    Ok(())
                })?;
                s.status = TaskStatus::Submitting;
            }
            let endpoint = if j.mode == "campus" {
                "Run/stopRunV278"
            } else {
                "Run/stopFreeRunV220"
            };
            match job_call(&j, endpoint, p, None).await {
                Ok(r) => {
                    let mut s = j.progress();
                    s.check()?;
                    s.submit = Some(r.clone());
                    s.status = TaskStatus::Submitted;
                    store.update(|v| {
                        if let Some(receipt) = v.run_receipts.get_mut(&data.account.uid.clone()) {
                            if receipt.job_id.as_str() == id {
                                receipt.record_id = Some(RecordId(text(&r["data"], "record_id")));
                            }
                        }
                    })?;
                    r
                }
                Err(e) => {
                    let mut s = j.progress();
                    s.status = TaskStatus::Unknown;
                    s.error = format!(
                        "提交请求已发出，但未得到可确认结果：{e}。请先检查服务端记录，勿重复提交"
                    );
                    return Err(s.error.clone().into());
                }
            }
        }
        "gyro_link" => {
            let (sid, k) = {
                let s = j.progress();
                (
                    s.submit
                        .as_ref()
                        .map(|r| text(&r["data"], "record_id"))
                        .unwrap_or_default(),
                    s.sensor_key.clone(),
                )
            };
            if sid.is_empty() || k.is_empty() {
                return Err("记录编号或传感器文件缺失".into());
            }
            let r = job_call(
                &j,
                "Run2/gyroscope",
                map(json!({"record_id":sid,"gyroscope_file":k})),
                None,
            )
            .await?;
            j.progress().gyro_linked = true;
            r
        }
        "complete" => {
            let submitted = j.progress().submit.clone();
            let mut result = if let Some(r) = submitted {
                r
            } else {
                let mut s = j.progress();
                s.status = TaskStatus::Failed;
                s.error = crate::session::ApiError::from(text(&args, "error")).message;
                return Ok(json!({"status":0,"info":s.error}));
            };
            let record_id = text(&result["data"], "record_id");
            let mut verified = false;
            if !record_id.is_empty() {
                if let Ok(detail) = job_call(
                    &j,
                    "Run/recordDetailV270",
                    map(json!({"record_id":record_id})),
                    None,
                )
                .await
                {
                    if !text(&detail["data"], "record_status").is_empty() {
                        result["data"]["record_status"] = detail["data"]["record_status"].clone();
                        verified = true;
                    }
                }
            }
            let status = text(&result["data"], "record_status");
            let gyro_ok = {
                let s = j.progress();
                number(s.rules.as_ref().ok_or("学校规则未加载")?, "gyroscope_type") <= 0.
                    || s.gyro_linked
                    || j.mode == "free"
            };
            result["recordOk"] = json!(status == "1" && gyro_ok && !record_id.is_empty());
            result["verified"] = json!(verified);
            result["humanStatus"] = json!(if record_id.is_empty() {
                "请求已发送，但服务端未返回记录编号，请到记录页复查，勿重复提交".to_string()
            } else if !gyro_ok {
                format!("记录 #{record_id} 已提交，但传感器关联失败，请复查成绩，勿重复提交")
            } else if status == "1" {
                format!("已提交，服务端返回有效成绩，记录 #{record_id}")
            } else if status.is_empty() {
                format!("已提交，成绩状态待确认，请到记录页复查 #{record_id}")
            } else {
                format!("已提交，但服务端成绩状态为 {status}，记录 #{record_id}")
            });
            let mut s = j.progress();
            s.check()?;
            crate::receipts::complete(
                &store,
                &data.account.uid.clone(),
                &j.id,
                RecordId(record_id),
                result.clone(),
            )?;
            s.status = TaskStatus::Done;
            s.result = result.clone();
            result
        }
        _ => return Err("未开放的任务操作".into()),
    };
    if !matches!(
        action.as_str(),
        "submit_free" | "submit_campus" | "gyro_link" | "complete"
    ) {
        guard(&j, &store)?;
    }
    Ok(result)
}

pub(super) fn submit_fields(
    j: &Job,
    o: &Value,
) -> Result<BTreeMap<String, String>, crate::error::ApiError> {
    let s = j.progress();
    let rules = s.rules.as_ref().ok_or("规则未获取")?;
    let duration = number(o, "durationS");
    let start = number(o, "startTs");
    let end = number(o, "endTs");
    let steps = number(o, "stepNum");
    let dist = number(o, "distanceM");
    if s.track_key.is_empty()
        || s.points.len() < 2
        || ![duration, start, end, steps, dist]
            .iter()
            .all(|v| v.is_finite())
        || duration < 1.
        || duration > 14400.
        || steps < 1.
        || steps > 100000.
        || (end - start - duration).abs() > 1.
        || end > (now() + s.clock) as f64
        || end < (now() + s.clock - 300) as f64
        || (distance(&s.points) - dist).abs() > 2.
        || (s.points.last().unwrap().t - duration).abs() > 2.
    {
        return Err("提交时间、轨迹或统计数据不一致，未发送记录".into());
    }
    let uid = j.data.account.uid.clone();
    let mut p = map(
        json!({"distance":format!("{:.2}",dist/1000.),"start_time":start as i64,"end_time":end as i64,"used_time":duration as u64,"step_num":steps as u64,"student_num":text(&j.data.account,"studentNum"),"step_info":step_info(duration as u64,steps as u64),"record_file":s.track_key,"file_img":if s.image_key.is_empty(){"1"}else{&s.image_key},"record_img":"","newMobileDeviceId":"","record_str":record_str(&j.data,&s.time_str)?,"run_check_res":run_check(&uid,&rules["run_check"],steps as u64,&s.points)?,"gee_token":"","ip":crate::store::device_view(&j.data)["localIp"],"pass_total":"0","pass_effective_num":"0"}),
    );
    if j.mode == "campus" {
        if number(rules, "gyroscope_type") > 0. && s.sensor_key.is_empty() {
            return Err("学校要求传感器文件，但尚未上传".into());
        }
        for k in ["termId", "gameId"] {
            let expected = text(rules, if k == "termId" { "term_id" } else { "game_id" });
            if text(o, k) != expected {
                return Err("学期或跑区不一致".into());
            }
        }
        p.extend(map(json!({"school_id":j.data.school_id,"term_id":text(rules,"term_id"),"game_id":text(rules,"game_id"),"log_data":text(o,"logData"),"pass_total":o["passTotal"],"pass_effective_num":o["passEffectiveNum"],"is_running_area_valid":text(o,"isRunningAreaValid"),"record_img":s.capture_key,"is_timeout_zfb":"0"})));
        let fc = &rules["run_face_verify_config"];
        let face = text(o, "faceVerifyId");
        if ["start_status", "middle_status", "stop_status"]
            .iter()
            .any(|k| number(fc, k) == 1.)
            && number(fc, "face_verify_type") == 1.
            && face.is_empty()
        {
            return Err("缺少学校要求的人脸核验结果".into());
        }
        p.insert(
            "run_face_verify_id".into(),
            if face.is_empty() {
                "1231231231231".into()
            } else {
                face
            },
        );
        if number(rules, "is_check_device") == 1. {
            let dev = crate::store::device_view(&j.data);
            for k in ["oaid", "mac"] {
                let v = text(&dev, k);
                if !v.is_empty() {
                    p.insert(k.into(), v);
                }
            }
        }
    }
    Ok(p)
}
pub(super) fn exif_comment(jpeg: &[u8], uid: &str) -> Result<Vec<u8>, crate::error::ApiError> {
    if !jpeg.starts_with(&[255, 216]) {
        return Err("人脸照片必须为 JPEG".into());
    }
    let mut body = b"ASCII\0\0\0".to_vec();
    body.extend_from_slice(format!("{:x}", Md5::digest(uid.trim().as_bytes())).as_bytes());
    let mut tiff = vec![];
    tiff.extend_from_slice(b"MM\0*\0\0\0\x08\0\x01\x92\x86\0\x07");
    tiff.extend_from_slice(&(body.len() as u32).to_be_bytes());
    tiff.extend_from_slice(&26u32.to_be_bytes());
    tiff.extend_from_slice(&0u32.to_be_bytes());
    tiff.extend(body);
    let mut seg = b"Exif\0\0".to_vec();
    seg.extend(tiff);
    let mut out = vec![255, 216, 255, 225];
    out.extend_from_slice(&((seg.len() + 2) as u16).to_be_bytes());
    out.extend(seg);
    let mut off = 2;
    while off + 4 <= jpeg.len() {
        if jpeg[off] != 255 {
            return Err("JPEG 结构无效".into());
        }
        let marker = jpeg[off + 1];
        if marker == 218 {
            out.extend_from_slice(&jpeg[off..]);
            return Ok(out);
        }
        let len = u16::from_be_bytes([jpeg[off + 2], jpeg[off + 3]]) as usize;
        if len < 2 || off + 2 + len > jpeg.len() {
            return Err("JPEG 段无效".into());
        }
        if !(marker == 225 && jpeg.get(off + 4..off + 10) == Some(b"Exif\0\0")) {
            out.extend_from_slice(&jpeg[off..off + 2 + len]);
        }
        off += 2 + len;
    }
    Err("JPEG 数据不完整".into())
}
