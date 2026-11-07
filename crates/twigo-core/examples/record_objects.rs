//! Records objects from a kind cluster as `twigo-describe` reads them: the
//! object, the cells the server prints for it, its events and what its
//! describer needs. The tests of `twigo-describe` describe them, and their
//! documents become the mock backend's.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run -p twigo-core --example record_objects
//!
//! It applies its objects to the namespace `overview` and waits until each
//! is in the state it records: a Deployment after a rollout, pods that
//! crash, cannot pull, cannot be scheduled or are not ready, a finished
//! Job and a CronJob that has run. Every image is one kind's node holds.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use kube::api::{ApiResource, DynamicObject, Patch, PatchParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::core::GroupVersionKind;
use kube::{Api, Config};
use serde_json::{Value, json};
use twigo_cache::hub::{Connect, Hub, Resource, Subscription};
use twigo_cache::object::Object;
use twigo_kube::client::{Clients, Gate, Options};

const NAMESPACE: &str = "overview";
/// A shell without coreutils, from kind's local path provisioner.
const SHELL: &str = "docker.io/kindest/local-path-helper:v20260131-7181c60a";
const PAUSE: &str = "registry.k8s.io/pause:3.10";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-"),
        "refusing context {context:?}: only kind clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    let admin = kube::Client::try_from(config.clone()).unwrap();
    let node = create(&admin).await;

    let clients =
        Arc::new(Clients::new(&config, Gate::unrestricted(), Options::default()).unwrap());
    let connect: Connect = Arc::new(move |_context| {
        let clients = Arc::clone(&clients);
        Box::pin(async move { Ok(clients) })
    });
    let hub = Hub::new(connect);
    let web = pod_of(&admin, "app=web").await;
    let crash = pod_of(&admin, "app=api").await;
    let replica_set = controller_of(&admin, &web).await;
    let ns = Some(NAMESPACE);
    let targets = [
        ("pod", resource("", "v1", "pods", true), ns, web),
        ("pod-crashing", resource("", "v1", "pods", true), ns, crash),
        (
            "pod-pulling",
            resource("", "v1", "pods", true),
            ns,
            "pull".to_owned(),
        ),
        (
            "pod-pending",
            resource("", "v1", "pods", true),
            ns,
            "pending".to_owned(),
        ),
        (
            "pod-unready",
            resource("", "v1", "pods", true),
            ns,
            "unready".to_owned(),
        ),
        (
            "deployment",
            resource("apps", "v1", "deployments", true),
            ns,
            "web".to_owned(),
        ),
        (
            "replicaset",
            resource("apps", "v1", "replicasets", true),
            ns,
            replica_set,
        ),
        (
            "statefulset",
            resource("apps", "v1", "statefulsets", true),
            ns,
            "db".to_owned(),
        ),
        (
            "daemonset",
            resource("apps", "v1", "daemonsets", true),
            ns,
            "agent".to_owned(),
        ),
        (
            "job",
            resource("batch", "v1", "jobs", true),
            ns,
            "migrate".to_owned(),
        ),
        (
            "cronjob",
            resource("batch", "v1", "cronjobs", true),
            ns,
            "report".to_owned(),
        ),
        (
            "service",
            resource("", "v1", "services", true),
            ns,
            "web".to_owned(),
        ),
        (
            "ingress",
            resource("networking.k8s.io", "v1", "ingresses", true),
            ns,
            "web".to_owned(),
        ),
        (
            "pvc",
            resource("", "v1", "persistentvolumeclaims", true),
            ns,
            "data-db-0".to_owned(),
        ),
        (
            "configmap",
            resource("", "v1", "configmaps", true),
            ns,
            "settings".to_owned(),
        ),
        (
            "secret",
            resource("", "v1", "secrets", true),
            ns,
            "credentials".to_owned(),
        ),
        ("node", resource("", "v1", "nodes", false), None, node),
        (
            "stage",
            resource("kwok.x-k8s.io", "v1alpha1", "stages", false),
            None,
            "pod-ready".to_owned(),
        ),
    ];
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../twigo-describe/tests/fixtures");
    for (file, target, namespace, name) in targets {
        let namespace = namespace.map(str::to_owned);
        let mut object = hub
            .object(&context, target, namespace.clone(), &name)
            .unwrap();
        let object = if file == "pod-crashing" {
            crash_looping(&mut object).await
        } else {
            listed(&mut object).await
        };
        let json: Value = serde_json::from_str(object.0.json.get()).unwrap();
        let uid = object.0.meta.uid.as_deref().unwrap_or_default();
        let selector = if file == "node" {
            format!("regarding.kind=Node,regarding.name={name}")
        } else {
            format!("regarding.uid={uid}")
        };
        let mut events = hub
            .selected(
                &context,
                resource("events.k8s.io", "v1", "events", true),
                namespace,
                Some(selector),
            )
            .unwrap();
        let mut events: Vec<_> = listed_all(&mut events)
            .await
            .iter()
            .map(|event| twigo_describe::event(&serde_json::from_str(event.json.get()).unwrap()))
            .collect();
        twigo_describe::newest_first(&mut events);
        let mut facts = Vec::new();
        for need in twigo_describe::needs(&json) {
            let mut objects = hub
                .selected(
                    &context,
                    resource(&need.group, &need.version, &need.resource, need.namespaced),
                    need.namespace.clone(),
                    need.field_selector.clone(),
                )
                .unwrap();
            let mut objects: Vec<Value> = listed_all(&mut objects)
                .await
                .iter()
                .map(|object| serde_json::from_str(object.json.get()).unwrap())
                .collect();
            objects.sort_by_key(|object| {
                (
                    object["metadata"]["namespace"].as_str().map(str::to_owned),
                    object["metadata"]["name"].as_str().map(str::to_owned),
                )
            });
            facts.push(json!({ "need": need, "found": { "state": "listed", "objects": objects } }));
        }
        let recorded = json!({
            "object": json,
            "printed": twigo_core::objects::printed(&object.1, &object.0.cells),
            "events": events,
            "facts": facts,
        });
        let path = fixtures.join(format!("{file}.json"));
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&recorded).unwrap() + "\n",
        )
        .unwrap();
        println!("{}", path.display());
    }
}

fn resource(group: &str, version: &str, resource: &str, namespaced: bool) -> Resource {
    Resource {
        group: group.to_owned(),
        version: version.to_owned(),
        resource: resource.to_owned(),
        namespaced,
    }
}

/// The object and the columns once its upstream has listed it.
async fn listed(
    subscription: &mut Subscription<Object>,
) -> (Arc<Object>, Arc<[twigo_cache::table::Column]>) {
    loop {
        if let (Some(object), Some(columns)) = (subscription.items().pop(), subscription.columns())
        {
            return (object, columns);
        }
        tokio::time::timeout(Duration::from_secs(30), subscription.changed())
            .await
            .expect("the object is listed within 30 s");
    }
}

/// The crashing pod while it waits out its back-off, which it leaves for
/// a moment at every restart.
async fn crash_looping(
    subscription: &mut Subscription<Object>,
) -> (Arc<Object>, Arc<[twigo_cache::table::Column]>) {
    for _ in 0..30 {
        let (object, columns) = listed(subscription).await;
        let json: Value = serde_json::from_str(object.json.get()).unwrap();
        if json["status"]["containerStatuses"][0]["state"]["waiting"]["reason"]
            == "CrashLoopBackOff"
        {
            return (object, columns);
        }
        tokio::time::timeout(Duration::from_secs(30), subscription.changed())
            .await
            .expect("the pod changes within 30 s");
    }
    panic!("the pod did not wait out a back-off");
}

async fn listed_all(subscription: &mut Subscription<Object>) -> Vec<Arc<Object>> {
    tokio::time::timeout(Duration::from_secs(30), subscription.whole())
        .await
        .expect("the objects are listed within 30 s")
        .expect("the objects can be listed")
}

/// Applies the objects and waits for each to reach the state it is
/// recorded in; returns the name of kind's own node, which every pod runs on.
async fn create(admin: &kube::Client) -> String {
    let node = dynamic(admin, "", "v1", "Node", "nodes", None)
        .list(&Default::default())
        .await
        .unwrap()
        .items
        .into_iter()
        .filter_map(|node| node.metadata.name)
        .find(|name| name.ends_with("-control-plane"))
        .expect("kind's control-plane node");
    let on_node = json!({ "kubernetes.io/hostname": node });
    apply(
        admin,
        json!({ "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": NAMESPACE } }),
    )
    .await;
    let web = |revision: &str| {
        json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "web", "namespace": NAMESPACE, "labels": { "app": "web" } },
            "spec": {
                "replicas": 2,
                "revisionHistoryLimit": 3,
                "selector": { "matchLabels": { "app": "web" } },
                "strategy": { "rollingUpdate": { "maxSurge": "25%", "maxUnavailable": 0 } },
                "template": {
                    "metadata": { "labels": { "app": "web" }, "annotations": { "twigo.io/revision": revision } },
                    "spec": {
                        "nodeSelector": on_node,
                        "containers": [{
                            "name": "app",
                            "image": PAUSE,
                            "ports": [{ "name": "http", "containerPort": 8080 }],
                            "resources": { "requests": { "cpu": "10m", "memory": "16Mi" }, "limits": { "memory": "64Mi" } },
                            "env": [
                                { "name": "MODE", "valueFrom": { "configMapKeyRef": { "name": "settings", "key": "mode" } } },
                                { "name": "PASSWORD", "valueFrom": { "secretKeyRef": { "name": "credentials", "key": "password" } } },
                                { "name": "POD_IP", "valueFrom": { "fieldRef": { "fieldPath": "status.podIP" } } },
                                { "name": "MEMORY_MI", "valueFrom": { "resourceFieldRef": { "resource": "limits.memory", "divisor": "1Mi" } } },
                            ],
                            "envFrom": [{ "configMapRef": { "name": "settings" }, "prefix": "APP_" }],
                            "volumeMounts": [{ "name": "settings", "mountPath": "/etc/web", "readOnly": true }],
                        }],
                        "volumes": [{ "name": "settings", "configMap": { "name": "settings" } }],
                    },
                },
            },
        })
    };
    apply(
        admin,
        json!({
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": { "name": "settings", "namespace": NAMESPACE },
            "data": { "mode": "fast", "app.yaml": "listen: 8080\nlog: info\n" },
            "binaryData": { "logo.png": "iVBORw0KGgo=" },
        }),
    )
    .await;
    apply(
        admin,
        json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": "credentials", "namespace": NAMESPACE },
            "type": "Opaque",
            "data": { "password": "dGVzdC1wYXNzd29yZA==", "key.der": "MIIBCgKCAQEA/w==" },
        }),
    )
    .await;
    let deployments = dynamic(
        admin,
        "apps",
        "v1",
        "Deployment",
        "deployments",
        Some(NAMESPACE),
    );
    let first = deployments.get_opt("web").await.unwrap().is_none();
    if first {
        apply(admin, web("1")).await;
        settled(&deployments, "web", |status| {
            status["updatedReplicas"] == 2 && status["readyReplicas"] == 2
        })
        .await;
    }
    apply(admin, web("2")).await;
    settled(&deployments, "web", |status| {
        status["updatedReplicas"] == 2 && status["readyReplicas"] == 2 && status["replicas"] == 2
    })
    .await;
    apply(admin, json!({
        "apiVersion": "v1", "kind": "Service",
        "metadata": { "name": "web", "namespace": NAMESPACE },
        "spec": { "selector": { "app": "web" }, "ports": [{ "name": "http", "port": 80, "targetPort": "http" }] },
    }))
    .await;
    apply(admin, json!({
        "apiVersion": "networking.k8s.io/v1", "kind": "Ingress",
        "metadata": { "name": "web", "namespace": NAMESPACE },
        "spec": {
            "ingressClassName": "nginx",
            "tls": [{ "hosts": ["web.example.test"], "secretName": "web-tls" }],
            "rules": [{
                "host": "web.example.test",
                "http": { "paths": [
                    { "path": "/", "pathType": "Prefix", "backend": { "service": { "name": "web", "port": { "name": "http" } } } },
                    { "path": "/reports", "pathType": "Prefix", "backend": { "service": { "name": "reports", "port": { "number": 8080 } } } },
                ] },
            }],
        },
    }))
    .await;
    apply(admin, json!({
        "apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": { "name": "db", "namespace": NAMESPACE },
        "spec": {
            "serviceName": "db",
            "replicas": 1,
            "selector": { "matchLabels": { "app": "db" } },
            "template": {
                "metadata": { "labels": { "app": "db" } },
                "spec": {
                    "nodeSelector": on_node,
                    "containers": [{
                        "name": "db",
                        "image": PAUSE,
                        "volumeMounts": [{ "name": "data", "mountPath": "/var/lib/db" }],
                    }],
                },
            },
            "volumeClaimTemplates": [{
                "metadata": { "name": "data" },
                "spec": { "accessModes": ["ReadWriteOnce"], "resources": { "requests": { "storage": "1Gi" } } },
            }],
        },
    }))
    .await;
    apply(
        admin,
        json!({
            "apiVersion": "apps/v1", "kind": "DaemonSet",
            "metadata": { "name": "agent", "namespace": NAMESPACE },
            "spec": {
                "selector": { "matchLabels": { "app": "agent" } },
                "template": {
                    "metadata": { "labels": { "app": "agent" } },
                    "spec": {
                        "nodeSelector": on_node,
                        "containers": [{ "name": "agent", "image": PAUSE }],
                    },
                },
            },
        }),
    )
    .await;
    let job = |name: &str| {
        json!({
            "spec": {
                "nodeSelector": on_node,
                "restartPolicy": "Never",
                "containers": [{ "name": name, "image": SHELL, "command": ["sh", "-c", format!("echo {name} done")] }],
            },
        })
    };
    apply(admin, json!({
        "apiVersion": "batch/v1", "kind": "Job",
        "metadata": { "name": "migrate", "namespace": NAMESPACE },
        "spec": { "backoffLimit": 2, "ttlSecondsAfterFinished": 86400, "template": job("migrate") },
    }))
    .await;
    apply(
        admin,
        json!({
            "apiVersion": "batch/v1", "kind": "CronJob",
            "metadata": { "name": "report", "namespace": NAMESPACE },
            "spec": {
                "schedule": "*/1 * * * *",
                "timeZone": "Etc/UTC",
                "concurrencyPolicy": "Forbid",
                "successfulJobsHistoryLimit": 2,
                "jobTemplate": { "spec": { "template": job("report") } },
            },
        }),
    )
    .await;
    let pod = |name: &str, container: Value| {
        json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": name, "namespace": NAMESPACE, "labels": { "app": name } },
            "spec": { "nodeSelector": on_node, "containers": [container] },
        })
    };
    apply(admin, json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": { "name": "api", "namespace": NAMESPACE },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": { "app": "api" } },
            "template": {
                "metadata": { "labels": { "app": "api" } },
                "spec": {
                    "nodeSelector": on_node,
                    "containers": [{
                        "name": "api",
                        "image": SHELL,
                        "command": ["sh", "-c", "echo 'panic: dial tcp 10.96.0.20:5432: connect: connection refused' >&2; exit 1"],
                        "terminationMessagePolicy": "FallbackToLogsOnError",
                    }],
                },
            },
        },
    }))
    .await;
    apply(
        admin,
        pod(
            "pull",
            json!({ "name": "api", "image": "registry.invalid/twigo/api:1.0" }),
        ),
    )
    .await;
    apply(admin, pod("unready", json!({
        "name": "api",
        "image": PAUSE,
        "readinessProbe": { "tcpSocket": { "port": 9 }, "periodSeconds": 2, "failureThreshold": 1 },
    })))
    .await;
    apply(admin, json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": { "name": "pending", "namespace": NAMESPACE },
        "spec": { "nodeSelector": { "disktype": "ssd" }, "containers": [{ "name": "api", "image": PAUSE }] },
    }))
    .await;

    let pods = dynamic(admin, "", "v1", "Pod", "pods", Some(NAMESPACE));
    let containers = |status: &Value| status["containerStatuses"][0].clone();
    let crash = pod_of(admin, "app=api").await;
    settled(&pods, &crash, |status| {
        let container = containers(status);
        container["state"]["waiting"]["reason"] == "CrashLoopBackOff"
            && container["restartCount"].as_u64() >= Some(2)
    })
    .await;
    settled(&pods, "pull", |status| {
        containers(status)["state"]["waiting"]["reason"] == "ImagePullBackOff"
    })
    .await;
    settled(&pods, "unready", |status| {
        containers(status)["state"]["running"].is_object() && containers(status)["ready"] == false
    })
    .await;
    settled(&pods, "pending", |status| {
        status["conditions"][0]["reason"] == "Unschedulable"
    })
    .await;
    let statefulsets = dynamic(
        admin,
        "apps",
        "v1",
        "StatefulSet",
        "statefulsets",
        Some(NAMESPACE),
    );
    settled(&statefulsets, "db", |status| status["readyReplicas"] == 1).await;
    let claims = dynamic(
        admin,
        "",
        "v1",
        "PersistentVolumeClaim",
        "persistentvolumeclaims",
        Some(NAMESPACE),
    );
    settled(&claims, "data-db-0", |status| status["phase"] == "Bound").await;
    let daemonsets = dynamic(
        admin,
        "apps",
        "v1",
        "DaemonSet",
        "daemonsets",
        Some(NAMESPACE),
    );
    settled(&daemonsets, "agent", |status| {
        status["numberReady"].as_u64() >= Some(1)
            && status["numberReady"] == status["desiredNumberScheduled"]
    })
    .await;
    let jobs = dynamic(admin, "batch", "v1", "Job", "jobs", Some(NAMESPACE));
    settled(&jobs, "migrate", |status| {
        status["succeeded"] == 1 && status["completionTime"].is_string()
    })
    .await;
    let cronjobs = dynamic(admin, "batch", "v1", "CronJob", "cronjobs", Some(NAMESPACE));
    settled(&cronjobs, "report", |status| {
        status["lastSuccessfulTime"].is_string()
    })
    .await;
    node
}

fn dynamic(
    admin: &kube::Client,
    group: &str,
    version: &str,
    kind: &str,
    plural: &str,
    namespace: Option<&str>,
) -> Api<DynamicObject> {
    let resource =
        ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, version, kind), plural);
    match namespace {
        Some(namespace) => Api::namespaced_with(admin.clone(), namespace, &resource),
        None => Api::all_with(admin.clone(), &resource),
    }
}

/// Applies an object server-side, so a second run changes nothing.
async fn apply(admin: &kube::Client, object: Value) {
    let api_version = object["apiVersion"].as_str().unwrap().to_owned();
    let (group, version) = api_version.split_once('/').unwrap_or(("", &api_version));
    let kind = object["kind"].as_str().unwrap().to_owned();
    let plural = match kind.as_str() {
        "Ingress" => "ingresses".to_owned(),
        kind => format!("{}s", kind.to_ascii_lowercase()),
    };
    let namespace = object["metadata"]["namespace"].as_str().map(str::to_owned);
    let name = object["metadata"]["name"].as_str().unwrap().to_owned();
    dynamic(admin, group, version, &kind, &plural, namespace.as_deref())
        .patch(
            &name,
            &PatchParams::apply("twigo-record").force(),
            &Patch::Apply(object),
        )
        .await
        .unwrap_or_else(|error| panic!("apply {kind} {name}: {error}"));
}

/// Waits up to five minutes for an object's status to hold.
async fn settled(api: &Api<DynamicObject>, name: &str, holds: impl Fn(&Value) -> bool) {
    for _ in 0..300 {
        if let Some(object) = api.get_opt(name).await.unwrap()
            && holds(&object.data["status"])
        {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    panic!("{name} did not settle within five minutes");
}

/// The first pod, by name, that a label selector picks, once one exists.
async fn pod_of(admin: &kube::Client, selector: &str) -> String {
    let pods = dynamic(admin, "", "v1", "Pod", "pods", Some(NAMESPACE));
    for _ in 0..60 {
        let mut names: Vec<String> = pods
            .list(&kube::api::ListParams::default().labels(selector))
            .await
            .unwrap()
            .items
            .into_iter()
            .filter_map(|pod| pod.metadata.name)
            .collect();
        names.sort();
        if let Some(name) = names.into_iter().next() {
            return name;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    panic!("no pod for {selector} within a minute");
}

/// The name of the object that controls a pod.
async fn controller_of(admin: &kube::Client, pod: &str) -> String {
    let pod = dynamic(admin, "", "v1", "Pod", "pods", Some(NAMESPACE))
        .get(pod)
        .await
        .unwrap();
    pod.metadata
        .owner_references
        .into_iter()
        .flatten()
        .find(|owner| owner.controller == Some(true))
        .map(|owner| owner.name)
        .expect("a controller")
}
