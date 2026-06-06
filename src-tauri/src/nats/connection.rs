use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use super::context::{load_contexts, NatsContext};

#[derive(Default)]
pub struct ConnState {
    clients: Mutex<HashMap<String, async_nats::Client>>,
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
) -> Result<async_nats::ConnectOptions, String> {
    let f = &ctx.file;

    let base = if let Some(creds) = non_empty(&f.creds) {
        let content =
            std::fs::read_to_string(creds).map_err(|e| format!("read creds file: {e}"))?;
        async_nats::ConnectOptions::new()
            .credentials(&content)
            .map_err(|e| e.to_string())?
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
            let _ = app.emit(
                "nats:event",
                NatsEvent {
                    conn: name,
                    kind: kind.into(),
                },
            );
        }
    }))
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, ConnState>,
    name: String,
    dir: Option<String>,
) -> Result<ConnInfo, String> {
    let custom = dir
        .filter(|d| !d.trim().is_empty())
        .map(std::path::PathBuf::from);
    let ctx = load_contexts(custom)?
        .into_iter()
        .find(|c| c.name == name)
        .ok_or_else(|| format!("context '{name}' not found"))?;

    let url = if ctx.file.url.trim().is_empty() {
        "127.0.0.1:4222".to_string()
    } else {
        ctx.file.url.clone()
    };

    let opts = build_options(&ctx, &app, &name)?;
    let client = opts.connect(url).await.map_err(|e| e.to_string())?;

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

    state.clients.lock().await.insert(name, client);
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, ConnState>, name: String) -> Result<(), String> {
    state.clients.lock().await.remove(&name);
    Ok(())
}

#[tauri::command]
pub async fn list_connections(state: State<'_, ConnState>) -> Result<Vec<String>, String> {
    Ok(state.clients.lock().await.keys().cloned().collect())
}
