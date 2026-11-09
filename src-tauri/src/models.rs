//! Typed persisted domain records. Null legacy records become empty records; malformed fields fail.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
pub fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}
fn string_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    match Value::deserialize(d)? {
        Value::String(v) => Ok(v),
        Value::Number(v) => Ok(v.to_string()),
        Value::Null => Ok(String::new()),
        _ => Err(serde::de::Error::custom("编号格式无效")),
    }
}
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Account {
    #[serde(deserialize_with = "string_id")]
    pub uid: String,
    pub token: String,
    pub refresh_token: Option<String>,
    pub label: Option<String>,
    pub real_name: Option<String>,
    pub nickname: Option<String>,
    pub student_num: Option<String>,
    pub login_type: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Device {
    pub model: Option<String>,
    pub os_version: Option<String>,
    pub oaid: Option<String>,
    pub mac: Option<String>,
    pub local_ip: Option<String>,
    #[serde(rename = "override")]
    pub override_id: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Zone {
    #[serde(deserialize_with = "string_id")]
    pub id: String,
    pub name: Option<String>,
    pub fence: Option<Vec<[f64; 2]>>,
    pub center: Option<[f64; 2]>,
    pub map_center: Option<[f64; 2]>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RunConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub straight_speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub curve_speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_accel: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gps_interval_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cadence_spm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sensor_intensity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_delay_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_length_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight_kg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub middle_face_type: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pace_level: Option<f64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
impl RunConfig {
    pub fn normalized(&self) -> Result<Self, crate::error::ApiError> {
        let mut out = self.clone();
        for (value, default, min, max, name) in [
            (&mut out.straight_speed, 4.1, 1., 5., "straightSpeed"),
            (&mut out.curve_speed, 3.3, 0.5, 5., "curveSpeed"),
            (&mut out.max_accel, 0.4, 0.05, 3., "maxAccel"),
            (
                &mut out.gps_interval_ms,
                2000.,
                500.,
                10000.,
                "gpsIntervalMs",
            ),
            (&mut out.warmup_time, 10., 0., 60., "warmupTime"),
            (&mut out.cooldown_time, 8., 0., 60., "cooldownTime"),
            (&mut out.cadence_spm, 160., 100., 220., "cadenceSpm"),
            (&mut out.sensor_intensity, 1., 0.7, 1.15, "sensorIntensity"),
            (&mut out.replay_delay_ms, 20., 0., 5000., "replayDelayMs"),
        ] {
            let n = value.unwrap_or(default);
            if !n.is_finite() || n < min || n > max {
                return Err(crate::error::ApiError::invalid(format!(
                    "跑步参数 {name} 应在 {min}~{max} 之间"
                )));
            }
            *value = Some(n);
        }
        if out
            .step_length_m
            .is_some_and(|n| !n.is_finite() || !(0.5..=3.).contains(&n))
        {
            return Err(crate::error::ApiError::invalid("步长应在0.5至3米之间"));
        }
        Ok(out)
    }
}
pub fn value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("finite persisted domain record")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_null_and_extensions_preserved() {
        #[derive(Deserialize)]
        struct Old {
            #[serde(deserialize_with = "null_default")]
            account: Account,
        }
        let a: Old = serde_json::from_str(r#"{"account":null}"#).unwrap();
        assert!(a.account.uid.is_empty());
        let a: Account =
            serde_json::from_str(r#"{"uid":42,"token":"t","extension":{"future":1}}"#).unwrap();
        assert_eq!(a.uid, "42");
        assert_eq!(value(&a)["extension"]["future"], 1);
        assert!(serde_json::from_str::<Account>(r#"{"token":123}"#).is_err());
    }
    #[test]
    fn missing_values_are_not_zero() {
        let c = RunConfig::default();
        assert_eq!(c.curve_speed, None);
        assert_eq!(c.normalized().unwrap().curve_speed, Some(3.3));
        assert!(RunConfig {
            curve_speed: Some(0.),
            ..Default::default()
        }
        .normalized()
        .is_err());
    }
}
