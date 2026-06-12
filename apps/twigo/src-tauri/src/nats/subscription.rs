use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::task::AbortHandle;

use super::connection::ConnState;
use super::error::{self, Error};

#[derive(Default)]
pub struct SubState {
    // sub_id -> (conn_id, task) so a connection's subscriptions can all be
    // aborted on disconnect (otherwise the task holds the Subscriber alive and
    // the async-nats event loop never closes the socket).
    handles: Mutex<HashMap<String, (String, AbortHandle)>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IncomingMessage {
    subject: String,
    reply: Option<String>,
    payload_b64: String,
    headers: Vec<(String, String)>,
    size: usize,
}

pub(super) fn encode_message(
    subject: String,
    reply: Option<String>,
    payload: &[u8],
    headers: Vec<(String, String)>,
) -> IncomingMessage {
    IncomingMessage {
        subject,
        reply,
        payload_b64: base64::engine::general_purpose::STANDARD.encode(payload),
        headers,
        size: payload.len(),
    }
}

pub(super) fn flatten_headers(headers: Option<&async_nats::HeaderMap>) -> Vec<(String, String)> {
    let Some(headers) = headers else {
        return Vec::new();
    };
    headers
        .iter()
        .flat_map(|(name, values)| {
            values
                .iter()
                .map(move |value| (name.to_string(), value.to_string()))
        })
        .collect()
}

fn stop(subs: &SubState, sub_id: &str) {
    if let Some((_conn, handle)) = subs.handles.lock().unwrap().remove(sub_id) {
        handle.abort();
    }
}

/// Abort every subscription belonging to a connection (used on disconnect).
pub(crate) fn abort_conn(subs: &SubState, conn_id: &str) {
    subs.handles.lock().unwrap().retain(|_, (conn, handle)| {
        if conn == conn_id {
            handle.abort();
            false
        } else {
            true
        }
    });
}

#[tauri::command]
pub async fn subscribe(
    conns: State<'_, ConnState>,
    subs: State<'_, SubState>,
    conn_id: String,
    sub_id: String,
    subject: String,
    on_message: Channel<IncomingMessage>,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;

    stop(&subs, &sub_id);
    let mut sub = client.subscribe(subject.clone()).await?;

    let task_subject = subject.clone();
    let handle = tokio::spawn(async move {
        while let Some(message) = sub.next().await {
            let dto = encode_message(
                message.subject.to_string(),
                message.reply.map(|r| r.to_string()),
                &message.payload,
                flatten_headers(message.headers.as_ref()),
            );
            // The channel closes when its UI tab goes away; end the task quietly
            // (a debug line for observability — this is normal teardown).
            if on_message.send(dto).is_err() {
                tracing::debug!(subject = %task_subject, "stream channel closed; ending subscription");
                break;
            }
        }
    });

    subs.handles
        .lock()
        .unwrap()
        .insert(sub_id, (conn_id.clone(), handle.abort_handle()));
    tracing::info!(conn = %conn_id, %subject, "subscribed");
    Ok(())
}

#[tauri::command]
pub fn unsubscribe(subs: State<'_, SubState>, sub_id: String) {
    stop(&subs, &sub_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_payload_as_base64_with_size() {
        let msg = encode_message("orders.created".into(), None, b"hello", Vec::new());
        assert_eq!(msg.subject, "orders.created");
        assert_eq!(msg.size, 5);
        assert_eq!(msg.payload_b64, "aGVsbG8=");
        assert!(msg.reply.is_none());
    }

    #[tokio::test]
    async fn abort_conn_drops_only_that_connections_subs() {
        let subs = SubState::default();
        let spawn = || {
            tokio::spawn(async {
                std::future::pending::<()>().await;
            })
            .abort_handle()
        };
        {
            let mut h = subs.handles.lock().unwrap();
            h.insert("s1".into(), ("a".into(), spawn()));
            h.insert("s2".into(), ("a".into(), spawn()));
            h.insert("s3".into(), ("b".into(), spawn()));
        }
        abort_conn(&subs, "a");
        let h = subs.handles.lock().unwrap();
        assert_eq!(h.len(), 1);
        assert!(h.contains_key("s3"));
    }
}
