use std::collections::HashMap;
use std::future::{Future, ready};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use twigo_cache::hub::{Hub, LINGER};
use twigo_ipc::{BusyWhy, ErrorKind, ForwardState, Gvr, IpcError};
use twigo_kube::client::Budgets;

use super::connect::{Connect, Connected};
use super::fake::{Fake, NAMESPACE, Renew};
use super::listen::Socket;
use super::watching::{Candidate, Seen, Watching};
use super::{BindError, Config, Forward, Listeners, Status, Target, free_port, listen};

async fn within<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(600), future)
        .await
        .unwrap_or_else(|_| panic!("{what} within ten virtual minutes"))
}

async fn stays<T>(time: Duration, future: impl Future<Output = T>) -> bool {
    tokio::time::timeout(time, future).await.is_err()
}

fn pod_json(name: &str, ready: bool, ports: &[(&str, u16)]) -> Value {
    let ports: Vec<Value> = ports
        .iter()
        .map(|(name, port)| json!({ "name": name, "containerPort": port }))
        .collect();
    json!({
        "kind": "Pod",
        "apiVersion": "v1",
        "metadata": { "name": name, "uid": format!("uid-{name}") },
        "spec": { "containers": [{ "name": "app", "ports": ports }] },
        "status": {
            "phase": "Running",
            "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }],
        },
    })
}

fn endpoint(pod: &str, serving: Option<bool>, terminating: Option<bool>) -> Value {
    let mut conditions = json!({});
    if let Some(serving) = serving {
        conditions["serving"] = json!(serving);
    }
    if let Some(terminating) = terminating {
        conditions["terminating"] = json!(terminating);
    }
    json!({
        "addresses": ["10.0.0.1"],
        "conditions": conditions,
        "targetRef": { "kind": "Pod", "name": pod, "uid": format!("uid-{pod}"), "namespace": NAMESPACE },
    })
}

fn slice(name: &str, service: &str, endpoints: &[Value], ports: &[(&str, u16)]) -> Value {
    let ports: Vec<Value> = ports
        .iter()
        .map(|(name, port)| json!({ "name": name, "port": port, "protocol": "TCP" }))
        .collect();
    json!({
        "kind": "EndpointSlice",
        "apiVersion": "discovery.k8s.io/v1",
        "metadata": { "name": name, "labels": { "kubernetes.io/service-name": service } },
        "addressType": "IPv4",
        "endpoints": endpoints,
        "ports": ports,
    })
}

fn service_json(name: &str, spec: &Value) -> Value {
    json!({
        "kind": "Service",
        "apiVersion": "v1",
        "metadata": { "name": name, "uid": format!("uid-{name}") },
        "spec": spec,
    })
}

fn gvr_resource(resource: &str) -> twigo_cache::hub::Resource {
    twigo_cache::hub::Resource {
        group: String::new(),
        version: "v1".to_owned(),
        resource: resource.to_owned(),
        namespaced: true,
    }
}

fn gvr(group: &str, resource: &str) -> Gvr {
    Gvr {
        group: group.to_owned(),
        version: "v1".to_owned(),
        resource: resource.to_owned(),
    }
}

fn config(group: &str, resource: &str, name: &str, port: u16, port_name: Option<&str>) -> Config {
    Config {
        context: "kind-test".to_owned(),
        target: Target::new(&gvr(group, resource), NAMESPACE.to_owned(), name.to_owned()).unwrap(),
        port,
        port_name: port_name.map(str::to_owned),
    }
}

struct Served {
    pod: String,
    port: u16,
    io: DuplexStream,
    error: oneshot::Sender<String>,
}

#[derive(Clone)]
struct Pods(Arc<Mutex<PodsState>>);

struct PodsState {
    refused: HashMap<String, u16>,
    connects: Vec<(String, u16)>,
    served: mpsc::UnboundedSender<Served>,
}

impl Pods {
    fn new() -> (Self, mpsc::UnboundedReceiver<Served>) {
        let (served, receiver) = mpsc::unbounded_channel();
        let pods = Self(Arc::new(Mutex::new(PodsState {
            refused: HashMap::new(),
            connects: Vec::new(),
            served,
        })));
        (pods, receiver)
    }

    fn refuse(&self, pod: &str, code: u16) {
        self.0.lock().unwrap().refused.insert(pod.to_owned(), code);
    }

    fn allow(&self, pod: &str) {
        self.0.lock().unwrap().refused.remove(pod);
    }

    fn connects(&self) -> Vec<String> {
        let state = self.0.lock().unwrap();
        state.connects.iter().map(|(pod, _)| pod.clone()).collect()
    }
}

impl Connect for Pods {
    fn connect(
        &self,
        _client: &kube::Client,
        _namespace: &str,
        pod: &str,
        port: u16,
    ) -> BoxFuture<'static, Result<Connected, kube::Error>> {
        let mut state = self.0.lock().unwrap();
        state.connects.push((pod.to_owned(), port));
        if let Some(code) = state.refused.get(pod) {
            let status = kube::core::Status::failure(
                &format!("the upgrade to {pod} was refused with {code}"),
                "Refused",
            )
            .with_code(*code);
            return ready(Err(kube::Error::Api(status.boxed()))).boxed();
        }
        let (stream, io) = tokio::io::duplex(64 * 1024);
        let (error, told) = oneshot::channel();
        let _ = state.served.send(Served {
            pod: pod.to_owned(),
            port,
            io,
            error,
        });
        ready(Ok(Connected {
            stream: Box::new(stream),
            error: told.map(Result::ok).boxed(),
            held: Box::new(()),
        }))
        .boxed()
    }
}

fn region() -> u16 {
    static BASE: OnceLock<u16> = OnceLock::new();
    static NEXT: AtomicU16 = AtomicU16::new(0);
    *BASE.get_or_init(|| 20_000 + (std::process::id() % 20_000) as u16)
        + 16 * NEXT.fetch_add(1, Ordering::Relaxed)
}

async fn listeners() -> Listeners {
    loop {
        let port = region();
        match listen(port).await {
            Ok(listeners) => return listeners,
            Err(BindError::Busy(_)) => {}
            Err(BindError::Failed(error)) => panic!("could not bind {port}: {error}"),
        }
    }
}

struct Harness {
    pods: Pods,
    served: mpsc::UnboundedReceiver<Served>,
    forward: Forward,
    hub: Hub,
    renew: Renew,
    sockets: mpsc::UnboundedSender<Socket>,
    status: watch::Receiver<Status>,
}

fn start(fake: &Fake, config: Config, restored: bool, budgets: Budgets) -> Harness {
    let (hub, renew) = fake.renewing(budgets);
    let (pods, served) = Pods::new();
    let (sockets, accepted) = mpsc::unbounded_channel();
    let forward = Forward::spawn_with(
        hub.clone(),
        config,
        accepted,
        (Vec::new(), None),
        restored,
        Arc::new(pods.clone()),
    );
    let status = forward.status();
    Harness {
        pods,
        served,
        forward,
        hub,
        renew,
        sockets,
        status,
    }
}

impl Harness {
    async fn state(&mut self, what: &str, wanted: impl Fn(&ForwardState) -> bool) -> Status {
        within(what, self.status.wait_for(|status| wanted(&status.state)))
            .await
            .unwrap()
            .clone()
    }

    async fn ready(&mut self) -> Status {
        let status = self
            .state("the forward is ready", |state| {
                *state == ForwardState::Ready
            })
            .await;
        while self.served.try_recv().is_ok() {}
        status
    }

    fn client(&self) -> DuplexStream {
        let (client, accepted) = tokio::io::duplex(64 * 1024);
        self.sockets.send(Box::new(accepted)).unwrap();
        client
    }

    async fn next(&mut self) -> Served {
        within("a stream to a pod", self.served.recv())
            .await
            .expect("the harness lives")
    }

    async fn until(&mut self, what: &str, wanted: impl Fn(&Status) -> bool) -> Status {
        within(what, self.status.wait_for(wanted))
            .await
            .unwrap()
            .clone()
    }
}

async fn read_exactly(from: &mut (impl AsyncReadExt + Unpin), len: usize) -> Vec<u8> {
    let mut read = vec![0; len];
    within("the bytes", from.read_exact(&mut read))
        .await
        .unwrap();
    read
}

fn pod_target(name: &str) -> Config {
    config("", "pods", name, 8080, None)
}

#[tokio::test(start_paused = true)]
async fn bytes_pass_both_ways_and_are_counted_and_a_refused_port_closes_its_connection_alone() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    let status = forward.ready().await;
    assert_eq!(status.pod.as_deref(), Some("web-1"));
    assert_eq!(status.pod_port, Some(8080));

    let mut first = forward.client();
    first.write_all(b"hello").await.unwrap();
    let mut pod = forward.next().await;
    assert_eq!((pod.pod.as_str(), pod.port), ("web-1", 8080));
    assert_eq!(read_exactly(&mut pod.io, 5).await, b"hello");
    pod.io.write_all(b"world!").await.unwrap();
    assert_eq!(read_exactly(&mut first, 6).await, b"world!");
    let status = forward
        .until("the bytes are counted", |status| {
            status.sent == 5 && status.received == 6
        })
        .await;
    assert_eq!(status.connections, 1);

    let mut second = forward.client();
    let refused = forward.next().await;
    let text = "error forwarding port 8080 to pod web-1: connection refused";
    refused.error.send(text.to_owned()).unwrap();
    drop(refused.io);
    let mut left = Vec::new();
    within(
        "the refused connection closes",
        second.read_to_end(&mut left),
    )
    .await
    .unwrap();
    assert!(left.is_empty());
    let status = forward
        .until("the refusal is the failure", |status| {
            status.failure.is_some() && status.connections == 1
        })
        .await;
    assert_eq!(status.failure.as_deref(), Some(text));
    assert_eq!(status.state, ForwardState::Ready);

    first.write_all(b"again").await.unwrap();
    assert_eq!(read_exactly(&mut pod.io, 5).await, b"again");
}

#[tokio::test(start_paused = true)]
async fn the_clients_fin_leaves_the_pods_answer_and_a_silent_pods_connection_ends_after_a_second() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;

    let mut client = forward.client();
    client.write_all(b"request").await.unwrap();
    client.shutdown().await.unwrap();
    let mut pod = forward.next().await;
    assert_eq!(read_exactly(&mut pod.io, 7).await, b"request");
    let mut more = [0; 1];
    assert!(
        stays(Duration::from_millis(100), pod.io.read(&mut more)).await,
        "the pod is not told that the client's side is done"
    );
    assert_eq!(forward.renew.clients().usage().borrow().sessions.held, 1);

    tokio::time::sleep(Duration::from_millis(500)).await;
    pod.io.write_all(b"answer").await.unwrap();
    assert_eq!(read_exactly(&mut client, 6).await, b"answer");
    let answered = Instant::now();
    let mut left = Vec::new();
    within("the connection ends", client.read_to_end(&mut left))
        .await
        .unwrap();
    assert!(left.is_empty());
    let silent = answered.elapsed();
    assert!(
        silent >= Duration::from_secs(1) && silent < Duration::from_millis(1_300),
        "it ended after {silent:?} of silence"
    );
    forward
        .until("its place is released", |status| status.connections == 0)
        .await;
    assert_eq!(forward.renew.clients().usage().borrow().sessions.held, 0);
    drop(pod);

    let mut silent = forward.client();
    silent.shutdown().await.unwrap();
    let _quiet = forward.next().await;
    let closed = Instant::now();
    let mut left = Vec::new();
    within("the silent connection ends", silent.read_to_end(&mut left))
        .await
        .unwrap();
    let waited = closed.elapsed();
    assert!(
        waited >= Duration::from_secs(1) && waited < Duration::from_millis(1_300),
        "it ended after {waited:?}"
    );
    forward
        .until("its place is released", |status| status.connections == 0)
        .await;
    assert_eq!(forward.renew.clients().usage().borrow().sessions.held, 0);
}

fn behind_web(fake: &Fake, pods: &[(&str, bool)]) {
    for (name, _) in pods {
        fake.put("pods", pod_json(name, true, &[("http", 8080)]));
    }
    fake.put(
        "services",
        service_json(
            "web",
            &json!({ "ports": [{ "name": "http", "port": 80, "targetPort": "http" }] }),
        ),
    );
    let endpoints: Vec<Value> = pods
        .iter()
        .map(|(name, ready)| endpoint(name, Some(*ready), None))
        .collect();
    fake.put(
        "endpointslices",
        slice("web-1", "web", &endpoints, &[("http", 8080)]),
    );
}

fn two_pods(fake: &Fake) {
    behind_web(fake, &[("web-a", true), ("web-b", true)]);
}

fn service_target() -> Config {
    config("", "services", "web", 80, Some("http"))
}

#[tokio::test(start_paused = true)]
async fn every_connection_goes_to_one_pod_until_it_stops_being_ready() {
    let fake = Fake::default();
    two_pods(&fake);
    let mut forward = start(&fake, service_target(), false, Budgets::default());
    forward.ready().await;

    let mut open = Vec::new();
    for _ in 0..3 {
        let mut client = forward.client();
        client.write_all(b"x").await.unwrap();
        let served = forward.next().await;
        assert_eq!(served.pod, "web-a");
        open.push((client, served));
    }

    behind_web(&fake, &[("web-a", false), ("web-b", true)]);
    forward
        .until("web-b is the pod", |status| {
            status.pod.as_deref() == Some("web-b")
        })
        .await;
    let mut moved = forward.client();
    moved.write_all(b"x").await.unwrap();
    assert_eq!(forward.next().await.pod, "web-b");

    two_pods(&fake);
    assert!(
        stays(
            Duration::from_secs(5),
            forward
                .status
                .wait_for(|status| status.pod.as_deref() == Some("web-a"))
        )
        .await,
        "web-a is ready again, and web-b keeps the connections"
    );
    let mut later = forward.client();
    later.write_all(b"x").await.unwrap();
    assert_eq!(forward.next().await.pod, "web-b");

    for (client, served) in &mut open {
        served.io.write_all(b"still").await.unwrap();
        assert_eq!(read_exactly(client, 5).await, b"still");
    }
}

#[tokio::test(start_paused = true)]
async fn a_pod_that_fails_is_avoided_and_comes_back_after_its_backoff() {
    let fake = Fake::default();
    behind_web(&fake, &[("web-a", true), ("web-b", true), ("web-c", true)]);
    let mut forward = start(&fake, service_target(), false, Budgets::default());
    forward.ready().await;
    let mut open = forward.client();
    open.write_all(b"x").await.unwrap();
    let held = forward.next().await;
    assert_eq!(held.pod, "web-a");

    forward.pods.refuse("web-a", 500);
    let mut failed = forward.client();
    let mut left = Vec::new();
    within("the connection fails", failed.read_to_end(&mut left))
        .await
        .unwrap();
    forward
        .until("web-b is the pod", |status| {
            status.pod.as_deref() == Some("web-b") && status.state == ForwardState::Ready
        })
        .await;

    behind_web(&fake, &[("web-a", true), ("web-b", false), ("web-c", true)]);
    forward
        .until("web-c is the pod, web-a being avoided", |status| {
            status.pod.as_deref() == Some("web-c")
        })
        .await;

    forward.pods.allow("web-a");
    tokio::time::sleep(Duration::from_secs(3)).await;
    behind_web(&fake, &[("web-a", true), ("web-b", true), ("web-c", false)]);
    forward
        .until("web-a is the pod again", |status| {
            status.pod.as_deref() == Some("web-a")
        })
        .await;
    while forward.served.try_recv().is_ok() {}
    let mut back = forward.client();
    back.write_all(b"x").await.unwrap();
    assert_eq!(forward.next().await.pod, "web-a");
}

async fn seen(fake: &Fake, config: &Config) -> Seen {
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut watching = Watching::new(&hub, config).await.unwrap();
    within("the objects are listed", async {
        loop {
            let seen = watching.look(config);
            if !matches!(seen, Seen::Unlisted(_)) {
                return seen;
            }
            watching.changed().await;
        }
    })
    .await
}

fn candidates(seen: Seen) -> Vec<(String, u16)> {
    match seen {
        Seen::Listed { candidates, .. } => candidates
            .into_iter()
            .map(|Candidate { name, port, .. }| (name.to_string(), port))
            .collect(),
        Seen::Fault(error) => panic!("a fault: {error:?}"),
        Seen::Unlisted(_) | Seen::Refused(_) => panic!("unlisted or refused"),
    }
}

fn why(seen: Seen) -> String {
    match seen {
        Seen::Listed { candidates, why } => {
            assert!(candidates.is_empty(), "{candidates:?}");
            why
        }
        Seen::Fault(error) => panic!("a fault: {error:?}"),
        Seen::Unlisted(_) | Seen::Refused(_) => panic!("unlisted or refused"),
    }
}

#[tokio::test(start_paused = true)]
async fn a_service_s_named_target_port_is_each_pods_own() {
    let fake = Fake::default();
    fake.put(
        "services",
        service_json(
            "web",
            &json!({ "ports": [{ "name": "http", "port": 80, "targetPort": "web" }] }),
        ),
    );
    fake.put(
        "endpointslices",
        slice(
            "web-1",
            "web",
            &[endpoint("web-a", None, None)],
            &[("http", 8080)],
        ),
    );
    fake.put(
        "endpointslices",
        slice(
            "web-2",
            "web",
            &[endpoint("web-b", None, None)],
            &[("http", 9090)],
        ),
    );
    fake.put(
        "endpointslices",
        slice(
            "other-1",
            "other",
            &[endpoint("other-a", None, None)],
            &[("http", 1234)],
        ),
    );
    assert_eq!(
        candidates(seen(&fake, &service_target()).await),
        [("web-a".to_owned(), 8080), ("web-b".to_owned(), 9090)]
    );
}

#[tokio::test(start_paused = true)]
async fn a_dual_stack_pod_counts_once_and_what_cannot_serve_is_left_out() {
    let fake = Fake::default();
    fake.put(
        "services",
        service_json("web", &json!({ "ports": [{ "port": 80 }] })),
    );
    let ready = endpoint("web-a", Some(true), Some(false));
    fake.put(
        "endpointslices",
        slice("web-v4", "web", std::slice::from_ref(&ready), &[("", 8080)]),
    );
    let mut v6 = slice("web-v6", "web", &[ready], &[("", 8080)]);
    v6["addressType"] = json!("IPv6");
    fake.put("endpointslices", v6);
    fake.put(
        "endpointslices",
        slice(
            "web-more",
            "web",
            &[
                endpoint("web-b", Some(true), Some(true)),
                endpoint("web-c", Some(false), None),
                endpoint("web-d", None, None),
            ],
            &[("", 8080)],
        ),
    );
    let config = config("", "services", "web", 80, None);
    assert_eq!(
        candidates(seen(&fake, &config).await),
        [("web-a".to_owned(), 8080), ("web-d".to_owned(), 8080)]
    );
}

#[tokio::test(start_paused = true)]
async fn a_service_with_nothing_to_forward_to_says_why() {
    let fake = Fake::default();
    let config = config("", "services", "web", 80, None);
    fake.put(
        "services",
        service_json(
            "web",
            &json!({ "type": "ExternalName", "externalName": "db.example" }),
        ),
    );
    assert_eq!(
        why(seen(&fake, &config).await),
        "Service web is of type ExternalName: it names a DNS record and has no pod"
    );

    fake.put(
        "services",
        service_json("web", &json!({ "ports": [{ "port": 80 }] })),
    );
    assert_eq!(
        why(seen(&fake, &config).await),
        "no pod behind Service web is ready"
    );

    let mut address = endpoint("web-a", None, None);
    address["targetRef"] = json!({ "kind": "Node", "name": "node-1" });
    let bare = json!({ "addresses": ["192.0.2.7"] });
    fake.put(
        "endpointslices",
        slice("web-1", "web", &[address, bare], &[("", 8080)]),
    );
    assert_eq!(
        why(seen(&fake, &config).await),
        "the endpoints of Service web are not pods, and only a pod can be forwarded to"
    );

    fake.put(
        "endpointslices",
        slice(
            "web-1",
            "web",
            &[endpoint("web-a", Some(false), None)],
            &[("", 8080)],
        ),
    );
    assert_eq!(
        why(seen(&fake, &config).await),
        "no pod behind Service web is ready"
    );

    fake.put(
        "endpointslices",
        slice(
            "web-1",
            "web",
            &[endpoint("web-a", None, None)],
            &[("other", 8080)],
        ),
    );
    assert_eq!(
        why(seen(&fake, &config).await),
        "no ready pod behind Service web has its unnamed port"
    );
}

#[tokio::test(start_paused = true)]
async fn a_service_that_is_gone_is_a_fault() {
    let fake = Fake::default();
    let config = config("", "services", "web", 80, None);
    let Seen::Fault(cause) = seen(&fake, &config).await else {
        panic!("a Service that does not exist is a fault");
    };
    assert!(cause.is_gone());
    assert_eq!(cause.error().kind, ErrorKind::NotFound);
    assert_eq!(cause.error().message, "Service web is gone");
}

fn owned(mut pod: Value, owner: &str) -> Value {
    pod["metadata"]["ownerReferences"] = json!([{
        "apiVersion": "apps/v1",
        "kind": "ReplicaSet",
        "name": owner,
        "uid": format!("uid-{owner}"),
        "controller": true,
    }]);
    pod
}

fn deployment(fake: &Fake) {
    fake.put(
        "deployments",
        json!({
            "kind": "Deployment",
            "apiVersion": "apps/v1",
            "metadata": { "name": "api", "uid": "uid-api" },
            "spec": {},
        }),
    );
    for (name, owner) in [("api-1", "api"), ("other-1", "other")] {
        fake.put(
            "replicasets",
            json!({
                "kind": "ReplicaSet",
                "apiVersion": "apps/v1",
                "metadata": {
                    "name": name,
                    "uid": format!("uid-{name}"),
                    "ownerReferences": [{
                        "apiVersion": "apps/v1",
                        "kind": "Deployment",
                        "name": owner,
                        "uid": format!("uid-{owner}"),
                        "controller": true,
                    }],
                },
            }),
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_workload_s_ready_pods_come_through_its_replica_sets_with_their_own_named_ports() {
    let fake = Fake::default();
    deployment(&fake);
    fake.put(
        "pods",
        owned(pod_json("api-1-x", true, &[("metrics", 9100)]), "api-1"),
    );
    fake.put(
        "pods",
        owned(pod_json("api-1-y", true, &[("metrics", 9101)]), "api-1"),
    );
    fake.put(
        "pods",
        owned(pod_json("api-1-z", false, &[("metrics", 9100)]), "api-1"),
    );
    let mut going = owned(pod_json("api-1-w", true, &[("metrics", 9100)]), "api-1");
    going["metadata"]["deletionTimestamp"] = json!("2026-11-11T10:00:00Z");
    fake.put("pods", going);
    fake.put(
        "pods",
        owned(pod_json("api-1-v", true, &[("http", 8080)]), "api-1"),
    );
    fake.put(
        "pods",
        owned(pod_json("other-1-x", true, &[("metrics", 9100)]), "other-1"),
    );
    fake.put("pods", pod_json("loose", true, &[("metrics", 9100)]));

    let named = config("apps", "deployments", "api", 9100, Some("metrics"));
    assert_eq!(
        candidates(seen(&fake, &named).await),
        [("api-1-x".to_owned(), 9100), ("api-1-y".to_owned(), 9101)]
    );
    let numbered = config("apps", "deployments", "api", 8080, None);
    assert_eq!(
        candidates(seen(&fake, &numbered).await),
        [
            ("api-1-v".to_owned(), 8080),
            ("api-1-x".to_owned(), 8080),
            ("api-1-y".to_owned(), 8080)
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn with_a_budget_of_two_a_third_connection_waits_and_goes_when_one_closes() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let budgets = Budgets {
        sessions: 2,
        ..Budgets::default()
    };
    let mut forward = start(&fake, pod_target("web-1"), false, budgets);
    forward.ready().await;

    let mut clients = Vec::new();
    let mut pods = Vec::new();
    for _ in 0..2 {
        let mut client = forward.client();
        client.write_all(b"x").await.unwrap();
        pods.push(forward.next().await);
        clients.push(client);
    }
    let mut third = forward.client();
    third.write_all(b"third").await.unwrap();
    let status = forward
        .until("the third waits", |status| status.queued == 1)
        .await;
    assert_eq!(status.connections, 3);
    assert!(
        stays(Duration::from_secs(5), forward.served.recv()).await,
        "it opens no stream while it waits"
    );

    drop(pods.remove(0));
    let mut served = forward.next().await;
    assert_eq!(read_exactly(&mut served.io, 5).await, b"third");
    let status = forward
        .until("the third is placed", |status| status.queued == 0)
        .await;
    assert_eq!(status.connections, 2);
}

#[tokio::test(start_paused = true)]
async fn a_forward_that_never_worked_fails_at_once_and_closes_what_it_accepts() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), true, Budgets::default());
    forward.pods.refuse("web-1", 500);
    assert_eq!(forward.status.borrow().state, ForwardState::Restored);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(fake.watching(), 0, "a restored forward asks nothing");

    let mut first = forward.client();
    let failed = forward
        .state("the forward fails", |state| {
            matches!(state, ForwardState::Failed { .. })
        })
        .await;
    let ForwardState::Failed { error } = failed.state else {
        unreachable!("waited for");
    };
    assert_eq!(error.kind, ErrorKind::Unavailable);
    assert_eq!(error.message, "the upgrade to web-1 was refused with 500");
    let mut left = Vec::new();
    within("its connection closes", first.read_to_end(&mut left))
        .await
        .unwrap();

    let before = forward.pods.connects().len();
    let mut second = forward.client();
    left.clear();
    within("a second closes at once", second.read_to_end(&mut left))
        .await
        .unwrap();
    assert_eq!(forward.pods.connects().len(), before, "it reached no pod");

    forward.pods.allow("web-1");
    forward.forward.restart();
    forward.ready().await;
}

#[tokio::test(start_paused = true)]
async fn a_port_nobody_listens_on_fails_a_forward_that_never_worked() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    let probe = forward.next().await;
    let text = "error forwarding port 8080 to pod web-1: connection refused";
    probe.error.send(text.to_owned()).unwrap();
    drop(probe.io);
    let status = forward
        .state("the forward fails", |state| {
            matches!(state, ForwardState::Failed { .. })
        })
        .await;
    assert_eq!(
        status.state,
        ForwardState::Failed {
            error: IpcError::new(ErrorKind::Unavailable, text)
        }
    );
    assert_eq!(status.failure.as_deref(), Some(text));
}

#[tokio::test(start_paused = true)]
async fn a_forward_that_worked_reconnects_when_its_pod_is_not_found_and_fails_when_forbidden() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;

    forward.pods.refuse("web-1", 404);
    let mut client = forward.client();
    let status = forward
        .state("the forward reconnects", |state| {
            matches!(state, ForwardState::Reconnecting { .. })
        })
        .await;
    assert_eq!(
        status.state,
        ForwardState::Reconnecting {
            reason: "the upgrade to web-1 was refused with 404".to_owned()
        }
    );
    assert_eq!(
        status.failure.as_deref(),
        Some("the upgrade to web-1 was refused with 404")
    );
    let mut left = Vec::new();
    within("its connection closes", client.read_to_end(&mut left))
        .await
        .unwrap();

    forward.pods.allow("web-1");
    let _again = forward.client();
    forward.ready().await;

    forward.pods.refuse("web-1", 403);
    let mut client = forward.client();
    let failed = forward
        .state("the forward fails", |state| {
            matches!(state, ForwardState::Failed { .. })
        })
        .await;
    let ForwardState::Failed { error } = failed.state else {
        unreachable!("waited for");
    };
    assert_eq!(error.kind, ErrorKind::Forbidden);
    left.clear();
    within("its connection closes", client.read_to_end(&mut left))
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_forward_with_no_pod_to_go_to_fails_after_the_wait() {
    let fake = Fake::default();
    fake.put(
        "services",
        service_json("web", &json!({ "ports": [{ "port": 80 }] })),
    );
    let mut forward = start(
        &fake,
        config("", "services", "web", 80, None),
        false,
        Budgets::default(),
    );
    let began = Instant::now();
    let status = forward
        .state("the forward fails", |state| {
            matches!(state, ForwardState::Failed { .. })
        })
        .await;
    assert_eq!(
        status.state,
        ForwardState::Failed {
            error: IpcError::new(ErrorKind::Unavailable, "no pod behind Service web is ready")
        }
    );
    assert_eq!(began.elapsed(), Duration::from_secs(20));
}

#[tokio::test(start_paused = true)]
async fn a_forward_that_worked_waits_for_a_pod_that_is_ready_again() {
    let fake = Fake::default();
    two_pods(&fake);
    let mut forward = start(&fake, service_target(), false, Budgets::default());
    forward.ready().await;
    let mut open = forward.client();
    open.write_all(b"x").await.unwrap();
    let _pod = forward.next().await;

    fake.put(
        "endpointslices",
        slice("web-1", "web", &[], &[("http", 8080)]),
    );
    let status = forward
        .state("the forward waits", |state| {
            matches!(state, ForwardState::Reconnecting { .. })
        })
        .await;
    assert_eq!(
        status.state,
        ForwardState::Reconnecting {
            reason: "no pod behind Service web is ready".to_owned()
        }
    );

    let mut waiting = forward.client();
    waiting.write_all(b"waiting").await.unwrap();
    assert!(
        stays(Duration::from_secs(5), forward.served.recv()).await,
        "it waits for a pod"
    );

    two_pods(&fake);
    forward
        .state("the forward is ready", |state| {
            *state == ForwardState::Ready
        })
        .await;
    loop {
        let mut served = forward.next().await;
        assert_eq!(served.pod, "web-a");
        let mut sent = [0; 7];
        let read = served.io.read_exact(&mut sent);
        if tokio::time::timeout(Duration::from_millis(100), read)
            .await
            .is_ok_and(|read| read.is_ok())
        {
            assert_eq!(&sent, b"waiting");
            break;
        }
    }
}

async fn ends_the_connection_and_recovers(end: impl FnOnce(&Harness)) {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let _pod = forward.next().await;

    end(&forward);
    let mut left = Vec::new();
    within("the connection ends", client.read_to_end(&mut left))
        .await
        .unwrap();
    forward
        .state("the forward reconnects", |state| {
            matches!(state, ForwardState::Reconnecting { .. })
        })
        .await;
    wakes_and_serves(&mut forward, b"again").await;
}

#[tokio::test(start_paused = true)]
async fn clients_that_are_replaced_end_the_connections_and_the_forward_reconnects() {
    ends_the_connection_and_recovers(|forward| forward.renew.replace()).await;
}

#[tokio::test(start_paused = true)]
async fn a_wake_ends_the_connections_and_the_forward_reconnects() {
    ends_the_connection_and_recovers(|forward| forward.renew.clients().connections().wake()).await;
}

#[tokio::test(start_paused = true)]
async fn the_subscriptions_last_only_as_long_as_the_forward_needs_them() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), true, Budgets::default());
    assert_eq!(forward.hub.subscribers("pods"), 0);

    forward.forward.restart();
    forward.ready().await;
    assert_eq!(
        forward.hub.subscribers("pods"),
        0,
        "ready with no connections watches nothing"
    );

    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let _pod = forward.next().await;
    assert_eq!(forward.hub.subscribers("pods"), 1);
    drop(client);
    drop(_pod);
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
    tokio::task::yield_now().await;
    assert_eq!(forward.hub.subscribers("pods"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_target_that_is_gone_fails_the_forward_with_its_name() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let _pod = forward.next().await;

    fake.remove("pods", "web-1");
    let status = forward
        .state("the forward fails", |state| {
            matches!(state, ForwardState::Failed { .. })
        })
        .await;
    assert_eq!(
        status.state,
        ForwardState::Failed {
            error: IpcError::new(ErrorKind::NotFound, "Pod web-1 is gone")
        }
    );
}

#[tokio::test(start_paused = true)]
async fn a_lifted_refusal_returns_a_restored_forward_to_waiting_and_a_started_one_to_starting() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut restored = start(&fake, pod_target("web-1"), true, Budgets::default());
    let refusal = IpcError::new(ErrorKind::Permissions, "the context is read-only");
    for round in 0..20 {
        restored.forward.refuse(refusal.clone());
        restored.state("the forward fails", is_failed).await;
        let _arrived = restored.client();
        restored.forward.allow();
        restored
            .state("the forward waits", |state| {
                *state == ForwardState::Restored
            })
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            restored.status.borrow().state,
            ForwardState::Restored,
            "round {round}: a connection that came while it failed does not start it"
        );
    }
    assert_eq!(fake.watching(), 0, "it asked nothing");

    let mut started = start(&fake, pod_target("web-1"), false, Budgets::default());
    started.ready().await;
    started.forward.refuse(refusal);
    started.state("the forward fails", is_failed).await;
    started.forward.allow();
    started.ready().await;
}

#[tokio::test(start_paused = true)]
async fn a_forward_says_whether_it_waits_for_its_first_connection_also_when_it_is_refused() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let refusal = IpcError::new(ErrorKind::Permissions, "the context is read-only");

    let mut restored = start(&fake, pod_target("web-1"), true, Budgets::default());
    assert!(restored.forward.waits());
    restored.forward.refuse(refusal.clone());
    restored.state("the forward fails", is_failed).await;
    assert!(restored.forward.waits());
    restored.forward.allow();
    restored
        .state("the forward waits", |state| {
            *state == ForwardState::Restored
        })
        .await;
    assert!(restored.forward.waits());
    let _client = restored.client();
    restored.ready().await;
    assert!(!restored.forward.waits());

    let mut started = start(&fake, pod_target("web-1"), false, Budgets::default());
    assert!(!started.forward.waits());
    started.ready().await;
    started.forward.refuse(refusal);
    started.state("the forward fails", is_failed).await;
    assert!(!started.forward.waits());
}

#[tokio::test(start_paused = true)]
async fn the_bytes_a_forward_carried_are_known_before_its_status_publishes_them() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut client = forward.client();
    client.write_all(b"hello").await.unwrap();
    let mut pod = forward.next().await;
    assert_eq!(read_exactly(&mut pod.io, 5).await, b"hello");
    pod.io.write_all(b"world!").await.unwrap();
    assert_eq!(read_exactly(&mut client, 6).await, b"world!");
    assert_eq!(forward.forward.bytes(), (5, 6));
}

#[tokio::test(start_paused = true)]
async fn a_refusal_ends_the_connections_and_a_restart_starts_over() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let _pod = forward.next().await;

    let refusal = IpcError::new(ErrorKind::Permissions, "the context is read-only");
    forward.forward.refuse(refusal.clone());
    let mut left = Vec::new();
    within("the connection ends", client.read_to_end(&mut left))
        .await
        .unwrap();
    let status = forward
        .state("the forward fails", |state| {
            matches!(state, ForwardState::Failed { .. })
        })
        .await;
    assert_eq!(status.state, ForwardState::Failed { error: refusal });
    let mut closed = forward.client();
    left.clear();
    within("a new one closes at once", closed.read_to_end(&mut left))
        .await
        .unwrap();

    forward.forward.restart();
    forward.ready().await;
}

const UNANSWERED: &str = "the cluster does not answer";

fn is_failed(state: &ForwardState) -> bool {
    matches!(state, ForwardState::Failed { .. })
}

fn is_reconnecting(state: &ForwardState) -> bool {
    matches!(state, ForwardState::Reconnecting { .. })
}

#[tokio::test(start_paused = true)]
async fn a_client_that_reads_slowly_after_its_fin_still_gets_the_whole_answer() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;

    let mut client = forward.client();
    client.write_all(b"request").await.unwrap();
    client.shutdown().await.unwrap();
    let mut pod = forward.next().await;
    assert_eq!(read_exactly(&mut pod.io, 7).await, b"request");
    let answer: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let sending = tokio::spawn({
        let answer = answer.clone();
        async move {
            pod.io.write_all(&answer).await.unwrap();
            pod
        }
    });
    let mut got = Vec::new();
    let mut buffer = [0; 16 * 1024];
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let read = within("the answer", client.read(&mut buffer))
            .await
            .unwrap();
        if read == 0 {
            break;
        }
        got.extend_from_slice(&buffer[..read]);
    }
    assert_eq!(got.len(), answer.len());
    assert!(got == answer, "the answer arrived whole and in order");
    drop(sending.await.unwrap());
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_waits_for_a_place_ends_when_its_client_leaves_and_keeps_what_it_was_sent()
 {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let budgets = Budgets {
        sessions: 1,
        ..Budgets::default()
    };
    let mut forward = start(&fake, pod_target("web-1"), false, budgets);
    forward.ready().await;
    let mut first = forward.client();
    first.write_all(b"x").await.unwrap();
    let held = forward.next().await;

    let gone = forward.client();
    forward
        .until("the second waits", |status| status.queued == 1)
        .await;
    drop(gone);
    let status = forward
        .until("it waits no more", |status| status.queued == 0)
        .await;
    assert_eq!(status.connections, 1);

    let mut asked = forward.client();
    asked.write_all(b"asked").await.unwrap();
    asked.shutdown().await.unwrap();
    forward
        .until("the next waits", |status| status.queued == 1)
        .await;
    first.shutdown().await.unwrap();
    drop(first);
    drop(held);
    let mut served = forward.next().await;
    assert_eq!(read_exactly(&mut served.io, 5).await, b"asked");
    assert!(
        stays(Duration::from_secs(5), forward.served.recv()).await,
        "no stream was opened for the client that left"
    );
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_waits_for_a_pod_ends_when_its_client_leaves() {
    let fake = Fake::default();
    two_pods(&fake);
    let mut forward = start(&fake, service_target(), false, Budgets::default());
    forward.ready().await;
    let mut open = forward.client();
    open.write_all(b"x").await.unwrap();
    let _pod = forward.next().await;
    fake.put(
        "endpointslices",
        slice("web-1", "web", &[], &[("http", 8080)]),
    );
    forward.state("the forward waits", is_reconnecting).await;

    let began = Instant::now();
    let waiting = forward.client();
    forward
        .until("it waits for a pod", |status| status.connections == 2)
        .await;
    drop(waiting);
    forward
        .until("it ends", |status| status.connections == 1)
        .await;
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
}

#[tokio::test(start_paused = true)]
async fn a_pod_made_again_under_its_name_is_the_same_target_for_the_next_connection() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let pod = forward.next().await;

    fake.remove("pods", "web-1");
    forward.state("the forward fails", is_failed).await;
    drop(client);
    drop(pod);
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
    let mut again = pod_json("web-1", true, &[("http", 8080)]);
    again["metadata"]["uid"] = json!("another-uid");
    fake.put("pods", again);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        is_failed(&forward.status.borrow().state),
        "a forward that nobody uses watches nothing"
    );

    let mut next = forward.client();
    next.write_all(b"hello").await.unwrap();
    forward
        .state("the forward is ready", |state| {
            *state == ForwardState::Ready
        })
        .await;
    loop {
        let mut served = forward.next().await;
        let mut sent = [0; 5];
        let read = served.io.read_exact(&mut sent);
        if tokio::time::timeout(Duration::from_millis(100), read)
            .await
            .is_ok_and(|read| read.is_ok())
        {
            assert_eq!(&sent, b"hello");
            break;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_failure_ends_the_connections_that_are_open() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let _pod = forward.next().await;

    fake.remove("pods", "web-1");
    forward.state("the forward fails", is_failed).await;
    let mut left = Vec::new();
    within("the open connection ends", client.read_to_end(&mut left))
        .await
        .unwrap();
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_cluster_that_does_not_answer_fails_a_forward_that_never_worked_in_those_words() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    fake.set_offline(true);
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    let began = Instant::now();
    let status = forward.state("the forward fails", is_failed).await;
    assert_eq!(
        status.state,
        ForwardState::Failed {
            error: IpcError::new(ErrorKind::Unavailable, UNANSWERED)
        }
    );
    assert_eq!(began.elapsed(), Duration::from_secs(20));
}

#[tokio::test(start_paused = true)]
async fn a_cluster_that_stops_answering_is_the_reason_of_a_forward_that_worked_and_of_its_connection()
 {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    tokio::task::yield_now().await;
    assert_eq!(forward.hub.subscribers("pods"), 0);
    tokio::time::sleep(LINGER + Duration::from_secs(1)).await;

    fake.set_offline(true);
    let _client = forward.client();
    let status = forward
        .until("the connection gave up", |status| status.failure.is_some())
        .await;
    assert_eq!(status.failure.as_deref(), Some(UNANSWERED));
    assert_eq!(
        status.state,
        ForwardState::Reconnecting {
            reason: UNANSWERED.to_owned()
        }
    );

    fake.set_offline(false);
    let mut again = forward.client();
    again.write_all(b"back").await.unwrap();
    forward
        .state("the forward is ready", |state| {
            *state == ForwardState::Ready
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_serves_proves_a_forward_whose_own_connections_fill_the_budget() {
    let fake = Fake::default();
    two_pods(&fake);
    let budgets = Budgets {
        sessions: 2,
        ..Budgets::default()
    };
    let mut forward = start(&fake, service_target(), false, budgets);
    forward.ready().await;
    let mut clients = Vec::new();
    let mut pods = Vec::new();
    for _ in 0..2 {
        let mut client = forward.client();
        client.write_all(b"x").await.unwrap();
        let mut pod = forward.next().await;
        pod.io.write_all(b"y").await.unwrap();
        assert_eq!(read_exactly(&mut client, 1).await, b"y");
        clients.push(client);
        pods.push(pod);
    }
    fake.put(
        "endpointslices",
        slice("web-1", "web", &[], &[("http", 8080)]),
    );
    forward.state("the forward waits", is_reconnecting).await;
    two_pods(&fake);
    forward
        .until("the forward looks again", |status| {
            is_reconnecting(&status.state) && status.pod.is_some()
        })
        .await;

    tokio::time::sleep(Duration::from_secs(1)).await;
    pods[0].io.write_all(b"more").await.unwrap();
    assert_eq!(read_exactly(&mut clients[0], 4).await, b"more");
    forward
        .state("the bytes prove the forward", |state| {
            *state == ForwardState::Ready
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_forward_whose_probe_finds_every_session_taken_says_so_after_a_while() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let budgets = Budgets {
        sessions: 1,
        ..Budgets::default()
    };
    let (hub, renew) = fake.renewing(budgets);
    let _taken = renew
        .clients()
        .admit_session(twigo_kube::client::Actor::Ui, None)
        .await;
    let (pods, _served) = Pods::new();
    let (_sockets, accepted) = mpsc::unbounded_channel();
    let forward = Forward::spawn_with(
        hub,
        pod_target("web-1"),
        accepted,
        (Vec::new(), None),
        false,
        Arc::new(pods),
    );
    let mut status = forward.status();
    let began = Instant::now();
    let failed = within(
        "the forward fails",
        status.wait_for(|status| is_failed(&status.state)),
    )
    .await
    .unwrap()
    .clone();
    assert_eq!(
        failed.state,
        ForwardState::Failed {
            error: IpcError::new(
                ErrorKind::Timeout,
                "every session of this context stayed in use"
            )
        }
    );
    assert_eq!(began.elapsed(), Duration::from_secs(15));
}

#[tokio::test(start_paused = true)]
async fn the_hub_s_errors_make_a_forward_that_worked_reconnect_and_fail_one_that_never_did() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let _pod = forward.next().await;

    fake.forbid("pods", true);
    fake.end_watches();
    let status = forward
        .state("the forward reconnects", is_reconnecting)
        .await;
    assert_eq!(
        status.state,
        ForwardState::Reconnecting {
            reason: "you may not watch pods".to_owned()
        }
    );
    fake.forbid("pods", false);
    forward
        .state("the forward is ready again", |state| {
            *state == ForwardState::Ready
        })
        .await;

    let mut never = start(&fake, pod_target("web-1"), false, Budgets::default());
    fake.forbid("pods", true);
    never.state("the forward fails", is_failed).await;
}

async fn refuse_a_port(forward: &mut Harness) -> String {
    let _client = forward.client();
    let refused = forward.next().await;
    let text = "error forwarding port 8080: connection refused";
    refused.error.send(text.to_owned()).unwrap();
    forward
        .until("the refusal is the failure", |status| {
            status.failure.as_deref() == Some(text)
        })
        .await;
    text.to_owned()
}

#[tokio::test(start_paused = true)]
async fn a_failure_goes_when_a_connection_opened_after_it_carries_bytes_and_not_before() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut before = forward.client();
    before.write_all(b"x").await.unwrap();
    let mut before_pod = forward.next().await;

    let text = refuse_a_port(&mut forward).await;

    before_pod.io.write_all(b"late").await.unwrap();
    assert_eq!(read_exactly(&mut before, 4).await, b"late");
    let mut quiet = forward.client();
    quiet.write_all(b"y").await.unwrap();
    let mut quiet_pod = forward.next().await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let status = forward.status.borrow().clone();
    assert_eq!(status.state, ForwardState::Ready);
    assert_eq!(
        status.failure.as_deref(),
        Some(text.as_str()),
        "a connection opened before it, or one that carried nothing, leaves it"
    );

    quiet_pod.io.write_all(b"fine").await.unwrap();
    assert_eq!(read_exactly(&mut quiet, 4).await, b"fine");
    let status = forward
        .until("the failure goes", |status| status.failure.is_none())
        .await;
    assert_eq!(status.state, ForwardState::Ready);
}

#[tokio::test(start_paused = true)]
async fn a_failure_goes_when_the_forward_is_ready_again_after_not_being_so() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    refuse_a_port(&mut forward).await;

    forward.pods.refuse("web-1", 404);
    let _fails = forward.client();
    forward
        .state("the forward reconnects", is_reconnecting)
        .await;
    forward.pods.allow("web-1");
    let _again = forward.client();
    let status = forward.ready().await;
    assert_eq!(status.failure, None);
}

#[tokio::test(start_paused = true)]
async fn the_error_channel_s_text_ends_the_connection_after_what_the_pod_sent_is_written() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let mut pod = forward.next().await;

    let sent = vec![7u8; 40_000];
    pod.io.write_all(&sent).await.unwrap();
    let text = "error forwarding port 8080 to pod web-1: connection reset";
    pod.error.send(text.to_owned()).unwrap();
    let mut got = Vec::new();
    within("the connection ends", client.read_to_end(&mut got))
        .await
        .unwrap();
    assert_eq!(got.len(), sent.len(), "what the pod sent first arrived");
    let status = forward
        .until("the text is the failure", |status| status.failure.is_some())
        .await;
    assert_eq!(status.failure.as_deref(), Some(text));
    drop(pod.io);
}

#[tokio::test(start_paused = true)]
async fn a_forward_is_not_ready_when_the_last_pod_left_while_its_first_stream_was_open() {
    let fake = Fake::default();
    behind_web(&fake, &[("web-a", true)]);
    let mut forward = start(&fake, service_target(), false, Budgets::default());
    let _probe = forward.next().await;
    behind_web(&fake, &[("web-a", false)]);
    forward
        .state("the forward waits", |state| {
            is_reconnecting(state) || *state == ForwardState::Ready
        })
        .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let status = forward.status.borrow().clone();
    assert_eq!(
        status.state,
        ForwardState::Reconnecting {
            reason: "no pod behind Service web is ready".to_owned()
        },
        "it was {:?} when it first changed",
        status.state
    );
}

#[tokio::test(start_paused = true)]
async fn a_forward_that_waits_for_a_pod_with_no_connection_lets_its_subscriptions_go() {
    let fake = Fake::default();
    two_pods(&fake);
    let mut forward = start(&fake, service_target(), false, Budgets::default());
    forward.ready().await;
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let pod = forward.next().await;
    fake.put(
        "endpointslices",
        slice("web-1", "web", &[], &[("http", 8080)]),
    );
    forward.state("the forward waits", is_reconnecting).await;
    assert_eq!(forward.hub.subscribers("endpointslices"), 1);

    drop(client);
    drop(pod);
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
    tokio::task::yield_now().await;
    assert_eq!(forward.hub.subscribers("endpointslices"), 0);
    assert_eq!(forward.hub.subscribers("services"), 0);
    assert_eq!(
        forward.status.borrow().state,
        ForwardState::Reconnecting {
            reason: "no pod behind Service web is ready".to_owned()
        },
        "it still says why it waits"
    );

    two_pods(&fake);
    let mut back = forward.client();
    back.write_all(b"again").await.unwrap();
    forward
        .state("the forward is ready", |state| {
            *state == ForwardState::Ready
        })
        .await;
}

fn not_running(name: &str) -> Value {
    let mut pod = pod_json(name, false, &[("http", 8080)]);
    pod["status"] = json!({ "phase": "Pending" });
    pod
}

async fn gone_and_idle(forward: &mut Harness, fake: &Fake) {
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let served = forward.next().await;
    fake.remove("pods", "web-1");
    forward.state("the forward fails", is_failed).await;
    drop((client, served));
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
    tokio::task::yield_now().await;
}

async fn reaches_the_pod(forward: &mut Harness, sent: &[u8]) {
    loop {
        let mut served = forward.next().await;
        let mut got = vec![0; sent.len()];
        let read = served.io.read_exact(&mut got);
        if tokio::time::timeout(Duration::from_millis(100), read)
            .await
            .is_ok_and(|read| read.is_ok())
        {
            assert_eq!(got, sent);
            return;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_pod_made_again_and_not_running_yet_makes_a_forward_wait_and_the_connection_goes_on() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    gone_and_idle(&mut forward, &fake).await;
    fake.put("pods", not_running("web-1"));

    let mut client = forward.client();
    client.write_all(b"hello").await.unwrap();
    let status = forward.state("the forward waits", is_reconnecting).await;
    assert_eq!(
        status.state,
        ForwardState::Reconnecting {
            reason: "Pod web-1 is not running yet".to_owned()
        }
    );

    tokio::time::sleep(Duration::from_secs(5)).await;
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    forward
        .state("the forward is ready", |state| {
            *state == ForwardState::Ready
        })
        .await;
    reaches_the_pod(&mut forward, b"hello").await;
}

#[tokio::test(start_paused = true)]
async fn a_pod_made_again_that_refuses_makes_a_forward_wait_and_not_fail_for_good() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    gone_and_idle(&mut forward, &fake).await;
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    forward.pods.refuse("web-1", 500);

    let mut client = forward.client();
    forward.state("the forward waits", is_reconnecting).await;
    let mut left = Vec::new();
    within("its connection closes", client.read_to_end(&mut left))
        .await
        .unwrap();

    forward.pods.allow("web-1");
    let mut again = forward.client();
    again.write_all(b"hello").await.unwrap();
    forward
        .state("the forward is ready", |state| {
            *state == ForwardState::Ready
        })
        .await;
    reaches_the_pod(&mut forward, b"hello").await;
}

#[tokio::test(start_paused = true)]
async fn a_pod_that_does_not_run_yet_is_no_candidate() {
    let fake = Fake::default();
    fake.put("pods", not_running("web-1"));
    assert_eq!(
        why(seen(&fake, &pod_target("web-1")).await),
        "Pod web-1 is not running yet"
    );
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    assert_eq!(
        candidates(seen(&fake, &pod_target("web-1")).await),
        [("web-1".to_owned(), 8080)]
    );
}

#[tokio::test(start_paused = true)]
async fn a_client_that_arrives_while_the_cut_connections_close_does_not_lose_that_the_pod_is_gone()
{
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    for round in 0..20 {
        forward.ready().await;
        let mut open = forward.client();
        open.write_all(b"x").await.unwrap();
        let _served = forward.next().await;
        let arrives = tokio::spawn({
            let (sockets, mut status) = (forward.sockets.clone(), forward.status.clone());
            async move {
                status
                    .wait_for(|status| is_failed(&status.state))
                    .await
                    .unwrap();
                let (client, accepted) = tokio::io::duplex(64 * 1024);
                sockets.send(Box::new(accepted)).unwrap();
                client
            }
        });
        fake.remove("pods", "web-1");
        let _arrives = within("the client arrives", arrives).await.unwrap();
        fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
        tokio::time::sleep(Duration::from_secs(2)).await;

        let mut next = forward.client();
        next.write_all(b"again").await.unwrap();
        within(
            &format!("round {round}: the forward is ready again"),
            async {
                forward
                    .status
                    .wait_for(|status| status.state == ForwardState::Ready)
                    .await
                    .unwrap();
            },
        )
        .await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_context_the_clients_cannot_find_fails_a_forward_for_good() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut open = forward.client();
    open.write_all(b"x").await.unwrap();
    let held = forward.next().await;

    fake.set_no_context(true);
    let _lost = forward.client();
    let failed = forward.state("the forward fails", is_failed).await;
    fake.set_no_context(false);
    drop((open, held));
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
    tokio::task::yield_now().await;

    let before = forward.pods.connects().len();
    let mut next = forward.client();
    let mut left = Vec::new();
    within(
        "the next connection closes at once",
        next.read_to_end(&mut left),
    )
    .await
    .unwrap();
    assert_eq!(forward.pods.connects().len(), before, "it reached no pod");
    assert_eq!(forward.status.borrow().state, failed.state);
}

#[tokio::test(start_paused = true)]
async fn a_forward_that_worked_tries_again_only_while_it_has_a_connection() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut held = forward.client();
    held.write_all(b"x").await.unwrap();
    let held_pod = forward.next().await;

    forward.pods.refuse("web-1", 500);
    let mut client = forward.client();
    let waiting = forward.state("the forward waits", is_reconnecting).await;
    let mut left = Vec::new();
    within("its connection closes", client.read_to_end(&mut left))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(10)).await;
    let tries = forward.pods.connects().len();
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert!(
        forward.pods.connects().len() > tries,
        "it tries again while a connection is open"
    );

    drop((held, held_pod));
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
    tokio::time::sleep(Duration::from_secs(10)).await;
    let tries = forward.pods.connects().len();
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(forward.pods.connects().len(), tries, "it tried for nobody");
    assert_eq!(forward.hub.subscribers("pods"), 0, "and watched for nobody");
    assert_eq!(forward.status.borrow().state, waiting.state);

    forward.pods.allow("web-1");
    let mut again = forward.client();
    again.write_all(b"hello").await.unwrap();
    forward.ready().await;
}

#[tokio::test(start_paused = true)]
async fn a_forward_that_never_worked_fails_in_the_words_of_a_hub_that_has_no_stream_slot_to_give() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let budgets = Budgets {
        watches: 1,
        ..Budgets::default()
    };
    let (hub, _renew) = fake.renewing(budgets);
    let _taken = hub
        .object(
            "kind-test",
            gvr_resource("configmaps"),
            Some(NAMESPACE.to_owned()),
            "settings",
        )
        .unwrap();
    let (pods, _served) = Pods::new();
    let (_sockets, accepted) = mpsc::unbounded_channel();
    let forward = Forward::spawn_with(
        hub,
        pod_target("web-1"),
        accepted,
        (Vec::new(), None),
        false,
        Arc::new(pods),
    );
    let mut status = forward.status();
    let began = Instant::now();
    let failed = within(
        "the forward fails",
        status.wait_for(|status| is_failed(&status.state)),
    )
    .await
    .unwrap()
    .clone();
    assert_eq!(
        failed.state,
        ForwardState::Failed {
            error: IpcError::new(
                ErrorKind::Unavailable,
                "waiting for a stream slot of this context"
            )
        }
    );
    assert_eq!(began.elapsed(), Duration::from_secs(20));
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_finds_no_stream_slot_for_the_hub_says_so() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let budgets = Budgets {
        watches: 1,
        ..Budgets::default()
    };
    let mut forward = start(&fake, pod_target("web-1"), false, budgets);
    forward.ready().await;
    tokio::task::yield_now().await;
    tokio::time::sleep(LINGER + Duration::from_secs(1)).await;
    let _taken = forward
        .hub
        .object(
            "kind-test",
            gvr_resource("configmaps"),
            Some(NAMESPACE.to_owned()),
            "settings",
        )
        .unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;

    let _client = forward.client();
    let status = forward
        .until("the connection gave up", |status| status.failure.is_some())
        .await;
    assert_eq!(
        status.failure.as_deref(),
        Some("waiting for a stream slot of this context")
    );
    assert_eq!(
        status.state,
        ForwardState::Reconnecting {
            reason: "waiting for a stream slot of this context".to_owned()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn a_forward_that_never_worked_gives_up_on_a_cluster_that_is_still_connecting() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    fake.set_stalled(true);
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    let began = Instant::now();
    let status = forward.state("the forward fails", is_failed).await;
    assert_eq!(
        status.state,
        ForwardState::Failed {
            error: IpcError::new(ErrorKind::Unavailable, "the cluster has not answered yet")
        }
    );
    assert_eq!(began.elapsed(), Duration::from_secs(20));
}

async fn rests(forward: &Harness) {
    let tries = forward.pods.connects().len();
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(
        forward.pods.connects().len(),
        tries,
        "it opened a stream for nobody"
    );
    assert_eq!(forward.hub.subscribers("pods"), 0, "it watched for nobody");
}

async fn comes_and_leaves(forward: &mut Harness) {
    let mut client = forward.client();
    client.write_all(b"x").await.unwrap();
    let mut left = Vec::new();
    within("its connection closes", client.read_to_end(&mut left))
        .await
        .unwrap();
    drop(client);
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
}

async fn wakes_and_serves(forward: &mut Harness, sent: &[u8]) {
    let mut client = forward.client();
    client.write_all(sent).await.unwrap();
    forward
        .state("the forward is ready", |state| {
            *state == ForwardState::Ready
        })
        .await;
    reaches_the_pod(forward, sent).await;
}

#[tokio::test(start_paused = true)]
async fn a_forward_restarted_for_a_gone_target_rests_when_the_cluster_does_not_answer() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    gone_and_idle(&mut forward, &fake).await;
    tokio::time::sleep(LINGER + Duration::from_secs(1)).await;

    fake.set_stalled(true);
    comes_and_leaves(&mut forward).await;
    rests(&forward).await;

    fake.set_stalled(false);
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    wakes_and_serves(&mut forward, b"again").await;
}

#[tokio::test(start_paused = true)]
async fn a_forward_restarted_for_a_gone_target_rests_when_the_cluster_fails_its_request() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    gone_and_idle(&mut forward, &fake).await;
    tokio::time::sleep(LINGER + Duration::from_secs(1)).await;

    fake.set_times_out(true);
    comes_and_leaves(&mut forward).await;
    rests(&forward).await;

    fake.set_times_out(false);
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    wakes_and_serves(&mut forward, b"again").await;
}

async fn probing_with_a_connection_open(forward: &mut Harness) -> (DuplexStream, Served, Served) {
    forward.ready().await;
    let mut held = forward.client();
    held.write_all(b"x").await.unwrap();
    let held_pod = forward.next().await;
    forward.pods.refuse("web-1", 500);
    let mut failing = forward.client();
    forward.state("the forward waits", is_reconnecting).await;
    let mut left = Vec::new();
    within("its connection closes", failing.read_to_end(&mut left))
        .await
        .unwrap();
    forward.pods.allow("web-1");
    let probe = forward.next().await;
    (held, held_pod, probe)
}

#[tokio::test(start_paused = true)]
async fn a_probe_that_fails_after_the_last_connection_closed_is_not_followed_by_another() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    let (held, held_pod, probe) = probing_with_a_connection_open(&mut forward).await;

    drop((held, held_pod));
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
    forward.pods.refuse("web-1", 500);
    probe
        .error
        .send("error forwarding port 8080: connection refused".to_owned())
        .unwrap();
    tokio::time::sleep(Duration::from_secs(10)).await;
    rests(&forward).await;
    assert!(is_reconnecting(&forward.status.borrow().state));

    forward.pods.allow("web-1");
    wakes_and_serves(&mut forward, b"hello").await;
}

#[tokio::test(start_paused = true)]
async fn a_probe_that_is_lost_after_the_last_connection_closed_is_not_followed_by_another() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    let (held, held_pod, _probe) = probing_with_a_connection_open(&mut forward).await;

    drop((held, held_pod));
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
    forward.renew.clients().connections().wake();
    tokio::task::yield_now().await;
    rests(&forward).await;
    assert!(is_reconnecting(&forward.status.borrow().state));

    wakes_and_serves(&mut forward, b"hello").await;
}

async fn stays_failed(forward: &mut Harness) {
    let failed = forward.status.borrow().state.clone();
    assert!(is_failed(&failed));
    let seen = Arc::new(Mutex::new(vec![failed.clone()]));
    let watcher = tokio::spawn({
        let (mut status, seen) = (forward.status.clone(), Arc::clone(&seen));
        async move {
            while status.changed().await.is_ok() {
                let state = status.borrow().state.clone();
                seen.lock().unwrap().push(state);
            }
        }
    });
    let tries = forward.pods.connects().len();
    let mut client = forward.client();
    let mut left = Vec::new();
    within(
        "the client is closed at once",
        client.read_to_end(&mut left),
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_secs(5)).await;
    watcher.abort();
    assert_eq!(forward.pods.connects().len(), tries, "it reached a pod");
    for resource in ["pods", "services", "endpointslices"] {
        assert_eq!(
            forward.hub.subscribers(resource),
            0,
            "it watches {resource}"
        );
    }
    let seen = seen.lock().unwrap();
    assert!(
        seen.iter().all(|state| *state == failed),
        "it looked again: {seen:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_context_no_source_lists_fails_a_forward_that_never_worked_without_calling_its_target_gone()
 {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    fake.set_no_context(true);
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    let failed = forward.state("the forward fails", is_failed).await;
    let ForwardState::Failed { error } = failed.state else {
        unreachable!("waited for");
    };
    assert_eq!(error.kind, ErrorKind::NotFound);
    stays_failed(&mut forward).await;

    fake.set_no_context(false);
    tokio::time::sleep(LINGER).await;
    forward.forward.restart();
    forward.ready().await;
}

#[tokio::test(start_paused = true)]
async fn a_list_the_server_does_not_have_fails_a_forward_that_never_worked_without_calling_its_target_gone()
 {
    let fake = Fake::default();
    behind_web(&fake, &[("web-a", true)]);
    fake.miss("endpointslices");
    let mut forward = start(&fake, service_target(), false, Budgets::default());
    let failed = forward.state("the forward fails", is_failed).await;
    let ForwardState::Failed { error } = failed.state else {
        unreachable!("waited for");
    };
    assert_eq!(error.kind, ErrorKind::NotFound);
    stays_failed(&mut forward).await;
}

#[tokio::test(start_paused = true)]
async fn a_refusal_for_a_missing_context_is_not_a_gone_target() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    forward.forward.refuse(IpcError::new(
        ErrorKind::NotFound,
        "no source lists the context \"kind-test\"",
    ));
    forward.state("the forward fails", is_failed).await;
    stays_failed(&mut forward).await;
}

#[tokio::test(start_paused = true)]
async fn a_probe_that_finds_no_context_fails_the_forward_without_calling_its_target_gone() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;
    let mut held = forward.client();
    held.write_all(b"x").await.unwrap();
    let held_pod = forward.next().await;
    fake.put("pods", not_running("web-1"));
    forward.state("the forward waits", is_reconnecting).await;

    fake.set_no_context(true);
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let failed = forward.state("the probe fails it", is_failed).await;
    let ForwardState::Failed { error } = failed.state else {
        unreachable!("waited for");
    };
    assert_eq!(error.kind, ErrorKind::NotFound);
    fake.set_no_context(false);
    drop((held, held_pod));
    forward
        .until("it has no connections", |status| status.connections == 0)
        .await;
    stays_failed(&mut forward).await;
}

#[tokio::test(start_paused = true)]
async fn a_404_on_the_upgrade_fails_a_forward_that_never_worked_and_the_next_connection_looks_again()
 {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), true, Budgets::default());
    forward.pods.refuse("web-1", 404);
    forward.forward.restart();
    let failed = forward.state("the forward fails", is_failed).await;
    let ForwardState::Failed { error } = failed.state else {
        unreachable!("waited for");
    };
    assert_eq!(error.kind, ErrorKind::NotFound);

    forward.pods.allow("web-1");
    wakes_and_serves(&mut forward, b"again").await;
}

#[tokio::test(start_paused = true)]
async fn a_client_that_reads_slowly_after_its_fin_still_gets_what_the_pod_sends_after_the_read() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let mut forward = start(&fake, pod_target("web-1"), false, Budgets::default());
    forward.ready().await;

    let mut client = forward.client();
    client.write_all(b"request").await.unwrap();
    client.shutdown().await.unwrap();
    let mut pod = forward.next().await;
    assert_eq!(read_exactly(&mut pod.io, 7).await, b"request");
    let answer: Vec<u8> = (0..80 * 1024u32).map(|i| (i % 251) as u8).collect();
    pod.io.write_all(&answer).await.unwrap();

    tokio::time::sleep(Duration::from_secs(3)).await;
    let first = read_exactly(&mut client, 64 * 1024).await;
    assert!(first == answer[..64 * 1024], "the first 64 KiB, in order");
    tokio::time::sleep(Duration::from_millis(500)).await;
    pod.io.write_all(b"tail").await.unwrap();

    let mut rest = Vec::new();
    within("the connection ends", client.read_to_end(&mut rest))
        .await
        .unwrap();
    let mut wanted = answer[64 * 1024..].to_vec();
    wanted.extend_from_slice(b"tail");
    assert_eq!(rest.len(), wanted.len());
    assert!(rest == wanted, "the rest arrived, and the pod's last bytes");
}

#[tokio::test]
async fn a_taken_port_answers_in_use_with_the_next_free_one_which_then_binds() {
    let port = region();
    let _taken = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    let Err(BindError::Busy(why)) = listen(port).await else {
        panic!("a port another listener holds is busy");
    };
    assert_eq!(why, BusyWhy::InUse);

    let free = free_port(port).await.unwrap();
    assert_eq!(free, port + 1);
    let bound = listen(free).await.unwrap();
    assert_eq!(bound.port(), free);
}

#[tokio::test]
async fn both_loopbacks_bind_one_port_and_a_port_held_on_either_is_busy() {
    let v6_here = std::net::TcpListener::bind(("::1", 0)).is_ok();
    let listeners = listeners().await;
    let port = listeners.port();
    assert_eq!(listeners.v4.local_addr().unwrap().port(), port);
    assert_eq!(listeners.v6.is_some(), v6_here);
    if let Some(v6) = &listeners.v6 {
        assert_eq!(v6.local_addr().unwrap().port(), port);
        assert_eq!(listeners.addresses(), ["127.0.0.1", "::1"]);
        assert!(
            TcpStream::connect((Ipv6Addr::LOCALHOST, port))
                .await
                .is_ok()
        );
    }
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_ok());

    if v6_here {
        let held = std::net::TcpListener::bind(("::1", 0)).unwrap();
        let on_v6 = held.local_addr().unwrap().port();
        assert!(
            matches!(listen(on_v6).await, Err(BindError::Busy(BusyWhy::InUse))),
            "a port held on ::1 alone is busy"
        );
        assert!(free_port(on_v6 - 1).await.unwrap() > on_v6, "and not free");
    }
}

fn held_on_wildcards() -> Vec<(u16, std::net::TcpListener)> {
    let mut held = Vec::new();
    for wildcard in ["0.0.0.0", "::"] {
        let port = region();
        if let Ok(listener) = std::net::TcpListener::bind((wildcard, port)) {
            assert!(
                std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_ok(),
                "the listener on {wildcard} answers on 127.0.0.1"
            );
            held.push((port, listener));
        }
    }
    assert!(!held.is_empty(), "this machine has an IPv4 wildcard");
    held
}

#[tokio::test]
async fn a_port_held_on_a_wildcard_address_is_busy_and_not_offered_as_free() {
    let held = held_on_wildcards();
    for (port, _listener) in &held {
        assert!(
            matches!(listen(*port).await, Err(BindError::Busy(BusyWhy::InUse))),
            "port {port} is held on a wildcard"
        );
        let free = free_port(port - 1).await.unwrap();
        assert_ne!(free, *port);
        assert!(free > *port);
    }
}

#[tokio::test]
async fn a_port_binds_again_straight_after_a_forward_that_served_connections_closed_it() {
    let mut loopbacks = vec![std::net::IpAddr::from(Ipv4Addr::LOCALHOST)];
    if std::net::TcpListener::bind(("::1", 0)).is_ok() {
        loopbacks.push(Ipv6Addr::LOCALHOST.into());
    }
    let listeners = listeners().await;
    let port = listeners.port();
    let (mut sockets, accepting) = listeners.accept();
    let mut open = Vec::new();
    for (round, address) in loopbacks.iter().enumerate() {
        let mut client = TcpStream::connect((*address, port)).await.unwrap();
        let mut served = within("an accepted socket", sockets.recv()).await.unwrap();
        served.write_all(b"done").await.unwrap();
        served.shutdown().await.unwrap();
        drop(served);
        let mut answer = Vec::new();
        client.read_to_end(&mut answer).await.unwrap();
        assert_eq!(answer, b"done", "round {round}");
        drop(client);
        let held = TcpStream::connect((*address, port)).await.unwrap();
        open.push((
            held,
            within("an accepted socket", sockets.recv()).await.unwrap(),
        ));
    }

    drop(accepting);
    let again = listen(port)
        .await
        .unwrap_or_else(|error| panic!("port {port} binds again at once: {error:?}"));
    assert_eq!(again.port(), port);
    assert_eq!(again.addresses().len(), loopbacks.len());
}

#[tokio::test]
async fn a_dropped_forward_has_closed_its_port_when_the_drop_returns() {
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let (hub, _clients) = fake.hub(Budgets::default());
    let (pods, _served) = Pods::new();
    let listeners = listeners().await;
    let (port, addresses) = (listeners.port(), listeners.addresses());
    let (sockets, accepting) = listeners.accept();
    let forward = Forward::spawn_with(
        hub,
        pod_target("web-1"),
        sockets,
        (addresses, Some(accepting)),
        false,
        Arc::new(pods),
    );
    tokio::task::yield_now().await;

    drop(forward);
    assert!(
        std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok(),
        "the port is free as the forward is dropped"
    );
}

#[tokio::test]
async fn a_client_of_either_loopback_is_served_by_the_pod() {
    let v6_here = std::net::TcpListener::bind(("::1", 0)).is_ok();
    let fake = Fake::default();
    fake.put("pods", pod_json("web-1", true, &[("http", 8080)]));
    let (hub, _clients) = fake.hub(Budgets::default());
    let (pods, mut served) = Pods::new();
    let listeners = listeners().await;
    let (port, addresses) = (listeners.port(), listeners.addresses());
    let (sockets, accepting) = listeners.accept();
    let forward = Forward::spawn_with(
        hub,
        pod_target("web-1"),
        sockets,
        (addresses, Some(accepting)),
        false,
        Arc::new(pods),
    );
    assert_eq!(forward.addresses().contains(&"::1".to_owned()), v6_here);
    let mut status = forward.status();
    within(
        "the forward is ready",
        status.wait_for(|status| status.state == ForwardState::Ready),
    )
    .await
    .unwrap();
    while served.try_recv().is_ok() {}

    let mut addresses = vec![std::net::IpAddr::from(Ipv4Addr::LOCALHOST)];
    if v6_here {
        addresses.push(Ipv6Addr::LOCALHOST.into());
    }
    for address in addresses {
        let mut client = TcpStream::connect((address, port)).await.unwrap();
        client.write_all(b"ping").await.unwrap();
        let mut pod = within("a stream to the pod", served.recv()).await.unwrap();
        assert_eq!(read_exactly(&mut pod.io, 4).await, b"ping");
        pod.io.write_all(b"pong").await.unwrap();
        assert_eq!(read_exactly(&mut client, 4).await, b"pong");
    }
}

#[tokio::test]
async fn a_privileged_port_is_not_permitted() {
    if is_root() {
        return;
    }
    let Err(BindError::Busy(why)) = listen(1).await else {
        panic!("port 1 is not for this process");
    };
    assert_eq!(why, BusyWhy::NotPermitted);
    assert!(free_port(1).await.unwrap() >= 1024);
}

fn is_root() -> bool {
    // SAFETY: `geteuid` reads the process's own identity.
    unsafe { libc::geteuid() == 0 }
}
