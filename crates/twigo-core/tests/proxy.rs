//! The policy proxy and its approval broker against a fake API server that
//! notes every request it sees: each refusal is proven by what it did not
//! see, and each request's headers by what it did.
//!
//! cargo test -p twigo-core --test proxy

use std::convert::Infallible;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use http::header::{HOST, UPGRADE};
use http::{HeaderMap, Method, Request, Response, StatusCode};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::client::conn::http1::SendRequest;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName};
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use twigo_core::{Core, ProxyProcess};
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    AnswerApproval, ApprovalAnswer, ApprovalAsk, ApprovalDetail, ApprovalEvent, Environment,
    ErrorKind, Mode, RequestClass,
};
use twigo_policy::Actor;

const WAIT: Duration = Duration::from_secs(10);
/// How long the fake holds a request with `slow=1` after it has seen it.
const SLOW: Duration = Duration::from_secs(2);

/// What the fake server saw of one request.
#[derive(Debug, Clone)]
struct Seen {
    method: Method,
    uri: String,
    headers: HeaderMap,
}

type FakeBody = UnsyncBoxBody<Bytes, Infallible>;

/// An API server that answers every request at once, holds watches open,
/// and echoes what an upgraded connection sends; it refuses the upgrades of
/// the pod `refuses`, holds open its refusal of anything of `holds`, and
/// answers what has `slow=1` in its query, but a dry run, only after `SLOW`.
#[derive(Clone)]
struct Fake {
    address: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Fake {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fake = Self {
            address: listener.local_addr().unwrap(),
            seen: Arc::default(),
        };
        let seen = Arc::clone(&fake.seen);
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let seen = Arc::clone(&seen);
                tokio::spawn(async move {
                    let service = service_fn(move |request| answer(Arc::clone(&seen), request));
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await;
                });
            }
        });
        fake
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// The requests it saw with `method`, but dry runs.
    fn writes(&self, method: Method) -> usize {
        self.seen()
            .iter()
            .filter(|seen| seen.method == method && !seen.uri.contains("dryRun"))
            .count()
    }
}

fn body(bytes: impl Into<Bytes>) -> FakeBody {
    Full::new(bytes.into()).boxed_unsync()
}

async fn answer(
    seen: Arc<Mutex<Vec<Seen>>>,
    mut request: Request<Incoming>,
) -> Result<Response<FakeBody>, Infallible> {
    seen.lock().unwrap().push(Seen {
        method: request.method().clone(),
        uri: request.uri().to_string(),
        headers: request.headers().clone(),
    });
    let query = request.uri().query().unwrap_or_default();
    if query.contains("slow=1") && !query.contains("dryRun") {
        tokio::time::sleep(SLOW).await;
    }
    let refuses = request.uri().path().contains("/pods/refuses/");
    if request.uri().path().contains("/pods/holds/") {
        let held = futures::stream::pending::<Result<Frame<Bytes>, Infallible>>();
        let mut response = Response::new(StreamBody::new(held).boxed_unsync());
        *response.status_mut() = StatusCode::BAD_REQUEST;
        return Ok(response);
    }
    if let Some(protocol) = request.headers().get(UPGRADE).cloned()
        && !refuses
    {
        let upgraded = hyper::upgrade::on(&mut request);
        tokio::spawn(async move {
            let mut upgraded = TokioIo::new(upgraded.await.unwrap());
            let mut buffer = [0; 1024];
            while let Ok(read) = upgraded.read(&mut buffer).await {
                if read == 0 || upgraded.write_all(&buffer[..read]).await.is_err() {
                    return;
                }
            }
        });
        let mut response = Response::new(body(Bytes::new()));
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let headers = response.headers_mut();
        headers.insert(UPGRADE, protocol);
        headers.insert("connection", "Upgrade".parse().unwrap());
        headers.insert("sec-websocket-accept", "accepted".parse().unwrap());
        return Ok(response);
    }
    if refuses {
        let status =
            json!({ "kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 400 });
        let mut response = Response::new(body(status.to_string()));
        *response.status_mut() = StatusCode::BAD_REQUEST;
        return Ok(response);
    }
    let watch = request
        .uri()
        .query()
        .is_some_and(|query| query.contains("watch=true"));
    if watch {
        let held = futures::stream::pending::<Result<Frame<Bytes>, Infallible>>();
        return Ok(Response::new(StreamBody::new(held).boxed_unsync()));
    }
    let method = request.method().clone();
    let sent = request.into_body().collect().await.unwrap().to_bytes();
    let object = match serde_json::from_slice::<Value>(&sent) {
        Ok(object) if method != Method::DELETE => object,
        _ => json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "c", "namespace": "a", "resourceVersion": "1" },
            "data": { "a": "1" },
        }),
    };
    let mut response = Response::new(body(object.to_string()));
    if method == Method::POST {
        *response.status_mut() = StatusCode::CREATED;
    }
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    Ok(response)
}

/// `kind-a` as the test kubeconfig lists it at first.
const KIND_A: &str = "
- name: kind-a
  context: { cluster: fake, user: nobody, namespace: a }";

/// A kubeconfig of `kind_a`, none if empty, and `kind-b` on `server`, whose
/// user has no credential, so no `Authorization` of its own reaches it.
fn kubeconfig(server: &str, kind_a: &str) -> String {
    format!(
        "
clusters:
- name: fake
  cluster: {{ server: '{server}' }}
users:
- name: nobody
  user: {{}}
contexts:{kind_a}
- name: kind-b
  context: {{ cluster: fake, user: nobody }}
"
    )
}

/// A core over the kubeconfig `config` in `dir`, of two contexts on the
/// fake server.
async fn core(dir: &Path, fake: &Fake) -> Arc<Core> {
    let kubeconfig = dir.join("config");
    let server = format!("http://{}", fake.address);
    std::fs::write(&kubeconfig, self::kubeconfig(&server, KIND_A)).unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let (status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            let _status = status;
            core.run(followed, Some(kubeconfig)).await;
        }
    });
    core.catalog.contexts().await;
    core
}

/// Where the proxy listens, trusted by the CA its kubeconfig names.
#[derive(Clone)]
struct At {
    address: SocketAddr,
    tls: TlsConnector,
}

/// A process's way through the proxy to each context: its URL and token.
struct Process {
    handle: ProxyProcess,
    at: At,
    kubeconfig: Value,
}

impl Process {
    async fn start(core: &Core, window: Option<&str>) -> Self {
        Self::start_as(core, Actor::Terminal, window).await
    }

    async fn start_as(core: &Core, actor: Actor, window: Option<&str>) -> Self {
        let handle = core
            .proxy_process(actor, "Terminal 1", window, "kind-a")
            .await
            .unwrap();
        let kubeconfig: Value =
            serde_json::from_slice(&std::fs::read(handle.kubeconfig()).unwrap()).unwrap();
        let cluster = &Self::entry(&kubeconfig, "clusters", "kind-a")["cluster"];
        let address = cluster["server"]
            .as_str()
            .unwrap()
            .strip_prefix("https://")
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let pem = STANDARD
            .decode(cluster["certificate-authority-data"].as_str().unwrap())
            .unwrap();
        let pem = String::from_utf8(pem).unwrap();
        let der: String = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(STANDARD.decode(der).unwrap()))
            .unwrap();
        let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
        let mut config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let at = At {
            address,
            tls: TlsConnector::from(Arc::new(config)),
        };
        Self {
            handle,
            at,
            kubeconfig,
        }
    }

    fn at(&self) -> At {
        self.at.clone()
    }

    fn entry<'a>(kubeconfig: &'a Value, list: &str, name: &str) -> &'a Value {
        kubeconfig[list]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == name)
            .unwrap()
    }

    fn token(&self, context: &str) -> String {
        Self::entry(&self.kubeconfig, "users", context)["user"]["token"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// The context's path prefix, as its server's path.
    fn prefix(&self, context: &str) -> String {
        let server = Self::entry(&self.kubeconfig, "clusters", context)["cluster"]["server"]
            .as_str()
            .unwrap();
        format!("/{}", server.rsplit('/').next().unwrap())
    }

    /// A request on `context`'s prefix, as kubectl sends it.
    fn request(&self, method: &str, context: &str, path: &str) -> http::request::Builder {
        Request::builder()
            .method(method)
            .uri(format!("{}{path}", self.prefix(context)))
            .header(HOST, self.at.address.to_string())
            .header("authorization", format!("Bearer {}", self.token(context)))
            .header(
                "user-agent",
                "kubectl/v1.34.1 (darwin/arm64) kubernetes/0000000",
            )
    }
}

/// A connection to the proxy, closed when this drops.
struct Connection {
    sender: SendRequest<Full<Bytes>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn connect(at: At) -> Connection {
    let stream = TcpStream::connect(at.address).await.unwrap();
    let stream = at
        .tls
        .connect(ServerName::IpAddress(at.address.ip().into()), stream)
        .await
        .unwrap();
    let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    let task = tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    Connection { sender, task }
}

async fn send(at: At, request: Request<Full<Bytes>>) -> (Response<Incoming>, Connection) {
    let mut connection = connect(at).await;
    let response = tokio::time::timeout(WAIT, connection.sender.send_request(request))
        .await
        .expect("the proxy answers")
        .unwrap();
    (response, connection)
}

/// The status and the `Status` body's message of a refusal.
async fn refused(at: At, request: Request<Full<Bytes>>) -> (StatusCode, String) {
    let (response, _connection) = send(at, request).await;
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let refusal: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(refusal["kind"], "Status", "{refusal}");
    assert_eq!(refusal["code"], status.as_u16(), "{refusal}");
    let message = refusal["message"].as_str().unwrap().to_owned();
    assert!(message.starts_with("Twigo: "), "{message}");
    (status, message)
}

fn empty() -> Full<Bytes> {
    Full::new(Bytes::new())
}

fn json_body(value: &Value) -> Full<Bytes> {
    Full::new(Bytes::from(value.to_string()))
}

fn follow(core: &Core, window: &str) -> mpsc::UnboundedReceiver<ApprovalEvent> {
    let (sender, events) = mpsc::unbounded_channel();
    core.follow_approvals(window, move |event| sender.send(event).is_ok());
    events
}

async fn asked(events: &mut mpsc::UnboundedReceiver<ApprovalEvent>) -> ApprovalAsk {
    match tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("an ask")
    {
        Some(ApprovalEvent::Asked { ask }) => *ask,
        other => panic!("not an ask: {other:?}"),
    }
}

fn answer_with(core: &Core, ask: &ApprovalAsk, answer: ApprovalAnswer, typed: Option<&str>) {
    core.answer_approval(
        "main",
        AnswerApproval {
            id: ask.id,
            answer,
            typed: typed.map(str::to_owned),
        },
    )
    .unwrap();
}

fn configmap(name: &str) -> Value {
    json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": name }, "data": { "k": "v" } })
}

const CONFIGMAPS: &str = "/api/v1/namespaces/a/configmaps";

fn create(process: &Process, name: &str) -> Request<Full<Bytes>> {
    process
        .request("POST", "kind-a", CONFIGMAPS)
        .header("content-type", "application/json")
        .header("kubectl-command", "kubectl create")
        .body(json_body(&configmap(name)))
        .unwrap()
}

#[tokio::test]
async fn a_process_s_kubeconfig_names_every_context_and_goes_with_its_handle() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let process = Process::start(&core, None).await;
    let path = process.handle.kubeconfig().to_owned();
    let config = &process.kubeconfig;
    assert_eq!(config["current-context"], "kind-a");
    let names: Vec<&str> = config["contexts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|context| context["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["kind-a", "kind-b"]);
    assert_eq!(
        Process::entry(config, "contexts", "kind-a")["context"],
        json!({ "cluster": "kind-a", "user": "kind-a", "namespace": "a" })
    );
    for context in ["kind-a", "kind-b"] {
        let cluster = &Process::entry(config, "clusters", context)["cluster"];
        let keys: Vec<&String> = cluster.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["certificate-authority-data", "server"],
            "a server and the proxy's CA only, no proxy-url"
        );
        assert!(
            cluster["server"]
                .as_str()
                .unwrap()
                .starts_with("https://127.0.0.1:")
        );
        let prefix = process.prefix(context);
        assert!(
            prefix[1..]
                .chars()
                .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()),
            "{prefix}"
        );
        let user = &Process::entry(config, "users", context)["user"];
        assert_eq!(user.as_object().unwrap().len(), 1, "a token only");
    }
    assert_ne!(process.prefix("kind-a"), process.prefix("kind-b"));
    assert_ne!(process.token("kind-a"), process.token("kind-b"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
    }

    let address = process.at();
    let get = process
        .request("GET", "kind-a", CONFIGMAPS)
        .body(empty())
        .unwrap();
    let (response, _connection) = send(address.clone(), get).await;
    assert_eq!(response.status(), StatusCode::OK);
    let again = process
        .request("GET", "kind-a", CONFIGMAPS)
        .body(empty())
        .unwrap();
    drop(process.handle);
    assert!(!path.exists(), "deleted with its handle");
    let (status, _) = refused(address.clone(), again).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "its tokens revoked");
    assert_eq!(fake.seen().len(), 1);

    let left = dir.path().join("proxy/process-9.kubeconfig");
    std::fs::write(&left, "{}").unwrap();
    let _restarted = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    assert!(!left.exists(), "what a previous run left goes at startup");
}

#[tokio::test]
async fn no_process_acts_as_the_ui() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let refused = core
        .proxy_process(Actor::Ui, "Terminal 1", Some("main"), "kind-a")
        .await;
    let Err(error) = refused else {
        panic!("a process of the UI's, whose writes pass guarded unasked");
    };
    assert_eq!(error.kind, ErrorKind::InvalidInput, "{}", error.message);
    assert!(!dir.path().join("proxy").exists(), "no kubeconfig written");
}

#[tokio::test]
async fn a_request_without_its_own_token_or_from_a_page_reaches_no_server() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let process = Process::start(&core, None).await;
    let address = process.at();
    let path = format!("{}{CONFIGMAPS}", process.prefix("kind-a"));
    let bare = || Request::get(path.as_str()).header(HOST, address.address.to_string());

    let (status, _) = refused(address.clone(), bare().body(empty()).unwrap()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "no token");
    let unknown = bare()
        .header("authorization", "Bearer bm90LWEtdG9rZW4")
        .body(empty())
        .unwrap();
    assert_eq!(
        refused(address.clone(), unknown).await.0,
        StatusCode::UNAUTHORIZED
    );
    let other_context = bare()
        .header(
            "authorization",
            format!("Bearer {}", process.token("kind-b")),
        )
        .body(empty())
        .unwrap();
    let (status, message) = refused(address.clone(), other_context).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{message}");

    let foreign = process
        .request("GET", "kind-a", CONFIGMAPS)
        .header(HOST, "attacker.example:80")
        .body(empty())
        .unwrap();
    assert_eq!(
        refused(address.clone(), foreign).await.0,
        StatusCode::FORBIDDEN
    );
    let from_a_page = process
        .request("GET", "kind-a", CONFIGMAPS)
        .header("origin", "https://attacker.example")
        .body(empty())
        .unwrap();
    assert_eq!(
        refused(address.clone(), from_a_page).await.0,
        StatusCode::FORBIDDEN
    );
    for unclear in [
        "/api/v1/namespaces/a/pods/p/log/../exec",
        "/api/v1/namespaces/a/pods/p/log/%2e%2e/exec",
        "/api/v1/namespaces/a//pods",
        "/api/v1/namespaces/a/./pods",
    ] {
        let request = process
            .request("GET", "kind-a", unclear)
            .body(empty())
            .unwrap();
        assert_eq!(
            refused(address.clone(), request).await.0,
            StatusCode::BAD_REQUEST,
            "{unclear}"
        );
    }
    let seen = fake.seen();
    assert!(seen.is_empty(), "{seen:?}");
}

#[tokio::test]
async fn the_server_sees_the_request_as_kubectl_sent_it_without_the_proxy_s_own_headers() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let process = Process::start(&core, None).await;
    let get = process
        .request("GET", "kind-a", "/api/v1/namespaces/a/configmaps?limit=500")
        .header(
            "accept",
            "application/json;as=Table;v=v1;g=meta.k8s.io,application/json",
        )
        .header("kubectl-command", "kubectl get")
        .header("kubectl-session", "5f0c")
        .body(empty())
        .unwrap();
    let (response, _connection) = send(process.at(), get).await;
    assert_eq!(response.status(), StatusCode::OK);
    let answered: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(answered["kind"], "ConfigMap");

    let seen = fake.seen();
    assert_eq!(seen.len(), 1, "{seen:?}");
    let seen = &seen[0];
    assert_eq!(seen.uri, "/api/v1/namespaces/a/configmaps?limit=500");
    assert!(
        seen.headers.get("authorization").is_none(),
        "{:?}",
        seen.headers
    );
    assert_eq!(
        seen.headers.get(HOST).unwrap(),
        fake.address.to_string().as_str(),
        "the server's own, not the proxy's"
    );
    assert_eq!(seen.headers.get("kubectl-command").unwrap(), "kubectl get");
    assert_eq!(seen.headers.get("kubectl-session").unwrap(), "5f0c");
    assert_eq!(
        seen.headers.get("user-agent").unwrap(),
        "kubectl/v1.34.1 (darwin/arm64) kubernetes/0000000"
    );
    assert_eq!(
        seen.headers.get("accept").unwrap(),
        "application/json;as=Table;v=v1;g=meta.k8s.io,application/json"
    );
    assert!(
        seen.headers
            .keys()
            .all(|name| !name.as_str().starts_with("x-forwarded"))
    );
}

#[tokio::test]
async fn a_body_over_the_api_server_s_limit_is_refused_and_not_sent() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let process = Process::start(&core, None).await;
    let post = |size: usize| {
        process
            .request("POST", "kind-a", CONFIGMAPS)
            .body(Full::new(Bytes::from(vec![b' '; size])))
            .unwrap()
    };
    let (status, _) = refused(process.at(), post((3 << 20) + 1)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(fake.writes(Method::POST), 0);
    let (response, _connection) = send(process.at(), post(3 << 20)).await;
    assert_eq!(
        response.status(),
        StatusCode::CREATED,
        "3 MiB itself passes"
    );
    assert_eq!(fake.writes(Method::POST), 1);
}

#[tokio::test]
async fn the_seventeenth_proxied_stream_gets_a_429_while_the_ui_s_requests_pass() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let process = Process::start(&core, None).await;
    let watch = || {
        process
            .request("GET", "kind-a", "/api/v1/namespaces/a/pods?watch=true")
            .body(empty())
            .unwrap()
    };
    let mut open = Vec::new();
    for _ in 0..16 {
        let (response, connection) = send(process.at(), watch()).await;
        assert_eq!(response.status(), StatusCode::OK);
        open.push((response, connection));
    }
    let (response, _connection) = send(process.at(), watch()).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers().get("retry-after").unwrap(), "1");
    let refusal: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(refusal["reason"], "TooManyRequests");
    let watches = fake
        .seen()
        .iter()
        .filter(|seen| seen.uri.contains("watch=true"))
        .count();
    assert_eq!(watches, 16, "the 17th reached no server");

    let clients = core.clients("kind-a").await.unwrap();
    let usage = *clients.usage().borrow();
    assert_eq!(usage.proxied.held, 16);
    assert_eq!(usage.watches.held, 0, "none of the hub's");
    let ui = Request::get(CONFIGMAPS).body(Vec::new()).unwrap();
    let listed = tokio::time::timeout(WAIT, clients.api.request_text(ui))
        .await
        .expect("the UI waits for none of the proxy's streams");
    listed.unwrap();

    open.pop();
    let freed = tokio::time::timeout(WAIT, async {
        loop {
            if clients.usage().borrow().proxied.held == 15 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    freed
        .await
        .expect("a watch ended by its client frees its stream");
    let (response, _connection) = send(process.at(), watch()).await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn in_guarded_a_write_with_no_window_to_ask_is_denied_and_not_sent() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    for window in [None, Some("main")] {
        let process = Process::start(&core, window).await;
        let (status, message) = refused(process.at(), create(&process, "c")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(
            message.contains("asks for an approval, and nothing can ask"),
            "{message}"
        );
    }
    let seen = fake.seen();
    assert!(seen.is_empty(), "not even a dry run: {seen:?}");
    let get = |process: &Process| {
        process
            .request("GET", "kind-a", CONFIGMAPS)
            .body(empty())
            .unwrap()
    };
    let process = Process::start(&core, None).await;
    let (response, _connection) = send(process.at(), get(&process)).await;
    assert_eq!(response.status(), StatusCode::OK, "reads need no approval");
}

#[tokio::test]
async fn once_sends_the_write_once_and_its_repeat_asks_again_after_it_reached_the_server() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;

    let first = tokio::spawn(send(process.at(), create(&process, "c")));
    let ask = asked(&mut events).await;
    assert_eq!(ask.context, "kind-a");
    assert_eq!(ask.process, "Terminal 1");
    assert_eq!(ask.command.as_deref(), Some("kubectl create"));
    assert_eq!(
        (ask.verb.as_str(), ask.class),
        ("create", RequestClass::Write)
    );
    assert_eq!(
        ask.target, "configmaps/c in a",
        "by the name its body gives"
    );
    assert_eq!((ask.typed, ask.lasting_minutes), (false, Some(15)));
    let ApprovalDetail::Diff { live, result, .. } = &ask.detail else {
        panic!("a create in the core group dry-runs: {:?}", ask.detail);
    };
    assert_eq!(*live, Value::Null, "nothing lives before a create");
    assert_eq!(result["metadata"]["name"], "c");
    assert_eq!(fake.writes(Method::POST), 0, "nothing sent while it asks");
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    let (response, _connection) = first.await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(fake.writes(Method::POST), 1);

    let second = tokio::spawn(send(process.at(), create(&process, "c")));
    let again = asked(&mut events).await;
    assert_ne!(again.id, ask.id);
    answer_with(&core, &again, ApprovalAnswer::Deny, None);
    let (response, _connection) = second.await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        fake.writes(Method::POST),
        1,
        "the denied repeat was not sent"
    );

    let generated = json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "generateName": "feature-" } });
    let generating = process
        .request("POST", "kind-a", CONFIGMAPS)
        .header("content-type", "application/json")
        .body(json_body(&generated))
        .unwrap();
    let third = tokio::spawn(send(process.at(), generating));
    let ask = asked(&mut events).await;
    assert_eq!(ask.target, "configmaps/feature-… in a");
    answer_with(&core, &ask, ApprovalAnswer::Deny, None);
    third.await.unwrap();
}

#[tokio::test]
async fn lasting_lets_later_writes_through_but_deletes_until_the_mode_changes() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;

    let first = tokio::spawn(send(process.at(), create(&process, "one")));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Lasting, None);
    assert_eq!(first.await.unwrap().0.status(), StatusCode::CREATED);

    let patch = process
        .request("PATCH", "kind-a", &format!("{CONFIGMAPS}/one"))
        .header("content-type", "application/merge-patch+json")
        .body(json_body(&json!({ "data": { "k": "w" } })))
        .unwrap();
    let (response, _connection) = send(process.at(), patch).await;
    assert_eq!(response.status(), StatusCode::OK, "sent without an ask");
    assert!(events.try_recv().is_err(), "nothing asked");
    assert_eq!(fake.writes(Method::PATCH), 1);

    let delete = process
        .request("DELETE", "kind-a", &format!("{CONFIGMAPS}/one"))
        .header("content-type", "application/json")
        .body(json_body(&json!({ "kind": "DeleteOptions", "apiVersion": "v1", "propagationPolicy": "Background" })))
        .unwrap();
    let deleting = tokio::spawn(send(process.at(), delete));
    let ask = asked(&mut events).await;
    assert_eq!((ask.typed, ask.lasting_minutes), (true, None));
    assert_eq!(
        ask.detail,
        ApprovalDetail::Delete {
            propagation: Some("Background".to_owned())
        }
    );
    let untyped = core.answer_approval(
        "main",
        AnswerApproval {
            id: ask.id,
            answer: ApprovalAnswer::Once,
            typed: Some("kind-b".to_owned()),
        },
    );
    assert_eq!(untyped.unwrap_err().kind, ErrorKind::InvalidInput);
    let lasting = core.answer_approval(
        "main",
        AnswerApproval {
            id: ask.id,
            answer: ApprovalAnswer::Lasting,
            typed: Some("kind-a".to_owned()),
        },
    );
    assert_eq!(lasting.unwrap_err().kind, ErrorKind::InvalidInput);
    let elsewhere = core.answer_approval(
        "another",
        AnswerApproval {
            id: ask.id,
            answer: ApprovalAnswer::Once,
            typed: Some("kind-a".to_owned()),
        },
    );
    assert_eq!(elsewhere.unwrap_err().kind, ErrorKind::Forbidden);
    assert_eq!(fake.writes(Method::DELETE), 0);
    answer_with(&core, &ask, ApprovalAnswer::Once, Some("kind-a"));
    assert_eq!(deleting.await.unwrap().0.status(), StatusCode::OK);
    assert_eq!(fake.writes(Method::DELETE), 1);
    let gone = core.answer_approval(
        "main",
        AnswerApproval {
            id: ask.id,
            answer: ApprovalAnswer::Once,
            typed: Some("kind-a".to_owned()),
        },
    );
    assert_eq!(gone.unwrap_err().kind, ErrorKind::NotFound);

    core.policy
        .set_mode("kind-a", Some(Mode::ReadWrite))
        .unwrap();
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let after = tokio::spawn(send(process.at(), create(&process, "two")));
    let ask = asked(&mut events).await;
    assert_eq!(ask.verb, "create", "the grant ended with the mode's change");
    answer_with(&core, &ask, ApprovalAnswer::Deny, None);
    assert_eq!(after.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    assert_eq!(fake.writes(Method::POST), 1);
}

#[tokio::test]
async fn a_request_no_answer_can_allow_is_refused_without_an_ask() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let mut events = follow(&core, "main");
    let agent = Process::start_as(&core, Actor::Agent, Some("main")).await;
    let read = agent
        .request("GET", "kind-a", "/api/v1/namespaces/a/secrets/s")
        .body(empty())
        .unwrap();
    let (status, message) = refused(agent.at(), read).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(message.contains("nothing can ask"), "{message}");
    assert!(events.try_recv().is_err(), "nothing asked");
    let seen = fake.seen();
    assert!(seen.is_empty(), "{seen:?}");
}

/// `request`, with `slow=1` added to its query.
fn slow(mut request: Request<Full<Bytes>>) -> Request<Full<Bytes>> {
    let uri = request.uri().to_string();
    let joined = if uri.contains('?') { '&' } else { '?' };
    *request.uri_mut() = format!("{uri}{joined}slow=1").parse().unwrap();
    request
}

/// Until the fake has seen `count` requests that `what` picks.
async fn seen_by(fake: &Fake, count: usize, what: impl Fn(&Seen) -> bool) {
    let waited = tokio::time::timeout(WAIT, async {
        while fake.seen().iter().filter(|seen| what(seen)).count() < count {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    waited.await.expect("the fake sees it");
}

fn post_of_c(seen: &Seen) -> bool {
    seen.method == Method::POST && !seen.uri.contains("dryRun")
}

#[tokio::test]
async fn once_covers_no_repeat_while_its_request_is_under_way() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;

    let first = tokio::spawn(send(process.at(), slow(create(&process, "c"))));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    seen_by(&fake, 1, post_of_c).await;
    let repeat = tokio::spawn(send(process.at(), slow(create(&process, "c"))));
    let again = asked(&mut events).await;
    answer_with(&core, &again, ApprovalAnswer::Deny, None);
    assert_eq!(repeat.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    assert_eq!(first.await.unwrap().0.status(), StatusCode::CREATED);
    assert_eq!(fake.writes(Method::POST), 1);

    let is_exec = |seen: &Seen| seen.uri.contains("/exec");
    let first = tokio::spawn(send(process.at(), slow(exec(&process, "p", "sh", true))));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    seen_by(&fake, 1, is_exec).await;
    let repeat = tokio::spawn(send(process.at(), slow(exec(&process, "p", "sh", false))));
    let again = asked(&mut events).await;
    answer_with(&core, &again, ApprovalAnswer::Deny, None);
    assert_eq!(repeat.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    let (response, _connection) = first.await.unwrap();
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    assert_eq!(execs(&fake), 1);
}

#[tokio::test]
async fn once_covers_no_rerun_once_its_request_reached_the_server_and_its_client_went() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;

    let first = tokio::spawn(send(process.at(), slow(create(&process, "c"))));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    seen_by(&fake, 1, post_of_c).await;
    first.abort();
    tokio::time::sleep(SLOW + Duration::from_millis(500)).await;
    let rerun = tokio::spawn(send(process.at(), slow(create(&process, "c"))));
    let again = asked(&mut events).await;
    answer_with(&core, &again, ApprovalAnswer::Deny, None);
    assert_eq!(rerun.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    assert_eq!(fake.writes(Method::POST), 1);
}

#[tokio::test]
async fn once_covers_a_repeat_after_the_proxy_s_own_429() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;
    let clients = core.clients("kind-a").await.unwrap();
    let mut open = Vec::new();
    for _ in 0..16 {
        let watch = process
            .request("GET", "kind-a", "/api/v1/namespaces/a/pods?watch=true")
            .body(empty())
            .unwrap();
        open.push(send(process.at(), watch).await);
    }

    let first = tokio::spawn(send(process.at(), create(&process, "c")));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    let (response, _connection) = first.await.unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    open.pop();
    let freed = tokio::time::timeout(WAIT, async {
        while clients.usage().borrow().proxied.held != 15 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    freed
        .await
        .expect("a watch ended by its client frees its stream");
    let (response, _connection) = send(process.at(), create(&process, "c")).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(events.try_recv().is_err(), "the 429 reached no server");
    assert_eq!(fake.writes(Method::POST), 1);
}

/// What the catalog says of `kind-a` for its mode, none while it lists none.
async fn said_of_kind_a(core: &Core) -> Option<(Option<bool>, Option<Environment>, u64)> {
    let contexts = core.catalog.contexts().await;
    let found = contexts.find("kind-a")?;
    Some((
        found.read_only,
        found.environment,
        found.fingerprint.value(),
    ))
}

/// Writes `text` to the core's kubeconfig and waits until what the catalog
/// says of `kind-a` is `wanted`, or other than it.
async fn rewrite(
    core: &Core,
    dir: &Path,
    text: &str,
    said: Option<(Option<bool>, Option<Environment>, u64)>,
    wanted: bool,
) {
    std::fs::write(dir.join("config"), text).unwrap();
    let waited = tokio::time::timeout(WAIT, async {
        while (said_of_kind_a(core).await == said) != wanted {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    waited
        .await
        .expect("the catalog reads the kubeconfig again");
}

#[tokio::test]
async fn lasting_ends_with_a_change_of_what_the_catalog_says_that_went_back() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let server = format!("http://{}", fake.address);
    let first = kubeconfig(&server, KIND_A);
    let marked = |extension: &str| {
        let kind_a = format!(
            "
- name: kind-a
  context:
    cluster: fake
    user: nobody
    namespace: a
    extensions:
    - name: twigo
      extension: {extension}"
        );
        kubeconfig(&server, &kind_a)
    };
    let said = said_of_kind_a(&core).await;
    let mut outlived = Vec::new();
    for (what, changed) in [
        ("its connection", kubeconfig("http://127.0.0.1:1", KIND_A)),
        ("twigo.readOnly", marked("{ readOnly: true }")),
        ("its environment", marked("{ environment: Staging }")),
        ("its listing", kubeconfig(&server, "")),
    ] {
        let process = Process::start(&core, Some("main")).await;
        let granted = tokio::spawn(send(process.at(), create(&process, "one")));
        let ask = asked(&mut events).await;
        answer_with(&core, &ask, ApprovalAnswer::Lasting, None);
        assert_eq!(granted.await.unwrap().0.status(), StatusCode::CREATED);
        rewrite(&core, dir.path(), &changed, said, false).await;
        rewrite(&core, dir.path(), &first, said, true).await;
        assert_eq!(core.policy.access("kind-a").mode, Mode::Guarded, "{what}");

        let after = tokio::spawn(send(process.at(), create(&process, "two")));
        match tokio::time::timeout(WAIT, events.recv()).await {
            Ok(Some(ApprovalEvent::Asked { ask })) => {
                answer_with(&core, &ask, ApprovalAnswer::Deny, None);
                assert_eq!(after.await.unwrap().0.status(), StatusCode::FORBIDDEN);
            }
            _ => outlived.push(what),
        }
    }
    assert!(
        outlived.is_empty(),
        "the grant outlived a change of {outlived:?} that went back"
    );
    assert_eq!(fake.writes(Method::POST), 4, "the grants' first writes");

    let process = Process::start(&core, Some("main")).await;
    let granted = tokio::spawn(send(process.at(), create(&process, "one")));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Lasting, None);
    assert_eq!(granted.await.unwrap().0.status(), StatusCode::CREATED);
    let kind_b = || async {
        let contexts = core.catalog.contexts().await;
        contexts.find("kind-b").unwrap().fingerprint.value()
    };
    let before = kind_b().await;
    let other = first.replace("user: nobody }", "user: nobody, namespace: b }");
    std::fs::write(dir.path().join("config"), other).unwrap();
    let moved = tokio::time::timeout(WAIT, async {
        while kind_b().await == before {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    moved.await.expect("the catalog reads the kubeconfig again");
    let (response, _connection) = send(process.at(), create(&process, "two")).await;
    assert_eq!(
        response.status(),
        StatusCode::CREATED,
        "another context's change"
    );
    assert!(events.try_recv().is_err(), "the grant holds");
}

#[tokio::test]
async fn a_denial_covers_the_request_s_repeat() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;

    let first = tokio::spawn(send(process.at(), create(&process, "c")));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Deny, None);
    assert_eq!(first.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    let (status, message) = refused(process.at(), create(&process, "c")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(message.contains("was denied"), "{message}");
    assert!(events.try_recv().is_err(), "the repeat asked nothing");
    assert_eq!(fake.writes(Method::POST), 0);
}

#[tokio::test]
async fn an_ask_says_every_identity_the_request_acts_as() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;
    let mut acting = create(&process, "c");
    for (name, value) in [
        ("impersonate-user", "x"),
        ("impersonate-group", "system:masters"),
        ("impersonate-group", "dev"),
        ("impersonate-uid", "42"),
        ("impersonate-extra-scopes", "view"),
        ("impersonate-extra-scopes", "edit"),
        ("impersonate-extra-acme.com%2fteam", "blue"),
    ] {
        acting.headers_mut().append(name, value.parse().unwrap());
    }
    let sent = tokio::spawn(send(process.at(), acting));
    let ask = asked(&mut events).await;
    assert_eq!(
        ask.impersonate.as_deref(),
        Some(
            "x, groups system:masters, dev, uid 42, extra acme.com/team=blue, scopes=view, scopes=edit"
        )
    );
    answer_with(&core, &ask, ApprovalAnswer::Deny, None);
    sent.await.unwrap();

    let sent = tokio::spawn(send(process.at(), create(&process, "d")));
    let ask = asked(&mut events).await;
    assert_eq!(ask.impersonate, None, "acting as nobody else");
    answer_with(&core, &ask, ApprovalAnswer::Deny, None);
    sent.await.unwrap();
}

#[tokio::test]
async fn an_ask_is_withdrawn_when_its_client_goes() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;

    let client = tokio::spawn(send(process.at(), create(&process, "c")));
    let ask = asked(&mut events).await;
    client.abort();
    let withdrawn = tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("withdrawn");
    assert_eq!(withdrawn, Some(ApprovalEvent::Withdrawn { id: ask.id }));
    let late = core.answer_approval(
        "main",
        AnswerApproval {
            id: ask.id,
            answer: ApprovalAnswer::Once,
            typed: None,
        },
    );
    assert_eq!(late.unwrap_err().kind, ErrorKind::NotFound);
    assert_eq!(fake.writes(Method::POST), 0);
}

#[tokio::test]
async fn an_exec_is_spliced_and_ends_when_its_context_turns_read_only() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let process = Process::start(&core, None).await;
    let exec = process
        .request(
            "GET",
            "kind-a",
            "/api/v1/namespaces/a/pods/p/exec?command=sh&stdin=true",
        )
        .header("connection", "Upgrade")
        .header(UPGRADE, "websocket")
        .header("sec-websocket-key", "a2V5")
        .header("sec-websocket-protocol", "v5.channel.k8s.io")
        .body(empty())
        .unwrap();
    let (response, _connection) = send(process.at(), exec).await;
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    assert_eq!(
        response.headers().get("sec-websocket-accept").unwrap(),
        "accepted"
    );
    let seen = fake.seen();
    assert_eq!(seen[0].headers.get("sec-websocket-key").unwrap(), "a2V5");
    assert_eq!(seen[0].headers.get(UPGRADE).unwrap(), "websocket");
    let clients = core.clients("kind-a").await.unwrap();
    assert_eq!(clients.usage().borrow().sessions.held, 1);

    let mut upgraded = TokioIo::new(hyper::upgrade::on(response).await.unwrap());
    upgraded.write_all(b"ping").await.unwrap();
    let mut echoed = [0; 4];
    upgraded.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");

    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    upgraded.write_all(b"more").await.unwrap();
    upgraded.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"more", "guarded ends no session");

    core.policy
        .set_mode("kind-a", Some(Mode::ReadOnly))
        .unwrap();
    let mut rest = Vec::new();
    let ended = tokio::time::timeout(WAIT, upgraded.read_to_end(&mut rest)).await;
    assert!(
        ended
            .expect("the session ends")
            .is_ok_and(|_| rest.is_empty())
    );
    let freed = tokio::time::timeout(WAIT, async {
        while clients.usage().borrow().sessions.held != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    freed.await.expect("its session freed");
}

#[tokio::test]
async fn no_audit_line_holds_a_token() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;
    for answer in [
        ApprovalAnswer::Once,
        ApprovalAnswer::Deny,
        ApprovalAnswer::Lasting,
    ] {
        let name = format!("{answer:?}").to_lowercase();
        let sent = tokio::spawn(send(process.at(), create(&process, &name)));
        let ask = asked(&mut events).await;
        answer_with(&core, &ask, answer, None);
        sent.await.unwrap();
    }
    let nobody = Process::start(&core, None).await;
    refused(nobody.at(), create(&nobody, "nobody")).await;

    let audit = std::fs::read_to_string(dir.path().join("audit.jsonl")).unwrap();
    for process in [&process, &nobody] {
        for context in ["kind-a", "kind-b"] {
            assert!(!audit.contains(&process.token(context)), "{audit}");
        }
    }
    let answers: Vec<String> = audit
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|line| line["event"] == "approval")
        .map(|line| {
            assert_eq!(line["process"], "Terminal 1", "{line}");
            assert_eq!(line["actor"], "terminal", "{line}");
            assert_eq!(line["target"], "configmaps in a", "{line}");
            line["answer"].as_str().unwrap().to_owned()
        })
        .collect();
    assert_eq!(answers, ["once", "denied", "lasting", "nobody"]);
}

fn delete(process: &Process, name: &str) -> Request<Full<Bytes>> {
    process
        .request("DELETE", "kind-a", &format!("{CONFIGMAPS}/{name}"))
        .header("content-type", "application/json")
        .body(json_body(&json!({ "kind": "DeleteOptions", "apiVersion": "v1", "propagationPolicy": "Background" })))
        .unwrap()
}

#[tokio::test]
async fn a_delete_is_denied_without_its_name_typed() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;
    let deleting = tokio::spawn(send(process.at(), delete(&process, "c")));
    let ask = asked(&mut events).await;
    assert!(ask.typed);
    answer_with(&core, &ask, ApprovalAnswer::Deny, None);
    assert_eq!(deleting.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    assert_eq!(fake.writes(Method::DELETE), 0);
}

fn exec(process: &Process, pod: &str, command: &str, websocket: bool) -> Request<Full<Bytes>> {
    let path = format!(
        "/api/v1/namespaces/a/pods/{pod}/exec?command={command}&container=app&stdin=true&stdout=true&tty=true"
    );
    let request = if websocket {
        process
            .request("GET", "kind-a", &path)
            .header(UPGRADE, "websocket")
            .header("sec-websocket-key", "a2V5")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-protocol", "v5.channel.k8s.io")
    } else {
        process
            .request("POST", "kind-a", &path)
            .header(UPGRADE, "SPDY/3.1")
            .header("x-stream-protocol-version", "v4.channel.k8s.io")
    };
    request
        .header("connection", "Upgrade")
        .header("kubectl-command", "kubectl exec")
        .body(empty())
        .unwrap()
}

fn execs(fake: &Fake) -> usize {
    fake.seen()
        .iter()
        .filter(|seen| seen.uri.contains("/exec"))
        .count()
}

#[tokio::test]
async fn an_exec_asks_with_what_it_runs_and_one_answer_covers_its_spdy_repeat() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;

    let websocket = tokio::spawn(send(process.at(), exec(&process, "p", "sh", true)));
    let ask = asked(&mut events).await;
    assert_eq!((ask.verb.as_str(), ask.class), ("exec", RequestClass::Exec));
    assert_eq!(ask.target, "pods/p in a", "the verb says exec");
    assert_eq!(
        ask.detail,
        ApprovalDetail::Session {
            container: Some("app".to_owned()),
            command: vec!["sh".to_owned()],
            tty: true,
            stdin: true,
        }
    );
    answer_with(&core, &ask, ApprovalAnswer::Deny, None);
    assert_eq!(websocket.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    let (status, _) = refused(process.at(), exec(&process, "p", "sh", false)).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the SPDY repeat is denied too"
    );
    assert!(events.try_recv().is_err(), "and asks nothing");
    assert_eq!(execs(&fake), 0);

    let websocket = tokio::spawn(send(process.at(), exec(&process, "refuses", "sh", true)));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    assert_eq!(websocket.await.unwrap().0.status(), StatusCode::BAD_REQUEST);
    let (response, _connection) = send(process.at(), exec(&process, "refuses", "sh", false)).await;
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "the server's answer"
    );
    assert!(
        events.try_recv().is_err(),
        "once covers a repeat no server took"
    );
    assert_eq!(execs(&fake), 2);

    let attach = process
        .request(
            "POST",
            "kind-a",
            "/api/v1/namespaces/a/pods/p/attach?stdin=true&stdout=true",
        )
        .header("connection", "Upgrade")
        .header(UPGRADE, "SPDY/3.1")
        .body(empty())
        .unwrap();
    let attaching = tokio::spawn(send(process.at(), attach));
    let ask = asked(&mut events).await;
    assert_eq!(ask.verb, "attach");
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    let (response, _connection) = attaching.await.unwrap();
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
}

/// A WebSocket upgrade of `path` with `method`.
fn upgraded(process: &Process, method: &str, path: &str) -> Request<Full<Bytes>> {
    process
        .request(method, "kind-a", path)
        .header("connection", "Upgrade")
        .header(UPGRADE, "websocket")
        .header("sec-websocket-key", "a2V5")
        .header("sec-websocket-version", "13")
        .body(empty())
        .unwrap()
}

#[tokio::test]
async fn an_upgrade_header_goes_only_with_a_pod_s_stream_or_a_proxy() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;
    for (method, path) in [
        ("GET", "/api/v1/namespaces/a/pods/x"),
        ("DELETE", "/api/v1/namespaces/a/pods/x"),
        ("DELETE", "/api/v1/namespaces/a/pods"),
        ("DELETE", "/api/v1/namespaces/a/pods/x/exec"),
        ("PUT", "/api/v1/namespaces/a/pods/x/proxy/"),
        ("PATCH", "/api/v1/namespaces/a/configmaps/c"),
        ("GET", "/api/v1/namespaces/a/configmaps/c/proxy"),
        ("GET", "/apis/example.com/v1/namespaces/a/pods/x/exec"),
        ("GET", "/api/v1/proxy/namespaces/a/pods/x"),
        ("GET", "/api/v1/watch/namespaces/a/pods/x/exec"),
    ] {
        let (status, message) = refused(process.at(), upgraded(&process, method, path)).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{method} {path}: {message}"
        );
    }
    let head = upgraded(&process, "HEAD", "/api/v1/namespaces/a/pods/x/exec");
    let (response, _connection) = send(process.at(), head).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST, "HEAD");
    assert!(events.try_recv().is_err(), "nothing asked");
    let seen = fake.seen();
    assert!(seen.is_empty(), "{seen:?}");
}

#[tokio::test]
async fn a_delete_asks_for_the_typed_name_whatever_its_class_and_no_grant_covers_it() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;
    let first = tokio::spawn(send(process.at(), create(&process, "one")));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Lasting, None);
    assert_eq!(first.await.unwrap().0.status(), StatusCode::CREATED);

    // RBAC calls whatever goes through the old proxy path `proxy`.
    let delete = process
        .request("DELETE", "kind-a", "/api/v1/proxy/namespaces/a/pods/p/x")
        .body(empty())
        .unwrap();
    let deleting = tokio::spawn(send(process.at(), delete));
    let ask = asked(&mut events).await;
    assert_eq!(ask.class, RequestClass::Exec);
    assert_eq!((ask.typed, ask.lasting_minutes), (true, None));
    answer_with(&core, &ask, ApprovalAnswer::Deny, None);
    assert_eq!(deleting.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    assert_eq!(fake.writes(Method::DELETE), 0);
}

#[tokio::test]
async fn a_proxy_s_answer_reached_its_backend_so_a_once_covers_no_repeat() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;
    let path = "/api/v1/namespaces/a/pods/refuses/proxy/";
    let first = tokio::spawn(send(process.at(), upgraded(&process, "GET", path)));
    let ask = asked(&mut events).await;
    assert_eq!(ask.class, RequestClass::Exec);
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    let (response, _connection) = first.await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST, "the backend's");

    let repeat = tokio::spawn(send(process.at(), upgraded(&process, "GET", path)));
    let again = asked(&mut events).await;
    answer_with(&core, &again, ApprovalAnswer::Deny, None);
    assert_eq!(repeat.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    let proxied = fake
        .seen()
        .iter()
        .filter(|seen| seen.uri.contains("/proxy/"))
        .count();
    assert_eq!(proxied, 1);
}

#[tokio::test]
async fn a_proxy_upgrade_keeps_its_method_where_a_pod_s_stream_folds_it() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;
    let clients = core.clients("kind-a").await.unwrap();
    let mut open = Vec::new();
    while clients.usage().borrow().sessions.held < 64 {
        let (response, connection) = send(process.at(), exec(&process, "p", "sh", true)).await;
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        open.push((response, connection));
    }
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let full = |response: Response<Incoming>| {
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    };

    let path = "/api/v1/namespaces/a/pods/p/proxy/";
    let get = tokio::spawn(send(process.at(), upgraded(&process, "GET", path)));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    full(get.await.unwrap().0);
    let post = tokio::spawn(send(process.at(), upgraded(&process, "POST", path)));
    let ask = asked(&mut events).await;
    assert_eq!(ask.verb, "create", "a POST asks for itself");
    answer_with(&core, &ask, ApprovalAnswer::Deny, None);
    assert_eq!(post.await.unwrap().0.status(), StatusCode::FORBIDDEN);
    full(send(process.at(), upgraded(&process, "GET", path)).await.0);
    assert!(
        events.try_recv().is_err(),
        "the GET's once covers its repeat"
    );

    let websocket = tokio::spawn(send(process.at(), exec(&process, "q", "sh", true)));
    let ask = asked(&mut events).await;
    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    full(websocket.await.unwrap().0);
    full(send(process.at(), exec(&process, "q", "sh", false)).await.0);
    assert!(
        events.try_recv().is_err(),
        "the WebSocket GET's once covers the SPDY POST"
    );
    let reached = fake
        .seen()
        .iter()
        .filter(|seen| seen.uri.contains("/proxy/") || seen.uri.contains("/pods/q/"))
        .count();
    assert_eq!(reached, 0);
}

#[tokio::test]
async fn a_stream_s_refusal_holds_its_session_until_its_body_ends() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let process = Process::start(&core, None).await;
    let clients = core.clients("kind-a").await.unwrap();
    let (response, connection) = send(process.at(), exec(&process, "holds", "sh", true)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        clients.usage().borrow().sessions.held,
        1,
        "while its body runs"
    );
    drop((response, connection));
    let freed = tokio::time::timeout(WAIT, async {
        while clients.usage().borrow().sessions.held != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    freed.await.expect("its session freed with its body");
}

async fn withdrawn(events: &mut mpsc::UnboundedReceiver<ApprovalEvent>, ask: &ApprovalAsk) {
    let event = tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("withdrawn");
    assert_eq!(event, Some(ApprovalEvent::Withdrawn { id: ask.id }));
}

#[tokio::test]
async fn a_write_whose_body_ends_after_its_process_did_is_not_sent() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let process = Process::start(&core, None).await;
    let at = process.at();
    let stream = TcpStream::connect(at.address).await.unwrap();
    let stream = at
        .tls
        .connect(ServerName::IpAddress(at.address.ip().into()), stream)
        .await
        .unwrap();
    let (frames, mut sent) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(4);
    let body = StreamBody::new(futures::stream::poll_fn(move |cx| sent.poll_recv(cx)));
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection);
    let manifest = configmap("late").to_string();
    let request = process
        .request("POST", "kind-a", CONFIGMAPS)
        .header("content-type", "application/json")
        .header("content-length", manifest.len().to_string())
        .body(body)
        .unwrap();
    let sending = tokio::spawn(async move { sender.send_request(request).await });
    let (first, rest) = manifest.split_at(5);
    let frame = |part: &str| Ok(Frame::data(Bytes::from(part.to_owned())));
    frames.send(frame(first)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(process.handle);
    frames.send(frame(rest)).await.unwrap();
    let response = tokio::time::timeout(WAIT, sending).await.unwrap().unwrap();
    let seen = fake.seen();
    assert!(seen.is_empty(), "{seen:?}");
    assert_eq!(response.unwrap().status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_process_that_ends_while_its_request_is_sent_gets_no_answer_of_the_server_s() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    let clients = core.clients("kind-a").await.unwrap();
    let process = Process::start(&core, None).await;
    let writing = tokio::spawn(send(process.at(), slow(create(&process, "c"))));
    let execing = tokio::spawn(send(process.at(), slow(exec(&process, "p", "sh", true))));
    seen_by(&fake, 2, |seen| seen.uri.contains("slow=1")).await;
    let ended = std::time::Instant::now();
    drop(process.handle);
    let (wrote, execed) = (writing.await, execing.await);
    assert!(ended.elapsed() < SLOW, "{:?}", ended.elapsed());
    assert_eq!(
        wrote.unwrap().0.status(),
        StatusCode::FORBIDDEN,
        "the write's"
    );
    assert_eq!(
        execed.unwrap().0.status(),
        StatusCode::FORBIDDEN,
        "the exec's"
    );
    let usage = *clients.usage().borrow();
    assert_eq!((usage.proxied.held, usage.sessions.held), (0, 0));
}

#[tokio::test]
async fn an_answer_given_as_the_process_ends_sends_nothing() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    for _ in 0..8 {
        let process = Process::start(&core, Some("main")).await;
        let execing = tokio::spawn(send(process.at(), exec(&process, "p", "sh", true)));
        let writing = tokio::spawn(send(process.at(), create(&process, "c")));
        let asks = [asked(&mut events).await, asked(&mut events).await];
        for ask in &asks {
            answer_with(&core, ask, ApprovalAnswer::Once, None);
        }
        drop(process.handle);
        let (execed, wrote) = (execing.await, writing.await);
        assert_eq!(execs(&fake), 0);
        assert_eq!(fake.writes(Method::POST), 0);
        assert_eq!(execed.unwrap().0.status(), StatusCode::FORBIDDEN);
        assert_eq!(wrote.unwrap().0.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn an_ask_its_window_cannot_answer_any_more_is_withdrawn_from_it() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut events = follow(&core, "main");
    let process = Process::start(&core, Some("main")).await;

    let relocked = tokio::spawn(send(process.at(), create(&process, "relocked")));
    let ask = asked(&mut events).await;
    core.policy
        .set_mode("kind-a", Some(Mode::ReadOnly))
        .unwrap();
    withdrawn(&mut events, &ask).await;
    let (response, _connection) = relocked.await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "as the new mode says"
    );

    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let opened = tokio::spawn(send(process.at(), create(&process, "opened")));
    let ask = asked(&mut events).await;
    core.policy
        .set_mode("kind-a", Some(Mode::ReadWrite))
        .unwrap();
    withdrawn(&mut events, &ask).await;
    let (response, _connection) = opened.await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::CREATED,
        "as the new mode says"
    );
    assert_eq!(fake.writes(Method::POST), 1);

    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let ended = Process::start(&core, Some("main")).await;
    let revoked = tokio::spawn(send(ended.at(), create(&ended, "revoked")));
    let ask = asked(&mut events).await;
    drop(ended.handle);
    withdrawn(&mut events, &ask).await;
    assert_eq!(revoked.await.unwrap().0.status(), StatusCode::FORBIDDEN);

    let reloaded = tokio::spawn(send(process.at(), create(&process, "reloaded")));
    let ask = asked(&mut events).await;
    core.drop_window("main");
    withdrawn(&mut events, &ask).await;
    let (status, message) = {
        let (response, _connection) = reloaded.await.unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8(body.to_vec()).unwrap())
    };
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(message.contains("nothing can ask"), "{message}");
    assert_eq!(fake.writes(Method::POST), 1);
}

#[tokio::test]
async fn a_later_follower_of_the_window_replaces_the_earlier_and_gets_what_still_waits() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &fake).await;
    core.policy.set_mode("kind-a", Some(Mode::Guarded)).unwrap();
    let mut earlier = follow(&core, "main");
    let mut elsewhere = follow(&core, "another");
    let process = Process::start(&core, Some("main")).await;

    let sent = tokio::spawn(send(process.at(), create(&process, "c")));
    let ask = asked(&mut earlier).await;
    let mut later = follow(&core, "main");
    assert_eq!(asked(&mut later).await, ask, "what still waits");
    let second = tokio::spawn(send(process.at(), create(&process, "d")));
    let next = asked(&mut later).await;
    assert_ne!(next.id, ask.id);
    assert!(earlier.try_recv().is_err(), "replaced");
    assert!(elsewhere.try_recv().is_err(), "another window's");

    answer_with(&core, &ask, ApprovalAnswer::Once, None);
    answer_with(&core, &next, ApprovalAnswer::Once, None);
    assert_eq!(sent.await.unwrap().0.status(), StatusCode::CREATED);
    assert_eq!(second.await.unwrap().0.status(), StatusCode::CREATED);
    assert_eq!(fake.writes(Method::POST), 2);
}
