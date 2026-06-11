use std::collections::HashMap;

use futures_util::TryStreamExt;
use serde::Serialize;
use tauri::State;

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
