use std::time::Duration;

use tauri::State;

use super::connection::ConnState;
use super::error::{self, Error};
use super::subscription::{encode_message, flatten_headers, IncomingMessage};

fn build_headers(pairs: Vec<(String, String)>) -> Option<async_nats::HeaderMap> {
    let mut headers = async_nats::HeaderMap::new();
    let mut any = false;
    for (key, value) in pairs {
        if !key.trim().is_empty() {
            headers.insert(key.as_str(), value.as_str());
            any = true;
        }
    }
    any.then_some(headers)
}

#[tauri::command]
pub async fn publish(
    conns: State<'_, ConnState>,
    conn_id: String,
    subject: String,
    payload: String,
    headers: Vec<(String, String)>,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;

    let bytes = payload.into_bytes();
    match build_headers(headers) {
        Some(h) => {
            client
                .publish_with_headers(subject, h, bytes.into())
                .await?
        }
        None => client.publish(subject, bytes.into()).await?,
    }
    client.flush().await?;
    tracing::info!(conn = %conn_id, "published");
    Ok(())
}

#[tauri::command]
pub async fn request(
    conns: State<'_, ConnState>,
    conn_id: String,
    subject: String,
    payload: String,
    timeout_ms: Option<u64>,
    headers: Vec<(String, String)>,
) -> error::Result<IncomingMessage> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;

    let mut req = async_nats::Request::new()
        .payload(payload.into_bytes().into())
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
