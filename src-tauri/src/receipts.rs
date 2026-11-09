use crate::{error::ApiError, store::Store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct JobId(pub String);
#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct RecordId(pub String);
impl JobId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptStatus {
    #[default]
    Pending,
    Done,
    Reviewed,
    Unknown,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Receipt {
    pub job_id: JobId,
    pub mode: String,
    pub time: i64,
    pub status: ReceiptStatus,
    #[serde(deserialize_with = "record_id")]
    pub record_id: Option<RecordId>,
    pub result: Option<Value>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, Value>,
}
fn record_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<RecordId>, D::Error> {
    let v = Value::deserialize(d)?;
    match v {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(RecordId(s))),
        Value::Number(n) => Ok(Some(RecordId(n.to_string()))),
        _ => Err(serde::de::Error::custom("记录编号格式无效")),
    }
}
pub fn complete(
    store: &Store,
    uid: &str,
    job: &JobId,
    record: RecordId,
    result: Value,
) -> Result<(), ApiError> {
    store.try_update(|d| {
        let receipt = d
            .run_receipts
            .get_mut(uid)
            .filter(|r| r.job_id == *job)
            .ok_or("回执任务不匹配，未覆盖其他任务结果")?;
        receipt.record_id = if record.0.is_empty() {
            None
        } else {
            Some(record)
        };
        receipt.result = Some(result);
        receipt.status = ReceiptStatus::Done;
        Ok(())
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn receipt_write_failure_preserves_pending_state_and_existing_receipt() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let store = Store::open(root.join("settings.dpapi")).unwrap();
        let job = JobId("job".into());
        store
            .update(|d| {
                d.run_receipts.insert(
                    "a".into(),
                    Receipt {
                        job_id: job.clone(),
                        ..Default::default()
                    },
                );
            })
            .unwrap();
        std::fs::rename(&store.path, root.join("backup")).unwrap();
        std::fs::create_dir(&store.path).unwrap();
        assert!(complete(
            &store,
            "a",
            &job,
            RecordId("server".into()),
            json!({"recordOk":true})
        )
        .is_err());
        let d = store.data.lock().unwrap();
        assert_eq!(d.run_receipts["a"].status, ReceiptStatus::Pending);
        assert!(d.run_receipts["a"].result.is_none());
        drop(d);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn completed_receipt_survives_reopen_and_stale_job_cannot_overwrite() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = root.join("settings.dpapi");
        let store = Store::open(path.clone()).unwrap();
        let job = JobId("local-task".into());
        store
            .update(|d| {
                d.run_receipts.insert(
                    "a".into(),
                    Receipt {
                        job_id: job.clone(),
                        ..Default::default()
                    },
                );
            })
            .unwrap();
        complete(
            &store,
            "a",
            &job,
            RecordId("server-record".into()),
            json!({"recordOk":true}),
        )
        .unwrap();
        let reopened = Store::open(path).unwrap();
        let d = reopened.data.lock().unwrap();
        assert_eq!(d.run_receipts["a"].status, ReceiptStatus::Done);
        assert_eq!(
            d.run_receipts["a"].record_id.as_ref().unwrap().0,
            "server-record"
        );
        drop(d);
        assert!(complete(
            &store,
            "a",
            &JobId("stale".into()),
            RecordId("wrong".into()),
            Value::Null
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
