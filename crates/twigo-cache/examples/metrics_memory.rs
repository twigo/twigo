//! Heap the poller holds for the samples of every pod of the cluster
//! (`bench/pods.sh`, kwok's usage, `bench/cluster.sh`): one reader of the
//! cluster-wide scope, next to the hub's `hub_memory`.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run --release -p twigo-cache --example metrics_memory

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use kube::Config;
use kube::config::{KubeConfigOptions, Kubeconfig};
use tokio::sync::watch;
use twigo_cache::discovery::Followers;
use twigo_cache::hub::{Connect, Hub};
use twigo_cache::metrics::{Kind, Poller, Scope};
use twigo_kube::client::{Clients, Gate, Options};
use twigo_kube::discovery::Cache;

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

fn mib(bytes: usize) -> String {
    format!("{:.2} MiB", bytes as f64 / (1024.0 * 1024.0))
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let _profiler = dhat::Profiler::builder().testing().build();
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
    let clients =
        Arc::new(Clients::new(&config, Gate::unrestricted(), Options::default()).unwrap());
    clients.api.apiserver_version().await.unwrap();
    let connect: Connect = {
        let clients = Arc::clone(&clients);
        Arc::new(move |_context| {
            let clients = Arc::clone(&clients);
            Box::pin(async move { Ok(clients) })
        })
    };
    let directory =
        std::env::temp_dir().join(format!("twigo-metrics-memory-{}", std::process::id()));
    let hub = Hub::new(connect);
    let followers = Followers::new(hub.clone(), Arc::new(Cache::new(&directory)));
    let api = followers
        .get(&context, async { watch::channel(None).1 })
        .await
        .api();
    let served = Poller::new(hub).context(&context, api);
    while !served.api().columns(Kind::Pods) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let mut reader = served.reader(Kind::Pods);
    let before = dhat::HeapStats::get();
    reader.want(HashSet::from([Scope::Cluster]));
    let samples = loop {
        let update = reader.drain();
        if let Some(reset) = update.resets.into_iter().next() {
            break reset.samples;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let after = dhat::HeapStats::get();
    let held = after.curr_bytes - before.curr_bytes;
    let churn = after.total_bytes - before.total_bytes;
    let count = samples.len();

    println!("{count} pods with samples");
    println!();
    println!("| Representation | {count} pods | Per pod |");
    println!("| --- | --- | --- |");
    println!(
        "| The poller with one cluster-wide scope (`twigo_cache::metrics`) | {} | {} B |",
        mib(held),
        held / count.max(1)
    );
    println!();
    println!(
        "Listing, reading and parsing the answer allocated {} in all.",
        mib(churn as usize)
    );
    std::fs::remove_dir_all(directory).ok();
}
