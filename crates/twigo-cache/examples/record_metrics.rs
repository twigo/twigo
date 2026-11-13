//! Records what the Metrics API answers into `tests/fixtures` from a kind
//! cluster of `bench/cluster.sh`: the pods of a namespace of its own, which
//! kwok gives the usage their annotations say, those of `kube-system`, whose
//! kubelet gives real ones, the nodes, the group in discovery, and, with
//! metrics-server scaled to none until discovery says it is stale, what a
//! list answers then. It scales metrics-server back.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run -p twigo-cache --example record_metrics

use std::path::Path;
use std::time::Duration;

use http::header::{ACCEPT, CONTENT_TYPE};
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::api::{DeleteParams, Patch, PatchParams, PostParams};
use kube::client::Body;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use serde_json::{Value, json};
use twigo_kube::client::{Clients, Gate, Options};

const NAMESPACE: &str = "record-metrics";
const API: &str = "/apis/metrics.k8s.io/v1beta1";
const AGGREGATED: &str =
    "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json";

struct Answer {
    status: StatusCode,
    content_type: String,
    body: Vec<u8>,
}

async fn get(clients: &Clients, path: &str, accept: &str) -> Answer {
    let request = Request::get(path)
        .header(ACCEPT, accept)
        .body(Body::from(Vec::new()))
        .unwrap();
    let response = clients.api.send(request).await.unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    Answer {
        status,
        content_type,
        body: body.to_vec(),
    }
}

async fn group(clients: &Clients) -> Value {
    let answer = get(clients, "/apis", AGGREGATED).await;
    let list: Value = serde_json::from_slice(&answer.body).unwrap();
    list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["metadata"]["name"] == "metrics.k8s.io")
        .expect("the group metrics.k8s.io")
        .clone()
}

async fn until<F: Future<Output = bool>>(what: &str, mut reached: impl FnMut() -> F) {
    for _ in 0..90 {
        if reached().await {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    panic!("{what} within three minutes");
}

fn pod(name: &str, containers: &[&str], cpu: &str, memory: &str) -> Pod {
    serde_json::from_value(json!({
        "metadata": {
            "name": name,
            "annotations": {
                "kwok.x-k8s.io/usage-cpu": cpu,
                "kwok.x-k8s.io/usage-memory": memory,
            },
        },
        "spec": {
            "nodeSelector": { "type": "kwok" },
            "tolerations": [{ "key": "kwok.x-k8s.io/node", "operator": "Exists", "effect": "NoSchedule" }],
            "containers": containers
                .iter()
                .map(|name| json!({ "name": name, "image": "fake-image" }))
                .collect::<Vec<_>>(),
        },
    }))
    .unwrap()
}

fn write(name: &str, bytes: &[u8]) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::write(&file, bytes).expect("write the fixture");
    println!("{}", file.display());
}

fn pretty(value: &Value) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(value).unwrap();
    text.push('\n');
    text.into_bytes()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: only kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    let clients = Clients::new(&config, Gate::unrestricted(), Options::default()).unwrap();
    let client = clients.api.clone();

    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
    until("the namespace of an earlier run gone", || async {
        namespaces.get_opt(NAMESPACE).await.unwrap().is_none()
    })
    .await;
    namespaces
        .create(
            &PostParams::default(),
            &serde_json::from_value(json!({ "metadata": { "name": NAMESPACE } })).unwrap(),
        )
        .await
        .unwrap();
    let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    for pod in [
        pod("web", &["app"], "100m", "40Mi"),
        pod("multi", &["a", "b"], "50m", "20Mi"),
    ] {
        pods.create(&PostParams::default(), &pod).await.unwrap();
    }

    let list = format!("{API}/namespaces/{NAMESPACE}/pods");
    until("a sample of each pod", || async {
        let answer = get(&clients, &list, "application/json").await;
        answer.status.is_success()
            && serde_json::from_slice::<Value>(&answer.body).unwrap()["items"]
                .as_array()
                .is_some_and(|items| items.len() == 2)
    })
    .await;
    write(
        "metrics-pods.json",
        &get(&clients, &list, "application/json").await.body,
    );
    write(
        "metrics-pods-kube-system.json",
        &get(
            &clients,
            &format!("{API}/namespaces/kube-system/pods"),
            "application/json",
        )
        .await
        .body,
    );
    write(
        "metrics-nodes.json",
        &get(&clients, &format!("{API}/nodes"), "application/json")
            .await
            .body,
    );
    write("metrics-discovery.json", &pretty(&group(&clients).await));

    let deployments: Api<Deployment> = Api::namespaced(client.clone(), "kube-system");
    let scale = |replicas: u32| {
        let deployments = deployments.clone();
        async move {
            deployments
                .patch_scale(
                    "metrics-server",
                    &PatchParams::default(),
                    &Patch::Merge(json!({ "spec": { "replicas": replicas } })),
                )
                .await
                .unwrap();
        }
    };
    scale(0).await;
    until("discovery saying the group is stale", || async {
        group(&clients).await["versions"][0]["freshness"] == "Stale"
    })
    .await;
    write(
        "metrics-discovery-stale.json",
        &pretty(&group(&clients).await),
    );
    let down = get(&clients, &list, "application/json").await;
    assert_eq!(down.status, StatusCode::SERVICE_UNAVAILABLE);
    write(
        "metrics-unavailable.json",
        &pretty(&json!({
            "status": down.status.as_u16(),
            "contentType": down.content_type,
            "body": String::from_utf8(down.body).unwrap(),
        })),
    );

    scale(1).await;
    until("metrics-server answering again", || async {
        get(&clients, &list, "application/json")
            .await
            .status
            .is_success()
    })
    .await;
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
}
