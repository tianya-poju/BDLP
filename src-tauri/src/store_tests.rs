use super::*;
fn fixture() -> (PathBuf, Store) {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let s = Store::open(root.join("settings.dpapi")).unwrap();
    (root, s)
}
#[test]
fn no_op_keeps_snapshot_and_disk_unchanged() {
    let (root, s) = fixture();
    s.update(|d| d.school_id = "1".into()).unwrap();
    let before = s.data.lock().unwrap();
    let bytes = fs::read(&s.path).unwrap();
    for _ in 0..30 {
        s.update(|_| {}).unwrap();
    }
    assert!(Arc::ptr_eq(&before, &s.data.lock().unwrap()));
    assert_eq!(bytes, fs::read(&s.path).unwrap());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn failed_disk_commit_never_publishes_new_state() {
    let (root, s) = fixture();
    s.update(|d| d.school_id = "old".into()).unwrap();
    fs::rename(&s.path, root.join("original")).unwrap();
    fs::create_dir(&s.path).unwrap();
    let before = s.data.lock().unwrap();
    assert!(s.update(|d| d.school_id = "new".into()).is_err());
    assert!(Arc::ptr_eq(&before, &s.data.lock().unwrap()));
    assert_eq!(s.data.lock().unwrap().school_id, "old");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn readers_see_committed_snapshot_while_writer_is_busy_and_writes_serialize() {
    let (root, s) = fixture();
    let s = Arc::new(s);
    let (entered, waiting) = std::sync::mpsc::channel();
    let (resume, paused) = std::sync::mpsc::channel();
    let writer = s.clone();
    let t = std::thread::spawn(move || {
        writer
            .update(|d| {
                d.school_id = "first".into();
                entered.send(()).unwrap();
                paused.recv().unwrap();
            })
            .unwrap()
    });
    waiting.recv().unwrap();
    let reader = s.clone();
    let (result, received) = std::sync::mpsc::channel();
    let r = std::thread::spawn(move || {
        result
            .send(reader.data.lock().unwrap().school_id.clone())
            .unwrap()
    });
    let read = received.recv_timeout(std::time::Duration::from_secs(1));
    resume.send(()).unwrap();
    t.join().unwrap();
    r.join().unwrap();
    assert_eq!(read.unwrap(), "");
    let mut threads = vec![];
    for _ in 0..8 {
        let s = s.clone();
        threads.push(std::thread::spawn(move || {
            for _ in 0..5 {
                s.update(|d| {
                    let n = d
                        .extra
                        .get("counter")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    d.extra.insert("counter".into(), (n + 1).into());
                })
                .unwrap();
            }
        }));
    }
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(s.data.lock().unwrap().extra["counter"], 40);
    assert_eq!(
        Store::open(s.path.clone())
            .unwrap()
            .data
            .lock()
            .unwrap()
            .extra["counter"],
        40
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn legacy_unknown_fields_survive_and_invalid_data_is_never_replaced() {
    let (root, s) = fixture();
    fs::create_dir_all(&root).unwrap();
    let old=br#"{"account":{"uid":123,"token":"synthetic","future":true},"zone":null,"device":null,"run_config":null,"extension":{"v":4}}"#;
    fs::write(&s.path, protect(old, false).unwrap()).unwrap();
    let s = Store::open(s.path).unwrap();
    s.update(|d| d.school_id = "2".into()).unwrap();
    let d = Store::open(s.path.clone()).unwrap().data.lock().unwrap();
    assert_eq!(d.account.uid, "123");
    assert_eq!(d.extra["extension"]["v"], 4);
    assert_eq!(d.account.extra["future"], true);
    let invalid = protect(br#"{"account":{"uid":[]}}"#, false).unwrap();
    fs::write(&s.path, &invalid).unwrap();
    assert!(Store::open(s.path.clone()).is_err());
    assert_eq!(fs::read(&s.path).unwrap(), invalid);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn synthetic_snapshot_measurement() {
    let (root, s) = fixture();
    s.update(|d| {
        for i in 0..200 {
            let mut p = crate::accounts::Profile::default();
            p.route = vec![[28., 112.]; 1000];
            d.profiles.insert(i.to_string(), p);
        }
    })
    .unwrap();
    let start = std::time::Instant::now();
    for _ in 0..500 {
        std::hint::black_box(s.data.lock().unwrap());
    }
    let snapshots = start.elapsed();
    let start = std::time::Instant::now();
    for _ in 0..500 {
        std::hint::black_box((*s.data.lock().unwrap()).clone());
    }
    let clones = start.elapsed();
    println!("synthetic: 200 profiles x 1000 points; 500 reads: Arc snapshot {:?}, full clone {:?}; no-op updates: 30 requests, 0 persisted changes (separate assertion)",snapshots,clones);
    fs::remove_dir_all(root).unwrap();
}
