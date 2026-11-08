//! What loading an OpenAPI document costs the process in resident memory:
//! the size of the document, then the process's RSS before its first load,
//! which fetches, hashes, stores and parses it, while its `Document` is held,
//! after it is dropped, and after ten more loads from the disk, which shows
//! whether freed memory is reused or the process keeps growing. One document
//! per process, so that none leaves its memory in the baseline of the next.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run --release -p twigo-kube --example openapi_memory -- apps/v1 Deployment

use kube::Config;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::core::GroupVersionKind;
use twigo_kube::client::{Clients, Gate, Options};
use twigo_kube::openapi::{Cache, Document};

fn rss_kib() -> u64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps runs");
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .unwrap()
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
    let mut args = std::env::args().skip(1);
    let api_version = args.next().expect("an apiVersion, such as apps/v1");
    let kind = args.next().expect("a kind, such as Deployment");
    let (group, version) = api_version.rsplit_once('/').unwrap_or(("", &api_version));
    let gvk = GroupVersionKind::gvk(group, version, &kind);

    clients.api.apiserver_version().await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path());

    let before = rss_kib();
    let document = Document::load(&clients.api, &cache, group, version)
        .await
        .unwrap();
    let schema = document.json_schema(&gvk).unwrap();
    let held = rss_kib();
    let schema_bytes = schema.len();
    drop((document, schema));
    let dropped = rss_kib();
    for _ in 0..10 {
        let document = Document::load(&clients.api, &cache, group, version)
            .await
            .unwrap();
        drop(document.json_schema(&gvk));
    }
    let after = rss_kib();
    let bytes = std::fs::read_dir(dir.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .metadata()
        .unwrap()
        .len();

    println!(
        "| Document | Bytes | Schema of {kind} | RSS before | Held | Dropped | After 10 more |"
    );
    println!("| --- | --- | --- | --- | --- | --- | --- |");
    println!(
        "| `{api_version}` | {bytes} | {schema_bytes} | {before} KiB | {held} KiB | {dropped} KiB | {after} KiB |"
    );
}
