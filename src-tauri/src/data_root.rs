use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};
pub fn beside(exe: &Path) -> io::Result<PathBuf> {
    Ok(exe
        .parent()
        .ok_or_else(|| io::Error::other("无法确定安装目录"))?
        .join("data"))
}
pub fn root() -> io::Result<PathBuf> {
    beside(&std::env::current_exe()?)
}
pub fn startup_error(message: &str) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            title: *const u16,
            flags: u32,
        ) -> i32;
    }
    let body: Vec<u16> = format!("无法启动不道乐跑：{message}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let title: Vec<u16> = "不道乐跑".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), 0x10);
    }
}
pub fn prepare(root: &Path) -> io::Result<()> {
    let probe = root.join(format!(".write-check-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::create_dir_all(root)?;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        f.write_all(b"ok")?;
        f.sync_all()?;
        drop(f);
        fs::remove_file(&probe)
    })();
    result.map_err(|_: io::Error| {
        io::Error::other("安装目录不可写，请将软件安装到当前用户可写的位置；数据不会回退到 AppData")
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exe_relative_not_working_directory() {
        assert_eq!(
            beside(Path::new("D:/Apps/Budao/budao.exe")).unwrap(),
            PathBuf::from("D:/Apps/Budao/data")
        );
    }
    #[test]
    fn fresh_directory_has_no_account_and_preserves_own_data() {
        let r = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        prepare(&r).unwrap();
        let s = crate::store::Store::open(r.join("settings.dpapi")).unwrap();
        assert!(s.data.lock().unwrap().account.is_null());
        s.update(|d| {
            d.amap_key = "synthetic".into();
            d.route = vec![[1., 2.], [2., 3.]];
        })
        .unwrap();
        let reopened = crate::store::Store::open(r.join("settings.dpapi")).unwrap();
        assert_eq!(reopened.data.lock().unwrap().amap_key, "synthetic");
        assert_eq!(reopened.data.lock().unwrap().route.len(), 2);
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn writable_and_blocked() {
        let r = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        prepare(&r).unwrap();
        assert_eq!(fs::read_dir(&r).unwrap().count(), 0);
        fs::write(r.join("file"), b"x").unwrap();
        assert!(prepare(&r.join("file/child")).is_err());
        fs::remove_dir_all(r).unwrap();
    }
}
