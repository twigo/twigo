//! A fake API server for the hub's tests on paused time: objects by group,
//! resource, namespace and name, as metadata unless a test puts whole ones,
//! list pages, watches resumed from a `resourceVersion` or streaming their
//! initial events as each group answers them, gzip for what asks for it,
//! `410 Gone` below a compacted version, refusals, probes, access reviews,
//! aggregated discovery with its ETags, and the Metrics API, which lists
//! whole and cannot be watched.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::convert::Infallible;
use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use flate2::Compression;
use flate2::write::GzEncoder;
use futures::channel::mpsc;
use http::{Request, Response, StatusCode};
use http_body::Frame;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use jiff::Timestamp;
use serde_json::{Value, json};
use tokio::time::Instant;
use tower::BoxError;
use twigo_ipc::IpcError;
use twigo_kube::client::{Budgets, Clients};
use twigo_kube::credentials::{CredentialError, RunError};

use crate::hub::{Connect, Hub};
use crate::upstream::Clock;

type Body = UnsyncBoxBody<Bytes, Infallible>;

/// What the aggregator answers a list of an API whose server is down, recorded by `record_metrics`.
pub const NO_ENDPOINTS: (&str, &str) = ("text/plain; charset=utf-8", "service unavailable\n");

#[derive(Clone, Default)]
pub struct Fake(Arc<Mutex<State>>);

#[derive(Default)]
pub struct State {
    version: u64,
    /// By group, resource, then namespace and name.
    objects: BTreeMap<(String, String, Option<String>, String), Value>,
    /// Changes in order, for watches that resume.
    log: Vec<Change>,
    watches: Vec<Watch>,
    /// Watches from below this version get `410 Gone`.
    pub compacted: u64,
    /// Streaming lists send their initial events only once released.
    pub hold_initial: bool,
    /// The paths whose streaming lists are held as `hold_initial` holds all.
    pub hold_paths: HashSet<String>,
    /// How each group answers a streaming list, the core group as `""`.
    streams: HashMap<String, Streams>,
    /// The responses that sent their headers and nothing more, which stay open.
    silent: Vec<mpsc::UnboundedSender<Result<Frame<Bytes>, Infallible>>>,
    /// Requests get `503` while this many remain.
    pub unavailable: usize,
    /// A watch from a version answers one `ERROR` event of 500, then ends.
    pub watch_fails: bool,
    /// Paths that answer `403`.
    pub forbidden: HashSet<String>,
    /// Paths that answer `401`.
    pub unauthorized: HashSet<String>,
    /// Paths that answer `503` with a plain-text body, as the aggregator does for a server that is down.
    pub no_endpoints: HashSet<String>,
    /// Resources the server cannot watch, as ComponentStatus.
    pub unwatchable: HashSet<String>,
    /// The person may list pods cluster-wide.
    pub may_list: bool,
    /// `/version` fails as over a dead connection.
    pub dead: bool,
    /// `/version` sends its headers and never its body, as over a connection
    /// whose window is full.
    pub version_body_hangs: bool,
    /// Every other request fails as when the credential plugin timed out.
    pub plugin_timed_out: bool,
    /// Discovery requests never answer.
    pub discovery_hangs: bool,
    /// When each request came, with its path and query.
    pub requests: Vec<(Instant, String)>,
    /// The path and query of each list and watch it answered gzipped.
    gzipped: Vec<String>,
    /// What discovery serves, by group, the core group as `""`.
    pub served: BTreeMap<String, Group>,
    /// How many discovery requests got 304.
    pub not_modified: usize,
    /// Each Metrics API request waits this long before it is answered.
    pub metrics_takes: std::time::Duration,
    /// A list's body arrives this long after its status and headers.
    pub body_takes: std::time::Duration,
    /// The most Metrics API requests that waited at once.
    pub metrics_overlap: usize,
    metrics_waiting: usize,
}

/// How a group answers a streaming list. Every answer that streams is gzipped
/// when gzip was asked, except [`Streams::Plain`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Streams {
    /// As 1.37: the initial events as `ADDED`, then the annotated bookmark,
    /// gzipped a member at each flush.
    #[default]
    Compressed,
    /// As 1.34 to 1.36: the same, plain although gzip was asked.
    Plain,
    /// As 1.33: 422 on `sendInitialEvents`.
    NoWatchList,
    /// This status, as `Status`, to the request.
    Status(StatusCode),
    /// As a server that knows neither parameter: every object as `ADDED`, a
    /// bookmark without the annotation, and the changes after.
    PlainWatch,
    /// Every object as `ADDED`, then a bookmark with neither the annotation
    /// nor a `resourceVersion`, which no decoder reads.
    BlankBookmark,
    /// 200, then nothing, ever.
    Silent,
    /// 200, then the end of the response.
    EndsAtOnce,
    /// 200, one `ERROR` event of 500, then the end of the response.
    ErrorThenEnd,
    /// Every object as `ADDED`, then a `DELETED` of the first, and no end.
    Deleted,
    /// One object as `ADDED` each interval, then the annotated bookmark.
    Trickle(std::time::Duration),
}

impl Streams {
    /// The answer of a server that refuses the request.
    fn refusal(self) -> Option<Response<Body>> {
        match self {
            Streams::NoWatchList => Some(full(
                StatusCode::UNPROCESSABLE_ENTITY,
                &json!({
                    "kind": "Status",
                    "apiVersion": "v1",
                    "status": "Failure",
                    "reason": "Invalid",
                    "code": 422,
                    "message": "sendInitialEvents is forbidden for watch unless the WatchList feature gate is enabled",
                    "details": { "causes": [{ "reason": "FieldValueForbidden", "field": "sendInitialEvents" }] }
                }),
                false,
            )),
            Streams::Status(code) => {
                Some(status(code, code.canonical_reason().unwrap_or("Unknown")))
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Group {
    pub version: String,
    /// The version stays with no resources, as an aggregated server that is down leaves it.
    pub stale: bool,
    pub resources: Vec<(String, String, bool)>,
    pub verbs: Vec<&'static str>,
}

impl Group {
    fn new(version: &str) -> Self {
        Self {
            version: version.to_owned(),
            stale: false,
            resources: Vec::new(),
            verbs: vec!["get", "list", "watch"],
        }
    }
}

struct Change {
    version: u64,
    kind: &'static str,
    group: String,
    resource: String,
    namespace: Option<String>,
    object: Value,
}

struct Watch {
    group: String,
    resource: String,
    namespace: Option<String>,
    sender: mpsc::UnboundedSender<Result<Frame<Bytes>, Infallible>>,
    /// A held streaming list, which has not sent its end yet.
    held: bool,
    /// Its initial events went out, but for the end.
    streamed: bool,
    /// Each frame is a gzip member of its own, as the server flushes at each.
    gzip: bool,
}

impl Watch {
    /// Whether the receiver is still there.
    fn send(&self, line: Bytes) -> bool {
        self.sender
            .unbounded_send(Ok(Frame::data(frame(line, self.gzip))))
            .is_ok()
    }
}

/// What a request's path names.
struct Target {
    group: String,
    resource: String,
    namespace: Option<String>,
}

fn target(path: &str) -> Target {
    let (group, collection) = match path.strip_prefix("/apis/") {
        Some(rest) => {
            let mut parts = rest.splitn(3, '/');
            let group = parts.next().expect("a group");
            parts.next().expect("a version");
            (group, parts.next().expect("a collection"))
        }
        None => ("", path.trim_start_matches("/api/v1/")),
    };
    let parts: Vec<&str> = collection.split('/').collect();
    match parts[..] {
        ["namespaces", namespace, resource] => Target {
            group: group.to_owned(),
            resource: resource.to_owned(),
            namespace: Some(namespace.to_owned()),
        },
        [resource] => Target {
            group: group.to_owned(),
            resource: resource.to_owned(),
            namespace: None,
        },
        _ => panic!("the fake serves no {path}"),
    }
}

struct Waiting<'a>(&'a Fake);

impl<'a> Waiting<'a> {
    fn start(fake: &'a Fake) -> Self {
        let mut state = fake.state();
        state.metrics_waiting += 1;
        state.metrics_overlap = state.metrics_overlap.max(state.metrics_waiting);
        Self(fake)
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.state().metrics_waiting -= 1;
    }
}

impl Fake {
    pub fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap()
    }

    /// Clients over this server.
    pub fn clients(&self, budgets: Budgets) -> Arc<Clients> {
        Arc::new(self.over(budgets))
    }

    /// Clients over this server, said to reach `cluster`.
    pub fn clients_reaching(&self, budgets: Budgets, cluster: &str) -> Arc<Clients> {
        Arc::new(self.over(budgets).reaching(cluster))
    }

    fn over(&self, budgets: Budgets) -> Clients {
        let fake = self.clone();
        let service = tower::service_fn(move |request: Request<kube::client::Body>| {
            let fake = fake.clone();
            async move { fake.answer(request).await }
        });
        Clients::over(service, budgets)
    }

    /// The hub over this server, every context's clients with `budgets`,
    /// stamping rows by a clock that starts at the epoch and runs with the
    /// test's paused time.
    pub fn hub(&self, budgets: Budgets) -> (Hub, Arc<Clients>) {
        let clients = self.clients(budgets);
        let connect: Connect = {
            let clients = Arc::clone(&clients);
            Arc::new(move |_context| {
                let clients = Arc::clone(&clients);
                Box::pin(async move { Ok::<_, IpcError>(clients) })
            })
        };
        let start = Instant::now();
        let clock: Clock = Arc::new(move || Timestamp::UNIX_EPOCH + start.elapsed());
        (Hub::with_clock(connect, clock), clients)
    }

    pub fn add(&self, resource: &str, namespace: Option<&str>, name: &str) {
        self.add_to("", resource, namespace, name);
    }

    pub fn add_to(&self, group: &str, resource: &str, namespace: Option<&str>, name: &str) {
        let object = json!({
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "uid": format!("{group}-{resource}-{}-{name}", namespace.unwrap_or("")),
            }
        });
        self.put(group, resource, namespace, object);
    }

    /// A `resourceVersion` is set unless the group has none, as `metrics.k8s.io` has not.
    pub fn put(&self, group: &str, resource: &str, namespace: Option<&str>, mut object: Value) {
        let mut state = self.state();
        state.version += 1;
        if group != crate::metrics::GROUP {
            object["metadata"]["resourceVersion"] = json!(state.version.to_string());
        }
        let name = object["metadata"]["name"]
            .as_str()
            .expect("an object with a name")
            .to_owned();
        let key = (
            group.to_owned(),
            resource.to_owned(),
            namespace.map(str::to_owned),
            name,
        );
        let kind = if state.objects.insert(key, object.clone()).is_some() {
            "MODIFIED"
        } else {
            "ADDED"
        };
        state.change(group, resource, namespace, kind, object);
    }

    pub fn delete(&self, resource: &str, namespace: Option<&str>, name: &str) {
        self.delete_from("", resource, namespace, name);
    }

    pub fn delete_from(&self, group: &str, resource: &str, namespace: Option<&str>, name: &str) {
        let mut state = self.state();
        state.version += 1;
        let key = (
            group.to_owned(),
            resource.to_owned(),
            namespace.map(str::to_owned),
            name.to_owned(),
        );
        let mut object = state.objects.remove(&key).expect("an object to delete");
        object["metadata"]["resourceVersion"] = json!(state.version.to_string());
        state.change(group, resource, namespace, "DELETED", object);
    }

    /// Has `group` answer streaming lists as `answer`.
    pub fn streams(&self, group: &str, answer: Streams) {
        self.state().streams.insert(group.to_owned(), answer);
    }

    /// Sends every watch a bookmark, but a held streaming list, which a real
    /// server sends none before its end.
    pub fn bookmark(&self) {
        let mut state = self.state();
        let version = state.version.to_string();
        state
            .watches
            .retain(|watch| watch.held || watch.send(line(&bookmark(&version, false))));
    }

    /// Sends the held streaming lists their initial events, but not the
    /// bookmark that ends them.
    pub fn stream_initial(&self) {
        let mut state = self.state();
        let mut watches = std::mem::take(&mut state.watches);
        for watch in watches.iter_mut().filter(|watch| watch.held) {
            state.send_initial(watch);
        }
        state.watches = watches;
    }

    /// Sends the held streaming lists their initial events, and ends them.
    pub fn release_initial(&self) {
        let mut state = self.state();
        state.hold_initial = false;
        state.hold_paths.clear();
        let version = state.version.to_string();
        let mut watches = std::mem::take(&mut state.watches);
        for watch in watches.iter_mut().filter(|watch| watch.held) {
            state.send_initial(watch);
            watch.send(line(&bookmark(&version, true)));
            watch.held = false;
        }
        state.watches = watches;
    }

    /// Watches from before now get `410 Gone`, as once the server compacted
    /// its history.
    pub fn compact(&self) {
        let mut state = self.state();
        state.compacted = state.version;
    }

    /// Ends every watch as `timeoutSeconds` does.
    pub fn end_watches(&self) {
        self.state().watches.clear();
    }

    /// How many watches are open.
    pub fn watching(&self) -> usize {
        let mut state = self.state();
        state.watches.retain(|watch| !watch.sender.is_closed());
        state.watches.len()
    }

    pub fn serve_metrics(&self, version: &str) {
        self.state().served.insert(
            crate::metrics::GROUP.to_owned(),
            Group {
                version: version.to_owned(),
                stale: false,
                resources: vec![
                    ("nodes".to_owned(), "NodeMetrics".to_owned(), false),
                    ("pods".to_owned(), "PodMetrics".to_owned(), true),
                ],
                verbs: vec!["get", "list"],
            },
        );
    }

    pub fn stale_metrics(&self, version: &str) {
        self.state().served.insert(
            crate::metrics::GROUP.to_owned(),
            Group {
                stale: true,
                ..Group::new(version)
            },
        );
    }

    pub fn pod_usage(&self, namespace: &str, name: &str, containers: &[(&str, &str, &str)]) {
        let containers: Vec<Value> = containers
            .iter()
            .map(|(container, cpu, memory)| {
                json!({ "name": container, "usage": { "cpu": cpu, "memory": memory } })
            })
            .collect();
        self.put(
            crate::metrics::GROUP,
            "pods",
            Some(namespace),
            json!({
                "kind": "PodMetrics",
                "apiVersion": "metrics.k8s.io/v1beta1",
                "metadata": { "name": name, "namespace": namespace },
                "timestamp": "2026-11-13T16:19:28Z",
                "window": "15s",
                "containers": containers,
            }),
        );
    }

    pub fn node_usage(&self, name: &str, cpu: &str, memory: &str) {
        self.put(
            crate::metrics::GROUP,
            "nodes",
            None,
            json!({
                "kind": "NodeMetrics",
                "apiVersion": "metrics.k8s.io/v1beta1",
                "metadata": { "name": name },
                "timestamp": "2026-11-13T16:19:28Z",
                "window": "15s",
                "usage": { "cpu": cpu, "memory": memory },
            }),
        );
    }

    pub fn count(&self, needle: &str) -> usize {
        self.state()
            .requests
            .iter()
            .filter(|(_, request)| request.contains(needle))
            .count()
    }

    /// How many of the requests holding `needle` it answered gzipped.
    pub fn count_gzipped(&self, needle: &str) -> usize {
        self.state()
            .gzipped
            .iter()
            .filter(|request| request.contains(needle))
            .count()
    }

    async fn answer(
        &self,
        request: Request<kube::client::Body>,
    ) -> Result<Response<Body>, BoxError> {
        let path = request.uri().path();
        if (path == "/api" || path == "/apis") && self.state().discovery_hangs {
            self.state()
                .requests
                .push((Instant::now(), request.uri().to_string()));
            return std::future::pending().await;
        }
        if path.starts_with("/apis/metrics.k8s.io/") && !self.state().metrics_takes.is_zero() {
            let _waiting = Waiting::start(self);
            let takes = self.state().metrics_takes;
            tokio::time::sleep(takes).await;
            return Ok(self.respond(request));
        }
        let dead = if path == "/version" {
            self.state().dead
        } else {
            self.state().plugin_timed_out
        };
        if dead {
            self.state()
                .requests
                .push((Instant::now(), request.uri().to_string()));
            if path == "/version" {
                return Err("the connection is dead".into());
            }
            return Err(Box::new(CredentialError::Run(RunError::Timeout {
                command: "aws".to_owned(),
                after: std::time::Duration::from_secs(120),
            })));
        }
        Ok(self.respond(request))
    }

    fn respond(&self, request: Request<kube::client::Body>) -> Response<Body> {
        let if_none_match = request
            .headers()
            .get(http::header::IF_NONE_MATCH)
            .map(|value| value.to_str().unwrap().to_owned());
        let request_headers = request.headers().clone();
        let uri = request.uri().clone();
        let path = uri.path().to_owned();
        let query: Vec<(String, String)> =
            form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
                .into_owned()
                .collect();
        let param = |name: &str| {
            query
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        let mut state = self.state();
        state.requests.push((Instant::now(), uri.to_string()));
        if path == "/version" {
            if state.version_body_hangs {
                let (sender, receiver) = mpsc::unbounded();
                state.silent.push(sender);
                return stream(receiver, false);
            }
            return full(StatusCode::OK, &json!({ "gitVersion": "v1.37.0" }), false);
        }
        if path.ends_with("selfsubjectaccessreviews") {
            let allowed = state.may_list;
            return full(
                StatusCode::CREATED,
                &json!({
                    "apiVersion": "authorization.k8s.io/v1",
                    "kind": "SelfSubjectAccessReview",
                    "spec": {},
                    "status": { "allowed": allowed }
                }),
                false,
            );
        }
        if state.unavailable > 0 {
            state.unavailable -= 1;
            return status(StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable");
        }
        if state.no_endpoints.contains(&path) {
            return text(StatusCode::SERVICE_UNAVAILABLE);
        }
        if state.forbidden.contains(&path) {
            return status(StatusCode::FORBIDDEN, "Forbidden");
        }
        if state.unauthorized.contains(&path) {
            return status(StatusCode::UNAUTHORIZED, "Unauthorized");
        }
        if path == "/api" || path == "/apis" {
            return state.discovery(path == "/api", if_none_match.as_deref());
        }
        let target = target(&path);
        let gzip = accepts_gzip(&request_headers);
        if target.group == crate::metrics::GROUP {
            return state.metrics(
                &target,
                param("watch") == Some("true"),
                param("fieldSelector"),
                gzip,
            );
        }
        if param("watch") != Some("true") {
            // A continue token is the list's version and where the next
            // page starts.
            let (version, start) = param("continue")
                .and_then(|token| token.split_once(':'))
                .map(|(version, start)| (version.to_owned(), start.parse::<usize>().unwrap()))
                .unwrap_or((state.version.to_string(), 0));
            let limit: usize = param("limit").map_or(usize::MAX, |limit| limit.parse().unwrap());
            let items = state.items(&target);
            let end = start.saturating_add(limit).min(items.len());
            let mut metadata = json!({ "resourceVersion": version });
            if end < items.len() {
                metadata["continue"] = json!(format!("{version}:{end}"));
            }
            let page = json!({
                "kind": "PartialObjectMetadataList",
                "apiVersion": "meta.k8s.io/v1",
                "metadata": metadata,
                "items": items[start..end],
            });
            if gzip {
                state.gzipped.push(uri.to_string());
            }
            if state.body_takes.is_zero() {
                return full(StatusCode::OK, &page, gzip);
            }
            return slow(StatusCode::OK, &page, state.body_takes, gzip);
        }
        if state.unwatchable.contains(&target.resource) {
            return status(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed");
        }
        let streaming = param("sendInitialEvents") == Some("true");
        let answer = state
            .streams
            .get(&target.group)
            .copied()
            .unwrap_or_default();
        if streaming && let Some(refusal) = answer.refusal() {
            return refusal;
        }
        let gzip = streaming && answer != Streams::Plain && gzip;
        if gzip {
            state.gzipped.push(uri.to_string());
        }
        let (sender, receiver) = mpsc::unbounded();
        let send = |value: &Value| {
            sender
                .unbounded_send(Ok(Frame::data(frame(line(value), gzip))))
                .expect("the receiver is ours");
        };
        if streaming {
            if state.hold_initial || state.hold_paths.contains(&path) {
                state.watches.push(Watch {
                    group: target.group,
                    resource: target.resource,
                    namespace: target.namespace,
                    sender,
                    held: true,
                    streamed: false,
                    gzip,
                });
                return stream(receiver, gzip);
            }
            let items = state.items(&target);
            let version = state.version.to_string();
            let added = |item: &Value| json!({ "type": "ADDED", "object": item });
            match answer {
                Streams::Silent => {
                    state.silent.push(sender);
                    return stream(receiver, gzip);
                }
                Streams::EndsAtOnce => return stream(receiver, gzip),
                Streams::ErrorThenEnd => {
                    send(&internal_error());
                    return stream(receiver, gzip);
                }
                Streams::PlainWatch => {
                    items.iter().for_each(|item| send(&added(item)));
                    send(&bookmark(&version, false));
                }
                Streams::BlankBookmark => {
                    items.iter().for_each(|item| send(&added(item)));
                    send(&json!({
                        "type": "BOOKMARK",
                        "object": { "kind": "Pod", "apiVersion": "v1", "metadata": {} }
                    }));
                }
                Streams::Deleted => {
                    items.iter().for_each(|item| send(&added(item)));
                    send(&json!({ "type": "DELETED", "object": items[0] }));
                }
                Streams::Trickle(every) => {
                    let sender = sender.clone();
                    tokio::spawn(async move {
                        for item in items {
                            tokio::time::sleep(every).await;
                            let event = line(&added(&item));
                            let _ = sender.unbounded_send(Ok(Frame::data(frame(event, gzip))));
                        }
                        tokio::time::sleep(every).await;
                        let end = line(&bookmark(&version, true));
                        let _ = sender.unbounded_send(Ok(Frame::data(frame(end, gzip))));
                    });
                }
                _ => {
                    items.iter().for_each(|item| send(&added(item)));
                    send(&bookmark(&version, true));
                }
            }
        } else {
            let from: u64 = param("resourceVersion")
                .and_then(|version| version.parse().ok())
                .expect("a watch from a version");
            if state.watch_fails {
                send(&internal_error());
                return stream(receiver, gzip);
            }
            if from < state.compacted {
                send(&json!({
                    "type": "ERROR",
                    "object": {
                        "kind": "Status",
                        "apiVersion": "v1",
                        "status": "Failure",
                        "reason": "Expired",
                        "code": 410,
                        "message": format!("too old resource version: {from}"),
                    }
                }));
                drop(sender);
                return stream(receiver, gzip);
            }
            for change in &state.log {
                if change.version > from
                    && target.matches(&change.group, &change.resource, change.namespace.as_deref())
                {
                    send(&json!({ "type": change.kind, "object": change.object }));
                }
            }
        }
        state.watches.push(Watch {
            group: target.group,
            resource: target.resource,
            namespace: target.namespace,
            sender,
            held: false,
            streamed: false,
            gzip,
        });
        stream(receiver, gzip)
    }
}

impl Target {
    fn matches(&self, group: &str, resource: &str, namespace: Option<&str>) -> bool {
        self.group == group
            && self.resource == resource
            && (self.namespace.is_none() || self.namespace.as_deref() == namespace)
    }
}

impl State {
    pub fn serve(&mut self, group: &str, resource: &str, kind: &str) {
        self.served
            .entry(group.to_owned())
            .or_insert_with(|| Group::new("v1"))
            .resources
            .push((resource.to_owned(), kind.to_owned(), false));
    }

    fn discovery(&mut self, core: bool, if_none_match: Option<&str>) -> Response<Body> {
        let items: Vec<Value> = self
            .served
            .iter()
            .filter(|(group, _)| group.is_empty() == core)
            .map(|(name, group)| {
                let resources: Vec<Value> = group
                    .resources
                    .iter()
                    .map(|(resource, kind, namespaced)| {
                        json!({
                            "resource": resource,
                            "responseKind": { "group": "", "version": "", "kind": kind },
                            "scope": if *namespaced { "Namespaced" } else { "Cluster" },
                            "verbs": group.verbs,
                        })
                    })
                    .collect();
                let version = if group.stale {
                    json!({ "version": group.version, "freshness": "Stale" })
                } else {
                    json!({ "version": group.version, "resources": resources, "freshness": "Current" })
                };
                json!({ "metadata": { "name": name }, "versions": [version] })
            })
            .collect();
        let body = serde_json::to_vec(&json!({
            "kind": "APIGroupDiscoveryList",
            "apiVersion": "apidiscovery.k8s.io/v2",
            "metadata": {},
            "items": items,
        }))
        .unwrap();
        let mut hasher = std::hash::DefaultHasher::new();
        std::hash::Hash::hash(&body, &mut hasher);
        let etag = format!("\"{:X}\"", std::hash::Hasher::finish(&hasher));
        let (code, body) = if if_none_match == Some(etag.as_str()) {
            self.not_modified += 1;
            (StatusCode::NOT_MODIFIED, Bytes::new())
        } else {
            (StatusCode::OK, Bytes::from(body))
        };
        let mut response = Response::new(Full::new(body).boxed_unsync());
        *response.status_mut() = code;
        let headers = response.headers_mut();
        headers.insert(http::header::ETAG, etag.parse().unwrap());
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static(
                "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList",
            ),
        );
        response
    }

    /// As metrics-server answers: whole, with the request's time as each `creationTimestamp`
    /// and the containers in an order that changes with every request.
    fn metrics(
        &self,
        target: &Target,
        watch: bool,
        selector: Option<&str>,
        gzip: bool,
    ) -> Response<Body> {
        if watch {
            return status(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed");
        }
        let name = selector.and_then(|selector| selector.strip_prefix("metadata.name="));
        let at = jiff::Timestamp::from_second(1_800_000_000 + self.requests.len() as i64)
            .expect("a time")
            .to_string();
        let items: Vec<Value> = self
            .items(target)
            .into_iter()
            .filter(|item| name.is_none_or(|name| item["metadata"]["name"] == name))
            .map(|mut item| {
                item["metadata"]["creationTimestamp"] = json!(at);
                if self.requests.len() % 2 == 1
                    && let Some(containers) =
                        item.get_mut("containers").and_then(Value::as_array_mut)
                {
                    containers.reverse();
                }
                item
            })
            .collect();
        let kind = if target.resource == "nodes" {
            "NodeMetricsList"
        } else {
            "PodMetricsList"
        };
        let mut response = full(
            StatusCode::OK,
            &json!({
                "kind": kind,
                "apiVersion": "metrics.k8s.io/v1beta1",
                "metadata": {},
                "items": items,
            }),
            gzip,
        );
        response.headers_mut().insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        response
    }

    /// Sends a held streaming list its items, once.
    fn send_initial(&self, watch: &mut Watch) {
        if std::mem::replace(&mut watch.streamed, true) {
            return;
        }
        let target = Target {
            group: watch.group.clone(),
            resource: watch.resource.clone(),
            namespace: watch.namespace.clone(),
        };
        for item in self.items(&target) {
            watch.send(line(&json!({ "type": "ADDED", "object": item })));
        }
    }

    fn items(&self, target: &Target) -> Vec<Value> {
        self.objects
            .iter()
            .filter(|((group, resource, namespace, _), _)| {
                target.matches(group, resource, namespace.as_deref())
            })
            .map(|(_, object)| object.clone())
            .collect()
    }

    fn change(
        &mut self,
        group: &str,
        resource: &str,
        namespace: Option<&str>,
        kind: &'static str,
        object: Value,
    ) {
        let event = line(&json!({ "type": kind, "object": object }));
        self.log.push(Change {
            version: self.version,
            kind,
            group: group.to_owned(),
            resource: resource.to_owned(),
            namespace: namespace.map(str::to_owned),
            object,
        });
        self.watches.retain(|watch| {
            let target = Target {
                group: watch.group.clone(),
                resource: watch.resource.clone(),
                namespace: watch.namespace.clone(),
            };
            // A held list sends what it holds once released, changes
            // after.
            watch.held || !target.matches(group, resource, namespace) || watch.send(event.clone())
        });
    }
}

fn internal_error() -> Value {
    json!({
        "type": "ERROR",
        "object": {
            "kind": "Status",
            "apiVersion": "v1",
            "status": "Failure",
            "reason": "InternalError",
            "code": 500,
            "message": "etcd does not support watch progress",
        }
    })
}

fn bookmark(version: &str, initial_events_end: bool) -> Value {
    let annotations = if initial_events_end {
        json!({ "k8s.io/initial-events-end": "true" })
    } else {
        json!({})
    };
    json!({
        "type": "BOOKMARK",
        "object": {
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": { "resourceVersion": version, "annotations": annotations }
        }
    })
}

fn line(value: &Value) -> Bytes {
    let mut line = serde_json::to_vec(value).unwrap();
    line.push(b'\n');
    line.into()
}

fn json_body(value: &Value, gzip: bool) -> Bytes {
    frame(Bytes::from(serde_json::to_vec(value).unwrap()), gzip)
}

fn full(code: StatusCode, value: &Value, gzip: bool) -> Response<Body> {
    let body = json_body(value, gzip);
    let mut response = Response::new(Full::new(body).boxed_unsync());
    *response.status_mut() = code;
    encoded(&mut response, gzip);
    response
}

/// A response whose status and headers come at once and whose body comes after `takes`.
fn slow(code: StatusCode, value: &Value, takes: std::time::Duration, gzip: bool) -> Response<Body> {
    let (sender, receiver) = mpsc::unbounded();
    let body = json_body(value, gzip);
    tokio::spawn(async move {
        tokio::time::sleep(takes).await;
        let _ = sender.unbounded_send(Ok(Frame::data(body)));
    });
    let mut response = stream(receiver, gzip);
    *response.status_mut() = code;
    response
}

fn status(code: StatusCode, reason: &str) -> Response<Body> {
    full(
        code,
        &json!({
            "kind": "Status",
            "apiVersion": "v1",
            "status": "Failure",
            "reason": reason,
            "code": code.as_u16(),
            "message": reason,
        }),
        false,
    )
}

fn text(code: StatusCode) -> Response<Body> {
    let (content_type, body) = NO_ENDPOINTS;
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())).boxed_unsync());
    *response.status_mut() = code;
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static(content_type),
    );
    response
}

fn accepts_gzip(headers: &http::HeaderMap) -> bool {
    headers
        .get(http::header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("gzip"))
}

pub fn stream<E: Send + 'static>(
    receiver: mpsc::UnboundedReceiver<Result<Frame<Bytes>, E>>,
    gzip: bool,
) -> Response<UnsyncBoxBody<Bytes, E>> {
    let mut response = Response::new(StreamBody::new(receiver).boxed_unsync());
    encoded(&mut response, gzip);
    response
}

fn encoded<B>(response: &mut Response<B>, gzip: bool) {
    if gzip {
        response.headers_mut().insert(
            http::header::CONTENT_ENCODING,
            http::HeaderValue::from_static("gzip"),
        );
    }
}

/// A gzip member of its own, or the bytes as they are.
pub fn frame(bytes: Bytes, gzip: bool) -> Bytes {
    if !gzip {
        return bytes;
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(&bytes).unwrap();
    encoder.finish().unwrap().into()
}

/// The fingerprint of a context that reaches `server`, as the catalog makes it.
#[cfg(test)]
pub fn fingerprint(server: &str) -> twigo_kube::kubeconfig::Fingerprint {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kubeconfig");
    std::fs::write(
        &file,
        format!(
            "clusters: [{{ name: c, cluster: {{ server: '{server}' }} }}]
contexts: [{{ name: kind-test, context: {{ cluster: c }} }}]
"
        ),
    )
    .unwrap();
    twigo_kube::kubeconfig::Sources::explicit(file)
        .load()
        .contexts[0]
        .fingerprint
}
