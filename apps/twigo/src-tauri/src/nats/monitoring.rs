use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::connection::ConnState;
use super::error::{self, Error};

fn mon_err<E: std::fmt::Display>(e: E) -> Error {
    Error::Monitoring(e.to_string())
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
) -> error::Result<T> {
    let client = conns
        .client(conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.to_string()))?;
    let id = client.server_info().server_id;
    let subject = format!("$SYS.REQ.SERVER.{id}.{endpoint}");

    let req = async_nats::Request::new().timeout(Some(Duration::from_secs(4)));
    let msg = client.send_request(subject, req).await.map_err(|e| {
        // A non-system-account connection can't reach $SYS: the request goes
        // nowhere and times out (no explicit no-responders). Treat both as the
        // same actionable "needs a system-account login" state.
        use async_nats::client::RequestErrorKind::{NoResponders, TimedOut};
        if matches!(e.kind(), NoResponders | TimedOut) {
            Error::Monitoring(
                "no response on $SYS — this connection isn't a system-account login, so server monitoring isn't available".to_string(),
            )
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
pub async fn monitor_varz(conns: State<'_, ConnState>, conn_id: String) -> error::Result<Varz> {
    sys_request(&conns, &conn_id, "VARZ").await
}

#[tauri::command]
pub async fn monitor_jsz(conns: State<'_, ConnState>, conn_id: String) -> error::Result<Jsz> {
    sys_request(&conns, &conn_id, "JSZ").await
}

#[tauri::command]
pub async fn monitor_healthz(
    conns: State<'_, ConnState>,
    conn_id: String,
) -> error::Result<Healthz> {
    sys_request(&conns, &conn_id, "HEALTHZ").await
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
