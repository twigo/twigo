//! The api client with an exec plugin against an HTTPS server that accepts
//! the tokens and client certificates the test names: a rejected token
//! gets one new run and one retry, and a new certificate a new connection.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use http::Request;
use kube::Config;
use kube::config::Kubeconfig;
use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use rustls::RootCertStore;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;
use twigo_env::ShellEnv;
use twigo_kube::client::{Clients, Options};
use twigo_kube::credentials::{Exec, Provider, Registry, Timeouts};

/// What the server saw of one request.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    connection: usize,
    /// The common name of the client certificate, if one came.
    client: Option<String>,
    token: Option<String>,
    status: u16,
}

#[derive(Default)]
struct Accepted {
    tokens: HashSet<String>,
    clients: HashSet<String>,
    /// The name of each client certificate the test made, by its DER.
    names: HashMap<Vec<u8>, String>,
}

struct Server {
    addr: SocketAddr,
    ca: CertificateDer<'static>,
    clients_ca: CertifiedIssuer<'static, KeyPair>,
    accepted: Arc<Mutex<Accepted>>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

fn new_ca() -> CertifiedIssuer<'static, KeyPair> {
    let mut params = CertificateParams::new(Vec::new()).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    CertifiedIssuer::self_signed(params, KeyPair::generate().unwrap()).unwrap()
}

impl Server {
    async fn start() -> Self {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let ca = new_ca();
        let clients_ca = new_ca();
        let key = KeyPair::generate().unwrap();
        let leaf = CertificateParams::new(vec!["localhost".to_owned()])
            .unwrap()
            .signed_by(&key, &ca)
            .unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(clients_ca.der().clone()).unwrap();
        let verifier =
            WebPkiClientVerifier::builder_with_provider(Arc::new(roots), Arc::clone(&provider))
                .allow_unauthenticated()
                .build()
                .unwrap();
        let mut tls = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_client_cert_verifier(verifier)
            .with_single_cert(
                vec![leaf.der().clone()],
                PrivateKeyDer::Pkcs8(key.serialize_der().into()),
            )
            .unwrap();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let acceptor = TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = Self {
            addr: listener.local_addr().unwrap(),
            ca: ca.der().clone(),
            clients_ca,
            accepted: Arc::default(),
            seen: Arc::default(),
        };
        let (accepted, seen) = (Arc::clone(&server.accepted), Arc::clone(&server.seen));
        tokio::spawn(async move {
            let mut connection = 0;
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let Ok(stream) = acceptor.accept(tcp).await else {
                    continue;
                };
                let client = stream
                    .get_ref()
                    .1
                    .peer_certificates()
                    .map(|chain| accepted.lock().unwrap().names[chain[0].as_ref()].clone());
                let (accepted, seen) = (Arc::clone(&accepted), Arc::clone(&seen));
                tokio::spawn(answer(stream, connection, client, accepted, seen));
                connection += 1;
            }
        });
        server
    }

    fn accept_token(&self, token: &str) {
        self.accepted
            .lock()
            .unwrap()
            .tokens
            .insert(token.to_owned());
    }

    fn revoke_token(&self, token: &str) {
        self.accepted.lock().unwrap().tokens.remove(token);
    }

    fn accept_client(&self, name: &str) {
        self.accepted
            .lock()
            .unwrap()
            .clients
            .insert(name.to_owned());
    }

    fn revoke_client(&self, name: &str) {
        self.accepted.lock().unwrap().clients.remove(name);
    }

    /// A client certificate and its key, in PEM, signed by the CA the
    /// server trusts for clients.
    fn client_pem(&self, name: &str) -> (String, String) {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::new()).unwrap();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, name);
        let cert = params.signed_by(&key, &self.clients_ca).unwrap();
        self.accepted
            .lock()
            .unwrap()
            .names
            .insert(cert.der().to_vec(), name.to_owned());
        (cert.pem(), key.serialize_pem())
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

/// HTTP/1.1, one request at a time, each without a body.
async fn answer(
    mut stream: tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
    connection: usize,
    client: Option<String>,
    accepted: Arc<Mutex<Accepted>>,
    seen: Arc<Mutex<Vec<Seen>>>,
) {
    let mut buffer = Vec::new();
    loop {
        let head = loop {
            if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
                buffer.drain(..end + 4);
                break head;
            }
            let mut chunk = [0; 4096];
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            }
        };
        let token = head.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            let value = value.trim().strip_prefix("Bearer ")?;
            name.eq_ignore_ascii_case("authorization")
                .then(|| value.to_owned())
        });
        let ok = {
            let accepted = accepted.lock().unwrap();
            let by_token = token.as_ref().is_some_and(|t| accepted.tokens.contains(t));
            let by_client = client
                .as_ref()
                .is_some_and(|c| accepted.clients.contains(c));
            by_token || by_client
        };
        let status = if ok { 200 } else { 401 };
        seen.lock().unwrap().push(Seen {
            connection,
            client: client.clone(),
            token,
            status,
        });
        let response = if ok {
            "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok".to_owned()
        } else {
            let body = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"Unauthorized","reason":"Unauthorized","code":401}"#;
            format!(
                "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            )
        };
        if stream.write_all(response.as_bytes()).await.is_err() {
            return;
        }
    }
}

/// A plugin that prints the credential its file holds, so the test can
/// change it between runs, and counts its runs.
struct Plugin {
    dir: TempDir,
}

impl Plugin {
    fn new() -> Self {
        let plugin = Self {
            dir: tempfile::tempdir().unwrap(),
        };
        let script = plugin.dir.path().join("plugin");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho run >> '{}'\ncat '{}'\n",
                plugin.path("runs").display(),
                plugin.path("credential").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        plugin
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn prints(&self, status: serde_json::Value) {
        let credential = serde_json::json!({
            "apiVersion": "client.authentication.k8s.io/v1",
            "kind": "ExecCredential",
            "status": status,
        });
        std::fs::write(self.path("credential"), credential.to_string()).unwrap();
    }

    fn runs(&self) -> usize {
        std::fs::read_to_string(self.path("runs"))
            .map(|runs| runs.lines().count())
            .unwrap_or(0)
    }

    fn exec(&self) -> Exec {
        exec(&self.path("plugin"))
    }
}

fn exec(command: &Path) -> Exec {
    let config = Kubeconfig::from_yaml(&format!(
        "
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      interactiveMode: Never
      command: '{}'
",
        command.display()
    ))
    .unwrap();
    let user = config.auth_infos[0].auth_info.as_ref().unwrap();
    Exec::of("u", user, &Default::default()).unwrap().unwrap()
}

fn clients(server: &Server, exec: Exec) -> Clients {
    let env: ShellEnv = std::env::vars_os()
        .collect::<Vec<(OsString, OsString)>>()
        .into_iter()
        .collect();
    let registry = Registry::new(
        watch::channel(Some(Arc::new(env))).1,
        watch::channel(true).1,
        Timeouts::default(),
    );
    let mut config = Config::new(
        format!("https://localhost:{}", server.addr.port())
            .parse()
            .unwrap(),
    );
    config.root_cert = Some(vec![server.ca.to_vec()]);
    Clients::new(
        &config,
        Options {
            provider: Some(Provider::Exec(registry.source(exec))),
            ..Options::default()
        },
    )
    .unwrap()
}

async fn get(clients: &Clients) -> Result<String, kube::Error> {
    let request = Request::get("/version").body(Vec::new()).unwrap();
    clients.api.request_text(request).await
}

#[tokio::test]
async fn a_rejected_token_gets_one_new_run_and_one_retry() {
    let server = Server::start().await;
    let plugin = Plugin::new();
    plugin.prints(serde_json::json!({"token": "old"}));
    server.accept_token("old");
    let clients = clients(&server, plugin.exec());
    assert_eq!(get(&clients).await.unwrap(), "ok");
    assert_eq!(plugin.runs(), 1);

    server.revoke_token("old");
    server.accept_token("new");
    plugin.prints(serde_json::json!({"token": "new"}));
    assert_eq!(get(&clients).await.unwrap(), "ok");
    assert_eq!(plugin.runs(), 2);
    let tokens: Vec<_> = server
        .seen()
        .into_iter()
        .map(|seen| (seen.token.unwrap(), seen.status))
        .collect();
    assert_eq!(
        tokens,
        [
            ("old".to_owned(), 200),
            ("old".to_owned(), 401),
            ("new".to_owned(), 200)
        ]
    );

    server.revoke_token("new");
    let Err(kube::Error::Api(status)) = get(&clients).await else {
        panic!("a token rejected after its new run fails");
    };
    assert_eq!(status.code, 401);
    assert_eq!(plugin.runs(), 3, "one new run, not a loop");
}

#[tokio::test]
async fn a_certificate_from_the_plugin_is_offered_and_a_new_one_opens_a_new_connection() {
    let server = Server::start().await;
    let plugin = Plugin::new();
    let (cert, key) = server.client_pem("first");
    plugin.prints(serde_json::json!({"clientCertificateData": cert, "clientKeyData": key}));
    server.accept_client("first");
    let clients = clients(&server, plugin.exec());
    assert_eq!(get(&clients).await.unwrap(), "ok");
    assert_eq!(get(&clients).await.unwrap(), "ok");

    server.revoke_client("first");
    server.accept_client("second");
    let (cert, key) = server.client_pem("second");
    plugin.prints(serde_json::json!({"clientCertificateData": cert, "clientKeyData": key}));
    assert_eq!(get(&clients).await.unwrap(), "ok");
    let seen: Vec<_> = server
        .seen()
        .into_iter()
        .map(|seen| (seen.connection, seen.client.unwrap(), seen.status))
        .collect();
    assert_eq!(
        seen,
        [
            (0, "first".to_owned(), 200),
            (0, "first".to_owned(), 200),
            (0, "first".to_owned(), 401),
            (1, "second".to_owned(), 200),
        ]
    );
    assert_eq!(plugin.runs(), 2);
}

#[tokio::test]
async fn a_new_certificate_seen_first_by_the_sessions_client_retires_the_api_s_connections() {
    let server = Server::start().await;
    let plugin = Plugin::new();
    let (cert, key) = server.client_pem("first");
    plugin.prints(serde_json::json!({"clientCertificateData": cert, "clientKeyData": key}));
    server.accept_client("first");
    let clients = clients(&server, plugin.exec());
    assert_eq!(get(&clients).await.unwrap(), "ok");

    server.revoke_client("first");
    server.accept_client("second");
    let (cert, key) = server.client_pem("second");
    plugin.prints(serde_json::json!({"clientCertificateData": cert, "clientKeyData": key}));
    let request = Request::get("/version").body(Vec::new()).unwrap();
    assert_eq!(clients.sessions.request_text(request).await.unwrap(), "ok");
    assert_eq!(get(&clients).await.unwrap(), "ok");
    let last = server.seen().pop().unwrap();
    assert_eq!(
        (last.client.as_deref(), last.status),
        (Some("second"), 200),
        "the api client left its connection with the old certificate"
    );
    assert_ne!(last.connection, 0);
}

#[tokio::test]
async fn a_token_in_the_entry_goes_out_rather_than_its_oidc_provider_s() {
    let server = Server::start().await;
    server.accept_token("static");
    let mut config = Config::new(
        format!("https://localhost:{}", server.addr.port())
            .parse()
            .unwrap(),
    );
    config.root_cert = Some(vec![server.ca.to_vec()]);
    config.auth_info.token = Some("static".to_owned().into());
    config.auth_info.auth_provider = Some(kube::config::AuthProviderConfig {
        name: "oidc".to_owned(),
        config: [("id-token".to_owned(), "stale".to_owned())]
            .into_iter()
            .collect(),
        other: Default::default(),
    });
    let clients = Clients::new(&config, Options::default()).unwrap();
    assert_eq!(get(&clients).await.unwrap(), "ok");
    assert_eq!(server.seen()[0].token.as_deref(), Some("static"));
}

#[tokio::test]
async fn an_empty_token_leaves_the_token_file_to_be_read() {
    let server = Server::start().await;
    server.accept_token("from-file");
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("token");
    std::fs::write(&file, "from-file").unwrap();
    let mut config = Config::new(
        format!("https://localhost:{}", server.addr.port())
            .parse()
            .unwrap(),
    );
    config.root_cert = Some(vec![server.ca.to_vec()]);
    config.auth_info.token = Some(String::new().into());
    config.auth_info.token_file = Some(file.display().to_string());
    let clients = Clients::new(&config, Options::default()).unwrap();
    assert_eq!(get(&clients).await.unwrap(), "ok");
}

#[tokio::test]
async fn an_empty_username_leaves_the_token_to_be_sent() {
    let server = Server::start().await;
    server.accept_token("t");
    let mut config = Config::new(
        format!("https://localhost:{}", server.addr.port())
            .parse()
            .unwrap(),
    );
    config.root_cert = Some(vec![server.ca.to_vec()]);
    config.auth_info.username = Some(String::new());
    config.auth_info.password = Some(String::new().into());
    config.auth_info.token = Some("t".to_owned().into());
    let clients = Clients::new(&config, Options::default()).unwrap();
    assert_eq!(get(&clients).await.unwrap(), "ok");
}

#[tokio::test]
async fn the_removed_gcp_and_azure_providers_are_refused_before_their_command_could_run() {
    let dir = TempDir::new().unwrap();
    let ran = dir.path().join("ran");
    for (name, refused) in [
        ("gcp", "The gcp auth plugin has been removed."),
        ("azure", "The azure auth plugin has been removed."),
    ] {
        let mut config = Config::new("https://localhost:1".parse().unwrap());
        config.auth_info.auth_provider = Some(kube::config::AuthProviderConfig {
            name: name.to_owned(),
            config: [
                ("cmd-path".to_owned(), "/usr/bin/touch".to_owned()),
                ("cmd-args".to_owned(), ran.display().to_string()),
            ]
            .into_iter()
            .collect(),
            other: Default::default(),
        });
        let error = Clients::new(&config, Options::default())
            .err()
            .expect("refused");
        assert!(error.to_string().starts_with(refused), "{error}");
    }
    assert!(!ran.exists());
}
