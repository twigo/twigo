//! Heap the hub holds for the pods of one namespace (`bench/pods.sh`): one
//! Table upstream, its row store and its watch, next to the decoded rows of
//! `table_memory`.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run --release -p twigo-cache --example hub_memory [namespace]

use std::sync::Arc;

use kube::Config;
use kube::config::{KubeConfigOptions, Kubeconfig};
use twigo_cache::hub::{Connect, Hub, Query, Resource, RowFormat};
use twigo_ipc::ViewState;
use twigo_kube::client::{Clients, Options};

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

fn mib(bytes: usize) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let _profiler = dhat::Profiler::builder().testing().build();
    let namespace = std::env::args().nth(1).unwrap_or_else(|| "bench".into());
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
    let clients = Arc::new(Clients::new(&config, Options::default()).unwrap());
    // The connection and its buffers come before the measurement.
    clients.api.apiserver_version().await.unwrap();
    let connect: Connect = {
        let clients = Arc::clone(&clients);
        Arc::new(move |_context| {
            let clients = Arc::clone(&clients);
            Box::pin(async move { Ok(clients) })
        })
    };

    let before = dhat::HeapStats::get();
    let hub = Hub::new(connect);
    let mut pods = hub
        .rows(Query {
            context,
            resource: Resource {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
                namespaced: true,
            },
            format: RowFormat::Table,
            namespaces: vec![namespace.clone()],
            field_selector: None,
        })
        .await
        .unwrap();
    while pods.state() != ViewState::Ready {
        pods.changed().await;
    }
    let after = dhat::HeapStats::get();
    let held = after.curr_bytes - before.curr_bytes;
    let churn = after.total_bytes - before.total_bytes;
    let count = pods.items().len();

    println!("{count} pods in {namespace}");
    println!();
    println!("| Representation | {count} pods | Per pod |");
    println!("| --- | --- | --- |");
    println!(
        "| The hub with one Table upstream (`twigo_cache::hub`) | {} | {} B |",
        mib(held),
        held / count.max(1)
    );
    println!();
    println!(
        "Listing and storing the rows allocated {} in all.",
        mib(churn as usize)
    );
}
