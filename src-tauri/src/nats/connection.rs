use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use super::context::{load_contexts, NatsContext};
use super::error::{self, Error};

#[derive(Default)]
pub struct ConnState {
    clients: Mutex<HashMap<String, async_nats::Client>>,
}

impl ConnState {
    pub(crate) async fn client(&self, name: &str) -> Option<async_nats::Client> {
        self.clients.lock().await.get(name).cloned()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    name: String,
    server_name: String,
    server_version: String,
    rtt_ms: f64,
    jetstream: bool,
    max_payload: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerDetails {
    name: String,
    server_id: String,
    server_name: String,
    version: String,
    go: String,
    host: String,
    port: u16,
    client_id: u64,
    client_ip: String,
    proto: i8,
    max_payload: usize,
    headers: bool,
    auth_required: bool,
    tls_required: bool,
    jetstream: bool,
    lame_duck_mode: bool,
    cluster: Option<String>,
    domain: Option<String>,
    connect_urls: Vec<String>,
    rtt_ms: f64,
}

fn server_details(name: String, info: &async_nats::ServerInfo, rtt_ms: f64) -> ServerDetails {
    ServerDetails {
        name,
        server_id: info.server_id.clone(),
        server_name: info.server_name.clone(),
        version: info.version.clone(),
        go: info.go.clone(),
        host: info.host.clone(),
        port: info.port,
        client_id: info.client_id,
        client_ip: info.client_ip.clone(),
        proto: info.proto,
        max_payload: info.max_payload,
        headers: info.headers,
        auth_required: info.auth_required,
        tls_required: info.tls_required,
        jetstream: info.jetstream,
        lame_duck_mode: info.lame_duck_mode,
        cluster: info.cluster.clone(),
        domain: info.domain.clone(),
        connect_urls: info.connect_urls.clone(),
        rtt_ms,
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NatsEvent {
    conn: String,
    kind: String,
}

fn read_maybe_file(value: &str) -> String {
    if Path::new(value).is_file() {
        std::fs::read_to_string(value)
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| value.to_string())
    } else {
        value.to_string()
    }
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn build_options(
    ctx: &NatsContext,
    app: &AppHandle,
    name: &str,
) -> error::Result<async_nats::ConnectOptions> {
    let f = &ctx.file;

    let base = if let Some(creds) = non_empty(&f.creds) {
        let content = std::fs::read_to_string(creds).map_err(|source| Error::Io {
            path: creds.to_string(),
            source,
        })?;
        async_nats::ConnectOptions::new()
            .credentials(&content)
            .map_err(|e| Error::Credentials(e.to_string()))?
    } else if let Some(token) = non_empty(&f.token) {
        async_nats::ConnectOptions::with_token(token.to_string())
    } else if let (Some(user), Some(pass)) = (non_empty(&f.user), non_empty(&f.password)) {
        async_nats::ConnectOptions::with_user_and_password(user.to_string(), pass.to_string())
    } else if let Some(nkey) = non_empty(&f.nkey) {
        async_nats::ConnectOptions::with_nkey(read_maybe_file(nkey))
    } else {
        async_nats::ConnectOptions::new()
    };

    let app = app.clone();
    let name = name.to_string();
    Ok(base.name("twigo").event_callback(move |event| {
        let app = app.clone();
        let name = name.clone();
        async move {
            let kind = match event {
                async_nats::Event::Connected => "connected",
                async_nats::Event::Disconnected => "disconnected",
                async_nats::Event::Closed => "closed",
                async_nats::Event::LameDuckMode => "lameDuck",
                async_nats::Event::Draining => "draining",
                async_nats::Event::SlowConsumer(_) => "slowConsumer",
                async_nats::Event::ServerError(_) => "serverError",
                async_nats::Event::ClientError(_) => "clientError",
            };
            tracing::debug!(conn = %name, event = kind, "nats event");
            if let Err(e) = app.emit(
                "nats:event",
                NatsEvent {
                    conn: name,
                    kind: kind.into(),
                },
            ) {
                tracing::warn!("failed to emit nats:event: {e}");
            }
        }
    }))
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, ConnState>,
    name: String,
    dir: Option<String>,
) -> error::Result<ConnInfo> {
    let custom = dir
        .filter(|d| !d.trim().is_empty())
        .map(std::path::PathBuf::from);
    let ctx = load_contexts(custom)?
        .into_iter()
        .find(|c| c.name == name)
        .ok_or_else(|| Error::ContextNotFound(name.clone()))?;

    let url = if ctx.file.url.trim().is_empty() {
        "127.0.0.1:4222".to_string()
    } else {
        ctx.file.url.clone()
    };

    let opts = build_options(&ctx, &app, &name)?;
    let client = opts.connect(url).await?;

    let server = client.server_info();
    let started = std::time::Instant::now();
    let rtt_ms = match client.flush().await {
        Ok(()) => started.elapsed().as_secs_f64() * 1000.0,
        Err(_) => 0.0,
    };
    let info = ConnInfo {
        name: name.clone(),
        server_name: server.server_name.clone(),
        server_version: server.version.clone(),
        rtt_ms,
        jetstream: server.jetstream,
        max_payload: server.max_payload,
    };

    tracing::info!(conn = %name, server = %server.server_name, rtt_ms, "connected");
    state.clients.lock().await.insert(name, client);
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, ConnState>, name: String) -> error::Result<()> {
    state.clients.lock().await.remove(&name);
    tracing::info!(conn = %name, "disconnected");
    Ok(())
}

#[tauri::command]
pub async fn list_connections(state: State<'_, ConnState>) -> error::Result<Vec<String>> {
    Ok(state.clients.lock().await.keys().cloned().collect())
}

#[tauri::command]
pub async fn server_info(
    state: State<'_, ConnState>,
    name: String,
) -> error::Result<ServerDetails> {
    let client = state
        .client(&name)
        .await
        .ok_or_else(|| Error::NotConnected(name.clone()))?;

    let info = client.server_info();
    let started = std::time::Instant::now();
    let rtt_ms = match client.flush().await {
        Ok(()) => started.elapsed().as_secs_f64() * 1000.0,
        Err(_) => 0.0,
    };
    Ok(server_details(name, &info, rtt_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_empty_filters_blank_and_trims() {
        assert_eq!(non_empty(&None), None);
        assert_eq!(non_empty(&Some(String::new())), None);
        assert_eq!(non_empty(&Some("   ".into())), None);
        assert_eq!(non_empty(&Some(" token ".into())), Some("token"));
    }

    #[test]
    fn server_details_maps_fields() {
        let info = async_nats::ServerInfo {
            server_name: "twigo-dev".into(),
            version: "2.10.0".into(),
            host: "127.0.0.1".into(),
            port: 4222,
            jetstream: true,
            max_payload: 1_048_576,
            ..Default::default()
        };
        let d = server_details("prod-eu".into(), &info, 1.5);
        assert_eq!(d.name, "prod-eu");
        assert_eq!(d.server_name, "twigo-dev");
        assert_eq!(d.version, "2.10.0");
        assert_eq!(d.host, "127.0.0.1");
        assert_eq!(d.port, 4222);
        assert!(d.jetstream);
        assert_eq!(d.max_payload, 1_048_576);
        assert_eq!(d.rtt_ms, 1.5);
    }
}
