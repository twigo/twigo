//! The command bus against a kind cluster with kwok: each friction a plan
//! names, a countdown's cancel that sends nothing, a plan that never runs on
//! another cluster than it was planned on, a read-only context whose write
//! never reaches the server, a Reveal that shows a value only as it runs, and
//! the kubectl line of each plan, run here, doing what the plan does.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-core --test bus_live -- --ignored

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::apps::v1::ReplicaSet;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod, Secret};
use kube::api::{DeleteParams, ListParams, PostParams};
use kube::config::Kubeconfig;
use kube::{Api, Config};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    ErrorKind, Execute, Friction, Gvr, IpcError, Mode, ObjectParts, ObjectQuery, OpenObject,
    OperationEvent, Plan, PlanRequest, ResourceRef, SetContextMode,
};

const WAIT: Duration = Duration::from_secs(60);

/// The test cluster: its context and an admin client.
struct Cluster {
    path: PathBuf,
    context: String,
    admin: kube::Client,
}

impl Cluster {
    async fn connect() -> Self {
        let path: PathBuf = std::env::var_os("TWIGO_TEST_KUBECONFIG")
            .expect("TWIGO_TEST_KUBECONFIG")
            .into();
        let kubeconfig = Kubeconfig::read_from(&path).unwrap();
        let context = kubeconfig.current_context.clone().unwrap_or_default();
        assert!(
            context.starts_with("kind-") || context.starts_with("kwok-"),
            "refusing context {context:?}: only kind and kwok clusters"
        );
        let config = Config::from_custom_kubeconfig(kubeconfig, &Default::default())
            .await
            .unwrap();
        Cluster {
            path,
            context,
            admin: kube::Client::try_from(config).unwrap(),
        }
    }

    async fn namespace(&self, prefix: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let namespace = format!("core-bus-{prefix}-{nanos}");
        Api::<Namespace>::all(self.admin.clone())
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({ "metadata": { "name": namespace } })).unwrap(),
            )
            .await
            .unwrap();
        namespace
    }

    async fn delete(&self, namespace: &str) {
        let deleted = Api::<Namespace>::all(self.admin.clone())
            .delete(namespace, &DeleteParams::default())
            .await;
        if let Err(kube::Error::Api(status)) = &deleted
            && status.code == 404
        {
            return;
        }
        deleted.unwrap();
    }

    async fn config_map(&self, namespace: &str, name: &str) -> String {
        Api::<ConfigMap>::namespaced(self.admin.clone(), namespace)
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap(),
            )
            .await
            .unwrap()
            .metadata
            .uid
            .unwrap()
    }

    /// The uid of the object `name` of `api`, none once it is gone.
    async fn uid<K>(api: &Api<K>, name: &str) -> Option<String>
    where
        K: kube::Resource + Clone + serde::de::DeserializeOwned + std::fmt::Debug,
    {
        api.get_opt(name)
            .await
            .unwrap()
            .and_then(|object| object.meta().uid.clone())
    }
}

/// A core that reads only a copy of the test's kubeconfig, which a test may
/// rewrite, with a space for its context.
async fn core(dir: &Path, cluster: &Cluster) -> (Arc<Core>, PathBuf) {
    let kubeconfig = dir.join("config");
    std::fs::copy(&cluster.path, &kubeconfig).unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    core.state.open_space(&cluster.context);
    let (status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    tokio::spawn({
        let core = Arc::clone(&core);
        let kubeconfig = kubeconfig.clone();
        async move {
            let _status = status;
            core.run(followed, Some(kubeconfig)).await;
        }
    });
    core.catalog.contexts().await;
    (core, kubeconfig)
}

fn target(resource: &str, namespace: Option<&str>, name: &str) -> ResourceRef {
    ResourceRef {
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: resource.to_owned(),
        },
        namespaced: namespace.is_some(),
        namespace: namespace.map(str::to_owned),
        name: name.to_owned(),
    }
}

async fn plan_delete(
    core: &Core,
    cluster: &Cluster,
    target: ResourceRef,
) -> Result<Plan, IpcError> {
    let request = PlanRequest::Delete {
        space: cluster.context.clone(),
        target,
    };
    core.command_plan("main", request).await
}

/// Runs a plan and gathers its events until the last.
async fn run(
    core: &Core,
    plan: &Plan,
    typed: Option<&str>,
) -> Result<Vec<OperationEvent>, IpcError> {
    let (sender, mut events) = mpsc::unbounded_channel();
    core.command_execute(
        "main",
        Execute {
            plan: plan.id,
            typed: typed.map(str::to_owned),
        },
        move |event| sender.send(event).is_ok(),
    )
    .await?;
    let mut told = Vec::new();
    tokio::time::timeout(WAIT, async {
        while let Some(event) = events.recv().await {
            let last = !matches!(event, OperationEvent::Running { .. });
            told.push(event);
            if last {
                return;
            }
        }
    })
    .await
    .expect("the run ends within 60 s");
    Ok(told)
}

/// The plan's kubectl line, run by a shell over `kubeconfig` only.
fn kubectl(plan: &Plan, kubeconfig: &Path) -> String {
    let output = Command::new("sh")
        .arg("-c")
        .arg(&plan.kubectl)
        .env("KUBECONFIG", kubeconfig)
        .output()
        .expect("kubectl runs");
    assert!(
        output.status.success(),
        "{}: {}",
        plan.kubectl,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn audit(dir: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(dir.join("audit.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_pod_its_replica_set_replaces_counts_down_and_a_cancel_sends_nothing() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("countdown").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let replica_set: ReplicaSet = serde_json::from_value(json!({
        "metadata": { "name": "web" },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": { "app": "web" } },
            "template": {
                "metadata": { "labels": { "app": "web" } },
                "spec": {
                    "nodeName": "kwok-node-0",
                    "containers": [{ "name": "app", "image": "fake" }],
                },
            },
        },
    }))
    .unwrap();
    Api::<ReplicaSet>::namespaced(cluster.admin.clone(), &namespace)
        .create(&PostParams::default(), &replica_set)
        .await
        .unwrap();
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    let listed = ListParams::default().labels("app=web");
    let pod = tokio::time::timeout(WAIT, async {
        loop {
            if let Some(pod) = pods.list(&listed).await.unwrap().items.pop() {
                return pod;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the replica set makes its pod");
    let name = pod.metadata.name.clone().unwrap();
    let uid = pod.metadata.uid.clone().unwrap();
    let pod_ref = || target("pods", Some(&namespace), &name);

    let cancelled = plan_delete(&core, &cluster, pod_ref()).await.unwrap();
    assert_eq!(cancelled.friction, Friction::Countdown { seconds: 5 });
    assert_eq!(cancelled.consequences, ["Its replica set web replaces it."]);
    assert_eq!(
        cancelled.question,
        format!("Delete pod {name} in {namespace} from {}?", cluster.context)
    );
    core.command_cancel("main", cancelled.id);
    tokio::time::sleep(Duration::from_secs(6)).await;
    let refused = run(&core, &cancelled, None).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::NotFound);
    assert_eq!(Cluster::uid(&pods, &name).await, Some(uid.clone()));
    assert!(
        audit(dir.path()).is_empty(),
        "a cancelled countdown sent nothing"
    );

    let early = plan_delete(&core, &cluster, pod_ref()).await.unwrap();
    let refused = run(&core, &early, None).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    assert_eq!(Cluster::uid(&pods, &name).await, Some(uid.clone()));

    let plan = plan_delete(&core, &cluster, pod_ref()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(5)).await;
    let told = run(&core, &plan, None).await.unwrap();
    assert_eq!(
        told.last(),
        Some(&OperationEvent::Done {
            text: format!("Deleted pod {name}")
        })
    );
    assert_ne!(Cluster::uid(&pods, &name).await, Some(uid));
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn each_friction_holds_its_plan_and_each_kubectl_line_does_the_same() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("friction").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let config_maps = Api::<ConfigMap>::namespaced(cluster.admin.clone(), &namespace);
    let context = &cluster.context;

    cluster.config_map(&namespace, "by-twigo").await;
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "by-twigo"),
    )
    .await
    .unwrap();
    assert_eq!(plan.friction, Friction::Confirm);
    assert_eq!(plan.confirm, "Delete config map");
    assert_eq!(
        plan.kubectl,
        format!("kubectl --context {context} delete configmaps by-twigo -n {namespace}")
    );
    let told = run(&core, &plan, None).await.unwrap();
    assert!(
        matches!(told.last(), Some(OperationEvent::Done { .. })),
        "{told:?}"
    );
    assert_eq!(Cluster::uid(&config_maps, "by-twigo").await, None);

    cluster.config_map(&namespace, "by-kubectl").await;
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "by-kubectl"),
    )
    .await
    .unwrap();
    core.command_cancel("main", plan.id);
    kubectl(&plan, &kubeconfig);
    assert_eq!(Cluster::uid(&config_maps, "by-kubectl").await, None);

    let typed = cluster.namespace("typed").await;
    let wide = || target("namespaces", None, &typed);
    let plan = plan_delete(&core, &cluster, wide()).await.unwrap();
    assert_eq!(
        plan.friction,
        Friction::Typed {
            text: typed.clone()
        }
    );
    assert_eq!(plan.consequences, ["Every object in it goes with it."]);
    let refused = run(&core, &plan, Some(context)).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    let namespaces = Api::<Namespace>::all(cluster.admin.clone());
    assert!(Cluster::uid(&namespaces, &typed).await.is_some());
    let plan = plan_delete(&core, &cluster, wide()).await.unwrap();
    let told = run(&core, &plan, Some(&typed)).await.unwrap();
    assert_eq!(
        told,
        [
            OperationEvent::Running {
                text: format!("Waiting for namespace {typed} to go")
            },
            OperationEvent::Done {
                text: format!("Deleted namespace {typed}")
            },
        ]
    );
    assert_eq!(Cluster::uid(&namespaces, &typed).await, None);

    let by_kubectl = cluster.namespace("kubectl").await;
    let plan = plan_delete(&core, &cluster, target("namespaces", None, &by_kubectl))
        .await
        .unwrap();
    core.command_cancel("main", plan.id);
    kubectl(&plan, &kubeconfig);
    assert_eq!(Cluster::uid(&namespaces, &by_kubectl).await, None);

    let lines = audit(dir.path());
    let events: Vec<&str> = lines
        .iter()
        .map(|line| line["event"].as_str().unwrap())
        .collect();
    assert_eq!(
        events,
        [
            "confirmed",
            "request",
            "ended",
            "confirmed",
            "request",
            "ended"
        ],
        "{lines:?}"
    );
    assert_eq!(
        lines[1]["target"],
        format!("configmaps/by-twigo in {namespace}")
    );
    assert_eq!(lines[1]["blocked"], serde_json::Value::Null);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn guarded_asks_for_the_context_s_name_and_read_only_sends_nothing() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("modes").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let config_maps = Api::<ConfigMap>::namespaced(cluster.admin.clone(), &namespace);
    let set = |mode| SetContextMode {
        context: cluster.context.clone(),
        mode: Some(mode),
    };

    cluster.config_map(&namespace, "guarded").await;
    core.set_context_mode(set(Mode::Guarded)).await.unwrap();
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "guarded"),
    )
    .await
    .unwrap();
    assert_eq!(
        plan.friction,
        Friction::Typed {
            text: cluster.context.clone()
        }
    );
    assert_eq!(plan.mode, Mode::Guarded);
    run(&core, &plan, Some(&cluster.context)).await.unwrap();
    assert_eq!(Cluster::uid(&config_maps, "guarded").await, None);

    let uid = cluster.config_map(&namespace, "locked").await;
    core.set_context_mode(set(Mode::ReadOnly)).await.unwrap();
    let blocked = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "locked"),
    )
    .await
    .unwrap_err();
    assert_eq!(blocked.kind, ErrorKind::Permissions);
    assert_eq!(blocked.blocked.unwrap().mode, Mode::ReadOnly);
    assert_eq!(Cluster::uid(&config_maps, "locked").await, Some(uid));
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_plan_never_runs_once_its_context_names_another_cluster() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("moved").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let uid = cluster.config_map(&namespace, "kept").await;
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "kept"),
    )
    .await
    .unwrap();

    let mut contexts = core.catalog.subscribe();
    contexts.borrow_and_update();
    let text = std::fs::read_to_string(&kubeconfig).unwrap();
    assert!(text.contains("https://127.0.0.1:"), "{text}");
    std::fs::write(
        &kubeconfig,
        text.replace("https://127.0.0.1:", "https://localhost:"),
    )
    .unwrap();
    tokio::time::timeout(WAIT, contexts.changed())
        .await
        .expect("the catalog reads the new server")
        .unwrap();

    let refused = run(&core, &plan, None).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Conflict);
    let config_maps = Api::<ConfigMap>::namespaced(cluster.admin.clone(), &namespace);
    assert_eq!(Cluster::uid(&config_maps, "kept").await, Some(uid));
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_reveal_asks_in_guarded_and_kubectl_reads_the_same_value() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("reveal").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let secret: Secret = serde_json::from_value(json!({
        "metadata": { "name": "db" },
        "stringData": { "password": "hunter2-live" },
        "data": { "key.der": "MIIBCgKCAQEA/w==" },
    }))
    .unwrap();
    Api::<Secret>::namespaced(cluster.admin.clone(), &namespace)
        .create(&PostParams::default(), &secret)
        .await
        .unwrap();

    let (sender, mut batches) = mpsc::unbounded_channel();
    let object = ObjectQuery {
        space: cluster.context.clone(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "secrets".to_owned(),
        },
        namespaced: true,
        namespace: Some(namespace.clone()),
        name: "db".to_owned(),
    };
    let parts = ObjectParts {
        overview: true,
        manifest: true,
        events: false,
        related: false,
    };
    let id = core
        .object_open("main", OpenObject { object, parts }, move |batch| {
            sender.send(batch).is_ok()
        })
        .await
        .unwrap();
    let shown = tokio::time::timeout(WAIT, async {
        loop {
            let batch = batches.recv().await.unwrap();
            core.object_ack("main", twigo_ipc::Ack { id, seq: batch.seq })
                .unwrap();
            if batch.exists && batch.manifest.is_some() {
                return batch;
            }
        }
    })
    .await
    .expect("the secret is listed");
    let sent = serde_json::to_string(&shown).unwrap();
    assert!(!sent.contains("hunter2"), "{sent}");

    core.set_context_mode(SetContextMode {
        context: cluster.context.clone(),
        mode: Some(Mode::Guarded),
    })
    .await
    .unwrap();
    for (key, expected, binary) in [
        ("password", "hunter2-live", false),
        ("key.der", "MIIBCgKCAQEA/w==", true),
    ] {
        let request = PlanRequest::Reveal {
            object: id,
            key: key.to_owned(),
        };
        let plan = core.command_plan("main", request).await.unwrap();
        assert_eq!(plan.friction, Friction::Confirm);
        assert!(!plan.kubectl.contains(expected), "{}", plan.kubectl);
        let told = run(&core, &plan, None).await.unwrap();
        assert_eq!(
            told,
            [OperationEvent::Revealed {
                value: expected.to_owned(),
                binary
            }]
        );
        assert_eq!(kubectl(&plan, &kubeconfig), expected, "{}", plan.kubectl);
    }

    let closed = core
        .command_plan(
            "main",
            PlanRequest::Reveal {
                object: id,
                key: "password".to_owned(),
            },
        )
        .await
        .unwrap();
    core.object_close("main", id).unwrap();
    let told = run(&core, &closed, None).await.unwrap();
    let [OperationEvent::Failed { error }] = told.as_slice() else {
        panic!("{told:?}");
    };
    assert_eq!(error.kind, ErrorKind::NotFound, "{}", error.message);

    core.state.flush().unwrap();
    for file in ["state.json", "audit.jsonl"] {
        let text = std::fs::read_to_string(dir.path().join(file)).unwrap();
        assert!(!text.contains("hunter2"), "{file}: {text}");
        assert!(!text.contains("MIIBCgKCAQEA"), "{file}: {text}");
    }
    let confirmed: Vec<_> = audit(dir.path())
        .into_iter()
        .filter(|line| line["event"] == "confirmed")
        .map(|line| line["target"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        confirmed,
        [
            format!("secrets/db in {namespace}, key password"),
            format!("secrets/db in {namespace}, key key.der"),
            format!("secrets/db in {namespace}, key password"),
        ]
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_object_replaced_since_the_plan_is_left_standing() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("replaced").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let config_maps = Api::<ConfigMap>::namespaced(cluster.admin.clone(), &namespace);
    cluster.config_map(&namespace, "settings").await;
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "settings"),
    )
    .await
    .unwrap();
    config_maps
        .delete("settings", &DeleteParams::default())
        .await
        .unwrap();
    let replacement = cluster.config_map(&namespace, "settings").await;

    let told = run(&core, &plan, None).await.unwrap();
    let [OperationEvent::Failed { error }] = told.as_slice() else {
        panic!("{told:?}");
    };
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    assert_eq!(
        Cluster::uid(&config_maps, "settings").await,
        Some(replacement)
    );
    cluster.delete(&namespace).await;
}
