use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::connection::ConnState;
use super::error::{self, Error};

// Scatter-gather window for $SRV discovery: every running instance replies once
// to the reply inbox and there's no terminator, so collect for a fixed window.
const GATHER_MS: u64 = 700;

// Per-endpoint runtime stats from a $SRV.STATS reply. Deserialized from the
// micro wire format (snake_case); re-serialized camelCase for the frontend.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct EndpointStats {
    name: String,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    num_requests: u64,
    #[serde(default)]
    num_errors: u64,
    // processing_time / average_processing_time are nanoseconds on the wire.
    #[serde(default)]
    processing_time: u64,
    #[serde(default)]
    average_processing_time: u64,
    #[serde(default)]
    last_error: String,
    #[serde(default)]
    queue_group: String,
}

// One running service instance, identified by (name, id).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct ServiceStats {
    name: String,
    id: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    started: String,
    #[serde(default)]
    endpoints: Vec<EndpointStats>,
}

// Per-endpoint definition from a $SRV.INFO reply (the human/config side that
// STATS doesn't carry: queue group + metadata).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct EndpointInfo {
    name: String,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    queue_group: String,
    #[serde(default)]
    metadata: HashMap<String, String>,
}

// One running service instance's definition (identified by (name, id)).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct ServiceInfo {
    name: String,
    id: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    metadata: HashMap<String, String>,
    #[serde(default)]
    endpoints: Vec<EndpointInfo>,
}

// Scatter-gather a $SRV verb, deserialize each reply as T, dedupe by (name, id).
async fn gather<T, K>(
    client: &async_nats::Client,
    subject: &'static str,
    key: impl Fn(&T) -> K,
) -> error::Result<Vec<T>>
where
    T: serde::de::DeserializeOwned,
    K: std::hash::Hash + Eq,
{
    let inbox = client.new_inbox();
    let mut sub = client.subscribe(inbox.clone()).await?;
    client
        .publish_with_reply(subject, inbox, Vec::new().into())
        .await?;
    let _ = client.flush().await;

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    while let Ok(Some(msg)) =
        tokio::time::timeout(Duration::from_millis(GATHER_MS), sub.next()).await
    {
        if let Ok(item) = serde_json::from_slice::<T>(&msg.payload) {
            if seen.insert(key(&item)) {
                out.push(item);
            }
        }
    }
    Ok(out)
}

/// Discover running NATS micro services by scatter-gathering `$SRV.STATS`: every
/// instance replies once to a reply inbox, so collect for a short window and
/// dedupe by (name, id). Non-destructive - request/reply only.
#[tauri::command]
pub async fn service_stats(
    conns: State<'_, ConnState>,
    conn_id: String,
) -> error::Result<Vec<ServiceStats>> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let mut out =
        gather::<ServiceStats, _>(&client, "$SRV.STATS", |s| (s.name.clone(), s.id.clone()))
            .await?;
    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

/// Definitions (description, metadata, endpoint queue groups) for running
/// services via a `$SRV.INFO` scatter-gather. Pairs with `service_stats` by
/// (name, id) for a full instance detail.
#[tauri::command]
pub async fn service_info(
    conns: State<'_, ConnState>,
    conn_id: String,
) -> error::Result<Vec<ServiceInfo>> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let mut out =
        gather::<ServiceInfo, _>(&client, "$SRV.INFO", |s| (s.name.clone(), s.id.clone())).await?;
    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_stats_reply_and_serializes_camelcase() {
        let wire = serde_json::json!({
            "type": "io.nats.micro.v1.stats_response",
            "name": "calc",
            "id": "abc123",
            "version": "1.2.0",
            "started": "2024-01-01T00:00:00Z",
            "endpoints": [{
                "name": "add",
                "subject": "calc.add",
                "num_requests": 10,
                "num_errors": 2,
                "processing_time": 5000,
                "average_processing_time": 500,
                "last_error": "boom",
                "queue_group": "q"
            }]
        });
        let stats: ServiceStats = serde_json::from_value(wire).unwrap();
        assert_eq!(stats.name, "calc");
        assert_eq!(stats.id, "abc123");
        assert_eq!(stats.endpoints.len(), 1);
        assert_eq!(stats.endpoints[0].num_requests, 10);

        // Re-serialized to the camelCase shape the frontend consumes.
        let json = serde_json::to_value(&stats).unwrap();
        assert_eq!(json["endpoints"][0]["numRequests"], 10);
        assert_eq!(json["endpoints"][0]["averageProcessingTime"], 500);
        assert_eq!(json["endpoints"][0]["lastError"], "boom");
        assert_eq!(json["endpoints"][0]["queueGroup"], "q");
    }

    #[test]
    fn tolerates_missing_optional_fields() {
        let wire = serde_json::json!({ "name": "svc", "id": "x" });
        let stats: ServiceStats = serde_json::from_value(wire).unwrap();
        assert_eq!(stats.version, "");
        assert!(stats.endpoints.is_empty());
    }

    #[test]
    fn parses_an_info_reply_with_metadata() {
        let wire = serde_json::json!({
            "type": "io.nats.micro.v1.info_response",
            "name": "calc",
            "id": "abc123",
            "version": "1.2.0",
            "description": "adds numbers",
            "metadata": { "owner": "team-a" },
            "endpoints": [{
                "name": "add",
                "subject": "calc.add",
                "queue_group": "q",
                "metadata": { "kind": "rpc" }
            }]
        });
        let info: ServiceInfo = serde_json::from_value(wire).unwrap();
        assert_eq!(info.description, "adds numbers");
        assert_eq!(
            info.metadata.get("owner").map(String::as_str),
            Some("team-a")
        );
        assert_eq!(info.endpoints[0].queue_group, "q");

        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["endpoints"][0]["queueGroup"], "q");
        assert_eq!(json["endpoints"][0]["metadata"]["kind"], "rpc");
    }
}
