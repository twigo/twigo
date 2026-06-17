use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_nats::jetstream::stream::StorageType;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::connection::ConnState;
use super::error::{self, Error};
use super::jetstream::{fmt_time, js_err, storage_str};

// Holds the picked upload path backend-side between pick and commit, so it never
// round-trips through (untrusted) JS. One slot - uploads are a sequential action.
#[derive(Default)]
pub struct UploadStaging(Mutex<Option<StagedUpload>>);

struct StagedUpload {
    conn_id: String,
    bucket: String,
    name: String,
    path: PathBuf,
}

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

/// Download an object. The save picker runs in Rust so a destination path never
/// crosses IPC; streams to a sidecar temp file renamed atomically on success.
/// Returns the saved path, or None if cancelled.
#[tauri::command]
pub async fn obj_get_object(
    app: AppHandle,
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
    name: String,
) -> error::Result<Option<String>> {
    let suggested = name
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("object")
        .to_string();
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(suggested)
            .blocking_save_file()
    })
    .await
    .map_err(|e| Error::Task(e.to_string()))?;
    let Some(dest) = picked.and_then(|p| p.as_path().map(Path::to_path_buf)) else {
        return Ok(None);
    };

    let os = store(&conns, &conn_id, &bucket).await?;
    let mut object = os.get(&name).await.map_err(js_err)?;
    let mut tmp = dest.clone().into_os_string();
    tmp.push(".twigo-part");
    let tmp = PathBuf::from(tmp);

    let download = async {
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|source| Error::Io {
                path: tmp.display().to_string(),
                source,
            })?;
        tokio::io::copy(&mut object, &mut file)
            .await
            .map_err(|source| Error::Io {
                path: tmp.display().to_string(),
                source,
            })?;
        file.flush().await.map_err(|source| Error::Io {
            path: tmp.display().to_string(),
            source,
        })?;
        tokio::fs::rename(&tmp, &dest)
            .await
            .map_err(|source| Error::Io {
                path: dest.display().to_string(),
                source,
            })?;
        Ok::<(), Error>(())
    };

    if let Err(e) = download.await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(Some(dest.display().to_string()))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StagedUploadInfo {
    name: String,
    exists: bool,
}

/// Stage an upload: the picker runs in Rust and the chosen path is held
/// backend-side (never crosses IPC). Reports whether the name already exists so
/// the UI can confirm an overwrite. Returns None if cancelled; then commit.
#[tauri::command]
pub async fn obj_stage_upload(
    app: AppHandle,
    conns: State<'_, ConnState>,
    staging: State<'_, UploadStaging>,
    conn_id: String,
    bucket: String,
) -> error::Result<Option<StagedUploadInfo>> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_file())
        .await
        .map_err(|e| Error::Task(e.to_string()))?;
    let Some(path) = picked.and_then(|p| p.as_path().map(Path::to_path_buf)) else {
        *staging.0.lock().await = None;
        return Ok(None);
    };
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("object")
        .to_string();

    let os = store(&conns, &conn_id, &bucket).await?;
    // info() errors when the object doesn't exist yet - treat that as "new".
    let exists = matches!(os.info(&name).await, Ok(i) if !i.deleted);

    *staging.0.lock().await = Some(StagedUpload {
        conn_id,
        bucket,
        name: name.clone(),
        path,
    });
    Ok(Some(StagedUploadInfo { name, exists }))
}

/// Commit the staged upload, streaming the chosen file into the object store.
/// Returns the object name, or None if nothing is staged.
#[tauri::command]
pub async fn obj_commit_upload(
    conns: State<'_, ConnState>,
    staging: State<'_, UploadStaging>,
) -> error::Result<Option<String>> {
    let Some(s) = staging.0.lock().await.take() else {
        return Ok(None);
    };
    let os = store(&conns, &s.conn_id, &s.bucket).await?;
    let mut file = tokio::fs::File::open(&s.path)
        .await
        .map_err(|source| Error::Io {
            path: s.path.display().to_string(),
            source,
        })?;
    if let Err(e) = os.put(s.name.as_str(), &mut file).await {
        // Best-effort cleanup so a mid-stream failure doesn't leave a partial
        // object occupying the store.
        let _ = os.delete(&s.name).await;
        return Err(js_err(e));
    }
    Ok(Some(s.name))
}

/// Discard a staged upload (the user declined the overwrite confirmation).
#[tauri::command]
pub async fn obj_cancel_upload(staging: State<'_, UploadStaging>) -> error::Result<()> {
    *staging.0.lock().await = None;
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
