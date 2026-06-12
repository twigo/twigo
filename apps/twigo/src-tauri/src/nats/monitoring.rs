use std::collections::HashSet;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::connection::ConnState;
use super::error::{self, Error};

const NO_SYS: &str = "no response on $SYS — this connection isn't a system-account login, so server monitoring isn't available";

fn mon_err<E: std::fmt::Display>(e: E) -> Error {
    Error::Monitoring(e.to_string())
}

// HTTP monitoring port (:8222) returns the same shapes as $SYS but BARE (no
// {server,data} envelope) and single-server. Used when a context opts in with a
// monitoring_url — the path for connections that aren't system-account logins.
async fn http_get<T: serde::de::DeserializeOwned>(base: &str, path: &str) -> error::Result<T> {
    let url = format!("{}/{}", base.trim_end_matches('/'), path);
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| Error::Monitoring(format!("monitoring request failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(Error::Monitoring(format!(
            "monitoring endpoint returned {status}"
        )));
    }
    resp.json::<T>()
        .await
        .map_err(|e| Error::Monitoring(format!("monitoring response parse failed: {e}")))
}

// $SYS server-API replies wrap the payload: { server, data, error? }. We only
// need data/error; the server block is ignored (serde drops unknown fields).
#[derive(Deserialize)]
struct ServerApiResponse<T> {
    #[serde(default = "none")]
    data: Option<T>,
    #[serde(default)]
    error: Option<ApiError>,
}

fn none<T>() -> Option<T> {
    None
}

#[derive(Deserialize)]
struct ApiError {
    #[serde(default)]
    description: String,
}

// Wire is snake_case (NATS); the frontend gets camelCase. rename_all only on
// serialize keeps deserialize matching the snake_case field names.
#[derive(Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Varz {
    server_id: String,
    server_name: String,
    version: String,
    host: String,
    port: u16,
    #[serde(default)]
    max_payload: i64,
    now: String,
    uptime: String,
    #[serde(default)]
    mem: i64,
    #[serde(default)]
    cores: u64,
    #[serde(default)]
    cpu: f64,
    #[serde(default)]
    connections: u64,
    #[serde(default)]
    total_connections: u64,
    #[serde(default)]
    subscriptions: u64,
    #[serde(default)]
    in_msgs: i64,
    #[serde(default)]
    in_bytes: i64,
    #[serde(default)]
    out_msgs: i64,
    #[serde(default)]
    out_bytes: i64,
    #[serde(default)]
    slow_consumers: i64,
    #[serde(default)]
    routes: u64,
    #[serde(default)]
    remotes: u64,
    #[serde(default)]
    leafnodes: u64,
    #[serde(default)]
    cluster: VarzCluster,
    #[serde(default)]
    lame_duck_mode: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct VarzCluster {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Jsz {
    #[serde(default)]
    memory: i64,
    #[serde(default)]
    storage: i64,
    #[serde(default)]
    reserved_memory: i64,
    #[serde(default)]
    reserved_storage: i64,
    #[serde(default)]
    accounts: i64,
    #[serde(default)]
    ha_assets: i64,
    #[serde(default)]
    streams: u64,
    #[serde(default)]
    consumers: u64,
    #[serde(default)]
    messages: u64,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    config: JszConfig,
    #[serde(default)]
    api: JszApi,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct JszConfig {
    #[serde(default)]
    max_memory: i64,
    #[serde(default)]
    max_storage: i64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct JszApi {
    #[serde(default)]
    level: i64,
    #[serde(default)]
    total: u64,
    #[serde(default)]
    errors: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Healthz {
    status: String,
    #[serde(default)]
    status_code: u16,
}

// Ask the connected server its own endpoint over $SYS. Targets the exact server
// by id (server_info), so it never wanders to a cluster peer. No-responders means
// the connection isn't a system-account login → a clear, typed unavailable state.
async fn sys_request<T: serde::de::DeserializeOwned>(
    conns: &State<'_, ConnState>,
    conn_id: &str,
    endpoint: &str,
    body: Vec<u8>,
) -> error::Result<T> {
    let client = conns
        .client(conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.to_string()))?;
    let id = client.server_info().server_id;
    let subject = format!("$SYS.REQ.SERVER.{id}.{endpoint}");

    let req = async_nats::Request::new()
        .payload(body.into())
        .timeout(Some(Duration::from_secs(4)));
    let msg = client.send_request(subject, req).await.map_err(|e| {
        // A non-system-account connection can't reach $SYS: the request goes
        // nowhere and times out (no explicit no-responders). Treat both as the
        // same actionable "needs a system-account login" state.
        use async_nats::client::RequestErrorKind::{NoResponders, TimedOut};
        if matches!(e.kind(), NoResponders | TimedOut) {
            Error::Monitoring(NO_SYS.to_string())
        } else {
            mon_err(e)
        }
    })?;

    let resp: ServerApiResponse<T> = serde_json::from_slice(&msg.payload).map_err(mon_err)?;
    if let Some(err) = resp.error {
        return Err(Error::Monitoring(err.description));
    }
    resp.data
        .ok_or_else(|| Error::Monitoring("empty monitoring response".to_string()))
}

#[tauri::command]
pub async fn monitor_varz(
    conns: State<'_, ConnState>,
    conn_id: String,
    monitoring_url: Option<String>,
) -> error::Result<Varz> {
    match monitoring_url {
        Some(url) => http_get(&url, "varz").await,
        None => sys_request(&conns, &conn_id, "VARZ", Vec::new()).await,
    }
}

#[tauri::command]
pub async fn monitor_jsz(
    conns: State<'_, ConnState>,
    conn_id: String,
    monitoring_url: Option<String>,
) -> error::Result<Jsz> {
    match monitoring_url {
        Some(url) => http_get(&url, "jsz").await,
        None => sys_request(&conns, &conn_id, "JSZ", Vec::new()).await,
    }
}

#[tauri::command]
pub async fn monitor_healthz(
    conns: State<'_, ConnState>,
    conn_id: String,
    monitoring_url: Option<String>,
) -> error::Result<Healthz> {
    match monitoring_url {
        Some(url) => http_get(&url, "healthz").await,
        None => sys_request(&conns, &conn_id, "HEALTHZ", Vec::new()).await,
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Connz {
    now: String,
    num_connections: u64,
    total: u64,
    offset: u64,
    limit: u64,
    #[serde(default)]
    connections: Vec<ConnzConn>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct ConnzConn {
    cid: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    lang: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    ip: String,
    #[serde(default)]
    port: u32,
    #[serde(default)]
    account: Option<String>,
    #[serde(default)]
    subscriptions: u64,
    #[serde(default)]
    pending_bytes: i64,
    #[serde(default)]
    in_msgs: i64,
    #[serde(default)]
    out_msgs: i64,
    #[serde(default)]
    in_bytes: i64,
    #[serde(default)]
    out_bytes: i64,
    #[serde(default)]
    rtt: String,
    #[serde(default)]
    idle: String,
    #[serde(default)]
    uptime: String,
    #[serde(default)]
    last_activity: String,
}

// Connz request options become the request body; the server sorts & paginates.
#[derive(Serialize)]
struct ConnzReq<'a> {
    sort: &'a str,
    limit: u32,
    offset: u32,
}

#[tauri::command]
pub async fn monitor_connz(
    conns: State<'_, ConnState>,
    conn_id: String,
    sort: String,
    limit: u32,
    offset: u32,
    monitoring_url: Option<String>,
) -> error::Result<Connz> {
    if let Some(url) = monitoring_url {
        return http_get(&url, &format!("connz?sort={sort}&limit={limit}&offset={offset}")).await;
    }
    let body = serde_json::to_vec(&ConnzReq {
        sort: &sort,
        limit,
        offset,
    })
    .map_err(mon_err)?;
    sys_request(&conns, &conn_id, "CONNZ", body).await
}

// Cluster-wide health: fan out a PING to every server and collect each node's
// varz. Reply count is unknown up front, so gather until a short idle gap.
#[tauri::command]
pub async fn monitor_cluster(
    conns: State<'_, ConnState>,
    conn_id: String,
    monitoring_url: Option<String>,
) -> error::Result<Vec<Varz>> {
    // HTTP :8222 is one server's endpoint — no cluster fan-in, just this node.
    if let Some(url) = monitoring_url {
        return Ok(vec![http_get(&url, "varz").await?]);
    }

    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;

    let inbox = client.new_inbox();
    let mut sub = client.subscribe(inbox.clone()).await.map_err(mon_err)?;
    client
        .publish_with_reply("$SYS.REQ.SERVER.PING.VARZ", inbox, Vec::new().into())
        .await
        .map_err(mon_err)?;
    let _ = client.flush().await;

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    while let Ok(Some(msg)) = tokio::time::timeout(Duration::from_millis(700), sub.next()).await {
        if let Ok(resp) = serde_json::from_slice::<ServerApiResponse<Varz>>(&msg.payload) {
            if let Some(v) = resp.data {
                if seen.insert(v.server_id.clone()) {
                    out.push(v);
                }
            }
        }
    }

    if out.is_empty() {
        return Err(Error::Monitoring(NO_SYS.to_string()));
    }
    out.sort_by(|a, b| a.server_name.cmp(&b.server_name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_varz_envelope() {
        let raw = include_str!("../../tests/fixtures/varz.json");
        let resp: ServerApiResponse<Varz> = serde_json::from_str(raw).unwrap();
        let v = resp.data.expect("data present");
        assert_eq!(v.server_name, "twigo-dev");
        assert!(v.connections > 0);
        assert!(v.cluster.name.is_none()); // single server
    }

    #[test]
    fn parses_jsz_envelope() {
        let raw = include_str!("../../tests/fixtures/jsz.json");
        let resp: ServerApiResponse<Jsz> = serde_json::from_str(raw).unwrap();
        let j = resp.data.expect("data present");
        assert!(j.config.max_storage > 0);
    }

    #[test]
    fn parses_connz_envelope() {
        let raw = include_str!("../../tests/fixtures/connz.json");
        let resp: ServerApiResponse<Connz> = serde_json::from_str(raw).unwrap();
        let c = resp.data.expect("data present");
        assert!(c.total >= c.num_connections);
        assert!(!c.connections.is_empty());
        assert!(c.connections[0].cid > 0);
    }

    #[test]
    fn parses_healthz_and_error_envelope() {
        let raw = include_str!("../../tests/fixtures/healthz.json");
        let resp: ServerApiResponse<Healthz> = serde_json::from_str(raw).unwrap();
        assert_eq!(resp.data.expect("data present").status, "ok");

        let err_raw = r#"{"server":{},"error":{"description":"boom","code":400}}"#;
        let er: ServerApiResponse<Varz> = serde_json::from_str(err_raw).unwrap();
        assert!(er.error.is_some());
        assert!(er.data.is_none());
    }
}
