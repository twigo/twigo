use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::task::AbortHandle;
use tokio::time::MissedTickBehavior;

use super::connection::ConnState;
use super::error::{self, Error};

struct Entry {
    conn_id: String,
    // Identifies the task in this slot so a task that ends on its own removes
    // only itself, never a newer re-subscribe that displaced it.
    token: u64,
    handle: AbortHandle,
}

#[derive(Default)]
pub struct SubState {
    // sub_id -> task entry so a connection's subscriptions can all be aborted on
    // disconnect (otherwise the task holds the Subscriber alive and the
    // async-nats event loop never closes the socket). Arc so a task can clean up
    // its own slot when it ends naturally.
    handles: Arc<Mutex<HashMap<String, Entry>>>,
    next_token: AtomicU64,
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

// A coalesced delivery to the frontend. `dropped` reports messages shed
// oldest-first to bound memory/IPC under a flood, so a batched view doesn't
// silently lose data.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessageBatch {
    messages: Vec<IncomingMessage>,
    dropped: u32,
}

// Cap the per-window buffer so a high-rate wildcard can't grow memory or the IPC
// payload without limit; excess is dropped oldest-first with a counter.
const MAX_COALESCE_BUFFER: usize = 10_000;

// Push a message into the bounded coalescing buffer, shedding the oldest (and
// counting it) once the cap is reached.
fn push_bounded(
    buf: &mut VecDeque<IncomingMessage>,
    msg: IncomingMessage,
    dropped: &mut u32,
    cap: usize,
) {
    if buf.len() >= cap {
        buf.pop_front();
        *dropped = dropped.saturating_add(1);
    }
    buf.push_back(msg);
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
    if let Some(entry) = subs.handles.lock().unwrap().remove(sub_id) {
        entry.handle.abort();
    }
}

fn register(subs: &SubState, sub_id: String, conn_id: String, token: u64, handle: AbortHandle) {
    if let Some(displaced) = subs.handles.lock().unwrap().insert(
        sub_id,
        Entry {
            conn_id,
            token,
            handle,
        },
    ) {
        // Concurrent re-subscribes with one sub_id can race past the upfront
        // stop(); an unaborted displaced task would pump duplicates forever.
        displaced.handle.abort();
    }
}

// Drop a slot when its task ended on its own, but only if it still owns the slot
// (a re-subscribe may have displaced it) - so a self-ended subscription doesn't
// leave a dead handle in the map until the next disconnect.
fn deregister(handles: &Mutex<HashMap<String, Entry>>, sub_id: &str, token: u64) {
    let mut map = handles.lock().unwrap();
    if map.get(sub_id).is_some_and(|e| e.token == token) {
        map.remove(sub_id);
    }
}

/// Abort every subscription belonging to a connection (used on disconnect).
pub(crate) fn abort_conn(subs: &SubState, conn_id: &str) {
    subs.handles.lock().unwrap().retain(|_, e| {
        if e.conn_id == conn_id {
            e.handle.abort();
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
    on_message: Channel<MessageBatch>,
    // None/0 = deliver each message immediately (request/reply responders need
    // low latency); Some(ms) = coalesce into batches over the window (streams).
    coalesce_ms: Option<u64>,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;

    stop(&subs, &sub_id);
    let mut sub = client.subscribe(subject.clone()).await?;

    let token = subs.next_token.fetch_add(1, Ordering::Relaxed);
    let handles = subs.handles.clone();
    let task_subject = subject.clone();
    let task_sub_id = sub_id.clone();
    let coalesce = coalesce_ms.filter(|&ms| ms > 0);
    let to_dto = |m: async_nats::Message| {
        encode_message(
            m.subject.to_string(),
            m.reply.map(|r| r.to_string()),
            &m.payload,
            flatten_headers(m.headers.as_ref()),
        )
    };
    let handle = tokio::spawn(async move {
        // The channel closes when its UI tab goes away; end the task quietly (a
        // debug line for observability - this is normal teardown).
        match coalesce {
            None => {
                while let Some(message) = sub.next().await {
                    let batch = MessageBatch {
                        messages: vec![to_dto(message)],
                        dropped: 0,
                    };
                    if on_message.send(batch).is_err() {
                        tracing::debug!(subject = %task_subject, "stream channel closed; ending subscription");
                        break;
                    }
                }
            }
            Some(ms) => {
                let mut buf: VecDeque<IncomingMessage> = VecDeque::new();
                let mut dropped = 0u32;
                let mut tick = tokio::time::interval(Duration::from_millis(ms));
                tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        msg = sub.next() => {
                            let Some(message) = msg else { break };
                            push_bounded(&mut buf, to_dto(message), &mut dropped, MAX_COALESCE_BUFFER);
                        }
                        _ = tick.tick() => {
                            if buf.is_empty() && dropped == 0 {
                                continue;
                            }
                            let batch = MessageBatch {
                                messages: buf.drain(..).collect(),
                                dropped,
                            };
                            dropped = 0;
                            if on_message.send(batch).is_err() {
                                tracing::debug!(subject = %task_subject, "stream channel closed; ending subscription");
                                break;
                            }
                        }
                    }
                }
                // Flush whatever remains when the subscription ends on its own.
                if !buf.is_empty() || dropped > 0 {
                    let _ = on_message.send(MessageBatch {
                        messages: buf.drain(..).collect(),
                        dropped,
                    });
                }
            }
        }
        // Ended on its own (server closed the sub or the UI channel went away);
        // drop the now-dead handle instead of leaking it until disconnect.
        deregister(&handles, &task_sub_id, token);
    });

    register(&subs, sub_id, conn_id.clone(), token, handle.abort_handle());
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
    async fn re_registering_a_sub_id_aborts_the_displaced_task() {
        let subs = SubState::default();
        let first = tokio::spawn(async { std::future::pending::<()>().await });
        register(&subs, "s".into(), "a".into(), 1, first.abort_handle());
        let second = tokio::spawn(async { std::future::pending::<()>().await });
        register(&subs, "s".into(), "a".into(), 2, second.abort_handle());
        assert!(first.await.unwrap_err().is_cancelled());
        assert_eq!(subs.handles.lock().unwrap().len(), 1);
        second.abort();
    }

    #[tokio::test]
    async fn abort_conn_drops_only_that_connections_subs() {
        let subs = SubState::default();
        let entry = |conn: &str| Entry {
            conn_id: conn.into(),
            token: 0,
            handle: tokio::spawn(async {
                std::future::pending::<()>().await;
            })
            .abort_handle(),
        };
        {
            let mut h = subs.handles.lock().unwrap();
            h.insert("s1".into(), entry("a"));
            h.insert("s2".into(), entry("a"));
            h.insert("s3".into(), entry("b"));
        }
        abort_conn(&subs, "a");
        let h = subs.handles.lock().unwrap();
        assert_eq!(h.len(), 1);
        assert!(h.contains_key("s3"));
    }

    #[tokio::test]
    async fn deregister_clears_a_self_ended_task() {
        let subs = SubState::default();
        let h = tokio::spawn(async {});
        let handle = h.abort_handle();
        h.await.unwrap();
        register(&subs, "s".into(), "a".into(), 7, handle);
        deregister(&subs.handles, "s", 7);
        assert!(subs.handles.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn deregister_keeps_a_newer_re_registration() {
        let subs = SubState::default();
        let old = tokio::spawn(async { std::future::pending::<()>().await });
        register(&subs, "s".into(), "a".into(), 1, old.abort_handle());
        let new = tokio::spawn(async { std::future::pending::<()>().await });
        register(&subs, "s".into(), "a".into(), 2, new.abort_handle());
        // The displaced (old) task ends late and tries to clean up: must no-op.
        deregister(&subs.handles, "s", 1);
        let h = subs.handles.lock().unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h.get("s").unwrap().token, 2);
        drop(h);
        new.abort();
    }

    #[test]
    fn push_bounded_sheds_oldest_past_cap() {
        let mut buf: VecDeque<IncomingMessage> = VecDeque::new();
        let mut dropped = 0u32;
        let mk = |s: &str| encode_message(s.into(), None, b"x", Vec::new());
        push_bounded(&mut buf, mk("a"), &mut dropped, 2);
        push_bounded(&mut buf, mk("b"), &mut dropped, 2);
        push_bounded(&mut buf, mk("c"), &mut dropped, 2); // sheds "a"
        assert_eq!(dropped, 1);
        let subjects: Vec<_> = buf.iter().map(|m| m.subject.clone()).collect();
        assert_eq!(subjects, vec!["b", "c"]);
    }
}
