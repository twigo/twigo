//! The port-forward manager on kind: a Deployment of two replicas behind a
//! Service with a named `targetPort`, a pod and a Deployment as targets, a
//! taken local port, a restart, the session budget, and a mode that turns
//! read-only. The pods run CoreDNS from the image kind's node holds, whose
//! `health` plugin answers HTTP on a port, so nothing is pulled. They need a
//! kubelet, so they refuse anything but `kind-*`, make a namespace of their
//! own and delete it, and take one lock, since the last one counts the API
//! server's `pods/portforward` requests.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-core --test forward_live -- --ignored

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Node, Pod, Service, ServiceAccount};
use kube::api::{DeleteParams, PostParams};
use kube::config::Kubeconfig;
use kube::{Api, Config};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    BusyWhy, ErrorKind, Forward, ForwardId, ForwardStarted, ForwardState, ForwardTarget, Gvr, Mode,
    ResumeForward, SetContextMode, StartForward,
};

const WAIT: Duration = Duration::from_secs(90);
/// Longer than the data path waits for a pod (20 s) and then for an upgrade
/// (15 s), so a client of the test never leaves while an upgrade of its
/// connection is still under way.
const PATIENCE: Duration = Duration::from_secs(45);
const COREDNS: &str = "registry.k8s.io/coredns/coredns:";
const COREFILE: &str = ".:5353 {\n    health :8080\n    whoami\n}\n";

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn unique() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!("{nanos}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

async fn eventually<F, Done>(what: &str, mut check: F)
where
    F: FnMut() -> Done,
    Done: std::future::Future<Output = bool>,
{
    let waited = tokio::time::timeout(WAIT, async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    assert!(waited.await.is_ok(), "{what} within 90 s");
}

struct Cluster {
    path: PathBuf,
    context: String,
    node: String,
    image: String,
    admin: kube::Client,
    namespace: String,
}

impl Cluster {
    async fn connect(prefix: &str) -> Self {
        let path: PathBuf = std::env::var_os("TWIGO_TEST_KUBECONFIG")
            .expect("TWIGO_TEST_KUBECONFIG")
            .into();
        let kubeconfig = Kubeconfig::read_from(&path).unwrap();
        let context = kubeconfig.current_context.clone().unwrap_or_default();
        let name = context.strip_prefix("kind-").unwrap_or_else(|| {
            panic!("refusing context {context:?}: only kind clusters, whose node runs real pods")
        });
        let node = format!("{name}-control-plane");
        let config = Config::from_custom_kubeconfig(kubeconfig, &Default::default())
            .await
            .unwrap();
        let admin = kube::Client::try_from(config).unwrap();
        let image = Api::<Node>::all(admin.clone())
            .get(&node)
            .await
            .unwrap()
            .status
            .and_then(|status| status.images)
            .into_iter()
            .flatten()
            .flat_map(|image| image.names.into_iter().flatten())
            .find(|name| name.starts_with(COREDNS))
            .unwrap_or_else(|| panic!("{node} holds no {COREDNS}*"));
        let namespace = format!("core-forward-{prefix}-{}", unique());
        Api::<Namespace>::all(admin.clone())
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({ "metadata": { "name": namespace } })).unwrap(),
            )
            .await
            .unwrap();
        let accounts = Api::<ServiceAccount>::namespaced(admin.clone(), &namespace);
        eventually("the default ServiceAccount", || async {
            matches!(accounts.get_opt("default").await, Ok(Some(_)))
        })
        .await;
        Api::<ConfigMap>::namespaced(admin.clone(), &namespace)
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "metadata": { "name": "corefile" },
                    "data": { "Corefile": COREFILE },
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        Cluster {
            path,
            context,
            node,
            image,
            admin,
            namespace,
        }
    }

    async fn delete(&self) {
        Api::<Namespace>::all(self.admin.clone())
            .delete(&self.namespace, &DeleteParams::default())
            .await
            .unwrap();
    }

    fn container(&self) -> serde_json::Value {
        json!({
            "name": "dns",
            "image": self.image,
            "imagePullPolicy": "Never",
            "args": ["-conf", "/etc/coredns/Corefile"],
            "ports": [{ "name": "web", "containerPort": 8080 }],
            "readinessProbe": { "httpGet": { "path": "/health", "port": 8080 } },
            "volumeMounts": [{ "name": "corefile", "mountPath": "/etc/coredns" }],
        })
    }

    fn pod_spec(&self) -> serde_json::Value {
        json!({
            "nodeName": self.node,
            "terminationGracePeriodSeconds": 0,
            "containers": [self.container()],
            "volumes": [{ "name": "corefile", "configMap": { "name": "corefile" } }],
        })
    }

    async fn serve_web(&self) {
        let deployments = Api::<Deployment>::namespaced(self.admin.clone(), &self.namespace);
        deployments
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "metadata": { "name": "web" },
                    "spec": {
                        "replicas": 2,
                        "selector": { "matchLabels": { "app": "web" } },
                        "template": {
                            "metadata": { "labels": { "app": "web" } },
                            "spec": self.pod_spec(),
                        },
                    },
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        Api::<Service>::namespaced(self.admin.clone(), &self.namespace)
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "metadata": { "name": "web" },
                    "spec": {
                        "selector": { "app": "web" },
                        "ports": [{
                            "name": "http",
                            "port": 80,
                            "targetPort": "web",
                            "appProtocol": "http",
                        }],
                    },
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        eventually("both replicas are ready", || async {
            let ready = deployments
                .get("web")
                .await
                .unwrap()
                .status
                .and_then(|status| status.ready_replicas);
            ready == Some(2)
        })
        .await;
    }

    async fn serve_solo(&self) {
        let pods = Api::<Pod>::namespaced(self.admin.clone(), &self.namespace);
        pods.create(
            &PostParams::default(),
            &serde_json::from_value(json!({
                "metadata": { "name": "solo" },
                "spec": self.pod_spec(),
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        eventually("solo is ready", || async {
            pods.get("solo")
                .await
                .unwrap()
                .status
                .is_some_and(|status| {
                    status
                        .conditions
                        .into_iter()
                        .flatten()
                        .any(|condition| condition.type_ == "Ready" && condition.status == "True")
                })
        })
        .await;
    }

    fn target(&self, group: &str, resource: &str, name: &str) -> ForwardTarget {
        ForwardTarget {
            space: self.context.clone(),
            gvr: Gvr {
                group: group.to_owned(),
                version: "v1".to_owned(),
                resource: resource.to_owned(),
            },
            namespace: self.namespace.clone(),
            name: name.to_owned(),
        }
    }

    fn service(&self) -> ForwardTarget {
        self.target("", "services", "web")
    }

    fn pod(&self) -> ForwardTarget {
        self.target("", "pods", "solo")
    }

    fn deployment(&self) -> ForwardTarget {
        self.target("apps", "deployments", "web")
    }

    /// The `pods/portforward` requests the API server has ended and those it
    /// has under way. It counts a request in `apiserver_request_total` once
    /// its handler returns ([`MonitorRequest`] after the route function,
    /// `InstrumentRouteFunc`), and in `apiserver_longrunning_requests` from
    /// when a connect handler starts until it returns
    /// ([`RecordLongRunning`], called by `ConnectResource`), so the two
    /// together are the requests started, but for the instant between a
    /// handler's return and its count.
    ///
    /// [`MonitorRequest`]: https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/endpoints/metrics/metrics.go#L569-L582
    /// [`RecordLongRunning`]: https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/endpoints/metrics/metrics.go#L539-L559
    async fn portforwards(&self) -> (u64, u64) {
        let request = http::Request::get("/metrics").body(Vec::new()).unwrap();
        let metrics = self.admin.request_text(request).await.unwrap();
        let sum = |name: &str| -> u64 {
            metrics
                .lines()
                .filter(|line| {
                    line.starts_with(name)
                        && line.contains("resource=\"pods\"")
                        && line.contains("subresource=\"portforward\"")
                })
                .map(|line| line.rsplit(' ').next().unwrap().parse::<f64>().unwrap() as u64)
                .sum()
        };
        (
            sum("apiserver_request_total{"),
            sum("apiserver_longrunning_requests{"),
        )
    }

    /// How many requests the API server has started, once `running` are
    /// under way and the number has held over a pause, which takes in a
    /// request that ended between the two counts.
    async fn started_with(&self, running: u64) -> u64 {
        let waited = tokio::time::timeout(WAIT, async {
            let mut previous = None;
            loop {
                let (ended, under_way) = self.portforwards().await;
                let started = ended + under_way;
                if under_way == running && previous == Some(started) {
                    return started;
                }
                previous = (under_way == running).then_some(started);
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        });
        waited
            .await
            .unwrap_or_else(|_| panic!("{running} requests under way and none new within 90 s"))
    }
}

async fn core(dir: &Path, cluster: &Cluster) -> Arc<Core> {
    core_task(dir, cluster).await.0
}

async fn core_task(dir: &Path, cluster: &Cluster) -> (Arc<Core>, JoinHandle<()>) {
    std::fs::copy(&cluster.path, dir.join("config")).unwrap();
    let (core, task) = running(dir);
    core.catalog.contexts().await;
    core.state.open_space(&cluster.context);
    (core, task)
}

fn running(dir: &Path) -> (Arc<Core>, JoinHandle<()>) {
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let (status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    let task = tokio::spawn({
        let core = Arc::clone(&core);
        let kubeconfig = dir.join("config");
        async move {
            let _status = status;
            core.run(followed, Some(kubeconfig)).await;
        }
    });
    (core, task)
}

fn forwards(core: &Core) -> Vec<Forward> {
    core.follow_forwards("poll", |_| false)
}

fn forward(core: &Core, id: ForwardId) -> Forward {
    forwards(core)
        .into_iter()
        .find(|forward| forward.id == id)
        .expect("the forward is listed")
}

async fn state(core: &Core, id: ForwardId, what: &str, wanted: impl Fn(&ForwardState) -> bool) {
    eventually(what, || async { wanted(&forward(core, id).state) }).await;
}

async fn start(core: &Core, target: ForwardTarget, port: u16, local: Option<u16>) -> Forward {
    match core
        .forward_start(StartForward {
            target,
            port,
            local,
        })
        .await
        .unwrap()
    {
        ForwardStarted::Started { forward } => *forward,
        ForwardStarted::Busy { local, why, .. } => panic!("port {local} is busy: {why:?}"),
    }
}

fn free() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn health(port: u16) -> Result<String, String> {
    let get = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|error| error.to_string())?;
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: web\r\nConnection: close\r\n\r\n")
            .await
            .map_err(|error| error.to_string())?;
        let mut answer = String::new();
        stream
            .read_to_string(&mut answer)
            .await
            .map_err(|error| error.to_string())?;
        if answer.starts_with("HTTP/1.1 200") && answer.trim_end().ends_with("OK") {
            Ok(answer)
        } else {
            Err(format!("an answer without the health: {answer:?}"))
        }
    };
    tokio::time::timeout(PATIENCE, get)
        .await
        .unwrap_or_else(|_| Err("no answer within 45 s".to_owned()))
}

async fn answered(port: u16) {
    eventually("the forward answers", || async {
        health(port).await.is_ok()
    })
    .await;
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_service_answers_and_the_next_connection_reaches_the_other_pod_on_the_same_port() {
    let _lock = LOCK.lock().await;
    let cluster = Cluster::connect("service").await;
    cluster.serve_web().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &cluster).await;

    let ports = core.forward_ports(cluster.service()).await.unwrap();
    assert_eq!(ports.kind, "Service");
    assert_eq!(ports.default, 80);
    assert_eq!(ports.ports[0].local, 8080, "80 plus 8000");
    assert_eq!(ports.ports[0].target_port.as_deref(), Some("web"));
    assert_eq!(ports.ports[0].app_protocol.as_deref(), Some("http"));

    let local = free();
    let started = start(&core, cluster.service(), 80, Some(local)).await;
    assert_eq!(started.local, local);
    assert_eq!(started.app_protocol.as_deref(), Some("http"));
    assert_eq!(started.kind, "Service");
    state(&core, started.id, "the forward is ready", |state| {
        *state == ForwardState::Ready
    })
    .await;
    answered(local).await;
    let first = forward(&core, started.id);
    let first_pod = first.pod.clone().expect("a pod is chosen");
    assert_eq!(first.pod_port, Some(8080), "the named targetPort");

    let requests = tokio::spawn({
        async move {
            let mut answered = 0;
            let mut failed = 0;
            for _ in 0..100 {
                match health(local).await {
                    Ok(_) => answered += 1,
                    Err(_) => failed += 1,
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            (answered, failed)
        }
    });
    Api::<Pod>::namespaced(cluster.admin.clone(), &cluster.namespace)
        .delete(
            &first_pod,
            &DeleteParams {
                grace_period_seconds: Some(0),
                ..DeleteParams::default()
            },
        )
        .await
        .unwrap();
    eventually("the other pod is the forward's", || async {
        let now = forward(&core, started.id);
        now.pod.as_deref().is_some_and(|pod| pod != first_pod) && now.local == local
    })
    .await;
    let (answered_during, _) = requests.await.unwrap();
    assert!(answered_during > 0, "requests were answered meanwhile");
    answered(local).await;
    assert!(
        TcpStream::connect(("127.0.0.1", local)).await.is_ok(),
        "the listener stayed"
    );
    let now = forward(&core, started.id);
    assert_eq!(now.local, local);
    assert_ne!(now.pod.as_deref(), Some(first_pod.as_str()));
    assert!(now.sent > 0 && now.received > 0, "{now:?}");
    cluster.delete().await;
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_pod_and_a_deployment_answer_too() {
    let _lock = LOCK.lock().await;
    let cluster = Cluster::connect("kinds").await;
    cluster.serve_web().await;
    cluster.serve_solo().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &cluster).await;

    let ports = core.forward_ports(cluster.pod()).await.unwrap();
    assert_eq!(ports.kind, "Pod");
    assert_eq!(ports.ports[0].container.as_deref(), Some("dns"));
    let pod = start(&core, cluster.pod(), 8080, Some(free())).await;
    state(&core, pod.id, "the pod's forward is ready", |state| {
        *state == ForwardState::Ready
    })
    .await;
    answered(pod.local).await;
    assert_eq!(forward(&core, pod.id).pod.as_deref(), Some("solo"));

    let ports = core.forward_ports(cluster.deployment()).await.unwrap();
    assert_eq!(ports.kind, "Deployment");
    assert_eq!(ports.ports[0].name.as_deref(), Some("web"));
    let deployment = start(&core, cluster.deployment(), 8080, Some(free())).await;
    state(
        &core,
        deployment.id,
        "the Deployment's forward is ready",
        |state| *state == ForwardState::Ready,
    )
    .await;
    answered(deployment.local).await;
    assert!(
        forward(&core, deployment.id)
            .pod
            .is_some_and(|pod| pod.starts_with("web-"))
    );
    cluster.delete().await;
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_taken_local_port_answers_busy_with_a_free_one_and_a_start_on_it_works() {
    let _lock = LOCK.lock().await;
    let cluster = Cluster::connect("busy").await;
    cluster.serve_solo().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &cluster).await;

    let taken = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let held = taken.local_addr().unwrap().port();
    let busy = core
        .forward_start(StartForward {
            target: cluster.pod(),
            port: 8080,
            local: Some(held),
        })
        .await
        .unwrap();
    let ForwardStarted::Busy { local, why, free } = busy else {
        panic!("a port another listener holds is busy: {busy:?}");
    };
    assert_eq!((local, why), (held, BusyWhy::InUse));
    assert!(free > held);
    assert!(forwards(&core).is_empty(), "nothing was kept");
    let ports = core.forward_ports(cluster.pod()).await.unwrap();
    assert_eq!(ports.ports[0].local, 8080);

    let started = start(&core, cluster.pod(), 8080, Some(free)).await;
    assert_eq!(started.local, free);
    state(&core, started.id, "the forward is ready", |state| {
        *state == ForwardState::Ready
    })
    .await;
    answered(free).await;
    let ports = core.forward_ports(cluster.pod()).await.unwrap();
    assert_eq!(ports.ports[0].local, free, "the forward's own port");
    assert_eq!(ports.ports[0].forward, Some(started.id));
    core.forward_remove(started.id).await.unwrap();
    let ports = core.forward_ports(cluster.pod()).await.unwrap();
    assert_eq!(ports.ports[0].local, 8080, "a detour is not remembered");
    assert_eq!(ports.ports[0].forward, None);
    cluster.delete().await;
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn the_bytes_count_since_the_app_started_and_a_stopped_port_binds_again_at_once() {
    let _lock = LOCK.lock().await;
    let cluster = Cluster::connect("bytes").await;
    cluster.serve_solo().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &cluster).await;
    let started = start(&core, cluster.pod(), 8080, Some(free())).await;
    state(&core, started.id, "the forward is ready", |state| {
        *state == ForwardState::Ready
    })
    .await;
    for _ in 0..3 {
        answered(started.local).await;
    }
    eventually("the bytes are shown", || async {
        let now = forward(&core, started.id);
        now.sent > 0 && now.received > 0
    })
    .await;
    let counted = forward(&core, started.id);

    core.forward_stop(started.id).await.unwrap();
    let resumed = match core
        .forward_resume(ResumeForward {
            id: started.id,
            local: None,
        })
        .await
        .unwrap()
    {
        ForwardStarted::Started { forward } => *forward,
        ForwardStarted::Busy { local, why, .. } => {
            panic!("port {local} that just served connections is busy: {why:?}")
        }
    };
    assert!(
        resumed.sent >= counted.sent && resumed.received >= counted.received,
        "{counted:?} then {resumed:?}"
    );
    state(&core, started.id, "the forward is ready again", |state| {
        *state == ForwardState::Ready
    })
    .await;
    answered(started.local).await;
    eventually("more bytes are counted", || async {
        let now = forward(&core, started.id);
        now.sent > counted.sent && now.received > counted.received
    })
    .await;
    cluster.delete().await;
}

async fn relay(to: String) -> (u16, Arc<AtomicU64>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let count = Arc::new(AtomicU64::new(0));
    tokio::spawn({
        let count = Arc::clone(&count);
        async move {
            loop {
                let Ok((mut client, _)) = listener.accept().await else {
                    return;
                };
                count.fetch_add(1, Ordering::SeqCst);
                let to = to.clone();
                tokio::spawn(async move {
                    if let Ok(mut server) = TcpStream::connect(to).await {
                        let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                    }
                });
            }
        }
    });
    (port, count)
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_restart_restores_a_forward_listening_and_asks_the_cluster_only_when_used() {
    let _lock = LOCK.lock().await;
    let cluster = Cluster::connect("restart").await;
    cluster.serve_solo().await;
    let dir = tempfile::tempdir().unwrap();
    let kubeconfig = Kubeconfig::read_from(&cluster.path).unwrap();
    let named = kubeconfig
        .contexts
        .iter()
        .find(|context| context.name == cluster.context)
        .and_then(|context| context.context.as_ref())
        .map(|context| context.cluster.clone())
        .expect("the context names its cluster");
    let real = kubeconfig
        .clusters
        .into_iter()
        .find(|cluster| cluster.name == named)
        .and_then(|cluster| cluster.cluster?.server)
        .expect("the cluster has a server");
    let to = real.trim_start_matches("https://").to_owned();

    let (core, task) = core_task(dir.path(), &cluster).await;
    let started = start(&core, cluster.pod(), 8080, Some(free())).await;
    state(&core, started.id, "the forward is ready", |state| {
        *state == ForwardState::Ready
    })
    .await;
    answered(started.local).await;
    core.state.flush().unwrap();
    core.shutdown();
    let first = Arc::downgrade(&core);
    task.abort();
    drop(core);
    eventually("the first core is gone", || async {
        first.upgrade().is_none()
    })
    .await;
    eventually("the port is free again", || async {
        std::net::TcpListener::bind(("127.0.0.1", started.local)).is_ok()
    })
    .await;

    let (port, connections) = relay(to).await;
    let second = core_over(dir.path(), &real, port).await;
    eventually("the forward is back", || async {
        forwards(&second)
            .iter()
            .any(|forward| forward.id == started.id)
    })
    .await;
    let restored = forward(&second, started.id);
    assert_eq!(restored.state, ForwardState::Restored);
    assert_eq!(restored.local, started.local);
    let ForwardStarted::Started { forward: resumed } = second
        .forward_resume(ResumeForward {
            id: started.id,
            local: None,
        })
        .await
        .unwrap()
    else {
        panic!("a resume answers with the forward");
    };
    assert_eq!(
        resumed.state,
        ForwardState::Restored,
        "a resume, which waits for the restore to end, leaves it waiting"
    );
    assert_eq!(
        connections.load(Ordering::SeqCst),
        0,
        "nothing reached the API server for it"
    );
    assert!(
        TcpStream::connect(("127.0.0.1", started.local))
            .await
            .is_ok(),
        "it listens"
    );

    Api::<Pod>::namespaced(cluster.admin.clone(), &cluster.namespace)
        .delete(
            "solo",
            &DeleteParams {
                grace_period_seconds: Some(0),
                ..DeleteParams::default()
            },
        )
        .await
        .unwrap();
    eventually("the pod is gone", || async {
        Api::<Pod>::namespaced(cluster.admin.clone(), &cluster.namespace)
            .get_opt("solo")
            .await
            .unwrap()
            .is_none()
    })
    .await;
    let mut client = TcpStream::connect(("127.0.0.1", started.local))
        .await
        .unwrap();
    state(&second, started.id, "the target is gone", |state| {
        matches!(state, ForwardState::Failed { error } if error.kind == ErrorKind::NotFound)
    })
    .await;
    let ForwardState::Failed { error } = forward(&second, started.id).state else {
        unreachable!("waited for");
    };
    assert_eq!(error.message, "Pod solo is gone");
    let mut left = Vec::new();
    tokio::time::timeout(WAIT, client.read_to_end(&mut left))
        .await
        .expect("its connection closes")
        .ok();
    assert!(connections.load(Ordering::SeqCst) > 0, "it asked then");
    cluster.delete().await;
}

async fn core_over(dir: &Path, real: &str, relay: u16) -> Arc<Core> {
    let text = std::fs::read_to_string(dir.join("config"))
        .unwrap()
        .replace(real, &format!("https://127.0.0.1:{relay}"));
    std::fs::write(dir.join("config"), text).unwrap();
    let (core, _task) = running(dir);
    core.catalog.contexts().await;
    core
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn sixty_four_connections_fill_the_budget_and_the_sixty_fifth_is_queued() {
    let _lock = LOCK.lock().await;
    let cluster = Cluster::connect("budget").await;
    cluster.serve_solo().await;
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), &cluster).await;
    let started = start(&core, cluster.pod(), 8080, Some(free())).await;
    state(&core, started.id, "the forward is ready", |state| {
        *state == ForwardState::Ready
    })
    .await;

    let mut open = Vec::new();
    for _ in 0..64 {
        let mut stream = TcpStream::connect(("127.0.0.1", started.local))
            .await
            .unwrap();
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: web\r\n\r\n")
            .await
            .unwrap();
        open.push(stream);
    }
    eventually("64 connections are placed", || async {
        let now = forward(&core, started.id);
        now.connections == 64 && now.queued == 0
    })
    .await;
    let mut last = TcpStream::connect(("127.0.0.1", started.local))
        .await
        .unwrap();
    last.write_all(b"GET /health HTTP/1.1\r\nHost: web\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    eventually("the 65th is queued", || async {
        let now = forward(&core, started.id);
        now.connections == 65 && now.queued == 1
    })
    .await;

    drop(open.pop());
    let mut answer = String::new();
    tokio::time::timeout(WAIT, last.read_to_string(&mut answer))
        .await
        .expect("the 65th goes through when one closes")
        .unwrap();
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer:?}");
    eventually("none waits", || async {
        forward(&core, started.id).queued == 0
    })
    .await;
    cluster.delete().await;
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_mode_that_refuses_forwards_ends_them_and_sends_nothing() {
    let _lock = LOCK.lock().await;
    let cluster = Cluster::connect("mode").await;
    cluster.serve_solo().await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        r#"{"readOnly": {"allowPortForward": false}}"#,
    )
    .unwrap();
    let core = core(dir.path(), &cluster).await;
    let started = start(&core, cluster.pod(), 8080, Some(free())).await;
    state(&core, started.id, "the forward is ready", |state| {
        *state == ForwardState::Ready
    })
    .await;
    answered(started.local).await;
    let mut open = TcpStream::connect(("127.0.0.1", started.local))
        .await
        .unwrap();
    open.write_all(b"GET /health HTTP/1.1\r\nHost: web\r\n\r\n")
        .await
        .unwrap();
    let mut reply = String::new();
    let mut chunk = [0; 512];
    while !reply.trim_end().ends_with("OK") {
        let read = tokio::time::timeout(WAIT, open.read(&mut chunk))
            .await
            .expect("the open connection is answered")
            .unwrap();
        assert_ne!(read, 0, "{reply:?}");
        reply.push_str(&String::from_utf8_lossy(&chunk[..read]));
    }
    eventually("it is ready with one connection", || async {
        let now = forward(&core, started.id);
        now.state == ForwardState::Ready && now.connections == 1
    })
    .await;
    let before = cluster.started_with(1).await;

    core.set_context_mode(SetContextMode {
        context: cluster.context.clone(),
        mode: Some(Mode::ReadOnly),
    })
    .await
    .unwrap();
    state(&core, started.id, "the forward fails", |state| {
        matches!(state, ForwardState::Failed { error } if error.kind == ErrorKind::Permissions)
    })
    .await;
    let mut left = Vec::new();
    tokio::time::timeout(WAIT, async {
        let _ = open.read_to_end(&mut left).await;
    })
    .await
    .expect("its connection ends");

    let mut refused = TcpStream::connect(("127.0.0.1", started.local))
        .await
        .expect("it still listens");
    let mut nothing = Vec::new();
    tokio::time::timeout(WAIT, refused.read_to_end(&mut nothing))
        .await
        .expect("a new connection is closed at once")
        .ok();
    assert!(nothing.is_empty());
    let other = core
        .forward_start(StartForward {
            target: cluster.pod(),
            port: 8080,
            local: Some(free()),
        })
        .await
        .unwrap_err();
    assert_eq!(other.kind, ErrorKind::Permissions);
    let resumed = core
        .forward_resume(ResumeForward {
            id: started.id,
            local: None,
        })
        .await
        .unwrap_err();
    assert_eq!(resumed.kind, ErrorKind::Permissions);
    assert_eq!(
        cluster.started_with(0).await,
        before,
        "since the mode turned the API server started no request"
    );

    core.set_context_mode(SetContextMode {
        context: cluster.context.clone(),
        mode: Some(Mode::ReadWrite),
    })
    .await
    .unwrap();
    state(&core, started.id, "the forward is ready again", |state| {
        *state == ForwardState::Ready
    })
    .await;
    answered(started.local).await;
    let (ended, under_way) = cluster.portforwards().await;
    assert!(ended + under_way > before, "it sends again once allowed");
    cluster.delete().await;
}
