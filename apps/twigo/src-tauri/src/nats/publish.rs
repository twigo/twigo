use std::time::Duration;

use tauri::State;

use super::connection::ConnState;
use super::error::{self, Error};
use super::subscription::{encode_message, flatten_headers, IncomingMessage};

#[tauri::command]
pub async fn publish(
    conns: State<'_, ConnState>,
    conn_id: String,
    subject: String,
    payload: String,
    reply: Option<String>,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;

    let bytes = payload.into_bytes();
    match reply.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => {
            client
                .publish_with_reply(subject, r.to_string(), bytes.into())
                .await?;
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
) -> error::Result<IncomingMessage> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;

    let req = async_nats::Request::new()
        .payload(payload.into_bytes().into())
        .timeout(Some(Duration::from_millis(timeout_ms.unwrap_or(5000))));
    let resp = client.send_request(subject, req).await?;

    Ok(encode_message(
        resp.subject.to_string(),
        resp.reply.map(|r| r.to_string()),
        &resp.payload,
        flatten_headers(resp.headers.as_ref()),
    ))
}
