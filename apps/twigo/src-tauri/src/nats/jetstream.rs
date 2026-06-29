use async_nats::jetstream::consumer::AckPolicy;
use async_nats::jetstream::stream::{RawMessageErrorKind, RetentionPolicy, StorageType};
use base64::Engine;
use futures_util::{StreamExt, TryStreamExt};
use serde::Serialize;
use tauri::State;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::connection::ConnState;
use super::error::{self, Error};

pub(crate) fn js_err<E: std::fmt::Display>(e: E) -> Error {
    Error::JetStream(e.to_string())
}

pub(crate) fn fmt_time(t: OffsetDateTime) -> Option<String> {
    t.format(&Rfc3339).ok()
}

pub(crate) fn storage_str(s: &StorageType) -> String {
    match s {
        StorageType::File => "file",
        StorageType::Memory => "memory",
    }
    .to_string()
}

fn retention_str(r: &RetentionPolicy) -> String {
    match r {
        RetentionPolicy::Limits => "limits",
        RetentionPolicy::Interest => "interest",
        RetentionPolicy::WorkQueue => "workqueue",
    }
    .to_string()
}

fn ack_policy_str(a: &AckPolicy) -> String {
    match a {
        AckPolicy::None => "none",
        AckPolicy::All => "all",
        AckPolicy::Explicit => "explicit",
        AckPolicy::FlowControl => "flow-control",
    }
    .to_string()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamSummary {
    name: String,
    subjects: Vec<String>,
    messages: u64,
    bytes: u64,
    first_seq: u64,
    last_seq: u64,
    consumer_count: usize,
    storage: String,
    retention: String,
}

fn stream_summary(info: &async_nats::jetstream::stream::Info) -> StreamSummary {
    let cfg = &info.config;
    let st = &info.state;
    StreamSummary {
        name: cfg.name.clone(),
        subjects: cfg.subjects.clone(),
        messages: st.messages,
        bytes: st.bytes,
        first_seq: st.first_sequence,
        last_seq: st.last_sequence,
        consumer_count: st.consumer_count,
        storage: storage_str(&cfg.storage),
        retention: retention_str(&cfg.retention),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerSummary {
    name: String,
    durable: bool,
    // "pull" | "push"
    kind: String,
    ack_policy: String,
    // Server-computed lag: respects filter subjects and deletes (unlike a raw
    // last_seq - ack_floor subtraction).
    num_pending: u64,
    num_ack_pending: usize,
    num_redelivered: usize,
    paused: bool,
}

fn consumer_summary(info: &async_nats::jetstream::consumer::Info) -> ConsumerSummary {
    let cfg = &info.config;
    ConsumerSummary {
        name: info.name.clone(),
        durable: cfg.durable_name.is_some(),
        kind: if cfg.deliver_subject.is_some() {
            "push".to_string()
        } else {
            "pull".to_string()
        },
        ack_policy: ack_policy_str(&cfg.ack_policy),
        num_pending: info.num_pending,
        num_ack_pending: info.num_ack_pending,
        num_redelivered: info.num_redelivered,
        paused: info.paused,
    }
}

#[tauri::command]
pub async fn js_list_streams(
    conns: State<'_, ConnState>,
    conn_id: String,
) -> error::Result<Vec<StreamSummary>> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);

    let mut infos = js.streams();
    let mut out = Vec::new();
    while let Some(info) = infos.try_next().await.map_err(js_err)? {
        out.push(stream_summary(&info));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamDetail {
    // Full stream config (Config is Serialize) - drives the Config panel + the
    // Raw-JSON toggle. State is split out because Info itself isn't Serialize.
    config: serde_json::Value,
    created: Option<String>,
    messages: u64,
    bytes: u64,
    first_seq: u64,
    first_ts: Option<String>,
    last_seq: u64,
    last_ts: Option<String>,
    consumer_count: usize,
    num_subjects: u64,
    num_deleted: u64,
}

#[tauri::command]
pub async fn js_stream_detail(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
) -> error::Result<StreamDetail> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;
    let info = handle.cached_info();
    let st = &info.state;
    Ok(StreamDetail {
        config: serde_json::to_value(&info.config).map_err(js_err)?,
        created: fmt_time(info.created),
        messages: st.messages,
        bytes: st.bytes,
        first_seq: st.first_sequence,
        first_ts: fmt_time(st.first_timestamp),
        last_seq: st.last_sequence,
        last_ts: fmt_time(st.last_timestamp),
        consumer_count: st.consumer_count,
        num_subjects: st.subjects_count,
        num_deleted: st.deleted_count.unwrap_or(0),
    })
}

#[tauri::command]
pub async fn js_list_consumers(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
) -> error::Result<Vec<ConsumerSummary>> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;

    let mut consumers = handle.consumers();
    let mut out = Vec::new();
    while let Some(info) = consumers.try_next().await.map_err(js_err)? {
        out.push(consumer_summary(&info));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerDetail {
    config: serde_json::Value,
    created: Option<String>,
    num_pending: u64,
    num_ack_pending: usize,
    num_redelivered: usize,
    num_waiting: usize,
    delivered_consumer_seq: u64,
    delivered_stream_seq: u64,
    ack_floor_consumer_seq: u64,
    ack_floor_stream_seq: u64,
    paused: bool,
}

#[tauri::command]
pub async fn js_consumer_detail(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
    consumer: String,
) -> error::Result<ConsumerDetail> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;
    let info = handle.consumer_info(&consumer).await.map_err(js_err)?;
    Ok(ConsumerDetail {
        config: serde_json::to_value(&info.config).map_err(js_err)?,
        created: fmt_time(info.created),
        num_pending: info.num_pending,
        num_ack_pending: info.num_ack_pending,
        num_redelivered: info.num_redelivered,
        num_waiting: info.num_waiting,
        delivered_consumer_seq: info.delivered.consumer_sequence,
        delivered_stream_seq: info.delivered.stream_sequence,
        ack_floor_consumer_seq: info.ack_floor.consumer_sequence,
        ack_floor_stream_seq: info.ack_floor.stream_sequence,
        paused: info.paused,
    })
}

// Cap the payload sent over IPC; a multi-MB stored message would otherwise be
// base64-encoded and rendered whole. `size` stays the true byte length.
const MAX_BROWSE_PAYLOAD: usize = 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    seq: u64,
    subject: String,
    time: Option<String>,
    size: usize,
    payload_b64: String,
    headers: Vec<(String, String)>,
    truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    messages: Vec<StoredMessage>,
    // Cursor to continue browsing (next sequence to fetch), or null at the edge.
    next_seq: Option<u64>,
}

// Fetch this many sequences concurrently per page; a sequential per-seq walk is
// a latency-bound N+1 stall on a remote server (e.g. demo.nats.io).
const GET_CONCURRENCY: usize = 32;

// Sequences to scan for one page, in walk order, capped at `max_scan` and the
// stream's [first, last] bounds. Pure, so the paging edges stay unit-testable.
fn candidate_seqs(first: u64, last: u64, start: u64, max_scan: u64, backward: bool) -> Vec<u64> {
    if last == 0 || first > last || max_scan == 0 {
        return Vec::new();
    }
    let mut seq = start.clamp(first, last);
    let mut seqs = Vec::new();
    while (seqs.len() as u64) < max_scan {
        seqs.push(seq);
        if backward {
            if seq <= first {
                break;
            }
            seq -= 1;
        } else {
            if seq >= last {
                break;
            }
            seq += 1;
        }
    }
    seqs
}

// The cursor to resume browsing from after consuming up to `consumed_last`, or
// None once the walk has reached the stream edge.
fn next_cursor(consumed_last: u64, first: u64, last: u64, backward: bool) -> Option<u64> {
    if backward {
        (consumed_last > first).then(|| consumed_last - 1)
    } else {
        (consumed_last < last).then(|| consumed_last + 1)
    }
}

/// Non-destructive message browse: walks sequences via get_raw_message (never
/// creates a consumer, never advances any ack floor), skipping deleted gaps.
#[tauri::command]
pub async fn js_get_messages(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
    start: Option<u64>,
    limit: u32,
    backward: bool,
) -> error::Result<MessagePage> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;
    let state = &handle.cached_info().state;
    let (first, last) = (state.first_sequence, state.last_sequence);

    if state.messages == 0 || last == 0 {
        return Ok(MessagePage {
            messages: Vec::new(),
            next_seq: None,
        });
    }

    let limit = limit.clamp(1, 500) as usize;
    let max_scan = (limit as u64).saturating_mul(4).saturating_add(50);
    let start = start
        .unwrap_or(if backward { last } else { first })
        .clamp(first, last);

    let candidates = candidate_seqs(first, last, start, max_scan, backward);
    let handle = &handle;
    let mut fetches = futures_util::stream::iter(candidates)
        .map(|seq| async move { (seq, handle.get_raw_message(seq).await) })
        .buffered(GET_CONCURRENCY);

    let mut messages = Vec::with_capacity(limit);
    let mut consumed_last = start;
    while let Some((seq, result)) = fetches.next().await {
        consumed_last = seq;
        match result {
            // StreamMessage is an unnameable type, so build the DTO inline.
            Ok(raw) => {
                let truncated = raw.payload.len() > MAX_BROWSE_PAYLOAD;
                let bytes = if truncated {
                    &raw.payload[..MAX_BROWSE_PAYLOAD]
                } else {
                    &raw.payload[..]
                };
                messages.push(StoredMessage {
                    seq: raw.sequence,
                    subject: raw.subject.to_string(),
                    time: fmt_time(raw.time),
                    size: raw.payload.len(),
                    payload_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
                    headers: super::subscription::flatten_headers(Some(&raw.headers)),
                    truncated,
                });
                if messages.len() >= limit {
                    break;
                }
            }
            // A deleted/purged sequence is an expected gap - keep walking.
            Err(e) if matches!(e.kind(), RawMessageErrorKind::NoMessageFound) => {}
            // A real fetch failure must surface, not be silently skipped.
            Err(e) => return Err(js_err(e)),
        }
    }

    let next_seq = next_cursor(consumed_last, first, last, backward);
    Ok(MessagePage { messages, next_seq })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    purged: u64,
}

#[tauri::command]
pub async fn js_purge_stream(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
    keep: Option<u64>,
    up_to_seq: Option<u64>,
) -> error::Result<PurgeResult> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;
    // keep/sequence are mutually exclusive (enforced by the builder's generics).
    let resp = match (keep, up_to_seq) {
        (Some(k), _) => handle.purge().keep(k).await,
        (_, Some(s)) => handle.purge().sequence(s).await,
        _ => handle.purge().await,
    }
    .map_err(js_err)?;
    Ok(PurgeResult {
        purged: resp.purged,
    })
}

#[tauri::command]
pub async fn js_create_stream(
    conns: State<'_, ConnState>,
    conn_id: String,
    config: serde_json::Value,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    // Deserialize into the typed config so defaults/feature-gated fields are
    // handled by async-nats rather than forwarding raw JSON.
    let cfg: async_nats::jetstream::stream::Config =
        serde_json::from_value(config).map_err(js_err)?;
    js.create_stream(cfg).await.map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn js_update_stream(
    conns: State<'_, ConnState>,
    conn_id: String,
    config: serde_json::Value,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let cfg: async_nats::jetstream::stream::Config =
        serde_json::from_value(config).map_err(js_err)?;
    js.update_stream(&cfg).await.map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn js_create_consumer(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
    config: serde_json::Value,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;
    let cfg: async_nats::jetstream::consumer::Config =
        serde_json::from_value(config).map_err(js_err)?;
    let _consumer = handle.create_consumer(cfg).await.map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn js_delete_stream(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    js.delete_stream(&stream).await.map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn js_delete_consumer(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
    consumer: String,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;
    handle.delete_consumer(&consumer).await.map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn js_pause_consumer(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
    consumer: String,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;
    // Pause far into the future = effectively indefinite (resume re-enables it).
    let until = OffsetDateTime::now_utc() + time::Duration::days(36500);
    handle
        .pause_consumer(&consumer, until)
        .await
        .map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn js_resume_consumer(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
    consumer: String,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;
    handle.resume_consumer(&consumer).await.map_err(js_err)?;
    Ok(())
}

#[tauri::command]
pub async fn js_delete_message(
    conns: State<'_, ConnState>,
    conn_id: String,
    stream: String,
    seq: u64,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let js = async_nats::jetstream::new(client);
    let handle = js.get_stream(&stream).await.map_err(js_err)?;
    handle.delete_message(seq).await.map_err(js_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_storage_retention_and_ack_policy() {
        assert_eq!(storage_str(&StorageType::File), "file");
        assert_eq!(storage_str(&StorageType::Memory), "memory");
        assert_eq!(retention_str(&RetentionPolicy::WorkQueue), "workqueue");
        assert_eq!(retention_str(&RetentionPolicy::Interest), "interest");
        assert_eq!(ack_policy_str(&AckPolicy::Explicit), "explicit");
        assert_eq!(ack_policy_str(&AckPolicy::None), "none");
    }

    #[test]
    fn candidate_seqs_walks_to_the_stream_edge() {
        assert_eq!(candidate_seqs(1, 10, 8, 100, false), vec![8, 9, 10]);
        assert_eq!(candidate_seqs(3, 10, 5, 100, true), vec![5, 4, 3]);
    }

    #[test]
    fn candidate_seqs_is_bounded_by_max_scan() {
        assert_eq!(candidate_seqs(1, 100, 1, 3, false), vec![1, 2, 3]);
        assert_eq!(candidate_seqs(1, 100, 10, 3, true), vec![10, 9, 8]);
    }

    #[test]
    fn candidate_seqs_clamps_start_into_range() {
        assert_eq!(candidate_seqs(5, 8, 1, 100, false), vec![5, 6, 7, 8]);
        assert_eq!(candidate_seqs(5, 8, 99, 100, true), vec![8, 7, 6, 5]);
    }

    #[test]
    fn candidate_seqs_empty_on_empty_stream_or_zero_scan() {
        assert!(candidate_seqs(0, 0, 0, 10, false).is_empty());
        assert!(candidate_seqs(1, 10, 5, 0, false).is_empty());
    }

    #[test]
    fn next_cursor_stops_at_the_edge() {
        assert_eq!(next_cursor(5, 1, 10, false), Some(6));
        assert_eq!(next_cursor(10, 1, 10, false), None);
        assert_eq!(next_cursor(5, 1, 10, true), Some(4));
        assert_eq!(next_cursor(1, 1, 10, true), None);
    }
}
