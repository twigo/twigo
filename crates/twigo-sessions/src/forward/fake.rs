//! A fake API server for the forward's tests on paused time: the objects of
//! one namespace by resource, listed and watched whole as raw objects, as a
//! server without Table sends them, picked by a `metadata.name` field
//! selector or all of them. It can be unreachable, never answer, answer
//! late, fail every request after a timeout, reject the credential, forbid
//! a resource, fail to make the clients and end its watches.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use futures::channel::mpsc;
use http::{Request, Response, StatusCode};
use http_body::Frame;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use serde_json::{Value, json};
use tower::BoxError;
use twigo_cache::hub::{Connect, Hub};
use twigo_ipc::{ErrorKind, IpcError};
use twigo_kube::client::{Budgets, Clients};

pub const NAMESPACE: &str = "shop";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(70);

type Body = UnsyncBoxBody<Bytes, BoxError>;
type Sender = mpsc::UnboundedSender<Result<Frame<Bytes>, BoxError>>;

#[derive(Clone, Default)]
pub struct Fake(Arc<Mutex<State>>);

#[derive(Default)]
struct State {
    offline: bool,
    stalled: bool,
    delay: Duration,
    times_out: bool,
    unauthorized: bool,
    no_context: bool,
    clients_fail: bool,
    forbidden: BTreeSet<String>,
    missing: BTreeSet<String>,
    version: u64,
    /// By resource, then name.
    objects: BTreeMap<(String, String), Value>,
    changes: Vec<(u64, String, &'static str, Value)>,
    watches: Vec<Watch>,
}

struct Watch {
    resource: String,
    /// The name its field selector picks.
    name: Option<String>,
    sender: Sender,
}

/// The clients a hub gets, which are replaced as the core replaces a
/// context's when what they were built from changes.
pub struct Renew {
    fake: Fake,
    budgets: Budgets,
    current: Arc<Mutex<Arc<Clients>>>,
}

impl Renew {
    pub fn clients(&self) -> Arc<Clients> {
        Arc::clone(&self.current.lock().unwrap())
    }

    /// New clients for whoever asks next, and the old ones abandoned.
    pub fn replace(&self) {
        let new = self.fake.clients(self.budgets);
        let old = std::mem::replace(&mut *self.current.lock().unwrap(), new);
        old.connections().abandon();
    }
}

impl Fake {
    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap()
    }

    /// The hub over this server, with the clients every context gets.
    pub fn hub(&self, budgets: Budgets) -> (Hub, Arc<Clients>) {
        let (hub, renew) = self.renewing(budgets);
        (hub, renew.clients())
    }

    /// [`Fake::hub`], whose clients can be replaced.
    pub fn renewing(&self, budgets: Budgets) -> (Hub, Renew) {
        let renew = Renew {
            fake: self.clone(),
            budgets,
            current: Arc::new(Mutex::new(self.clients(budgets))),
        };
        let connect: Connect = {
            let current = Arc::clone(&renew.current);
            let fake = self.clone();
            Arc::new(move |_context| {
                let clients = Arc::clone(&current.lock().unwrap());
                let (missing, failing) = {
                    let state = fake.state();
                    (state.no_context, state.clients_fail)
                };
                Box::pin(async move {
                    if missing {
                        return Err(IpcError::new(
                            ErrorKind::NotFound,
                            "no source lists the context \"kind-test\"",
                        ));
                    }
                    if failing {
                        return Err(IpcError::new(
                            ErrorKind::Unavailable,
                            "the context's clients could not be made",
                        ));
                    }
                    Ok(clients)
                })
            })
        };
        (Hub::new(connect), renew)
    }

    fn clients(&self, budgets: Budgets) -> Arc<Clients> {
        let fake = self.clone();
        let service = tower::service_fn(move |request: Request<kube::client::Body>| {
            let fake = fake.clone();
            async move {
                if fake.state().stalled {
                    std::future::pending::<()>().await;
                }
                let delay = fake.state().delay;
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                if fake.state().times_out {
                    tokio::time::sleep(REQUEST_TIMEOUT).await;
                    return Err::<Response<Body>, BoxError>("request timed out".into());
                }
                fake.respond(&request)
            }
        });
        Arc::new(Clients::over(service, budgets))
    }

    /// Adds or replaces an object of `resource`, such as `pods`.
    pub fn put(&self, resource: &str, mut object: Value) {
        let mut state = self.state();
        state.version += 1;
        object["metadata"]["namespace"] = json!(NAMESPACE);
        object["metadata"]["resourceVersion"] = json!(state.version.to_string());
        let name = object["metadata"]["name"].as_str().unwrap().to_owned();
        let kind = match state
            .objects
            .insert((resource.to_owned(), name), object.clone())
        {
            Some(_) => "MODIFIED",
            None => "ADDED",
        };
        state.change(resource, kind, object);
    }

    pub fn remove(&self, resource: &str, name: &str) {
        let mut state = self.state();
        state.version += 1;
        let mut object = state
            .objects
            .remove(&(resource.to_owned(), name.to_owned()))
            .expect("an object to remove");
        object["metadata"]["resourceVersion"] = json!(state.version.to_string());
        state.change(resource, "DELETED", object);
    }

    pub fn set_offline(&self, offline: bool) {
        self.state().offline = offline;
    }

    pub fn set_stalled(&self, stalled: bool) {
        self.state().stalled = stalled;
    }

    /// Answers every request `delay` after it arrives.
    pub fn set_delay(&self, delay: Duration) {
        self.state().delay = delay;
    }

    pub fn set_times_out(&self, times_out: bool) {
        self.state().times_out = times_out;
    }

    /// Answers 401 to every request for a resource, as a cluster that
    /// rejects the credential does.
    pub fn set_unauthorized(&self, unauthorized: bool) {
        self.state().unauthorized = unauthorized;
    }

    pub fn set_no_context(&self, missing: bool) {
        self.state().no_context = missing;
    }

    /// The context's clients cannot be made, in a way that may pass.
    pub fn set_clients_fail(&self, failing: bool) {
        self.state().clients_fail = failing;
    }

    pub fn forbid(&self, resource: &str, forbidden: bool) {
        let mut state = self.state();
        if forbidden {
            state.forbidden.insert(resource.to_owned());
        } else {
            state.forbidden.remove(resource);
        }
    }

    /// Answers 404 to a list of `resource`, as a server that does not serve
    /// its group does.
    pub fn miss(&self, resource: &str) {
        self.state().missing.insert(resource.to_owned());
    }

    pub fn end_watches(&self) {
        self.state().watches.clear();
    }

    /// How many watches are open.
    pub fn watching(&self) -> usize {
        let mut state = self.state();
        state.watches.retain(|watch| !watch.sender.is_closed());
        state.watches.len()
    }

    fn respond(&self, request: &Request<kube::client::Body>) -> Result<Response<Body>, BoxError> {
        if self.state().offline {
            return Err("connection refused".into());
        }
        let uri = request.uri();
        let query: BTreeMap<String, String> =
            form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
                .into_owned()
                .collect();
        let param = |name: &str| query.get(name).map(String::as_str);
        if uri.path() == "/version" {
            return Ok(full(StatusCode::OK, &json!({ "gitVersion": "v1.37.0" })));
        }
        let path: Vec<&str> = uri.path().trim_matches('/').split('/').collect();
        let resource = match path[..] {
            ["api", "v1", "namespaces", NAMESPACE, resource]
            | ["apis", _, _, "namespaces", NAMESPACE, resource] => resource.to_owned(),
            _ => panic!("the fake serves no {uri}"),
        };
        let name = param("fieldSelector")
            .and_then(|selector| selector.strip_prefix("metadata.name="))
            .map(str::to_owned);
        let mut state = self.state();
        if state.unauthorized {
            return Ok(full(
                StatusCode::UNAUTHORIZED,
                &json!({
                    "kind": "Status",
                    "apiVersion": "v1",
                    "status": "Failure",
                    "message": "Unauthorized",
                    "reason": "Unauthorized",
                    "code": 401,
                }),
            ));
        }
        if state.forbidden.contains(&resource) {
            return Ok(full(
                StatusCode::FORBIDDEN,
                &json!({
                    "kind": "Status",
                    "apiVersion": "v1",
                    "status": "Failure",
                    "message": format!("{resource} is forbidden"),
                    "reason": "Forbidden",
                    "code": 403,
                }),
            ));
        }
        if state.missing.contains(&resource) {
            return Ok(full(
                StatusCode::NOT_FOUND,
                &json!({
                    "kind": "Status",
                    "apiVersion": "v1",
                    "status": "Failure",
                    "message": format!("the server could not find the requested resource ({resource})"),
                    "reason": "NotFound",
                    "code": 404,
                }),
            ));
        }
        if param("watch") == Some("true") {
            return Ok(state.watch(
                resource,
                name,
                param("resourceVersion"),
                param("sendInitialEvents"),
            ));
        }
        let items: Vec<&Value> = state.items(&resource, name.as_deref()).collect();
        Ok(full(
            StatusCode::OK,
            &json!({
                "kind": "List",
                "apiVersion": "v1",
                "metadata": { "resourceVersion": state.version.to_string() },
                "items": items,
            }),
        ))
    }
}

fn picks(name: Option<&str>, object: &Value) -> bool {
    name.is_none_or(|name| object["metadata"]["name"] == name)
}

impl State {
    fn items<'a>(
        &'a self,
        resource: &'a str,
        name: Option<&'a str>,
    ) -> impl Iterator<Item = &'a Value> {
        self.objects
            .iter()
            .filter(move |((kept, _), object)| kept == resource && picks(name, object))
            .map(|(_, object)| object)
    }

    fn change(&mut self, resource: &str, kind: &'static str, object: Value) {
        self.changes
            .push((self.version, resource.to_owned(), kind, object.clone()));
        let event = line(&json!({ "type": kind, "object": object }));
        self.watches.retain(|watch| {
            watch.resource != resource
                || !picks(watch.name.as_deref(), &object)
                || watch
                    .sender
                    .unbounded_send(Ok(Frame::data(event.clone())))
                    .is_ok()
        });
    }

    /// A watch of the objects `name` picks: their initial events and the
    /// bookmark that ends them, or the changes after `from`.
    fn watch(
        &mut self,
        resource: String,
        name: Option<String>,
        from: Option<&str>,
        initial: Option<&str>,
    ) -> Response<Body> {
        let (sender, receiver) = mpsc::unbounded();
        let send = |value: &Value| {
            sender
                .unbounded_send(Ok(Frame::data(line(value))))
                .expect("the receiver is ours");
        };
        if initial == Some("true") {
            for object in self.items(&resource, name.as_deref()) {
                send(&json!({ "type": "ADDED", "object": object }));
            }
            send(&json!({
                "type": "BOOKMARK",
                "object": {
                    "kind": "List",
                    "apiVersion": "v1",
                    "metadata": {
                        "resourceVersion": self.version.to_string(),
                        "annotations": { "k8s.io/initial-events-end": "true" },
                    },
                },
            }));
        } else {
            let from: u64 = from.and_then(|from| from.parse().ok()).expect("a version");
            for (version, kept, kind, object) in &self.changes {
                if *version > from && *kept == resource && picks(name.as_deref(), object) {
                    send(&json!({ "type": kind, "object": object }));
                }
            }
        }
        self.watches.push(Watch {
            resource,
            name,
            sender,
        });
        Response::new(StreamBody::new(receiver).boxed_unsync())
    }
}

fn line(value: &Value) -> Bytes {
    let mut line = serde_json::to_vec(value).unwrap();
    line.push(b'\n');
    line.into()
}

fn full(code: StatusCode, value: &Value) -> Response<Body> {
    let body = Full::new(Bytes::from(serde_json::to_vec(value).unwrap()));
    let mut response = Response::new(body.map_err(|never| match never {}).boxed_unsync());
    *response.status_mut() = code;
    response
}
