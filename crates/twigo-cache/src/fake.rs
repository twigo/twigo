//! A fake API server for the hub's tests on paused time: pods and
//! namespaces as metadata, list pages, watches resumed from a
//! `resourceVersion` or streaming their initial events, `410 Gone` below a
//! compacted version, refusals, probes and access reviews.

use std::collections::{BTreeMap, HashSet};
use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
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

use crate::hub::{Connect, Hub};

type Body = UnsyncBoxBody<Bytes, Infallible>;

#[derive(Clone, Default)]
pub struct Fake(Arc<Mutex<State>>);

#[derive(Default)]
pub struct State {
    version: u64,
    /// Objects by resource, then namespace and name.
    objects: BTreeMap<(String, Option<String>, String), Value>,
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
    /// The person may list pods cluster-wide.
    pub may_list: bool,
    /// `/version` fails as over a dead connection.
    pub dead: bool,
    /// When each request came, with its path and query.
    pub requests: Vec<(Instant, String)>,
}

struct Change {
    version: u64,
    kind: &'static str,
    resource: String,
    namespace: Option<String>,
    object: Value,
}

struct Watch {
    resource: String,
    namespace: Option<String>,
    sender: mpsc::UnboundedSender<Result<Frame<Bytes>, Infallible>>,
    /// A held streaming list, which has sent nothing yet.
    held: bool,
}

/// What a request's path names.
struct Target {
    resource: String,
    namespace: Option<String>,
}

fn target(path: &str) -> Target {
    let parts: Vec<&str> = path.trim_start_matches("/api/v1/").split('/').collect();
    match parts[..] {
        ["namespaces", namespace, resource] => Target {
            resource: resource.to_owned(),
            namespace: Some(namespace.to_owned()),
        },
        [resource] => Target {
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

    /// The hub over this server, every context's clients with `budgets`.
    pub fn hub(&self, budgets: Budgets) -> (Hub, Arc<Clients>) {
        let fake = self.clone();
        let service = tower::service_fn(move |request: Request<kube::client::Body>| {
            let fake = fake.clone();
            async move { fake.answer(request).await }
        });
        let clients = Arc::new(Clients::over(service, budgets));
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
        let mut state = self.state();
        state.version += 1;
        let object = json!({
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "uid": format!("{}-{}-{name}", resource, namespace.unwrap_or("")),
                "resourceVersion": state.version.to_string(),
            }
        });
        let key = (
            resource.to_owned(),
            namespace.map(str::to_owned),
            name.to_owned(),
        );
        let kind = if state.objects.insert(key, object.clone()).is_some() {
            "MODIFIED"
        } else {
            "ADDED"
        };
        state.change(resource, namespace, kind, object);
    }

    pub fn delete(&self, resource: &str, namespace: Option<&str>, name: &str) {
        let mut state = self.state();
        state.version += 1;
        let key = (
            resource.to_owned(),
            namespace.map(str::to_owned),
            name.to_owned(),
        );
        let mut object = state.objects.remove(&key).expect("an object to delete");
        object["metadata"]["resourceVersion"] = json!(state.version.to_string());
        state.change(resource, namespace, "DELETED", object);
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
        if request.uri().path() == "/version" && self.state().dead {
            self.state()
                .requests
                .push((Instant::now(), request.uri().to_string()));
            return Err("the connection is dead".into());
        }
        Ok(self.respond(request))
    }

    fn respond(&self, request: Request<kube::client::Body>) -> Response<Body> {
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
        if state.forbidden.contains(&path) {
            return status(StatusCode::FORBIDDEN, "Forbidden");
        }
        if state.unauthorized.contains(&path) {
            return status(StatusCode::UNAUTHORIZED, "Unauthorized");
        }
        let target = target(&path);
        if param("watch") != Some("true") {
            let items = state.items(&target);
            return full(
                StatusCode::OK,
                json!({
                    "kind": "PartialObjectMetadataList",
                    "apiVersion": "meta.k8s.io/v1",
                    "metadata": { "resourceVersion": state.version.to_string() },
                    "items": items,
                }),
            );
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
                    && target.matches(&change.resource, change.namespace.as_deref())
                {
                    send(&json!({ "type": change.kind, "object": change.object }));
                }
            }
        }
        state.watches.push(Watch {
            resource: target.resource,
            namespace: target.namespace,
            sender,
            held: false,
        });
        stream(receiver)
    }
}

impl Target {
    fn matches(&self, resource: &str, namespace: Option<&str>) -> bool {
        self.resource == resource
            && (self.namespace.is_none() || self.namespace.as_deref() == namespace)
    }
}

impl State {
    fn items(&self, target: &Target) -> Vec<Value> {
        self.objects
            .iter()
            .filter(|((resource, namespace, _), _)| target.matches(resource, namespace.as_deref()))
            .map(|(_, object)| object.clone())
            .collect()
    }

    fn change(
        &mut self,
        resource: &str,
        namespace: Option<&str>,
        kind: &'static str,
        object: Value,
    ) {
        let event = line(&json!({ "type": kind, "object": object }));
        self.log.push(Change {
            version: self.version,
            kind,
            resource: resource.to_owned(),
            namespace: namespace.map(str::to_owned),
            object,
        });
        self.watches.retain(|watch| {
            let target = Target {
                resource: watch.resource.clone(),
                namespace: watch.namespace.clone(),
            };
            !target.matches(resource, namespace)
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

fn stream(receiver: mpsc::UnboundedReceiver<Result<Frame<Bytes>, Infallible>>) -> Response<Body> {
    Response::new(StreamBody::new(receiver).boxed_unsync())
}
