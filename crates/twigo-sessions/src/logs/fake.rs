//! A fake API server and kubelet for the logs' tests on paused time: the
//! pods of one namespace, listed and watched whole as raw objects, as a
//! server without Table sends them, and the logs of each container's
//! instances, which the kubelet reads as its own status says, the running
//! instance or the previous one (`validateContainerLogStatus`, kubernetes
//! v1.37.0), each line at or after `sinceTime` in the log's order
//! (cri-client `logWriter.write`).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use futures::channel::mpsc;
use http::{Request, Response, StatusCode};
use http_body::Frame;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use serde_json::{Value, json};
use tower::BoxError;
use twigo_cache::hub::{Connect, Hub};
use twigo_ipc::IpcError;
use twigo_kube::client::{Budgets, Clients};

use crate::logs::view::rfc3339;

pub const NAMESPACE: &str = "shop";

type Body = UnsyncBoxBody<Bytes, BoxError>;
type Sender = mpsc::UnboundedSender<Result<Frame<Bytes>, BoxError>>;

#[derive(Clone, Default)]
pub struct Fake(Arc<Mutex<State>>);

#[derive(Default)]
struct State {
    version: u64,
    pods: BTreeMap<String, Value>,
    changes: Vec<(u64, &'static str, Value)>,
    watches: Vec<Watch>,
    containers: BTreeMap<(String, String), Container>,
    /// Follows over a connection that died: open, and silent.
    stranded: Vec<Sender>,
}

struct Watch {
    /// The name its field selector picks.
    name: Option<String>,
    sender: Sender,
}

/// What the kubelet holds of a container.
#[derive(Default)]
struct Container {
    instances: BTreeMap<String, Instance>,
    /// The instances it reads, as its own status names them, which the
    /// API server's may not yet.
    current: Option<String>,
    previous: Option<String>,
    /// The next read's body breaks after this many lines.
    breaks: Option<usize>,
}

#[derive(Default)]
struct Instance {
    lines: Vec<(i64, String)>,
    stopped: bool,
    /// Its log is gone, so the kubelet says it cannot read it.
    removed: bool,
    /// The open follows, with their `sinceTime`.
    followers: Vec<(i64, Sender)>,
}

impl Fake {
    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap()
    }

    pub fn hub(&self) -> (Hub, Arc<Clients>) {
        let fake = self.clone();
        let service = tower::service_fn(move |request: Request<kube::client::Body>| {
            let fake = fake.clone();
            async move { Ok::<_, BoxError>(fake.respond(&request)) }
        });
        let clients = Arc::new(Clients::over(service, Budgets::default()));
        let connect: Connect = {
            let clients = Arc::clone(&clients);
            Arc::new(move |_context| {
                let clients = Arc::clone(&clients);
                Box::pin(async move { Ok::<_, IpcError>(clients) })
            })
        };
        (Hub::new(connect), clients)
    }

    /// Adds or replaces a pod.
    pub fn pod(&self, mut pod: Value) {
        let mut state = self.state();
        state.version += 1;
        pod["kind"] = json!("Pod");
        pod["apiVersion"] = json!("v1");
        pod["metadata"]["namespace"] = json!(NAMESPACE);
        pod["metadata"]["resourceVersion"] = json!(state.version.to_string());
        let name = pod["metadata"]["name"].as_str().unwrap().to_owned();
        let kind = match state.pods.insert(name, pod.clone()) {
            Some(_) => "MODIFIED",
            None => "ADDED",
        };
        state.change(kind, pod);
    }

    pub fn delete(&self, name: &str) {
        let mut state = self.state();
        state.version += 1;
        let mut pod = state.pods.remove(name).expect("a pod to delete");
        pod["metadata"]["resourceVersion"] = json!(state.version.to_string());
        state.change("DELETED", pod);
    }

    /// Which instances of a container the kubelet reads.
    pub fn serve(&self, pod: &str, container: &str, current: Option<&str>, previous: Option<&str>) {
        let mut state = self.state();
        let served = state.container(pod, container);
        served.current = current.map(str::to_owned);
        served.previous = previous.map(str::to_owned);
    }

    /// An instance writes a line at `at`, in nanoseconds since the epoch.
    pub fn write(&self, pod: &str, container: &str, instance: &str, at: i64, text: &str) {
        let mut state = self.state();
        let instance = state.instance(pod, container, instance);
        instance.lines.push((at, text.to_owned()));
        let line = Bytes::from(format!("{} {text}\n", rfc3339(at)));
        instance.followers.retain(|(since, sender)| {
            at < *since || sender.unbounded_send(Ok(Frame::data(line.clone()))).is_ok()
        });
    }

    /// An instance stops, which ends the follows of its log.
    pub fn stop(&self, pod: &str, container: &str, instance: &str) {
        let mut state = self.state();
        let instance = state.instance(pod, container, instance);
        instance.stopped = true;
        instance.followers.clear();
    }

    /// The kubelet removes an instance and its log.
    pub fn remove(&self, pod: &str, container: &str, instance: &str) {
        let mut state = self.state();
        let instance = state.instance(pod, container, instance);
        instance.removed = true;
        instance.followers.clear();
    }

    /// Breaks the body of each open follow of a container.
    pub fn break_follows(&self, pod: &str, container: &str) {
        let mut state = self.state();
        for instance in state.container(pod, container).instances.values_mut() {
            for (_, sender) in instance.followers.drain(..) {
                let _ = sender.unbounded_send(Err("the connection broke".into()));
            }
        }
    }

    /// The follows of a container get nothing more, as over a connection
    /// that died, which neither ends nor breaks their bodies.
    pub fn strand(&self, pod: &str, container: &str) {
        let mut state = self.state();
        let mut stranded = Vec::new();
        for instance in state.container(pod, container).instances.values_mut() {
            stranded.extend(instance.followers.drain(..).map(|(_, sender)| sender));
        }
        state.stranded.extend(stranded);
    }

    /// The next read of a container breaks after `lines` lines.
    pub fn break_after(&self, pod: &str, container: &str, lines: usize) {
        self.state().container(pod, container).breaks = Some(lines);
    }

    fn respond(&self, request: &Request<kube::client::Body>) -> Response<Body> {
        let uri = request.uri();
        let query: BTreeMap<String, String> =
            form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
                .into_owned()
                .collect();
        let param = |name: &str| query.get(name).map(String::as_str);
        let path: Vec<&str> = uri.path().trim_matches('/').split('/').collect();
        let mut state = self.state();
        match path[..] {
            ["api", "v1", "namespaces", NAMESPACE, "pods"] => {
                let name = param("fieldSelector")
                    .and_then(|selector| selector.strip_prefix("metadata.name="))
                    .map(str::to_owned);
                if param("watch") == Some("true") {
                    state.watch(name, param("resourceVersion"), param("sendInitialEvents"))
                } else {
                    let items: Vec<&Value> = state
                        .pods
                        .values()
                        .filter(|pod| picks(name.as_deref(), pod))
                        .collect();
                    let list = json!({
                        "kind": "PodList",
                        "apiVersion": "v1",
                        "metadata": { "resourceVersion": state.version.to_string() },
                        "items": items,
                    });
                    full(StatusCode::OK, list)
                }
            }
            ["api", "v1", "namespaces", NAMESPACE, "pods", pod, "log"] => state.log(pod, &query),
            _ => panic!("the fake serves no {uri}"),
        }
    }
}

fn picks(name: Option<&str>, pod: &Value) -> bool {
    name.is_none_or(|name| pod["metadata"]["name"] == name)
}

impl State {
    fn change(&mut self, kind: &'static str, pod: Value) {
        self.changes.push((self.version, kind, pod.clone()));
        let mut event = serde_json::to_vec(&json!({ "type": kind, "object": pod })).unwrap();
        event.push(b'\n');
        let event = Bytes::from(event);
        self.watches.retain(|watch| {
            !picks(watch.name.as_deref(), &pod)
                || watch
                    .sender
                    .unbounded_send(Ok(Frame::data(event.clone())))
                    .is_ok()
        });
    }

    /// A watch of the pods `name` picks: their initial events and the
    /// bookmark that ends them, or the changes after `from`.
    fn watch(
        &mut self,
        name: Option<String>,
        from: Option<&str>,
        initial: Option<&str>,
    ) -> Response<Body> {
        let (sender, receiver) = mpsc::unbounded();
        let send = |value: &Value| {
            let mut line = serde_json::to_vec(value).unwrap();
            line.push(b'\n');
            sender
                .unbounded_send(Ok(Frame::data(Bytes::from(line))))
                .expect("the receiver is ours");
        };
        if initial == Some("true") {
            for pod in self.pods.values().filter(|pod| picks(name.as_deref(), pod)) {
                send(&json!({ "type": "ADDED", "object": pod }));
            }
            send(&json!({
                "type": "BOOKMARK",
                "object": {
                    "kind": "Pod",
                    "apiVersion": "v1",
                    "metadata": {
                        "resourceVersion": self.version.to_string(),
                        "annotations": { "k8s.io/initial-events-end": "true" },
                    },
                },
            }));
        } else {
            let from: u64 = from.and_then(|from| from.parse().ok()).expect("a version");
            for (version, kind, pod) in &self.changes {
                if *version > from && picks(name.as_deref(), pod) {
                    send(&json!({ "type": kind, "object": pod }));
                }
            }
        }
        self.watches.push(Watch { name, sender });
        Response::new(StreamBody::new(receiver).boxed_unsync())
    }

    fn container(&mut self, pod: &str, container: &str) -> &mut Container {
        self.containers
            .entry((pod.to_owned(), container.to_owned()))
            .or_default()
    }

    fn instance(&mut self, pod: &str, container: &str, instance: &str) -> &mut Instance {
        self.container(pod, container)
            .instances
            .entry(instance.to_owned())
            .or_default()
    }

    fn log(&mut self, pod: &str, query: &BTreeMap<String, String>) -> Response<Body> {
        let param = |name: &str| query.get(name).map(String::as_str);
        let container = param("container").expect("a container");
        let since = param("sinceTime").map_or(i64::MIN, |since| {
            let since: jiff::Timestamp = since.parse().unwrap();
            i64::try_from(since.as_nanosecond()).unwrap()
        });
        let served = self.container(pod, container);
        let id = if param("previous") == Some("true") {
            served.previous.clone()
        } else {
            served.current.clone()
        };
        let Some(id) = id else {
            let message = format!("container {container:?} in pod {pod:?} is waiting to start");
            return full(
                StatusCode::BAD_REQUEST,
                json!({ "kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "BadRequest", "code": 400, "message": message }),
            );
        };
        let breaks = served.breaks.take();
        let instance = served.instances.entry(id).or_default();
        if instance.removed {
            let gone = "failed to try resolving symlinks in path \"/var/log/pods/0.log\": lstat /var/log/pods/0.log: no such file or directory\n";
            let body = Full::new(Bytes::from(gone)).map_err(|never| match never {});
            return Response::new(body.boxed_unsync());
        }
        let lines: Vec<Bytes> = instance
            .lines
            .iter()
            .filter(|(at, _)| *at >= since)
            .map(|(at, text)| Bytes::from(format!("{} {text}\n", rfc3339(*at))))
            .collect();
        let (sender, receiver) = mpsc::unbounded();
        let body = Response::new(StreamBody::new(receiver).boxed_unsync());
        let send = |line: &Bytes| {
            sender
                .unbounded_send(Ok(Frame::data(line.clone())))
                .expect("the receiver is ours");
        };
        if let Some(after) = breaks {
            lines.iter().take(after).for_each(send);
            let _ = sender.unbounded_send(Err("the connection broke".into()));
            return body;
        }
        lines.iter().for_each(send);
        if param("follow") == Some("true") && !instance.stopped {
            instance.followers.push((since, sender));
        }
        body
    }
}

fn full(code: StatusCode, value: Value) -> Response<Body> {
    let body = Full::new(Bytes::from(serde_json::to_vec(&value).unwrap()));
    let mut response = Response::new(body.map_err(|never| match never {}).boxed_unsync());
    *response.status_mut() = code;
    response
}
