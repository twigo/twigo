use std::time::Duration;

use tauri::State;

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
        headers.insert(key.as_str(), value.as_str());
        any = true;
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

#[cfg(test)]
mod tests {
    use super::build_headers;

    #[test]
    fn multiline_value_does_not_panic() {
        // A multi-line rendered responder value used to assert in async-nats.
        let h = build_headers(vec![("Nats-Service-Error".into(), "a\r\nb".into())]);
        assert!(h.is_some());
    }

    #[test]
    fn blank_keys_are_skipped() {
        assert!(build_headers(vec![("  ".into(), "v".into())]).is_none());
        assert!(build_headers(vec![]).is_none());
    }
}
