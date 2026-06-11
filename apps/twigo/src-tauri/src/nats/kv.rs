use async_nats::jetstream::kv::Operation;
use base64::Engine;
use futures_util::{StreamExt, TryStreamExt};
use serde::Serialize;
use tauri::State;

use super::connection::ConnState;
use super::error::{self, Error};
use super::jetstream::{fmt_time, js_err, storage_str};

// Cap the value sent over IPC; a multi-MB stored value would otherwise be
// base64-encoded and rendered whole. `size` stays the true byte length.
const MAX_KV_PAYLOAD: usize = 1024 * 1024;

fn op_str(op: &Operation) -> String {
    match op {
        Operation::Put => "put",
        Operation::Delete => "delete",
        Operation::Purge => "purge",
    }
    .to_string()
}

async fn store(
    conns: &State<'_, ConnState>,
    conn_id: &str,
    bucket: &str,
) -> error::Result<async_nats::jetstream::kv::Store> {
    let client = conns
        .client(conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.to_string()))?;
    let js = async_nats::jetstream::new(client);
    js.get_key_value(bucket).await.map_err(js_err)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KvBucketSummary {
    bucket: String,
    values: u64,
    bytes: u64,
    history: i64,
    max_age: u64,
    storage: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KvBucketDetail {
    bucket: String,
    values: u64,
    bytes: u64,
    history: i64,
    max_age: u64,
    storage: String,
    max_value_size: i32,
    replicas: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KvEntrySummary {
    key: String,
    revision: u64,
    created: Option<String>,
    operation: String,
    delta: u64,
    size: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KvEntryDetail {
    key: String,
    revision: u64,
    created: Option<String>,
    operation: String,
    delta: u64,
    size: usize,
    payload_b64: String,
    truncated: bool,
}

fn entry_summary(e: &async_nats::jetstream::kv::Entry) -> KvEntrySummary {
    KvEntrySummary {
        key: e.key.clone(),
        revision: e.revision,
        created: fmt_time(e.created),
        operation: op_str(&e.operation),
        delta: e.delta,
        size: e.value.len(),
    }
}

#[tauri::command]
pub async fn kv_list_buckets(
    conns: State<'_, ConnState>,
    conn_id: String,
) -> error::Result<Vec<KvBucketSummary>> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);

    // KV buckets are JetStream streams named "KV_<bucket>".
    let mut stream_names = js.stream_names();
    let mut buckets = Vec::new();
    while let Some(stream_name) = stream_names.try_next().await.map_err(js_err)? {
        if let Some(bucket) = stream_name.strip_prefix("KV_") {
            buckets.push(bucket.to_string());
        }
    }

    let mut out = Vec::new();
    for bucket in buckets {
        let Ok(kv) = js.get_key_value(&bucket).await else {
            continue;
        };
        let Ok(status) = kv.status().await else {
            continue;
        };
        out.push(KvBucketSummary {
            bucket: status.bucket().to_string(),
            values: status.values(),
            bytes: status.info.state.bytes,
            history: status.history(),
            max_age: status.max_age().as_nanos() as u64,
            storage: storage_str(&status.info.config.storage),
        });
    }
    out.sort_by(|a, b| a.bucket.cmp(&b.bucket));
    Ok(out)
}

#[tauri::command]
pub async fn kv_bucket_info(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
) -> error::Result<KvBucketDetail> {
    let kv = store(&conns, &conn_id, &bucket).await?;
    let status = kv.status().await.map_err(js_err)?;
    Ok(KvBucketDetail {
        bucket: status.bucket().to_string(),
        values: status.values(),
        bytes: status.info.state.bytes,
        history: status.history(),
        max_age: status.max_age().as_nanos() as u64,
        storage: storage_str(&status.info.config.storage),
        max_value_size: status.info.config.max_message_size,
        replicas: status.info.config.num_replicas,
    })
}

#[tauri::command]
pub async fn kv_list_keys(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
) -> error::Result<Vec<KvEntrySummary>> {
    let kv = store(&conns, &conn_id, &bucket).await?;
    let mut keys = kv.keys().await.map_err(js_err)?.boxed();
    let mut out = Vec::new();
    while let Some(key) = keys.try_next().await.map_err(js_err)? {
        if let Ok(Some(entry)) = kv.entry(&key).await {
            out.push(entry_summary(&entry));
        }
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(out)
}

#[tauri::command]
pub async fn kv_get_entry(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    key: String,
    revision: Option<u64>,
) -> error::Result<Option<KvEntryDetail>> {
    let kv = store(&conns, &conn_id, &bucket).await?;
    let entry = match revision {
        None => kv.entry(&key).await.map_err(js_err)?,
        Some(rev) => {
            let mut hist = kv.history(&key).await.map_err(js_err)?;
            let mut found = None;
            while let Some(e) = hist.try_next().await.map_err(js_err)? {
                if e.revision == rev {
                    found = Some(e);
                    break;
                }
            }
            found
        }
    };
    Ok(entry.map(|e| {
        let truncated = e.value.len() > MAX_KV_PAYLOAD;
        let bytes = if truncated {
            &e.value[..MAX_KV_PAYLOAD]
        } else {
            &e.value[..]
        };
        KvEntryDetail {
            key: e.key.clone(),
            revision: e.revision,
            created: fmt_time(e.created),
            operation: op_str(&e.operation),
            delta: e.delta,
            size: e.value.len(),
            payload_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
            truncated,
        }
    }))
}

#[tauri::command]
pub async fn kv_history(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    key: String,
) -> error::Result<Vec<KvEntrySummary>> {
    let kv = store(&conns, &conn_id, &bucket).await?;
    let mut hist = kv.history(&key).await.map_err(js_err)?;
    let mut out = Vec::new();
    while let Some(e) = hist.try_next().await.map_err(js_err)? {
        out.push(entry_summary(&e));
    }
    out.reverse(); // newest-first
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_operations() {
        assert_eq!(op_str(&Operation::Put), "put");
        assert_eq!(op_str(&Operation::Delete), "delete");
        assert_eq!(op_str(&Operation::Purge), "purge");
    }
}
