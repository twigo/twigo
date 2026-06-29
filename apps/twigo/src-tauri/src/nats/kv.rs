use async_nats::jetstream::kv::Operation;
use async_nats::jetstream::stream::StorageType;
use base64::Engine;
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::connection::ConnState;
use super::error::{self, Error};
use super::jetstream::{fmt_time, js_err, storage_str};

// Cap the value sent over IPC; a multi-MB stored value would otherwise be
// base64-encoded and rendered whole. `size` stays the true byte length.
const MAX_KV_PAYLOAD: usize = 1024 * 1024;

// A failed optimistic update is almost always a CAS conflict (someone wrote a
// newer revision). Map that to a typed `conflict` error so the UI can offer the
// reload-and-retry flow instead of regex-matching the message.
fn kv_update_err(e: async_nats::jetstream::kv::UpdateError) -> Error {
    use async_nats::jetstream::kv::UpdateErrorKind;
    match e.kind() {
        UpdateErrorKind::WrongLastRevision => Error::Conflict(e.to_string()),
        _ => Error::JetStream(e.to_string()),
    }
}

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

// Bound the listing (mirrors subjects.rs MAX_SUBJECTS) so a huge bucket can't
// buffer unboundedly, and fetch entries with bounded concurrency rather than a
// sequential chain of round-trips.
const MAX_KV_KEYS: usize = 10_000;
const KV_ENTRY_CONCURRENCY: usize = 64;

#[tauri::command]
pub async fn kv_list_keys(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
) -> error::Result<Vec<KvEntrySummary>> {
    let kv = store(&conns, &conn_id, &bucket).await?;
    let mut key_stream = kv.keys().await.map_err(js_err)?.boxed();
    let mut keys = Vec::new();
    while let Some(key) = key_stream.try_next().await.map_err(js_err)? {
        keys.push(key);
        if keys.len() >= MAX_KV_KEYS {
            tracing::warn!(
                bucket = %bucket,
                cap = MAX_KV_KEYS,
                "kv_list_keys truncated at cap"
            );
            break;
        }
    }

    let kv = &kv;
    let mut out: Vec<KvEntrySummary> = futures_util::stream::iter(keys)
        .map(|key| async move { kv.entry(&key).await })
        .buffer_unordered(KV_ENTRY_CONCURRENCY)
        .filter_map(|res| async move {
            match res {
                Ok(Some(entry)) => Some(entry_summary(&entry)),
                _ => None,
            }
        })
        .collect()
        .await;
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
            // Bound the scan so a request for a very old revision on a
            // high-churn key can't walk an unbounded history.
            let mut scanned = 0u32;
            while let Some(e) = hist.try_next().await.map_err(js_err)? {
                if e.revision == rev {
                    found = Some(e);
                    break;
                }
                scanned += 1;
                if scanned >= 100_000 {
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PutResult {
    revision: u64,
}

#[tauri::command]
pub async fn kv_put(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    key: String,
    payload_b64: String,
    // Some(rev) → optimistic CAS update; None → unconditional put.
    revision: Option<u64>,
) -> error::Result<PutResult> {
    let kv = store(&conns, &conn_id, &bucket).await?;
    let val = base64::engine::general_purpose::STANDARD
        .decode(payload_b64.as_bytes())
        .map_err(js_err)?;
    let rev = match revision {
        Some(r) => kv
            .update(&key, val.into(), r)
            .await
            .map_err(kv_update_err)?,
        None => kv.put(&key, val.into()).await.map_err(js_err)?,
    };
    Ok(PutResult { revision: rev })
}

#[tauri::command]
pub async fn kv_create(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    key: String,
    payload_b64: String,
) -> error::Result<PutResult> {
    let kv = store(&conns, &conn_id, &bucket).await?;
    let val = base64::engine::general_purpose::STANDARD
        .decode(payload_b64.as_bytes())
        .map_err(js_err)?;
    let rev = kv.create(&key, val.into()).await.map_err(js_err)?;
    Ok(PutResult { revision: rev })
}

#[tauri::command]
pub async fn kv_delete(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    key: String,
) -> error::Result<()> {
    let kv = store(&conns, &conn_id, &bucket).await?;
    kv.delete(&key).await.map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn kv_purge(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    key: String,
) -> error::Result<()> {
    let kv = store(&conns, &conn_id, &bucket).await?;
    kv.purge(&key).await.map_err(js_err)?;
    Ok(())
}

// kv::Config is Serialize-only (it's a create payload), so build it from a
// deserializable form rather than round-tripping the typed config.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewBucket {
    bucket: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    history: i64,
    #[serde(default)]
    max_value_size: i32,
    #[serde(default)]
    max_bytes: i64,
    #[serde(default)]
    max_age: u64,
    #[serde(default)]
    storage: String,
    #[serde(default)]
    num_replicas: usize,
}

#[tauri::command]
pub async fn kv_create_bucket(
    conns: State<'_, ConnState>,
    conn_id: String,
    config: serde_json::Value,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let nb: NewBucket = serde_json::from_value(config).map_err(js_err)?;
    let cfg = async_nats::jetstream::kv::Config {
        bucket: nb.bucket,
        description: nb.description,
        history: if nb.history > 0 { nb.history } else { 1 },
        max_value_size: nb.max_value_size,
        max_bytes: nb.max_bytes,
        max_age: std::time::Duration::from_nanos(nb.max_age),
        storage: if nb.storage == "memory" {
            StorageType::Memory
        } else {
            StorageType::File
        },
        num_replicas: if nb.num_replicas > 0 {
            nb.num_replicas
        } else {
            1
        },
        ..Default::default()
    };
    js.create_key_value(cfg).await.map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn kv_delete_bucket(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    js.delete_key_value(&bucket).await.map_err(js_err)?;
    Ok(())
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
