use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use super::context::{demo_context, load_contexts, ContextFile, NatsContext, DEMO_CONTEXT_NAME};
use super::error::{self, Error};
use super::subjects::{self, SubjectWatch};
use super::subscription::{abort_conn, SubState};

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
    // False while the client is still (re)connecting in the background - the
    // server info/rtt above are placeholders until a real link is up.
    connected: bool,
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
    // Human-readable cause for error-bearing events (server/client error), so
    // the UI can surface "authorization violation" instead of a bare kind.
    detail: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReconnectEvent {
    conn: String,
    attempt: usize,
    delay_ms: u64,
}

// Visible exponential backoff (the async-nats default is sub-second and flashes
// past): 0 → 250ms → 0.5s → 1s → 2s → 4s → 8s, capped at 15s.
fn reconnect_backoff(attempts: usize) -> std::time::Duration {
    if attempts <= 1 {
        return std::time::Duration::from_millis(0);
    }
    let exp = u32::try_from(attempts - 2).unwrap_or(u32::MAX).min(20);
    let ms = 250u64.saturating_mul(2u64.saturating_pow(exp)).min(15_000);
    std::time::Duration::from_millis(ms)
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

// RTT via flush timing, bounded so a still-reconnecting client (server down at
// launch under retry_on_initial_connect) can't hang the command. A successful
// flush also doubles as the "is the link actually up" signal: Some(rtt) means
// connected, None means still (re)connecting.
async fn measure_rtt(client: &async_nats::Client) -> Option<f64> {
    let started = std::time::Instant::now();
    match tokio::time::timeout(std::time::Duration::from_secs(2), client.flush()).await {
        Ok(Ok(())) => Some(started.elapsed().as_secs_f64() * 1000.0),
        _ => None,
    }
}

async fn build_conn_info(name: String, client: &async_nats::Client) -> ConnInfo {
    let rtt = measure_rtt(client).await;
    let server = client.server_info();
    ConnInfo {
        name,
        server_name: server.server_name.clone(),
        server_version: server.version.clone(),
        rtt_ms: rtt.unwrap_or(0.0),
        jetstream: server.jetstream,
        max_payload: server.max_payload,
        connected: rtt.is_some(),
    }
}

// Pure so the decision is unit-testable; ConnectOptions itself is opaque.
#[derive(Debug, Default, PartialEq, Eq)]
struct TlsPlan {
    ca: Option<PathBuf>,
    client: Option<(PathBuf, PathBuf)>,
    tls_first: bool,
    // Force a TLS handshake when the context carries TLS material: without it
    // async-nats only upgrades on a tls:// URL or server-advertised tls_required,
    // so a ca/cert context on nats:// could silently connect in plaintext.
    require: bool,
}

fn tls_plan(f: &ContextFile) -> TlsPlan {
    let ca = non_empty(&f.ca).map(PathBuf::from);
    let client = match (non_empty(&f.cert), non_empty(&f.key)) {
        (Some(cert), Some(key)) => Some((PathBuf::from(cert), PathBuf::from(key))),
        _ => None,
    };
    let require = ca.is_some() || client.is_some() || f.tls_first;
    TlsPlan {
        ca,
        client,
        tls_first: f.tls_first,
        require,
    }
}

fn apply_tls(opts: async_nats::ConnectOptions, plan: TlsPlan) -> async_nats::ConnectOptions {
    let mut opts = opts;
    if plan.require {
        opts = opts.require_tls(true);
    }
    if let Some(ca) = plan.ca {
        opts = opts.add_root_certificates(ca);
    }
    if let Some((cert, key)) = plan.client {
        opts = opts.add_client_certificate(cert, key);
    }
    if plan.tls_first {
        opts = opts.tls_first();
    }
    opts
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

    let base = apply_tls(base, tls_plan(f));

    let app = app.clone();
    let name = name.to_string();
    let rc_app = app.clone();
    let rc_name = name.clone();
    // Keep the client alive across a server that is briefly unavailable - this
    // lets a saved connection restore on launch even if its server is down,
    // and survives transient drops mid-session.
    Ok(base
        .name("twigo")
        // Twigo is an inspection tool: a connection must stay on the exact
        // server the user picked. Without this, async-nats adds the cluster
        // peers a server advertises (INFO.connect_urls) to its pool and can
        // (re)connect to any of them - so a dev/staging context clustered with
        // prod would silently show prod's data. Pin to the configured URL.
        .ignore_discovered_servers()
        .retain_servers_order()
        .retry_on_initial_connect()
        .max_reconnects(None)
        // Called before each (re)connect attempt with the attempt count; report
        // it + the chosen delay so the UI can show "attempt N · next try in Xs".
        .reconnect_delay_callback(move |attempts| {
            let delay = reconnect_backoff(attempts);
            if let Err(e) = rc_app.emit(
                "nats:reconnect",
                ReconnectEvent {
                    conn: rc_name.clone(),
                    attempt: attempts,
                    delay_ms: delay.as_millis() as u64,
                },
            ) {
                tracing::warn!("failed to emit nats:reconnect: {e}");
            }
            delay
        })
        .event_callback(move |event| {
            let app = app.clone();
            let name = name.clone();
            async move {
                let (kind, detail) = match &event {
                    async_nats::Event::Connected => ("connected", None),
                    async_nats::Event::Disconnected => ("disconnected", None),
                    async_nats::Event::Closed => ("closed", None),
                    async_nats::Event::LameDuckMode => ("lameDuck", None),
                    async_nats::Event::Draining => ("draining", None),
                    async_nats::Event::SlowConsumer(_) => ("slowConsumer", None),
                    async_nats::Event::ServerError(e) => ("serverError", Some(e.to_string())),
                    async_nats::Event::ClientError(e) => ("clientError", Some(e.to_string())),
                };
                tracing::debug!(conn = %name, event = kind, detail = ?detail, "nats event");
                if let Err(e) = app.emit(
                    "nats:event",
                    NatsEvent {
                        conn: name,
                        kind: kind.into(),
                        detail,
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
    subs: State<'_, SubState>,
    watch: State<'_, SubjectWatch>,
    name: String,
    dir: Option<String>,
) -> error::Result<ConnInfo> {
    let custom = dir
        .filter(|d| !d.trim().is_empty())
        .map(std::path::PathBuf::from);

    // The demo server is synthetic (no file on disk); everything else is read
    // from the context dir. Config + creds reads are blocking std::fs, so keep
    // them off the async runtime.
    let ctx = if name == DEMO_CONTEXT_NAME {
        demo_context()
    } else {
        let lookup = name.clone();
        tokio::task::spawn_blocking(move || {
            load_contexts(custom)?
                .into_iter()
                .find(|c| c.name == lookup)
                .ok_or_else(|| Error::ContextNotFound(lookup.clone()))
        })
        .await
        .map_err(|e| Error::Task(e.to_string()))??
    };

    let url = if ctx.file.url.trim().is_empty() {
        "127.0.0.1:4222".to_string()
    } else {
        ctx.file.url.clone()
    };

    let opts = {
        let app = app.clone();
        let name = name.clone();
        tokio::task::spawn_blocking(move || build_options(&ctx, &app, &name))
            .await
            .map_err(|e| Error::Task(e.to_string()))??
    };
    let client = opts.connect(url.clone()).await?;
    let info = build_conn_info(name.clone(), &client).await;

    // Reconnecting the same name: tear down the previous connection's tasks so
    // the old client/socket closes instead of leaking behind the new one.
    abort_conn(&subs, &name);
    subjects::stop(&watch, &name);
    tracing::info!(
        conn = %name,
        url = %url,
        server = %info.server_name,
        connected = info.connected,
        "connect"
    );
    state.clients.lock().await.insert(name, client);
    Ok(info)
}

#[tauri::command]
pub async fn conn_info(state: State<'_, ConnState>, name: String) -> error::Result<ConnInfo> {
    let client = state
        .client(&name)
        .await
        .ok_or_else(|| Error::NotConnected(name.clone()))?;
    Ok(build_conn_info(name, &client).await)
}

#[tauri::command]
pub async fn disconnect(
    state: State<'_, ConnState>,
    subs: State<'_, SubState>,
    watch: State<'_, SubjectWatch>,
    name: String,
) -> error::Result<()> {
    // Abort the connection's subscription + watch tasks first so their
    // Subscribers drop and the async-nats event loop can close the socket;
    // only then drop the client.
    abort_conn(&subs, &name);
    subjects::stop(&watch, &name);
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
    let rtt_ms = measure_rtt(&client).await.unwrap_or(0.0);
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
    fn tls_plan_maps_context_materials() {
        let none = tls_plan(&ContextFile::default());
        assert_eq!(none, TlsPlan::default());
        assert!(none.ca.is_none() && none.client.is_none() && !none.tls_first);
        assert!(!none.require);

        let ca_only = tls_plan(&ContextFile {
            ca: Some("/etc/ca.pem".into()),
            ..Default::default()
        });
        assert_eq!(ca_only.ca, Some(PathBuf::from("/etc/ca.pem")));
        assert!(ca_only.client.is_none());
        assert!(ca_only.require);

        let mtls = tls_plan(&ContextFile {
            cert: Some("/c.pem".into()),
            key: Some("/k.pem".into()),
            tls_first: true,
            ..Default::default()
        });
        assert_eq!(
            mtls.client,
            Some((PathBuf::from("/c.pem"), PathBuf::from("/k.pem")))
        );
        assert!(mtls.tls_first);
        assert!(mtls.require);

        // A cert without its key (or vice versa) is not usable for client auth.
        let half = tls_plan(&ContextFile {
            cert: Some("/c.pem".into()),
            ..Default::default()
        });
        assert!(half.client.is_none());
        assert!(!half.require);

        // tls_first alone (no certs) still forces TLS.
        let first_only = tls_plan(&ContextFile {
            tls_first: true,
            ..Default::default()
        });
        assert!(first_only.require);

        // Blank strings are treated as absent.
        let blank = tls_plan(&ContextFile {
            ca: Some("   ".into()),
            ..Default::default()
        });
        assert!(blank.ca.is_none());
        assert!(!blank.require);
    }

    #[test]
    fn reconnect_backoff_ramps_and_caps() {
        use std::time::Duration;
        assert_eq!(reconnect_backoff(1), Duration::from_millis(0));
        assert_eq!(reconnect_backoff(2), Duration::from_millis(250));
        assert_eq!(reconnect_backoff(4), Duration::from_millis(1000));
        assert_eq!(reconnect_backoff(7), Duration::from_millis(8000));
        assert_eq!(reconnect_backoff(8), Duration::from_millis(15_000));
        assert_eq!(reconnect_backoff(100), Duration::from_millis(15_000));
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
