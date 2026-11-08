//! Records what the OpenAPI tests read from a kind cluster that has kwok's
//! CRDs (`bench/cluster.sh`): the index and the documents of `apis/apps/v1`
//! and of kwok's group, as the server sent them, into
//! `crates/twigo-kube/tests/fixtures/openapi`, and the JSON Schema that
//! `schema_get` answers for a few kinds into the mock backend's
//! `packages/protocol/src/mock/schemas.json`.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run -p twigo-kube --example record_openapi

use std::path::Path;

use http::Request;
use http_body_util::BodyExt;
use kube::Client;
use kube::Config;
use kube::client::Body;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::core::GroupVersionKind;
use serde_json::{Map, Value};
use twigo_kube::client::{Clients, Gate, Options};
use twigo_kube::openapi::{Cache, Document};

const DOCUMENTS: [&str; 2] = ["apis/apps/v1", "apis/kwok.x-k8s.io/v1alpha1"];

const KINDS: [(&str, &str, &str); 4] = [
    ("apps", "v1", "Deployment"),
    ("", "v1", "Pod"),
    ("", "v1", "ConfigMap"),
    ("kwok.x-k8s.io", "v1alpha1", "Stage"),
];

async fn get(client: &Client, path: &str) -> Vec<u8> {
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
    response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec()
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

    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/openapi");
    std::fs::create_dir_all(&fixtures).unwrap();
    let index = get(&clients.api, "/openapi/v3").await;
    std::fs::write(fixtures.join("index.json"), &index).unwrap();
    let listed: Value = serde_json::from_slice(&index).unwrap();
    for document in DOCUMENTS {
        let url = listed["paths"][document]["serverRelativeURL"]
            .as_str()
            .unwrap_or_else(|| panic!("the cluster serves no {document}"));
        let file = format!("{}.json", document.replace('/', "-"));
        std::fs::write(fixtures.join(&file), get(&clients.api, url).await).unwrap();
        println!("{}", fixtures.join(file).display());
    }

    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path());
    let mut schemas = Map::new();
    for (group, version, kind) in KINDS {
        let document = Document::load(&clients.api, &cache, group, version)
            .await
            .unwrap();
        let schema = document
            .json_schema(&GroupVersionKind::gvk(group, version, kind))
            .unwrap_or_else(|| panic!("the cluster has no {kind}"));
        let api_version = if group.is_empty() {
            version.to_owned()
        } else {
            format!("{group}/{version}")
        };
        schemas.insert(
            format!("{api_version}/{kind}"),
            serde_json::from_str(&schema).unwrap(),
        );
    }
    let file =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/src/mock/schemas.json");
    std::fs::write(
        &file,
        serde_json::to_string_pretty(&schemas).unwrap() + "\n",
    )
    .unwrap();
    println!("{}", file.display());
}
