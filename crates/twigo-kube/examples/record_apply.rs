//! Records the objects whose managedFields the apply tests read, from a kind
//! cluster with kwok, into `crates/twigo-kube/tests/fixtures/apply`: a
//! Deployment another manager created, with what Twigo took and added, and
//! a ConfigMap whose keys are Twigo's alone, shared and another's. The
//! namespace `record-apply` is left behind.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run -p twigo-kube --example record_apply

use std::path::Path;

use http::Request;
use http_body_util::BodyExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace};
use kube::api::{Api, Patch, PatchParams, PostParams};
use kube::client::Body;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use serde_json::json;

const NAMESPACE: &str = "record-apply";

async fn record(client: &Client, path: &str, file: &Path) {
    let request = Request::get(path)
        .header("Accept", "application/json")
        .body(Body::from(Vec::new()))
        .unwrap();
    let response = client.send(request).await.unwrap();
    assert!(
        response.status().is_success(),
        "{path}: {}",
        response.status()
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    std::fs::write(file, &body).unwrap();
    println!("{}", file.display());
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
    let client = Client::try_from(config).unwrap();

    Api::<Namespace>::all(client.clone())
        .create(
            &PostParams::default(),
            &serde_json::from_value(json!({ "metadata": { "name": NAMESPACE } })).unwrap(),
        )
        .await
        .unwrap();
    let as_other = PostParams {
        field_manager: Some("other".to_owned()),
        ..PostParams::default()
    };

    let deployments = Api::<Deployment>::namespaced(client.clone(), NAMESPACE);
    let deployment: Deployment = serde_json::from_value(json!({
        "metadata": { "name": "web", "labels": { "team": "a" } },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": { "app": "web" } },
            "template": {
                "metadata": { "labels": { "app": "web" } },
                "spec": {
                    "nodeName": "kwok-node-0",
                    "containers": [{
                        "name": "app",
                        "image": "fake:1",
                        "ports": [{ "name": "http", "containerPort": 80 }],
                    }],
                },
            },
        },
    }))
    .unwrap();
    deployments.create(&as_other, &deployment).await.unwrap();
    deployments
        .patch(
            "web",
            &PatchParams::apply("twigo").force(),
            &Patch::Apply(json!({
                "apiVersion": "apps/v1",
                "kind": "Deployment",
                "metadata": { "name": "web", "annotations": { "owner": "twigo" } },
                "spec": {
                    "replicas": 5,
                    "template": {
                        "spec": {
                            "containers": [{
                                "name": "app",
                                "ports": [{ "containerPort": 8080 }],
                            }],
                        },
                    },
                },
            })),
        )
        .await
        .unwrap();

    let configs = Api::<ConfigMap>::namespaced(client.clone(), NAMESPACE);
    let settings = |manager: &str, data: serde_json::Value| {
        let configs = configs.clone();
        let manager = manager.to_owned();
        async move {
            configs
                .patch(
                    "settings",
                    &PatchParams::apply(&manager),
                    &Patch::Apply(json!({
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "metadata": { "name": "settings" },
                        "data": data,
                    })),
                )
                .await
                .unwrap();
        }
    };
    settings("twigo", json!({ "only": "1", "shared": "2" })).await;
    settings("other", json!({ "shared": "2", "theirs": "3" })).await;

    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/apply");
    std::fs::create_dir_all(&fixtures).unwrap();
    record(
        &client,
        &format!("/apis/apps/v1/namespaces/{NAMESPACE}/deployments/web"),
        &fixtures.join("deployment.json"),
    )
    .await;
    record(
        &client,
        &format!("/api/v1/namespaces/{NAMESPACE}/configmaps/settings"),
        &fixtures.join("configmap.json"),
    )
    .await;
}
