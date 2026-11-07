//! Records the mock backend's resources from a kind or kwok cluster's
//! discovery, as `resources_watch` answers them.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run -p twigo-kube --example record_discovery

use std::path::Path;

use kube::Config;
use kube::config::{KubeConfigOptions, Kubeconfig};
use twigo_kube::client::{Clients, Gate, Options};
use twigo_kube::discovery::Discovery;

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
    let discovery = Discovery::refresh(&clients.api, None)
        .await
        .unwrap()
        .expect("a first refresh answers");
    let json = serde_json::to_string_pretty(&discovery.resources()).expect("resources serialize");
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/src/mock/resources.json");
    std::fs::write(&file, json + "\n").expect("write the resources");
    println!("{}", file.display());
}
