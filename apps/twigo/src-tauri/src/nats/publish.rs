use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::connection::ConnState;
use super::error::{self, Error};
use super::subscription::{encode_message, flatten_headers, IncomingMessage};

fn build_headers(pairs: Vec<(String, String)>) -> Option<async_nats::HeaderMap> {
    let mut headers = async_nats::HeaderMap::new();
    let mut any = false;
    for (key, value) in pairs {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        // CR/LF are illegal in NATS headers (async-nats asserts on them), and a
        // rendered responder value can be multi-line - collapse so a stray
        // newline can't panic the publish command.
        let key = key.replace(['\r', '\n'], " ");
        let value = value.replace(['\r', '\n'], " ");
        // Headers are multi-value; `insert` would keep only the last repeat of a key.
        headers.append(key.as_str(), value.as_str());
        any = true;
    }
    any.then_some(headers)
}

fn decode_payload(payload_b64: &str) -> error::Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(payload_b64)
        .map_err(|e| Error::InvalidInput(format!("invalid base64 payload: {e}")))
}

#[tauri::command]
pub async fn publish(
    conns: State<'_, ConnState>,
    conn_id: String,
    subject: String,
    payload_b64: String,
    headers: Vec<(String, String)>,
) -> error::Result<()> {
    publish_impl(&conns, conn_id, subject, payload_b64, headers).await
}

pub(crate) async fn publish_impl(
    conns: &ConnState,
    conn_id: String,
    subject: String,
    payload_b64: String,
    headers: Vec<(String, String)>,
) -> error::Result<()> {
    conns.assert_writable(&conn_id).await?;
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;

    let bytes = decode_payload(&payload_b64)?;
    match build_headers(headers) {
        Some(h) => {
            client
                .publish_with_headers(subject, h, bytes.into())
                .await?
        }
        None => client.publish(subject, bytes.into()).await?,
    }
    // The client keeps reconnecting forever (max_reconnects None), so a flush
    // against a down server would never resolve and hang the command - bound it.
    match tokio::time::timeout(Duration::from_secs(5), client.flush()).await {
        Ok(r) => r?,
        Err(_) => {
            return Err(Error::Timeout(
                "publish flush timed out - the connection may be down".into(),
            ))
        }
    }
    tracing::info!(conn = %conn_id, "published");
    Ok(())
}

#[tauri::command]
pub async fn request(
    conns: State<'_, ConnState>,
    conn_id: String,
    subject: String,
    payload_b64: String,
    timeout_ms: Option<u64>,
    headers: Vec<(String, String)>,
) -> error::Result<IncomingMessage> {
    request_impl(&conns, conn_id, subject, payload_b64, timeout_ms, headers).await
}

pub(crate) async fn request_impl(
    conns: &ConnState,
    conn_id: String,
    subject: String,
    payload_b64: String,
    timeout_ms: Option<u64>,
    headers: Vec<(String, String)>,
) -> error::Result<IncomingMessage> {
    conns.assert_writable(&conn_id).await?;
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;

    let mut req = async_nats::Request::new()
        .payload(decode_payload(&payload_b64)?.into())
        .timeout(Some(Duration::from_millis(timeout_ms.unwrap_or(5000))));
    if let Some(h) = build_headers(headers) {
        req = req.headers(h);
    }
    let resp = client.send_request(subject, req).await?;

    Ok(encode_message(
        resp.subject.to_string(),
        resp.reply.map(|r| r.to_string()),
        &resp.payload,
        flatten_headers(resp.headers.as_ref()),
    ))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PickedPayload {
    name: String,
    size: usize,
    payload_b64: String,
}

/// Pick a file as a publish payload. The picker and read run in Rust (the path
/// never crosses IPC); `max_bytes` caps what gets base64'd into the webview.
#[tauri::command]
pub async fn pick_payload_file(
    app: AppHandle,
    max_bytes: usize,
) -> error::Result<Option<PickedPayload>> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_file())
        .await
        .map_err(|e| Error::Task(e.to_string()))?;
    let Some(path) = picked.and_then(|p| p.as_path().map(Path::to_path_buf)) else {
        return Ok(None);
    };
    Ok(Some(load_picked_payload(path, max_bytes).await?))
}

pub(crate) async fn load_picked_payload(
    path: PathBuf,
    max_bytes: usize,
) -> error::Result<PickedPayload> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|source| Error::Io {
            path: path.display().to_string(),
            source,
        })?;
    let size = usize::try_from(meta.len()).unwrap_or(usize::MAX);
    if size > max_bytes {
        return Err(Error::InvalidInput(format!(
            "file is {size} bytes - larger than the {max_bytes} byte payload limit"
        )));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|source| Error::Io {
        path: path.display().to_string(),
        source,
    })?;
    if bytes.len() > max_bytes {
        return Err(Error::InvalidInput(format!(
            "file is {} bytes - larger than the {max_bytes} byte payload limit",
            bytes.len()
        )));
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    Ok(PickedPayload {
        name,
        size: bytes.len(),
        payload_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiline_value_does_not_panic() {
        // A multi-line rendered responder value used to assert in async-nats.
        let h = build_headers(vec![("Nats-Service-Error".into(), "a\r\nb".into())]);
        assert!(h.is_some());
    }

    #[test]
    fn repeated_keys_keep_every_value() {
        let h = build_headers(vec![
            ("Accept".into(), "one".into()),
            ("Accept".into(), "two".into()),
        ])
        .unwrap();
        let values: Vec<&str> = h
            .get_all("Accept")
            .map(async_nats::HeaderValue::as_str)
            .collect();
        assert_eq!(values, vec!["one", "two"]);
    }

    #[test]
    fn blank_keys_are_skipped() {
        assert!(build_headers(vec![("  ".into(), "v".into())]).is_none());
        assert!(build_headers(vec![]).is_none());
    }

    #[test]
    fn payload_is_base64_decoded() {
        assert_eq!(decode_payload("aGk=").unwrap(), b"hi");
        assert_eq!(decode_payload("").unwrap(), b"");
        assert_eq!(
            decode_payload("not base64!").unwrap_err().kind(),
            "invalidInput"
        );
    }
}
