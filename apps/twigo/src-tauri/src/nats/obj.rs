use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_nats::jetstream::stream::StorageType;
use futures_util::{StreamExt, TryStreamExt};
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
    existed: bool,
}

// Concurrency for per-bucket get_stream round-trips when listing object stores.
const BUCKET_CONCURRENCY: usize = 32;

/// Whether the name currently holds a live object. Anything but a definite
/// NotFound counts as "exists", so a transient error can never authorize a
/// destructive cleanup.
async fn object_exists(os: &async_nats::jetstream::object_store::ObjectStore, name: &str) -> bool {
    match os.info(name).await {
        Ok(i) => !i.deleted,
        Err(e) => e.kind() != async_nats::jetstream::object_store::InfoErrorKind::NotFound,
    }
}

async fn store(
    conns: &ConnState,
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

// Object-store buckets are JetStream streams named "OBJ_<bucket>".
fn bucket_name(stream_name: &str) -> Option<&str> {
    stream_name.strip_prefix("OBJ_")
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
    obj_list_buckets_impl(&conns, conn_id).await
}

pub(crate) async fn obj_list_buckets_impl(
    conns: &ConnState,
    conn_id: String,
) -> error::Result<Vec<ObjBucketSummary>> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);

    let mut stream_names = js.stream_names();
    let mut buckets = Vec::new();
    while let Some(stream_name) = stream_names.try_next().await.map_err(js_err)? {
        if let Some(bucket) = bucket_name(&stream_name) {
            buckets.push(bucket.to_string());
        }
    }

    // Concurrent per-bucket get_stream so a server with many object stores
    // (e.g. demo.nats.io) isn't a sequential N+1 stall.
    let js = &js;
    let mut out: Vec<ObjBucketSummary> = futures_util::stream::iter(buckets)
        .map(|bucket| async move {
            let handle = js.get_stream(format!("OBJ_{bucket}")).await.ok()?;
            let info = handle.cached_info();
            Some(ObjBucketSummary {
                bucket,
                bytes: info.state.bytes,
                storage: storage_str(&info.config.storage),
            })
        })
        .buffer_unordered(BUCKET_CONCURRENCY)
        .filter_map(|x| async move { x })
        .collect()
        .await;
    out.sort_by(|a, b| a.bucket.cmp(&b.bucket));
    Ok(out)
}

#[tauri::command]
pub async fn obj_list_objects(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
) -> error::Result<Vec<ObjSummary>> {
    obj_list_objects_impl(&conns, conn_id, bucket).await
}

pub(crate) async fn obj_list_objects_impl(
    conns: &ConnState,
    conn_id: String,
    bucket: String,
) -> error::Result<Vec<ObjSummary>> {
    let os = store(conns, &conn_id, &bucket).await?;
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
    obj_object_info_impl(&conns, conn_id, bucket, name).await
}

pub(crate) async fn obj_object_info_impl(
    conns: &ConnState,
    conn_id: String,
    bucket: String,
    name: String,
) -> error::Result<ObjDetail> {
    let os = store(conns, &conn_id, &bucket).await?;
    let info = os.info(&name).await.map_err(|e| {
        if e.kind() == async_nats::jetstream::object_store::InfoErrorKind::NotFound {
            Error::NotFound(format!("object '{name}' not found"))
        } else {
            js_err(e)
        }
    })?;
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
    Ok(Some(
        download_object(&conns, conn_id, bucket, name, dest).await?,
    ))
}

pub(crate) async fn download_object(
    conns: &ConnState,
    conn_id: String,
    bucket: String,
    name: String,
    dest: PathBuf,
) -> error::Result<String> {
    let os = store(conns, &conn_id, &bucket).await?;
    let mut object = os.get(&name).await.map_err(|e| {
        if e.kind() == async_nats::jetstream::object_store::GetErrorKind::NotFound {
            Error::NotFound(format!("object '{name}' not found"))
        } else {
            js_err(e)
        }
    })?;
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
    Ok(dest.display().to_string())
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
    conns.assert_writable(&conn_id).await?;
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_file())
        .await
        .map_err(|e| Error::Task(e.to_string()))?;
    let path = picked.and_then(|p| p.as_path().map(Path::to_path_buf));
    stage_upload(&conns, &staging, conn_id, bucket, path).await
}

pub(crate) async fn stage_upload(
    conns: &ConnState,
    staging: &UploadStaging,
    conn_id: String,
    bucket: String,
    path: Option<PathBuf>,
) -> error::Result<Option<StagedUploadInfo>> {
    conns.assert_writable(&conn_id).await?;
    let Some(path) = path else {
        *staging.0.lock().await = None;
        return Ok(None);
    };
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("object")
        .to_string();

    let os = store(conns, &conn_id, &bucket).await?;
    // `exists` gates the destructive cleanup on commit - only a definite
    // NotFound may count as "new".
    let exists = match os.info(&name).await {
        Ok(i) => !i.deleted,
        Err(e) if e.kind() == async_nats::jetstream::object_store::InfoErrorKind::NotFound => false,
        Err(e) => {
            *staging.0.lock().await = None;
            return Err(js_err(e));
        }
    };

    *staging.0.lock().await = Some(StagedUpload {
        conn_id,
        bucket,
        name: name.clone(),
        path,
        existed: exists,
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
    obj_commit_upload_impl(&conns, &staging).await
}

pub(crate) async fn obj_commit_upload_impl(
    conns: &ConnState,
    staging: &UploadStaging,
) -> error::Result<Option<String>> {
    let mut staged = staging.0.lock().await;
    let Some(peek) = staged.as_ref() else {
        return Ok(None);
    };
    // A denied commit must keep the staging for retry.
    conns.assert_writable(&peek.conn_id).await?;
    let Some(s) = staged.take() else {
        return Ok(None);
    };
    drop(staged);
    let os = store(conns, &s.conn_id, &s.bucket).await?;
    let mut file = tokio::fs::File::open(&s.path)
        .await
        .map_err(|source| Error::Io {
            path: s.path.display().to_string(),
            source,
        })?;
    // `existed` was sampled when the file was staged, which can be a whole
    // confirmation dialog ago - re-check next to the write so the destructive
    // cleanup below can't tombstone an object created in between.
    let existed = s.existed || object_exists(&os, &s.name).await;
    if let Err(e) = os.put(s.name.as_str(), &mut file).await {
        // Only a name this upload introduced may be deleted; on replace the
        // cleanup would destroy the pre-existing object.
        if !existed {
            let _ = os.delete(&s.name).await;
        }
        return Err(js_err(e));
    }
    Ok(Some(s.name))
}

/// Discard a staged upload (the user declined the overwrite confirmation).
#[tauri::command]
pub async fn obj_cancel_upload(staging: State<'_, UploadStaging>) -> error::Result<()> {
    obj_cancel_upload_impl(&staging).await
}

pub(crate) async fn obj_cancel_upload_impl(staging: &UploadStaging) -> error::Result<()> {
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
    obj_delete_impl(&conns, conn_id, bucket, name).await
}

pub(crate) async fn obj_delete_impl(
    conns: &ConnState,
    conn_id: String,
    bucket: String,
    name: String,
) -> error::Result<()> {
    conns.assert_writable(&conn_id).await?;
    let os = store(conns, &conn_id, &bucket).await?;
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

fn object_store_config(nb: NewObjBucket) -> async_nats::jetstream::object_store::Config {
    async_nats::jetstream::object_store::Config {
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
    }
}

#[tauri::command]
pub async fn obj_create_bucket(
    conns: State<'_, ConnState>,
    conn_id: String,
    config: serde_json::Value,
) -> error::Result<()> {
    obj_create_bucket_impl(&conns, conn_id, config).await
}

pub(crate) async fn obj_create_bucket_impl(
    conns: &ConnState,
    conn_id: String,
    config: serde_json::Value,
) -> error::Result<()> {
    conns.assert_writable(&conn_id).await?;
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let nb: NewObjBucket = serde_json::from_value(config).map_err(js_err)?;
    js.create_object_store(object_store_config(nb))
        .await
        .map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn obj_delete_bucket(
    conns: State<'_, ConnState>,
    conn_id: String,
    bucket: String,
) -> error::Result<()> {
    obj_delete_bucket_impl(&conns, conn_id, bucket).await
}

pub(crate) async fn obj_delete_bucket_impl(
    conns: &ConnState,
    conn_id: String,
    bucket: String,
) -> error::Result<()> {
    conns.assert_writable(&conn_id).await?;
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    js.delete_object_store(&bucket).await.map_err(js_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::OffsetDateTime;

    fn info(name: &str) -> async_nats::jetstream::object_store::ObjectInfo {
        async_nats::jetstream::object_store::ObjectInfo {
            name: name.to_string(),
            description: Some("d".to_string()),
            metadata: HashMap::new(),
            headers: None,
            options: None,
            bucket: "B".to_string(),
            nuid: "n1".to_string(),
            size: 42,
            chunks: 3,
            modified: Some(OffsetDateTime::UNIX_EPOCH),
            digest: Some("SHA-256=x".to_string()),
            deleted: true,
        }
    }

    #[test]
    fn obj_summary_maps_fields() {
        let s = obj_summary(&info("a/b.txt"));
        assert_eq!(s.name, "a/b.txt");
        assert_eq!(s.size, 42);
        assert_eq!(s.chunks, 3);
        assert_eq!(s.modified.as_deref(), Some("1970-01-01T00:00:00Z"));
        assert!(s.deleted);
    }

    #[test]
    fn bucket_names_come_from_the_obj_prefix() {
        assert_eq!(bucket_name("OBJ_files"), Some("files"));
        assert_eq!(bucket_name("KV_files"), None);
        assert_eq!(bucket_name("ORDERS_OBJ_x"), None);
    }

    #[test]
    fn bucket_config_defaults_empty_fields() {
        let cfg = object_store_config(NewObjBucket {
            bucket: "files".to_string(),
            description: String::new(),
            max_age: 0,
            max_bytes: 0,
            storage: String::new(),
            num_replicas: 0,
        });
        assert_eq!(cfg.bucket, "files");
        assert_eq!(cfg.description, None);
        assert_eq!(cfg.max_age, Duration::ZERO);
        assert!(matches!(cfg.storage, StorageType::File));
        assert_eq!(cfg.num_replicas, 1);
    }

    #[test]
    fn bucket_config_maps_explicit_fields() {
        let cfg = object_store_config(NewObjBucket {
            bucket: "files".to_string(),
            description: "docs".to_string(),
            max_age: 5_000_000_000,
            max_bytes: 1024,
            storage: "memory".to_string(),
            num_replicas: 3,
        });
        assert_eq!(cfg.description.as_deref(), Some("docs"));
        assert_eq!(cfg.max_age, Duration::from_secs(5));
        assert_eq!(cfg.max_bytes, 1024);
        assert!(matches!(cfg.storage, StorageType::Memory));
        assert_eq!(cfg.num_replicas, 3);
    }
}
