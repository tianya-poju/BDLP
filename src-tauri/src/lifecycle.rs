use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
pub fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let task = MenuItem::with_id(app, "task", "查看任务状态", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &task, &exit])?;
    TrayIconBuilder::with_id("budao-tray")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/32x32.png"
        ))?)
        .tooltip("不道乐跑")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show(app),
            "task" => {
                show(app);
                let _ = app.emit_to("main", "show-task", ());
            }
            "exit" => {
                show(app);
                let _ = app.emit_to("main", "close-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if matches!(
                e,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    if let Some(w) = app.get_webview_window("main") {
        w.set_icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/128x128.png"
        ))?)?;
        let h = app.handle().clone();
        w.on_window_event(move |e| match e {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let behavior = crate::network::snapshot(&h.state::<crate::store::Store>())
                    .map(|d| d.close_behavior)
                    .unwrap_or_default();
                if behavior == "tray" {
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.hide();
                    }
                } else if behavior == "exit" {
                    h.exit(0)
                } else {
                    let _ = h.emit_to("main", "close-requested", ());
                }
            }
            tauri::WindowEvent::Focused(true) => {
                let _ = h.emit_to("main", "window-restored", ());
            }
            _ => {}
        });
    }
    Ok(())
}
#[tauri::command]
pub fn window_preferences(
    behavior: Option<String>,
    store: tauri::State<crate::store::Store>,
) -> Result<Value, String> {
    if let Some(b) = behavior {
        if !["ask", "tray", "exit"].contains(&b.as_str()) {
            return Err("关闭行为无效".into());
        }
        store.update(|d| d.close_behavior = b)?;
    }
    Ok(json!({"behavior":crate::network::snapshot(&store)?.close_behavior}))
}
#[tauri::command]
pub fn window_choice(choice: String, remember: bool, app: tauri::AppHandle) -> Result<(), String> {
    if !["cancel", "tray", "exit"].contains(&choice.as_str()) {
        return Err("关闭行为无效".into());
    }
    if remember && choice != "cancel" {
        app.state::<crate::store::Store>()
            .update(|d| d.close_behavior = choice.clone())?;
    }
    match choice.as_str() {
        "tray" => app
            .get_webview_window("main")
            .ok_or("窗口不存在")?
            .hide()
            .map_err(|_| "无法隐藏窗口")?,
        "exit" => app.exit(0),
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remembered_preferences_roundtrip_without_losing_accounts() {
        let root = std::env::temp_dir().join(format!("window-pref-{}", uuid::Uuid::new_v4()));
        let store = crate::store::Store::open(root.join("settings.dpapi")).unwrap();
        store
            .update(|d| {
                d.account = json!({"uid":"test","token":"kept"});
                d.close_behavior = "tray".into();
            })
            .unwrap();
        let read = crate::store::Store::open(root.join("settings.dpapi")).unwrap();
        let d = crate::network::snapshot(&read).unwrap();
        assert_eq!(d.close_behavior, "tray");
        assert_eq!(d.account["token"], "kept");
        std::fs::remove_file(root.join("settings.dpapi")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
