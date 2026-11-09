//! Recoverable deletion: encrypted journal, same-volume quarantine, persisted commit marker.
use crate::store::{protect, Store};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
#[derive(Serialize, Deserialize)]
struct Journal {
    id: String,
    uid: String,
}
fn root(store: &Store) -> Result<PathBuf, crate::error::ApiError> {
    Ok(store
        .path
        .parent()
        .ok_or("数据目录无效")?
        .join("pending-deletions"))
}
fn paths(
    store: &Store,
    j: &Journal,
) -> Result<(PathBuf, PathBuf, PathBuf), crate::error::ApiError> {
    uuid::Uuid::parse_str(&j.id)
        .map_err(|_| crate::error::ApiError::storage("删除恢复记录无效"))?;
    Ok((
        crate::faces::directory(store, &j.uid)?,
        root(store)?.join(&j.id),
        root(store)?.join(format!("{}.bin", j.id)),
    ))
}
fn clean(dir: &Path) -> Result<(), crate::error::ApiError> {
    if !dir.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(dir)
        .map_err(|_| crate::error::ApiError::storage("照片清理待重试"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| crate::error::ApiError::storage("照片清理待重试"))?;
    for e in &entries {
        let t = e
            .file_type()
            .map_err(|_| crate::error::ApiError::storage("照片清理待重试"))?;
        let name = e.file_name().to_string_lossy().to_string();
        if !t.is_file() || !(crate::faces::valid_name(&name) || name == "reference.bin") {
            return Err("照片目录包含异常项目，已保留等待处理".into());
        }
    }
    for e in entries {
        fs::remove_file(e.path()).map_err(|_| crate::error::ApiError::storage("照片清理待重试"))?;
    }
    fs::remove_dir(dir).map_err(|_| "照片清理待重试".into())
}
fn finish(store: &Store, j: &Journal) -> Result<(), crate::error::ApiError> {
    let (original, quarantine, journal) = paths(store, j)?;
    if store.data.lock()?.pending_deletions.contains(&j.id) {
        clean(&quarantine)?;
    } else if quarantine.exists() {
        if original.exists() {
            return Err("照片恢复目标已存在，已保留隔离副本".into());
        }
        fs::rename(&quarantine, &original)
            .map_err(|_| crate::error::ApiError::storage("照片恢复失败，隔离副本已保留"))?;
    }
    store.update(|d| {
        d.pending_deletions.remove(&j.id);
    })?;
    if journal.exists() {
        fs::remove_file(journal)
            .map_err(|_| crate::error::ApiError::storage("删除恢复记录清理待重试"))?;
    }
    Ok(())
}
pub(crate) fn recover(store: &Store) -> Result<(), crate::error::ApiError> {
    let dir = root(store)?;
    if !dir.exists() {
        return Ok(());
    }
    let _files = store
        .files
        .lock()
        .map_err(|_| crate::error::ApiError::storage("照片库正在恢复"))?;
    for e in
        fs::read_dir(dir).map_err(|_| crate::error::ApiError::storage("无法读取删除恢复记录"))?
    {
        let e = e.map_err(|_| crate::error::ApiError::storage("无法读取删除恢复记录"))?;
        if e.path().extension().and_then(|x| x.to_str()) != Some("bin") {
            continue;
        }
        if !e
            .file_type()
            .map_err(|_| crate::error::ApiError::storage("删除恢复记录无效"))?
            .is_file()
        {
            return Err("删除恢复记录无效".into());
        }
        let j: Journal = serde_json::from_slice(&protect(
            &fs::read(e.path())
                .map_err(|_| crate::error::ApiError::storage("删除恢复记录无法读取"))?,
            true,
        )?)
        .map_err(|_| crate::error::ApiError::storage("删除恢复记录损坏，未清理照片"))?;
        if paths(store, &j)?.2 != e.path() {
            return Err("删除恢复记录路径不匹配".into());
        }
        if let Err(error) = finish(store, &j) {
            // Committed account removal is safe to use while cleanup waits for the next launch.
            if !store.data.lock()?.pending_deletions.contains(&j.id) {
                return Err(error);
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Store, PathBuf) {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let s = Store::open(root.join("settings.dpapi")).unwrap();
        s.update(|d| {
            d.account.uid = "a".into();
            d.account.token = "synthetic".into();
        })
        .unwrap();
        let photos = crate::faces::directory(&s, "a").unwrap();
        fs::create_dir_all(&photos).unwrap();
        fs::write(photos.join("reference.bin"), b"synthetic-photo").unwrap();
        (root, s, photos)
    }
    fn interrupted(s: &Store, photos: &Path) -> Journal {
        let j = Journal {
            id: uuid::Uuid::new_v4().to_string(),
            uid: "a".into(),
        };
        let (_, q, path) = paths(s, &j).unwrap();
        fs::create_dir_all(root(s).unwrap()).unwrap();
        fs::write(
            path,
            protect(&serde_json::to_vec(&j).unwrap(), false).unwrap(),
        )
        .unwrap();
        fs::rename(photos, q).unwrap();
        j
    }
    #[test]
    fn account_save_failure_restores_photos_and_keeps_account() {
        let (root, s, p) = fixture();
        fs::rename(&s.path, root.join("original.dpapi")).unwrap();
        fs::create_dir(&s.path).unwrap();
        assert!(remove(&s, "a").is_err());
        assert_eq!(s.data.lock().unwrap().account.uid, "a");
        assert_eq!(
            fs::read(p.join("reference.bin")).unwrap(),
            b"synthetic-photo"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_uncommitted_deletion_is_restored_on_reopen() {
        let (root, s, p) = fixture();
        let j = interrupted(&s, &p);
        drop(s);
        let s = Store::open(root.join("settings.dpapi")).unwrap();
        recover(&s).unwrap();
        assert!(p.join("reference.bin").exists());
        assert!(!paths(&s, &j).unwrap().2.exists());
        assert_eq!(s.data.lock().unwrap().account.uid, "a");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn committed_cleanup_is_retryable_and_never_deletes_unknown_files() {
        let (root, s, p) = fixture();
        let j = interrupted(&s, &p);
        let (_, q, _) = paths(&s, &j).unwrap();
        fs::write(q.join("unknown.txt"), b"preserve").unwrap();
        s.update(|d| {
            crate::accounts::logout(d, true);
            d.pending_deletions.insert(j.id.clone());
        })
        .unwrap();
        recover(&s).unwrap();
        assert!(q.join("reference.bin").exists());
        assert!(s.data.lock().unwrap().pending_deletions.contains(&j.id));
        fs::remove_file(q.join("unknown.txt")).unwrap();
        recover(&s).unwrap();
        assert!(!q.exists());
        assert!(s.data.lock().unwrap().pending_deletions.is_empty());
        assert!(s.data.lock().unwrap().account.uid.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn complete_removal_cleans_only_selected_account() {
        let (root, s, p) = fixture();
        let other = crate::faces::directory(&s, "b").unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("reference.bin"), b"keep").unwrap();
        assert!(!remove(&s, "a").unwrap());
        assert!(!p.exists());
        assert!(other.exists());
        assert!(s.data.lock().unwrap().account.uid.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
pub(crate) fn remove(store: &Store, uid: &str) -> Result<bool, crate::error::ApiError> {
    let _files = store
        .files
        .lock()
        .map_err(|_| crate::error::ApiError::storage("照片库正在处理"))?;
    let j = Journal {
        id: uuid::Uuid::new_v4().to_string(),
        uid: uid.into(),
    };
    let (original, quarantine, journal) = paths(store, &j)?;
    fs::create_dir_all(root(store)?)
        .map_err(|_| crate::error::ApiError::storage("无法准备账号删除"))?;
    let encrypted = protect(
        &serde_json::to_vec(&j).map_err(|_| crate::error::ApiError::storage("删除记录编码失败"))?,
        false,
    )?;
    let temp = journal.with_extension("tmp");
    let mut file = fs::File::create(&temp)
        .map_err(|_| crate::error::ApiError::storage("无法准备删除恢复记录"))?;
    file.write_all(&encrypted)
        .and_then(|_| file.sync_all())
        .map_err(|_| crate::error::ApiError::storage("无法保存删除恢复记录"))?;
    drop(file);
    crate::store::replace_file(&temp, &journal)?;
    if original.exists() {
        fs::rename(&original, &quarantine)
            .map_err(|_| crate::error::ApiError::storage("无法暂存照片，未删除账号"))?;
    }
    let saved = store.try_update(|d| {
        if crate::accounts::uid(d) == uid {
            crate::accounts::logout(d, true)
        } else {
            d.profiles.remove(uid);
            d.run_receipts.remove(uid);
        }
        d.pending_deletions.insert(j.id.clone());
        Ok(())
    });
    if let Err(error) = saved {
        finish(store, &j).map_err(|_| {
            crate::error::ApiError::storage("保存失败且照片尚待恢复；请保留data目录并重启")
        })?;
        return Err(error);
    }
    Ok(finish(store, &j).is_err())
}
