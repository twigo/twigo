use std::collections::HashMap;
use std::time::Duration;

use async_nats::jetstream::stream::StorageType;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::AsyncWriteExt;

use super::connection::ConnState;
use super::error::{self, Error};
use super::jetstream::{fmt_time, js_err, storage_str};

async fn store(
    conns: &State<'_, ConnState>,
    conn_id: &str,
    bucket: &str,
) -> error::Result<async_nats::jetstream::object_store::ObjectStore> {
    let client = conns
        .client(conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.to_string()))?;
    let js = async_nats::jetstream::new(client);
    js.get_object_store(bucket).await.map_err(js_err)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ObjBucketSummary {
    bucket: String,
    bytes: u64,
    storage: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ObjSummary {
    name: String,
    size: usize,
    chunks: usize,
    modified: Option<String>,
    deleted: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ObjDetail {
    name: String,
    description: Option<String>,
    size: usize,
    chunks: usize,
    modified: Option<String>,
    digest: Option<String>,
    deleted: bool,
    metadata: HashMap<String, String>,
    headers: Vec<(String, String)>,
}

fn obj_summary(i: &async_nats::jetstream::object_store::ObjectInfo) -> ObjSummary {
    ObjSummary {
        name: i.name.clone(),
        size: i.size,
        chunks: i.chunks,
        modified: i.modified.and_then(fmt_time),
        deleted: i.deleted,
    }
}

#[tauri::command]
pub async fn obj_list_buckets(
    conns: State<'_, ConnState>,
    conn_id: String,
) -> error::Result<Vec<ObjBucketSummary>> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);

    // Object-store buckets are JetStream streams named "OBJ_<bucket>".
    let mut stream_names = js.stream_names();
    let mut buckets = Vec::new();
    while let Some(stream_name) = stream_names.try_next().await.map_err(js_err)? {
        if let Some(bucket) = stream_name.strip_prefix("OBJ_") {
            buckets.push(bucket.to_string());
        }
    }

    let mut out = Vec::new();
    for bucket in buckets {
        let Ok(handle) = js.get_stream(format!("OBJ_{bucket}")).await else {
            continue;
        };
        let info = handle.cached_info();
        out.push(ObjBucketSummary {
            bucket,
            bytes: info.state.bytes,
            storage: storage_str(&info.config.storage),
        });
    }
    out.sort_by(|a, b| a.bucket.cmp(&b.bucket));
    Ok(out)
}

#[tauri::command]
pub async fn obj_list_objects(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
) -> error::Result<Vec<ObjSummary>> {
    let os = store(&conns, &conn_id, &bucket).await?;
    let mut list = os.list().await.map_err(js_err)?;
    let mut out = Vec::new();
    while let Some(info) = list.try_next().await.map_err(js_err)? {
        out.push(obj_summary(&info));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub async fn obj_object_info(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    name: String,
) -> error::Result<ObjDetail> {
    let os = store(&conns, &conn_id, &bucket).await?;
    let info = os.info(&name).await.map_err(js_err)?;
    Ok(ObjDetail {
        name: info.name.clone(),
        description: info.description.clone(),
        size: info.size,
        chunks: info.chunks,
        modified: info.modified.and_then(fmt_time),
        digest: info.digest.clone(),
        deleted: info.deleted,
        metadata: info.metadata.clone(),
        headers: super::subscription::flatten_headers(info.headers.as_ref()),
    })
}

/// Download an object to a local path. Streams chunk-by-chunk so a multi-GB
/// object never lands wholly in memory, and writes to a sidecar temp file that
/// is atomically renamed on success — a failed download never leaves a
/// truncated file at `dest`.
#[tauri::command]
pub async fn obj_get_object(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    name: String,
    dest: String,
) -> error::Result<()> {
    let os = store(&conns, &conn_id, &bucket).await?;
    let mut object = os.get(&name).await.map_err(js_err)?;
    let tmp = format!("{dest}.twigo-part");

    let download = async {
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|source| Error::Io {
                path: tmp.clone(),
                source,
            })?;
        tokio::io::copy(&mut object, &mut file)
            .await
            .map_err(|source| Error::Io {
                path: tmp.clone(),
                source,
            })?;
        file.flush().await.map_err(|source| Error::Io {
            path: tmp.clone(),
            source,
        })?;
        tokio::fs::rename(&tmp, &dest)
            .await
            .map_err(|source| Error::Io {
                path: dest.clone(),
                source,
            })?;
        Ok::<(), Error>(())
    };

    if let Err(e) = download.await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

/// Upload a local file as an object (name = the caller-chosen object name).
#[tauri::command]
pub async fn obj_put_object(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    name: String,
    src: String,
) -> error::Result<()> {
    let os = store(&conns, &conn_id, &bucket).await?;
    let mut file = tokio::fs::File::open(&src)
        .await
        .map_err(|source| Error::Io {
            path: src.clone(),
            source,
        })?;
    if let Err(e) = os.put(name.as_str(), &mut file).await {
        // Best-effort cleanup so a mid-stream failure doesn't leave a partial
        // object occupying the store.
        let _ = os.delete(&name).await;
        return Err(js_err(e));
    }
    Ok(())
}

#[tauri::command]
pub async fn obj_delete(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    name: String,
) -> error::Result<()> {
    let os = store(&conns, &conn_id, &bucket).await?;
    os.delete(&name).await.map_err(js_err)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewObjBucket {
    bucket: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    max_age: u64,
    #[serde(default)]
    max_bytes: i64,
    #[serde(default)]
    storage: String,
    #[serde(default)]
    num_replicas: usize,
}

#[tauri::command]
pub async fn obj_create_bucket(
    conns: State<'_, ConnState>,
    conn_id: String,
    config: serde_json::Value,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let nb: NewObjBucket = serde_json::from_value(config).map_err(js_err)?;
    let cfg = async_nats::jetstream::object_store::Config {
        bucket: nb.bucket,
        description: if nb.description.is_empty() {
            None
        } else {
            Some(nb.description)
        },
        max_age: Duration::from_nanos(nb.max_age),
        max_bytes: nb.max_bytes,
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
    js.create_object_store(cfg).await.map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn obj_delete_bucket(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    js.delete_object_store(&bucket).await.map_err(js_err)?;
    Ok(())
}
