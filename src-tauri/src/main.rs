#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]
mod accounts;
mod alipay;
mod amap;
mod data_root;
mod deletions;
mod error;
mod face_window;
mod faces;
mod history;
mod ipc_policy;
mod lifecycle;
mod login;
mod map_config;
mod models;
mod native_runner;
mod network;
mod planner;
mod protocol_config;
mod receipts;
mod running;
mod schools;
mod session;
mod store;
mod updates;
mod wechat;
use serde::Serialize;
use std::collections::BTreeMap;
const SCHOOLS: &str = include_str!("../../frontend/data/schools.json");
#[derive(Serialize, Clone, Debug, PartialEq)]
struct School {
    id: String,
    name: String,
}
fn search_schools(
    data: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<School>, crate::error::ApiError> {
    let schools: BTreeMap<String, String> =
        serde_json::from_str(data).map_err(|_| "学校数据无法读取".to_string())?;
    let term = query.trim().to_lowercase();
    let mut out: Vec<School> = schools
        .into_iter()
        .filter(|(id, name)| {
            !id.is_empty()
                && id != "0"
                && !name.trim().is_empty()
                && (term.is_empty() || name.to_lowercase().contains(&term) || id.contains(&term))
        })
        .map(|(id, name)| School { id, name })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    out.truncate(limit.clamp(1, 100));
    Ok(out)
}
#[tauri::command]
fn schools_search(
    query: String,
    store: tauri::State<store::Store>,
) -> Result<Vec<School>, crate::error::ApiError> {
    let all = schools::merged(&store)?;
    search_schools(
        &serde_json::to_string(&all).map_err(|_| "学校表无效")?,
        &query,
        2000,
    )
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            lifecycle::show(app)
        }))
        .manage(login::Attempts::default())
        .manage(updates::Checks::default())
        .manage(planner::Plans::default())
        .manage(face_window::Registration::default())
        .manage(alipay::Tickets::default())
        .manage(wechat::Sessions::default())
        .manage(running::Runs::default())
        .setup(|app| {
            data_root::prepare(&data_root::root()?)?;
            store::setup(app)?;
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(data_root::root()?.join("webview/main"))
                .on_navigation(ipc_policy::local)
                .build()?;
            lifecycle::setup(app)?;
            Ok(())
        })
        .invoke_handler(|invoke| {
            let view = invoke.message.webview_ref();
            if !view
                .url()
                .map(|url| ipc_policy::allowed(view.label(), &url))
                .unwrap_or(false)
            {
                invoke.resolver.reject("该窗口无权调用应用命令");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                login::login_begin,
                login::login_cancel,
                updates::update_check,
                updates::update_open,
                planner::route_plan,
                planner::route_plan_status,
                planner::route_plan_cancel,
                planner::route_plan_apply,
                store::map_center_save,
                running::face_validate,
                faces::face_reference_remove,
                schools::schools_list,
                schools::schools_refresh,
                session::session_check,
                alipay::alipay_url,
                alipay::alipay_check,
                alipay::alipay_opened,
                alipay::alipay_launch,
                lifecycle::window_choice,
                lifecycle::window_preferences,
                native_runner::run_prepare,
                native_runner::run_execute,
                running::run_current,
                running::run_resolve,
                running::run_open,
                running::run_action,
                running::run_cancel,
                running::run_status,
                schools_search,
                store::local_state,
                store::school_save,
                store::route_save,
                store::config_save,
                store::device_save,
                store::device_extra_save,
                store::device_new_id,
                store::device_history_update,
                store::account_logout,
                accounts::account_select,
                accounts::account_rename,
                accounts::account_remove,
                network::qq_login_start,
                wechat::wechat_login_start,
                wechat::wechat_login_poll,
                wechat::wechat_login_cancel,
                network::network_read,
                map_config::map_config,
                faces::face_info,
                faces::face_registration_open,
                faces::face_photos,
                faces::face_add,
                faces::face_replace,
                faces::face_remove,
                history::record_track,
                history::record_import
            ];
            handler(invoke)
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| data_root::startup_error(&e.to_string()));
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn school_search_known_and_absent() {
        assert!(search_schools(SCHOOLS, "长沙理工大学", 50)
            .unwrap()
            .iter()
            .any(|x| x.name.contains("长沙理工大学")));
        assert!(search_schools(SCHOOLS, "不存在的学校名称xyz123", 50)
            .unwrap()
            .is_empty());
    }
    #[test]
    fn school_search_input_and_limit() {
        let data = r#"{ "1":"ABC大学", "2":"abc学院", "0":"忽略", "3":"" }"#;
        assert_eq!(search_schools(data, " abc ", 50).unwrap().len(), 2);
        assert_eq!(search_schools(data, "", 1).unwrap().len(), 1);
        assert!(search_schools("invalid", "", 1).is_err());
    }
}
