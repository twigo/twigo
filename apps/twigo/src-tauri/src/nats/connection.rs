use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use super::context::{demo_context, load_contexts, ContextFile, NatsContext, DEMO_CONTEXT_NAME};
use super::error::{self, Error};
use super::subjects::{self, SubjectWatch};
use super::subscription::{abort_conn, SubState};
use crate::emit::Emit;

#[derive(Default)]
pub struct ConnState {
    clients: Mutex<HashMap<String, async_nats::Client>>,
    // Frontend read-only locks mirrored behind IPC (SEC-4).
    readonly: Mutex<HashSet<String>>,
}

impl ConnState {
    pub(crate) async fn client(&self, name: &str) -> Option<async_nats::Client> {
        self.clients.lock().await.get(name).cloned()
    }

    pub(crate) async fn set_readonly(&self, names: Vec<String>) {
        *self.readonly.lock().await = names.into_iter().collect();
    }

    pub(crate) async fn assert_writable(&self, name: &str) -> error::Result<()> {
        if self.readonly.lock().await.contains(name) {
            return Err(Error::Permissions(format!(
                "connection '{name}' is read-only - writes are blocked"
            )));
        }
        Ok(())
    }
}

/// Replace the read-only lock set (synced from the frontend store on change).
#[tauri::command]
pub async fn conn_sync_readonly(
    conns: State<'_, ConnState>,
    names: Vec<String>,
) -> error::Result<()> {
    conns.set_readonly(names).await;
    Ok(())
}

/// What the server states about itself, known only once the link is up.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerFacts {
    server_name: String,
    server_version: String,
    jetstream: bool,
    max_payload: usize,
}

/// The facts sit behind one Option instead of next to a `connected` flag, so
/// there is no shape in which they are readable but meaningless.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    name: String,
    server: Option<ServerFacts>,
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
}

fn server_details(name: String, info: &async_nats::ServerInfo) -> ServerDetails {
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

const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

// A flush completes once the write buffer reaches the socket, which cannot
// happen mid-reconnect - hence liveness, not latency. Bounded so a server that
// is down at launch (retry_on_initial_connect) can't hang the command.
async fn link_is_up(client: &async_nats::Client) -> bool {
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, client.flush()).await,
        Ok(Ok(()))
    )
}

// async-nats has no rtt()/ping(), and its flush() never leaves the socket
// (unlike nats.go) - timing that reports ~0 against any server. Requesting a
// fresh inbox nobody answers gets a no-responders reply, which is a real hop.
// Fails on an account that denies publishing to _INBOX.>: there is no
// permission-free round trip in this client, so the RTT stays unknown.
async fn measure_rtt(client: &async_nats::Client) -> error::Result<f64> {
    let subject = client.new_inbox();
    let started = std::time::Instant::now();
    let elapsed = || started.elapsed().as_secs_f64() * 1000.0;
    match tokio::time::timeout(PROBE_TIMEOUT, client.request(subject, Vec::new().into())).await {
        Ok(Ok(_)) => Ok(elapsed()),
        Ok(Err(e)) if e.kind() == async_nats::client::RequestErrorKind::NoResponders => {
            Ok(elapsed())
        }
        Ok(Err(e)) => Err(e.into()),
        Err(_) => Err(Error::Timeout(
            "round-trip probe got no reply within 2s".into(),
        )),
    }
}

async fn build_conn_info(name: String, client: &async_nats::Client) -> ConnInfo {
    if !link_is_up(client).await {
        return ConnInfo { name, server: None };
    }
    let info = client.server_info();
    ConnInfo {
        name,
        server: Some(ServerFacts {
            server_name: info.server_name.clone(),
            server_version: info.version.clone(),
            jetstream: info.jetstream,
            max_payload: info.max_payload,
        }),
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

// Pure so the auth decision is unit-testable, mirroring TlsPlan.
#[derive(Debug, PartialEq, Eq)]
enum AuthPlan {
    None,
    Token(String),
    UserPassword(String, String),
    NKey(String),
    Creds(String),
}

fn auth_plan(f: &ContextFile) -> error::Result<AuthPlan> {
    if let Some(creds) = non_empty(&f.creds) {
        let content = std::fs::read_to_string(creds).map_err(|source| Error::Io {
            path: creds.to_string(),
            source,
        })?;
        Ok(AuthPlan::Creds(content))
    } else if let Some(token) = non_empty(&f.token) {
        Ok(AuthPlan::Token(token.to_string()))
    } else if let (Some(user), Some(pass)) = (non_empty(&f.user), non_empty(&f.password)) {
        Ok(AuthPlan::UserPassword(user.to_string(), pass.to_string()))
    } else if let Some(nkey) = non_empty(&f.nkey) {
        Ok(AuthPlan::NKey(read_maybe_file(nkey)))
    } else {
        Ok(AuthPlan::None)
    }
}

fn apply_auth(plan: AuthPlan) -> error::Result<async_nats::ConnectOptions> {
    Ok(match plan {
        AuthPlan::None => async_nats::ConnectOptions::new(),
        AuthPlan::Token(token) => async_nats::ConnectOptions::with_token(token),
        AuthPlan::UserPassword(user, password) => {
            async_nats::ConnectOptions::with_user_and_password(user, password)
        }
        AuthPlan::NKey(seed) => async_nats::ConnectOptions::with_nkey(seed),
        AuthPlan::Creds(content) => async_nats::ConnectOptions::new()
            .credentials(&content)
            .map_err(|e| Error::Credentials(e.to_string()))?,
    })
}

fn build_options<E: Emit>(
    ctx: &NatsContext,
    emitter: &E,
    name: &str,
) -> error::Result<async_nats::ConnectOptions> {
    let f = &ctx.file;
    let base = apply_tls(apply_auth(auth_plan(f)?)?, tls_plan(f));

    let emitter = emitter.clone();
    let name = name.to_string();
    let rc_emitter = emitter.clone();
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
            rc_emitter.emit_event(
                "nats:reconnect",
                ReconnectEvent {
                    conn: rc_name.clone(),
                    attempt: attempts,
                    delay_ms: delay.as_millis() as u64,
                },
            );
            delay
        })
        .event_callback(move |event| {
            let emitter = emitter.clone();
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
                emitter.emit_event(
                    "nats:event",
                    NatsEvent {
                        conn: name,
                        kind: kind.into(),
                        detail,
                    },
                );
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
    connect_impl(&app, &state, &subs, &watch, name, dir).await
}

pub(crate) async fn connect_impl<E: Emit>(
    emitter: &E,
    state: &ConnState,
    subs: &SubState,
    watch: &SubjectWatch,
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
        let emitter = emitter.clone();
        let name = name.clone();
        tokio::task::spawn_blocking(move || build_options(&ctx, &emitter, &name))
            .await
            .map_err(|e| Error::Task(e.to_string()))??
    };
    let client = opts.connect(url.clone()).await?;
    let info = build_conn_info(name.clone(), &client).await;

    match &info.server {
        Some(s) => tracing::info!(conn = %name, url = %url, server = %s.server_name, "connect"),
        None => tracing::info!(conn = %name, url = %url, "connect - link not up yet"),
    }
    // Reconnecting the same name: tear down the previous connection's tasks so
    // the old client/socket closes instead of leaking behind the new one. Hold
    // the clients lock across teardown + insert so a concurrent reconnect of the
    // same name can't interleave the two and leave a half-swapped connection.
    {
        let mut clients = state.clients.lock().await;
        abort_conn(subs, &name);
        subjects::stop(watch, &name);
        clients.insert(name, client);
    }
    Ok(info)
}

#[tauri::command]
pub async fn conn_info(state: State<'_, ConnState>, name: String) -> error::Result<ConnInfo> {
    conn_info_impl(&state, name).await
}

pub(crate) async fn conn_info_impl(state: &ConnState, name: String) -> error::Result<ConnInfo> {
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
    disconnect_impl(&state, &subs, &watch, name).await
}

pub(crate) async fn disconnect_impl(
    state: &ConnState,
    subs: &SubState,
    watch: &SubjectWatch,
    name: String,
) -> error::Result<()> {
    // Abort the connection's subscription + watch tasks first so their
    // Subscribers drop and the async-nats event loop can close the socket;
    // only then drop the client.
    abort_conn(subs, &name);
    subjects::stop(watch, &name);
    state.clients.lock().await.remove(&name);
    tracing::info!(conn = %name, "disconnected");
    Ok(())
}

#[tauri::command]
pub async fn list_connections(state: State<'_, ConnState>) -> error::Result<Vec<String>> {
    list_connections_impl(&state).await
}

pub(crate) async fn list_connections_impl(state: &ConnState) -> error::Result<Vec<String>> {
    Ok(state.clients.lock().await.keys().cloned().collect())
}

/// Round trip in milliseconds. Not part of [`ConnInfo`]: that holds facts fixed
/// at CONNECT, this is a sample that ages and can fail on its own.
#[tauri::command]
pub async fn conn_rtt(state: State<'_, ConnState>, name: String) -> error::Result<f64> {
    conn_rtt_impl(&state, name).await
}

pub(crate) async fn conn_rtt_impl(state: &ConnState, name: String) -> error::Result<f64> {
    let client = state
        .client(&name)
        .await
        .ok_or_else(|| Error::NotConnected(name))?;
    measure_rtt(&client).await
}

#[tauri::command]
pub async fn server_info(
    state: State<'_, ConnState>,
    name: String,
) -> error::Result<ServerDetails> {
    server_info_impl(&state, name).await
}

pub(crate) async fn server_info_impl(
    state: &ConnState,
    name: String,
) -> error::Result<ServerDetails> {
    let client = state
        .client(&name)
        .await
        .ok_or_else(|| Error::NotConnected(name.clone()))?;

    let info = client.server_info();
    Ok(server_details(name, &info))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[derive(Clone)]
    struct NoopEmit;

    impl Emit for NoopEmit {
        fn emit_event<T: Serialize + Clone>(&self, _event: &str, _payload: T) {}
    }

    fn ctx(file: ContextFile) -> NatsContext {
        NatsContext {
            name: "t".into(),
            file,
            selected: false,
        }
    }

    #[tokio::test]
    async fn readonly_set_gates_writes_until_cleared() {
        let conns = ConnState::default();
        assert!(conns.assert_writable("prod").await.is_ok());

        conns.set_readonly(vec!["prod".into()]).await;
        let err = conns.assert_writable("prod").await.unwrap_err();
        assert_eq!(err.kind(), "permissions");
        assert!(conns.assert_writable("dev").await.is_ok());

        conns.set_readonly(Vec::new()).await;
        assert!(conns.assert_writable("prod").await.is_ok());
    }

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
    fn auth_plan_maps_each_method() {
        assert_eq!(auth_plan(&ContextFile::default()).unwrap(), AuthPlan::None);

        let token = auth_plan(&ContextFile {
            token: Some(" tok ".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(token, AuthPlan::Token("tok".into()));

        let user_pass = auth_plan(&ContextFile {
            user: Some("u".into()),
            password: Some("p".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(user_pass, AuthPlan::UserPassword("u".into(), "p".into()));

        let nkey = auth_plan(&ContextFile {
            nkey: Some("SUAINLINESEED".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(nkey, AuthPlan::NKey("SUAINLINESEED".into()));

        let mut creds_file = tempfile::NamedTempFile::new().unwrap();
        creds_file.write_all(b"creds-content").unwrap();
        let creds = auth_plan(&ContextFile {
            creds: Some(creds_file.path().to_string_lossy().into_owned()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(creds, AuthPlan::Creds("creds-content".into()));
    }

    #[test]
    fn auth_plan_precedence_and_partial_user_pass() {
        // token wins over user/password and nkey.
        let f = ContextFile {
            token: Some("t".into()),
            user: Some("u".into()),
            password: Some("p".into()),
            nkey: Some("n".into()),
            ..Default::default()
        };
        assert_eq!(auth_plan(&f).unwrap(), AuthPlan::Token("t".into()));

        // A user without a password is not usable - falls through to nkey.
        let f = ContextFile {
            user: Some("u".into()),
            nkey: Some("n".into()),
            ..Default::default()
        };
        assert_eq!(auth_plan(&f).unwrap(), AuthPlan::NKey("n".into()));
    }

    #[test]
    fn nkey_reads_seed_from_a_file_path() {
        let mut seed_file = tempfile::NamedTempFile::new().unwrap();
        seed_file.write_all(b" SUAFILESEED \n").unwrap();
        let f = ContextFile {
            nkey: Some(seed_file.path().to_string_lossy().into_owned()),
            ..Default::default()
        };
        assert_eq!(auth_plan(&f).unwrap(), AuthPlan::NKey("SUAFILESEED".into()));
    }

    #[test]
    fn missing_creds_file_is_an_io_error() {
        let f = ContextFile {
            creds: Some("/definitely/not/here.creds".into()),
            ..Default::default()
        };
        assert_eq!(auth_plan(&f).unwrap_err().kind(), "io");
        let err = build_options(&ctx(f), &NoopEmit, "c").unwrap_err();
        assert_eq!(err.kind(), "io");
        assert!(err.to_string().contains("/definitely/not/here.creds"));
    }

    #[test]
    fn unparsable_creds_content_is_a_credentials_error() {
        let mut creds_file = tempfile::NamedTempFile::new().unwrap();
        creds_file.write_all(b"not a creds file").unwrap();
        let f = ContextFile {
            creds: Some(creds_file.path().to_string_lossy().into_owned()),
            ..Default::default()
        };
        assert_eq!(
            apply_auth(auth_plan(&f).unwrap()).unwrap_err().kind(),
            "credentials"
        );
        assert_eq!(
            build_options(&ctx(f), &NoopEmit, "c").unwrap_err().kind(),
            "credentials"
        );
    }

    #[test]
    fn build_options_needs_no_app_handle() {
        for f in [
            ContextFile::default(),
            ContextFile {
                token: Some("t".into()),
                ..Default::default()
            },
            ContextFile {
                user: Some("u".into()),
                password: Some("p".into()),
                ..Default::default()
            },
            ContextFile {
                nkey: Some("SUAINLINESEED".into()),
                ..Default::default()
            },
        ] {
            assert!(build_options(&ctx(f), &NoopEmit, "conn").is_ok());
        }
    }

    #[test]
    fn build_options_routes_tls_material_through_the_tls_plan() {
        // Cert paths are applied lazily, so building options must succeed and
        // take the tls_plan/apply_tls path (covered in detail by its own tests).
        let f = ContextFile {
            ca: Some("/ca.pem".into()),
            cert: Some("/c.pem".into()),
            key: Some("/k.pem".into()),
            tls_first: true,
            ..Default::default()
        };
        assert!(tls_plan(&f).require);
        assert!(build_options(&ctx(f), &NoopEmit, "conn").is_ok());
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
        let d = server_details("prod-eu".into(), &info);
        assert_eq!(d.name, "prod-eu");
        assert_eq!(d.server_name, "twigo-dev");
        assert_eq!(d.version, "2.10.0");
        assert_eq!(d.host, "127.0.0.1");
        assert_eq!(d.port, 4222);
        assert!(d.jetstream);
        assert_eq!(d.max_payload, 1_048_576);
    }
}
