//! Heap retained by decoded Table rows, next to the object representations
//! of 3.3, for the pods of one namespace (`bench/pods.sh`).
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run --release -p twigo-cache --example table_memory [namespace]

use k8s_openapi::api::core::v1::Pod;
use kube::api::ListParams;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use twigo_cache::decode::Decode;
use twigo_cache::request::{self, Collection};
use twigo_cache::table::{Row, TableDecoder};
use twigo_kube::client::{Clients, Gate, Options};

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

const PAGE: u32 = 500;

fn heap() -> dhat::HeapStats {
    dhat::HeapStats::get()
}

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
    let client = Clients::new(&config, Gate::unrestricted(), Options::default())
        .unwrap()
        .api;

    let collection = format!("/api/v1/namespaces/{namespace}/pods");
    let mut bodies = Vec::new();
    let mut token: Option<Box<str>> = None;
    loop {
        let body = client
            .request_text(request::list(
                &Collection::table(&collection),
                PAGE,
                token.as_deref(),
            ))
            .await
            .unwrap();
        token = TableDecoder::new()
            .decode_list(body.as_bytes())
            .unwrap()
            .continue_token;
        bodies.push(body);
        if token.is_none() {
            break;
        }
    }
    let body_bytes: usize = bodies.iter().map(String::len).sum();

    let before = heap();
    let mut decoder = TableDecoder::new();
    let mut rows: Vec<Row> = Vec::new();
    for body in &bodies {
        rows.extend(decoder.decode_list(body.as_bytes()).unwrap().items);
    }
    rows.shrink_to_fit();
    let after = heap();
    let count = rows.len();
    let table = after.curr_bytes - before.curr_bytes;
    let churn = after.total_bytes - before.total_bytes;
    drop(rows);
    drop(bodies);

    let pods = Api::<Pod>::namespaced(client.clone(), &namespace);
    let params = ListParams::default().limit(PAGE);

    let before = heap().curr_bytes;
    let mut full = Vec::new();
    let mut params_page = params.clone();
    loop {
        let list = pods.list(&params_page).await.unwrap();
        full.extend(list.items);
        match list.metadata.continue_ {
            Some(token) if !token.is_empty() => params_page = params.clone().continue_token(&token),
            _ => break,
        }
    }
    full.shrink_to_fit();
    let full_bytes = heap().curr_bytes - before;
    for pod in &mut full {
        pod.metadata.managed_fields = None;
    }
    let full_without = heap().curr_bytes - before;
    drop(full);

    let before = heap().curr_bytes;
    let mut partial = Vec::new();
    let mut params_page = params.clone();
    loop {
        let list = pods.list_metadata(&params_page).await.unwrap();
        partial.extend(list.items);
        match list.metadata.continue_ {
            Some(token) if !token.is_empty() => params_page = params.clone().continue_token(&token),
            _ => break,
        }
    }
    partial.shrink_to_fit();
    let partial_bytes = heap().curr_bytes - before;
    for object in &mut partial {
        object.metadata.managed_fields = None;
    }
    let partial_without = heap().curr_bytes - before;
    drop(partial);

    println!(
        "{count} pods in {namespace}, Table responses {}",
        mib(body_bytes)
    );
    println!();
    println!("| Representation | {count} pods | Per pod |");
    println!("| --- | --- | --- |");
    for (name, bytes) in [
        ("Full Pod", full_bytes),
        ("Pod without managedFields", full_without),
        ("`PartialObjectMeta<Pod>`", partial_bytes),
        (
            "`PartialObjectMeta<Pod>` without managedFields",
            partial_without,
        ),
        ("Table row (`twigo_cache::table::Row`)", table),
    ] {
        println!("| {name} | {} | {} B |", mib(bytes), bytes / count.max(1));
    }
    println!();
    println!(
        "Decoding the rows allocated {} in all.",
        mib(churn as usize)
    );
}
