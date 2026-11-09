use super::*;
#[cfg(test)]
mod tests {
    use super::*;
    fn points() -> Vec<Point> {
        vec![
            Point {
                lat: 28.,
                lng: 112.,
                speed: 3.,
                t: 0.,
            },
            Point {
                lat: 28.001,
                lng: 112.,
                speed: 3.,
                t: 40.,
            },
        ]
    }
    fn job() -> Job {
        let mut data = Data::default();
        data.account = serde_json::from_value(json!({"uid":"2468","token":"test"})).unwrap();
        data.school_id = "297".into();
        Job {
            id: JobId("test".into()),
            data,
            mode: "free".into(),
            state: Mutex::new(Progress {
                status: TaskStatus::Running,
                rules: Some(json!({"game_id":"z","term_id":"t"})),
                time_str: "mock-time".into(),
                track_key: "mock-file".into(),
                points: points(),
                ..Default::default()
            }),
        }
    }
    #[test]
    fn cancelled_step_blocks_other_jobs_until_inflight_step_exits() {
        let j = job();
        let step = j.step().unwrap();
        assert!(j.step().is_err());
        j.cancel().unwrap();
        assert!(j.blocking());
        assert!(j.progress().submission_ready().is_err());
        assert!(j.step().is_err());
        drop(step);
        assert!(!j.blocking());
    }
    #[test]
    fn cancellation_and_submission_share_one_atomic_transition() {
        let j = Arc::new(job());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let a = j.clone();
        let b = barrier.clone();
        let submit = std::thread::spawn(move || {
            b.wait();
            let mut state = a.progress();
            if state.submission_ready().is_ok() {
                state.status = TaskStatus::Submitting;
                true
            } else {
                false
            }
        });
        let a = j.clone();
        let b = barrier.clone();
        let cancel = std::thread::spawn(move || {
            b.wait();
            a.cancel().is_ok()
        });
        barrier.wait();
        let submitted = submit.join().unwrap();
        let cancelled = cancel.join().unwrap();
        assert_ne!(submitted, cancelled);
        let state = j.progress();
        assert!(matches!(
            state.status,
            TaskStatus::Submitting | TaskStatus::Cancelled
        ));
        assert!(state.submission_ready().is_err());
    }
    #[test]
    fn poison_stops_task_but_does_not_release_inflight_execution_or_resend() {
        for submitted in [false, true] {
            let j = Arc::new(job());
            let runs = Runs(Mutex::new(VecDeque::from([j.clone()])));
            j.progress().executing = true;
            let execution = state::Execution(j.clone());
            if submitted {
                j.progress().status = TaskStatus::Submitting;
            }
            let step = j.step().unwrap();
            assert!(std::panic::catch_unwind(|| {
                let _state = j.state.lock().unwrap();
                panic!("synthetic poisoned task");
            })
            .is_err());
            let status = if submitted {
                TaskStatus::Unknown
            } else {
                TaskStatus::Failed
            };
            assert_eq!(j.progress().status, status);
            assert!(j.progress().faulted);
            assert!(!j.state.is_poisoned());
            assert!(j.blocking());
            assert!(ensure_idle(&runs).is_err());
            assert!(j.step().is_err());
            drop(step);
            assert!(j.blocking());
            drop(execution);
            assert!(!j.blocking());
            assert!(ensure_idle(&runs).is_ok());
            assert_eq!(j.progress().status, status);
            assert!(j.progress().submission_ready().is_err());
        }
    }
    #[test]
    fn step_unwind_and_executor_drop_release_occupancy_without_reviving_task() {
        let j = Arc::new(job());
        j.progress().executing = true;
        let execution = state::Execution(j.clone());
        assert!(std::panic::catch_unwind(|| {
            let _step = j.step().unwrap();
            panic!("synthetic step failure");
        })
        .is_err());
        assert!(!j.progress().busy);
        assert_eq!(j.progress().status, TaskStatus::Failed);
        assert!(j.blocking());
        drop(execution);
        assert!(!j.blocking());
        let j = Arc::new(job());
        j.progress().executing = true;
        let execution = state::Execution(j.clone());
        j.progress().status = TaskStatus::Done;
        drop(execution);
        assert_eq!(j.progress().status, TaskStatus::Done);
    }
    #[test]
    fn record_signature_matches_supplied_exe_including_i32_wrapping() {
        let v: Value = serde_json::from_str(include_str!("../run-vectors.json")).unwrap();
        for row in v["recordStrings"].as_array().unwrap() {
            let mut d = Data::default();
            d.account = serde_json::from_value(json!({"uid":row["uid"].to_string()})).unwrap();
            d.school_id = row["school"].to_string();
            assert_eq!(
                record_str(&d, row["time"].as_str().unwrap()).unwrap(),
                row["expected"]
            );
        }
    }
    #[test]
    fn route_encoding_marks_distance_and_does_not_export_timestamps() {
        let p = points();
        let v = track_json(&p);
        assert!(v[1]["d"].as_f64().unwrap() > 0.);
        assert!(v[1].get("t").is_none());
        let enc = encrypted(&v.to_string()).unwrap();
        let c = network::cfg();
        assert_eq!(
            network::decrypt(std::str::from_utf8(&enc).unwrap(), &c.key_trk, &c.iv_trk).unwrap(),
            v.to_string()
        );
    }
    #[test]
    fn invalid_tracks_and_sensors_rejected() {
        let mut p = points();
        assert!(validate_points(&p).is_ok());
        p[1].t = 0.;
        assert!(validate_points(&p).is_err());
        p[1].t = 40.;
        p[0].lat = f64::NAN;
        assert!(validate_points(&p).is_err());
        assert!(validate_sensor("[]").is_err());
        assert!(validate_sensor("not json").is_err());
    }
    #[test]
    fn same_position_with_later_time_is_valid_but_equal_time_is_not() {
        let mut p = points();
        p[1].lat = p[0].lat;
        p[1].lng = p[0].lng;
        assert!(validate_points(&p).is_ok());
        p[1].t = p[0].t;
        assert!(validate_points(&p).is_err());
        p[1].t = -1.;
        assert!(validate_points(&p).is_err());
    }
    #[test]
    fn step_info_sums_exactly_to_total() {
        for (d, s) in [(1, 2), (61, 165), (1199, 3201)] {
            let v: Value = serde_json::from_str(&step_info(d, s)).unwrap();
            assert_eq!(
                v["list"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap())
                    .sum::<u64>(),
                s
            );
        }
    }
    #[test]
    fn extra_verification_is_blocked_before_upload() {
        let base = json!({"game_id":"z","term_id":"t"});
        assert!(gates(&base, "campus").is_ok());
        for key in [
            "is_check_geetest",
            "is_check_geedevice",
            "is_check_deepknow",
            "is_check_shumeng",
        ] {
            let mut v = base.clone();
            v[key] = json!(1);
            assert!(gates(&v, "campus").is_err());
        }
        let mut v = base;
        v["run_face_verify_config"] = json!({"start_status":1,"face_verify_type":2});
        assert!(gates(&v, "campus").is_ok());
        v["run_face_verify_config"]["face_verify_type"] = json!(3);
        assert!(gates(&v, "campus").is_err());
    }
    #[test]
    fn account_changes_and_cancellation_stop_frozen_job() {
        let j = job();
        let test_root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let store = Store::open(test_root.join("settings.dpapi")).unwrap();
        store.update(|d| *d = j.data.clone()).unwrap();
        assert!(guard(&j, &store).is_ok());
        store.update(|d| d.account.uid = "other".into()).unwrap();
        assert!(guard(&j, &store).is_err());
        store.update(|d| *d = j.data.clone()).unwrap();
        j.progress().cancelled = true;
        assert!(guard(&j, &store).is_err());
    }
    #[test]
    fn submit_payload_uses_owned_files_and_rejects_inconsistent_duration() {
        let j = job();
        let end = now() - 5;
        let o = json!({"durationS":40,"startTs":end-40,"endTs":end,"stepNum":100,"distanceM":distance(&points()),"recordFile":"untrusted"});
        let p = submit_fields(&j, &o).unwrap();
        assert_eq!(p["record_file"], "mock-file");
        let mut bad = o;
        bad["durationS"] = json!(400);
        assert!(submit_fields(&j, &bad).is_err());
    }
    #[test]
    fn interrupted_receipts_are_account_scoped() {
        let mut d = Data::default();
        d.account = serde_json::from_value(json!({"uid":"A"})).unwrap();
        d.run_receipts.insert(
            "A".into(),
            Receipt {
                job_id: JobId("one".into()),
                ..Default::default()
            },
        );
        assert!(pending_receipt(&d));
        d.account.uid = "B".to_string();
        d.run_receipts.insert(
            "B".into(),
            Receipt {
                status: ReceiptStatus::Done,
                ..Default::default()
            },
        );
        assert!(!pending_receipt(&d));
        d.account.uid = "A".to_string();
        assert!(pending_receipt(&d));
    }
    #[test]
    fn jpeg_comment_matches_uid_digest_and_replaces_old_exif() {
        let src = [255, 216, 255, 218, 0, 2, 255, 217];
        let once = exif_comment(&src, "2468").unwrap();
        assert!(once
            .windows(32)
            .any(|s| s == format!("{:x}", Md5::digest(b"2468")).as_bytes()));
        assert_eq!(once, exif_comment(&once, "2468").unwrap());
        assert!(exif_comment(b"invalid", "2468").is_err());
    }
    #[test]
    fn date_conversion() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(20761), (2026, 11, 4));
    }
    #[test]
    fn run_settings_have_finite_bounds() {
        assert_eq!(
            run_config(&Default::default())
                .unwrap()
                .straight_speed
                .unwrap(),
            4.1
        );
        assert!(run_config(&serde_json::from_value(json!({"straightSpeed":0})).unwrap()).is_err());
        assert!(
            run_config(&serde_json::from_value(json!({"replayDelayMs":5001})).unwrap()).is_err()
        );
    }
}

#[cfg(test)]
mod live_preflight {
    use super::*;
    #[test]
    #[ignore]
    fn saved_account_rules_without_submission() {
        let path = crate::data_root::root().unwrap().join("settings.dpapi");
        let store = Store::open(path).unwrap();
        let d = snapshot(&store).unwrap();
        tauri::async_runtime::block_on(async {
            let r = network::call(&d, "Run2/beforeRunV260", map(json!({"type":"1"})), None)
                .await
                .unwrap();
            let rules = &r["data"];
            assert!(!text(rules, "game_id").is_empty());
            let t = network::call(
                &d,
                "Run/getTimestampV278",
                map(json!({"game_id":text(rules,"game_id")})),
                None,
            )
            .await
            .unwrap();
            assert!(number(&t["data"], "timestamp") > 0.);
            assert!(!text(&t["data"], "str").is_empty());
            println!(
                "只读规则与校时成功；校园跑所需人工核验限制：{}；未发送心跳、照片、轨迹或成绩",
                gates(rules, "campus")
                    .err()
                    .unwrap_or_else(|| "未发现已知限制，仍需本人主动提交验收".into())
            );
        });
    }
}

#[cfg(test)]
mod progress_retention_tests {
    use super::*;
    #[test]
    fn rolling_logs_keep_monotonic_cursor() {
        let mut s = Progress::default();
        for i in 0..2007 {
            s.push_log(i.to_string());
        }
        assert_eq!(s.logs.len(), 2000);
        assert_eq!(s.log_start, 7);
        assert_eq!(s.logs[0], "7");
        assert_eq!(s.logs.last().unwrap(), "2006");
    }
}

#[cfg(test)]
mod finish_race_tests {
    use super::*;
    #[test]
    fn photo_reply_cannot_revive_cancelled_or_failed_job() {
        for status in [TaskStatus::Cancelled, TaskStatus::Failed, TaskStatus::Done] {
            let mut s = Progress {
                status,
                ..Default::default()
            };
            s.finish_photo_check(false, json!({"ok":true}));
            assert_eq!(s.status, status);
            assert!(s.result.is_null());
        }
        let mut s = Progress {
            status: TaskStatus::Running,
            ..Default::default()
        };
        s.finish_photo_check(true, json!({"ok":true}));
        assert!(s.result.is_null());
        s.finish_photo_check(false, json!({"ok":true}));
        assert_eq!(s.status, TaskStatus::Done);
    }
}
