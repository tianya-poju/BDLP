use crate::{
    network::{self, text},
    store::Store,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub fn merged(store: &Store) -> Result<BTreeMap<String, String>, crate::error::ApiError> {
    let mut all: BTreeMap<String, String> =
        serde_json::from_str(crate::SCHOOLS).map_err(|_| "内置学校表损坏")?;
    all.extend(network::snapshot(store)?.school_cache);
    Ok(all)
}
#[tauri::command]
pub fn schools_list(store: tauri::State<Store>) -> Result<Value, crate::error::ApiError> {
    Ok(
        json!({"list":merged(&store)?.into_iter().map(|(id,name)|json!({"id":id,"name":name})).collect::<Vec<_>>()}),
    )
}
fn valid(list: &Value) -> BTreeMap<String, String> {
    list.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    let id = text(r, "i");
                    let name = text(r, "n").trim().to_string();
                    if id.parse::<u64>().ok().is_some_and(|n| n > 0)
                        && !name.is_empty()
                        && name.len() <= 300
                    {
                        Some((id, name))
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}
pub async fn refresh(store: &Store) -> Result<Value, crate::session::ApiError> {
    let mut d = network::snapshot(&store)?;
    d.account = serde_json::from_value(json!({"uid":"1","token":""}))?;
    d.school_id = "0".into();
    let r = network::call(
        &d,
        "School/nearbySchool",
        BTreeMap::from([
            ("lat".into(), "30.479948".into()),
            ("lng".into(), "114.422066".into()),
            ("province".into(), "湖北省".into()),
            ("city".into(), "武汉市".into()),
            ("cache_time".into(), "0".into()),
        ]),
        None,
    )
    .await?;
    let updated = valid(&r["data"]["all_school_list"]["list"]);
    if updated.is_empty() {
        return Err("服务端未返回有效学校，已保留旧表".into());
    }
    let old = merged(&store)?;
    let added = updated.keys().filter(|k| !old.contains_key(*k)).count();
    store.update(|d| d.school_cache.extend(updated))?;
    Ok(
        json!({"status":1,"all":merged(&store)?.len(),"added":added,"nearby":0,"saved":true,"info":format!("学校表已更新，新增 {added} 所")}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_invalid_and_merges_ids() {
        let a = valid(
            &json!([{"i":1,"n":"大学"},{"i":"0","n":"无"},{"i":"2","n":""},{"i":"1","n":"新名"}]),
        );
        assert_eq!(a.len(), 1);
        assert_eq!(a["1"], "新名");
    }
}

#[tauri::command]
pub async fn schools_refresh(
    store: tauri::State<'_, Store>,
) -> Result<Value, crate::session::ApiError> {
    refresh(&store).await
}
#[cfg(test)]
mod live {
    use super::*;
    #[test]
    #[ignore]
    fn refresh_real_school_table() {
        let path = crate::data_root::root().unwrap().join("settings.dpapi");
        let store = Store::open(path).unwrap();
        let old = network::snapshot(&store).unwrap();
        let result = tauri::async_runtime::block_on(refresh(&store)).unwrap();
        let new = network::snapshot(&store).unwrap();
        assert_eq!(old.amap_key, new.amap_key);
        assert_eq!(old.account, new.account);
        assert!(result["all"].as_u64().unwrap() > 0);
        println!(
            "学校表刷新成功，共 {} 所；账号与地图 Key 未变化",
            result["all"]
        );
    }
}
