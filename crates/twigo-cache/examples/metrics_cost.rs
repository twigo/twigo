//! What the Metrics API costs per scope, to set where one list of the whole
//! cluster beats one per namespace (`CLUSTER_WIDE_ABOVE`): the time and the
//! bytes of the lists of the `k` namespaces with the most pods, sent
//! together as the poller sends them, against the cluster-wide list, gzipped
//! as the poller asks.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run --release -p twigo-cache --example metrics_cost [runs]

use std::collections::BTreeMap;
use std::io::Read;
use std::time::{Duration, Instant};

use flate2::read::MultiGzDecoder;
use futures::future::join_all;
use http::Request;
use http::header::{ACCEPT, ACCEPT_ENCODING};
use http_body_util::BodyExt;
use kube::Config;
use kube::client::Body;
use kube::config::{KubeConfigOptions, Kubeconfig};
use serde_json::Value;
use twigo_kube::client::{Clients, Gate, Options};

const API: &str = "/apis/metrics.k8s.io/v1beta1";

async fn list(clients: &Clients, path: &str) -> (usize, Vec<u8>) {
    let request = Request::get(path)
        .header(ACCEPT, "application/json")
        .header(ACCEPT_ENCODING, "gzip")
        .body(Body::from(Vec::new()))
        .unwrap();
    let response = clients.api.send(request).await.unwrap();
    assert!(
        response.status().is_success(),
        "{path}: {}",
        response.status()
    );
    let gzipped = response
        .headers()
        .contains_key(http::header::CONTENT_ENCODING);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let wire = body.len();
    if !gzipped {
        return (wire, body.to_vec());
    }
    let mut plain = Vec::new();
    MultiGzDecoder::new(&body[..])
        .read_to_end(&mut plain)
        .unwrap();
    (wire, plain)
}

async fn together(clients: &Clients, paths: &[String]) -> (Duration, usize, usize) {
    let start = Instant::now();
    let lists = join_all(paths.iter().map(|path| list(clients, path))).await;
    let took = start.elapsed();
    (
        took,
        lists.iter().map(|(wire, _)| wire).sum(),
        lists.iter().map(|(_, plain)| plain.len()).sum(),
    )
}

fn median(mut values: Vec<Duration>) -> Duration {
    values.sort();
    values[values.len() / 2]
}

#[tokio::main]
async fn main() {
    let runs: usize = std::env::args()
        .nth(1)
        .map_or(15, |runs| runs.parse().expect("a number of runs"));
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

    let (_, all) = list(&clients, &format!("{API}/pods")).await;
    let all: Value = serde_json::from_slice(&all).unwrap();
    let mut pods: BTreeMap<&str, usize> = BTreeMap::new();
    for item in all["items"].as_array().unwrap() {
        *pods
            .entry(item["metadata"]["namespace"].as_str().unwrap())
            .or_default() += 1;
    }
    let mut namespaces: Vec<(&str, usize)> = pods.into_iter().collect();
    namespaces.sort_by_key(|(_, pods)| std::cmp::Reverse(*pods));
    let total: usize = namespaces.iter().map(|(_, pods)| pods).sum();

    println!(
        "{total} pods with metrics in {} namespaces, {runs} runs each, medians; the lists of the k namespaces with the most pods, sent together.",
        namespaces.len()
    );
    println!();
    println!("| Scope | Pods | Requests | Time | Gzipped bytes | JSON bytes |");
    println!("| --- | --- | --- | --- | --- | --- |");
    for k in 1..=namespaces.len() {
        let chosen = &namespaces[..k];
        let paths: Vec<String> = chosen
            .iter()
            .map(|(namespace, _)| format!("{API}/namespaces/{namespace}/pods"))
            .collect();
        let mut times = Vec::new();
        let (mut wire, mut plain) = (0, 0);
        for _ in 0..runs {
            let (took, w, p) = together(&clients, &paths).await;
            times.push(took);
            (wire, plain) = (w, p);
        }
        println!(
            "| {k} namespaces | {} | {k} | {:.1} ms | {wire} | {plain} |",
            chosen.iter().map(|(_, pods)| pods).sum::<usize>(),
            median(times).as_secs_f64() * 1000.0,
        );
    }
    let paths = [format!("{API}/pods")];
    let mut times = Vec::new();
    let (mut wire, mut plain) = (0, 0);
    for _ in 0..runs {
        let (took, w, p) = together(&clients, &paths).await;
        times.push(took);
        (wire, plain) = (w, p);
    }
    println!(
        "| the cluster | {total} | 1 | {:.1} ms | {wire} | {plain} |",
        median(times).as_secs_f64() * 1000.0,
    );
}
