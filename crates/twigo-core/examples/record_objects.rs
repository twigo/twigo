//! Records objects from a kind cluster as `twigo-describe` reads them: the
//! object, the cells the server prints for it and its events. The tests of
//! `twigo-describe` describe them, and their documents become the mock
//! backend's.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run -p twigo-core --example record_objects

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod, Secret, Service};
use kube::api::{ListParams, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use serde_json::{Value, json};
use twigo_cache::hub::{Connect, Hub, Resource, Subscription};
use twigo_cache::object::Object;
use twigo_kube::client::{Clients, Options};

const NAMESPACE: &str = "overview";

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
    create(&admin).await;

    let clients = Arc::new(Clients::new(&config, Options::default()).unwrap());
    let connect: Connect = Arc::new(move |_context| {
        let clients = Arc::clone(&clients);
        Box::pin(async move { Ok(clients) })
    });
    let hub = Hub::new(connect);
    let pod = Api::<Pod>::namespaced(admin.clone(), NAMESPACE)
        .list(&ListParams::default().labels("app=web"))
        .await
        .unwrap()
        .items
        .into_iter()
        .next()
        .and_then(|pod| pod.metadata.name)
        .expect("a pod of the deployment");
    let targets = [
        (
            "pod",
            resource("", "v1", "pods", true),
            Some(NAMESPACE),
            pod,
        ),
        (
            "deployment",
            resource("apps", "v1", "deployments", true),
            Some(NAMESPACE),
            "web".to_owned(),
        ),
        (
            "service",
            resource("", "v1", "services", true),
            Some(NAMESPACE),
            "web".to_owned(),
        ),
        (
            "configmap",
            resource("", "v1", "configmaps", true),
            Some(NAMESPACE),
            "settings".to_owned(),
        ),
        (
            "secret",
            resource("", "v1", "secrets", true),
            Some(NAMESPACE),
            "credentials".to_owned(),
        ),
        (
            "node",
            resource("", "v1", "nodes", false),
            None,
            "kwok-node-0".to_owned(),
        ),
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
        let object = listed(&mut object).await;
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
                selector,
            )
            .unwrap();
        let mut events: Vec<_> = listed_all(&mut events)
            .await
            .iter()
            .map(|event| twigo_describe::event(&serde_json::from_str(event.json.get()).unwrap()))
            .collect();
        twigo_describe::newest_first(&mut events);
        let recorded = json!({
            "object": json,
            "printed": twigo_core::objects::printed(&object.1, &object.0.cells),
            "events": events,
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

async fn listed_all(subscription: &mut Subscription<Object>) -> Vec<Arc<Object>> {
    tokio::time::timeout(Duration::from_secs(30), subscription.whole())
        .await
        .expect("the events are listed within 30 s")
        .expect("the events can be listed")
}

/// A deployment of two pods on kind's own node, so their events are the
/// kubelet's, its service, a ConfigMap
/// with text and binary data and a Secret whose values are test values.
async fn create(admin: &kube::Client) {
    let namespaces = Api::<Namespace>::all(admin.clone());
    if namespaces.get_opt(NAMESPACE).await.unwrap().is_none() {
        namespaces
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({ "metadata": { "name": NAMESPACE } })).unwrap(),
            )
            .await
            .unwrap();
    }
    let post = PostParams::default();
    let deployments = Api::<Deployment>::namespaced(admin.clone(), NAMESPACE);
    if deployments.get_opt("web").await.unwrap().is_none() {
        let deployment = json!({
            "metadata": { "name": "web", "labels": { "app": "web" } },
            "spec": {
                "replicas": 2,
                "selector": { "matchLabels": { "app": "web" } },
                "template": {
                    "metadata": { "labels": { "app": "web" } },
                    "spec": {
                        "nodeSelector": { "node-role.kubernetes.io/control-plane": "" },
                        "containers": [{
                            "name": "app",
                            "image": "registry.k8s.io/pause:3.10",
                            "ports": [{ "name": "http", "containerPort": 8080 }],
                            "resources": { "requests": { "cpu": "10m", "memory": "16Mi" } },
                        }],
                    },
                },
            },
        });
        deployments
            .create(&post, &serde_json::from_value(deployment).unwrap())
            .await
            .unwrap();
    }
    let services = Api::<Service>::namespaced(admin.clone(), NAMESPACE);
    if services.get_opt("web").await.unwrap().is_none() {
        let service = json!({
            "metadata": { "name": "web" },
            "spec": { "selector": { "app": "web" }, "ports": [{ "name": "http", "port": 80, "targetPort": "http" }] },
        });
        services
            .create(&post, &serde_json::from_value(service).unwrap())
            .await
            .unwrap();
    }
    let config_maps = Api::<ConfigMap>::namespaced(admin.clone(), NAMESPACE);
    if config_maps.get_opt("settings").await.unwrap().is_none() {
        let config_map = json!({
            "metadata": { "name": "settings" },
            "data": { "mode": "fast", "app.yaml": "listen: 8080\nlog: info\n" },
            "binaryData": { "logo.png": "iVBORw0KGgo=" },
        });
        config_maps
            .create(&post, &serde_json::from_value(config_map).unwrap())
            .await
            .unwrap();
    }
    let secrets = Api::<Secret>::namespaced(admin.clone(), NAMESPACE);
    if secrets.get_opt("credentials").await.unwrap().is_none() {
        let secret = json!({
            "metadata": { "name": "credentials" },
            "type": "Opaque",
            "data": { "password": "dGVzdC1wYXNzd29yZA==", "key.der": "MIIBCgKCAQEA/w==" },
        });
        secrets
            .create(&post, &serde_json::from_value(secret).unwrap())
            .await
            .unwrap();
    }
    for _ in 0..60 {
        let ready = deployments
            .get("web")
            .await
            .unwrap()
            .status
            .and_then(|status| status.ready_replicas)
            == Some(2);
        if ready {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    panic!("the deployment is not ready within 60 s");
}
