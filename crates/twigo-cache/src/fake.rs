//! A fake API server for the hub's tests on paused time: objects by group,
//! resource, namespace and name, as metadata unless a test puts whole ones,
//! list pages, watches resumed from a `resourceVersion` or streaming their
//! initial events, `410 Gone` below a compacted version, refusals, probes,
//! access reviews, aggregated discovery with its ETags, and the Metrics
//! API, which lists whole and cannot be watched.

use std::collections::{BTreeMap, HashSet};
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
use serde_json::{Value, json};
use tokio::time::Instant;
use tower::BoxError;
use twigo_ipc::IpcError;
use twigo_kube::client::{Budgets, Clients};
use twigo_kube::credentials::{CredentialError, RunError};

use crate::hub::{Connect, Hub};

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
    /// The cluster refuses streaming lists, as 1.33 does.
    pub no_streaming: bool,
    /// Requests get `503` while this many remain.
    pub unavailable: usize,
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
    /// Every other request fails as when the credential plugin timed out.
    pub plugin_timed_out: bool,
    /// Discovery requests never answer.
    pub discovery_hangs: bool,
    /// When each request came, with its path and query.
    pub requests: Vec<(Instant, String)>,
    /// What discovery serves, by group, the core group as `""`.
    pub served: BTreeMap<String, Group>,
    /// How many discovery requests got 304.
    pub not_modified: usize,
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
    /// A held streaming list, which has sent nothing yet.
    held: bool,
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

    /// The hub over this server, every context's clients with `budgets`.
    pub fn hub(&self, budgets: Budgets) -> (Hub, Arc<Clients>) {
        let clients = self.clients(budgets);
        let connect: Connect = {
            let clients = Arc::clone(&clients);
            Arc::new(move |_context| {
                let clients = Arc::clone(&clients);
                Box::pin(async move { Ok::<_, IpcError>(clients) })
            })
        };
        (Hub::new(connect), clients)
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

    /// Sends every watch a bookmark.
    pub fn bookmark(&self) {
        let mut state = self.state();
        let version = state.version.to_string();
        state.watches.retain(|watch| {
            watch
                .sender
                .unbounded_send(Ok(Frame::data(line(&bookmark(&version, false)))))
                .is_ok()
        });
    }

    /// Sends the held streaming lists their initial events.
    pub fn release_initial(&self) {
        let mut state = self.state();
        state.hold_initial = false;
        let version = state.version.to_string();
        let mut watches = std::mem::take(&mut state.watches);
        for watch in watches.iter_mut().filter(|watch| watch.held) {
            let target = Target {
                group: watch.group.clone(),
                resource: watch.resource.clone(),
                namespace: watch.namespace.clone(),
            };
            for item in state.items(&target) {
                let event = line(&json!({ "type": "ADDED", "object": item }));
                let _ = watch.sender.unbounded_send(Ok(Frame::data(event)));
            }
            let end = line(&bookmark(&version, true));
            let _ = watch.sender.unbounded_send(Ok(Frame::data(end)));
            watch.held = false;
        }
        state.watches = watches;
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
            return full(StatusCode::OK, json!({ "gitVersion": "v1.37.0" }));
        }
        if path.ends_with("selfsubjectaccessreviews") {
            let allowed = state.may_list;
            return full(
                StatusCode::CREATED,
                json!({
                    "apiVersion": "authorization.k8s.io/v1",
                    "kind": "SelfSubjectAccessReview",
                    "spec": {},
                    "status": { "allowed": allowed }
                }),
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
        if target.group == crate::metrics::GROUP {
            let gzip = accepts_gzip(&request_headers);
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
            return full(
                StatusCode::OK,
                json!({
                    "kind": "PartialObjectMetadataList",
                    "apiVersion": "meta.k8s.io/v1",
                    "metadata": metadata,
                    "items": items[start..end],
                }),
            );
        }
        if state.unwatchable.contains(&target.resource) {
            return status(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed");
        }
        let (sender, receiver) = mpsc::unbounded();
        let send = |value: &Value| {
            sender
                .unbounded_send(Ok(Frame::data(line(value))))
                .expect("the receiver is ours");
        };
        if param("sendInitialEvents") == Some("true") {
            if state.no_streaming {
                return full(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({
                        "kind": "Status",
                        "apiVersion": "v1",
                        "status": "Failure",
                        "reason": "Invalid",
                        "code": 422,
                        "message": "sendInitialEvents is forbidden for watch unless the WatchList feature gate is enabled",
                        "details": { "causes": [{ "reason": "FieldValueForbidden", "field": "sendInitialEvents" }] }
                    }),
                );
            }
            if state.hold_initial {
                state.watches.push(Watch {
                    group: target.group,
                    resource: target.resource,
                    namespace: target.namespace,
                    sender,
                    held: true,
                });
                return stream(receiver);
            }
            for item in state.items(&target) {
                send(&json!({ "type": "ADDED", "object": item }));
            }
            send(&bookmark(&state.version.to_string(), true));
        } else {
            let from: u64 = param("resourceVersion")
                .and_then(|version| version.parse().ok())
                .expect("a watch from a version");
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
                return stream(receiver);
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
        });
        stream(receiver)
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
        let body = serde_json::to_vec(&json!({
            "kind": kind,
            "apiVersion": "metrics.k8s.io/v1beta1",
            "metadata": {},
            "items": items,
        }))
        .unwrap();
        let mut response = Response::new(Full::new(Bytes::new()).boxed_unsync());
        if gzip {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&body).unwrap();
            *response.body_mut() = Full::new(Bytes::from(encoder.finish().unwrap())).boxed_unsync();
            response.headers_mut().insert(
                http::header::CONTENT_ENCODING,
                http::HeaderValue::from_static("gzip"),
            );
        } else {
            *response.body_mut() = Full::new(Bytes::from(body)).boxed_unsync();
        }
        response.headers_mut().insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        response
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
            watch.held
                || !target.matches(group, resource, namespace)
                || watch
                    .sender
                    .unbounded_send(Ok(Frame::data(event.clone())))
                    .is_ok()
        });
    }
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

fn full(code: StatusCode, value: Value) -> Response<Body> {
    let mut response =
        Response::new(Full::new(Bytes::from(serde_json::to_vec(&value).unwrap())).boxed_unsync());
    *response.status_mut() = code;
    response
}

fn status(code: StatusCode, reason: &str) -> Response<Body> {
    full(
        code,
        json!({
            "kind": "Status",
            "apiVersion": "v1",
            "status": "Failure",
            "reason": reason,
            "code": code.as_u16(),
            "message": reason,
        }),
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

fn stream(receiver: mpsc::UnboundedReceiver<Result<Frame<Bytes>, Infallible>>) -> Response<Body> {
    Response::new(StreamBody::new(receiver).boxed_unsync())
}
