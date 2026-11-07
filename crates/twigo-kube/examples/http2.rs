//! TCP connections and GET latency under 50 Table watches, over kube's default
//! HTTP/1.1 client and over the HTTP/2 api client, on the pods of one
//! namespace (`bench/pods.sh`); before that, an api client that streams
//! watches but sends no request for 100 s.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run --release -p twigo-kube --example http2 [namespace]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures::AsyncBufReadExt;
use futures::future::join_all;
use http::Request;
use k8s_openapi::api::apps::v1::Deployment;
use kube::api::{Patch, PatchParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use serde_json::json;
use tokio::task::JoinHandle;
use twigo_cache::decode::Decode;
use twigo_cache::request::{self, Collection, WatchFrom};
use twigo_cache::table::TableDecoder;
use twigo_kube::client::{Budgets, Clients, Gate, Options};

const WATCHES: usize = 50;
const REPLICAS: i32 = 5000;
const WINDOW: Duration = Duration::from_secs(10);
const IDLE: Duration = Duration::from_secs(100);

struct Watches {
    tasks: Vec<JoinHandle<()>>,
    events: Arc<AtomicU64>,
    bytes: Arc<AtomicU64>,
}

async fn resource_version(client: &Client, path: &str) -> Box<str> {
    let body = client
        .request_text(request::list(&Collection::table(path), 1, None))
        .await
        .unwrap();
    TableDecoder::new()
        .decode_list(body.as_bytes())
        .unwrap()
        .resource_version
}

impl Watches {
    async fn open(client: &Client, path: &str, version: &str, count: usize) -> Self {
        let streams = join_all((0..count).map(|_| {
            let watch = request::watch(
                &Collection::table(path),
                WatchFrom::ResourceVersion(version),
                600,
            );
            client.request_stream(watch)
        }))
        .await;
        let events = Arc::new(AtomicU64::new(0));
        let bytes = Arc::new(AtomicU64::new(0));
        let tasks = streams
            .into_iter()
            .map(|stream| {
                let mut stream = Box::pin(stream.unwrap());
                let (events, bytes) = (events.clone(), bytes.clone());
                tokio::spawn(async move {
                    let mut line = Vec::new();
                    loop {
                        line.clear();
                        match stream.read_until(b'\n', &mut line).await {
                            Ok(0) | Err(_) => break,
                            Ok(read) => {
                                events.fetch_add(1, Ordering::Relaxed);
                                bytes.fetch_add(read as u64, Ordering::Relaxed);
                            }
                        }
                    }
                })
            })
            .collect();
        Watches {
            tasks,
            events,
            bytes,
        }
    }

    fn events(&self) -> u64 {
        self.events.load(Ordering::Relaxed)
    }

    fn ended(&self) -> usize {
        self.tasks.iter().filter(|task| task.is_finished()).count()
    }

    fn close(self) -> u64 {
        for task in &self.tasks {
            task.abort();
        }
        self.bytes.load(Ordering::Relaxed)
    }
}

fn connections(port: u16) -> usize {
    let output = std::process::Command::new("lsof")
        .args([
            "-nP",
            "-a",
            "-p",
            &std::process::id().to_string(),
            &format!("-iTCP:{port}"),
            "-sTCP:ESTABLISHED",
            "-Fn",
        ])
        .output()
        .expect("lsof");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.starts_with('n'))
        .count()
}

async fn get(client: &Client, path: &str) {
    let request = Request::get(format!("{path}?limit=1"))
        .body(Vec::new())
        .unwrap();
    client.request_text(request).await.unwrap();
}

struct Latency {
    samples: usize,
    p50: f64,
    p95: f64,
    p99: f64,
    max: f64,
}

async fn latency(client: &Client, path: &str) -> Latency {
    let mut samples = Vec::new();
    let end = Instant::now() + WINDOW;
    while Instant::now() < end {
        let start = Instant::now();
        get(client, path).await;
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    let at = |q: f64| samples[((samples.len() - 1) as f64 * q) as usize];
    Latency {
        samples: samples.len(),
        p50: at(0.50),
        p95: at(0.95),
        p99: at(0.99),
        max: at(1.0),
    }
}

async fn scale(client: &Client, namespace: &str, replicas: i32) {
    let patch = json!({ "spec": { "replicas": replicas } });
    Api::<Deployment>::namespaced(client.clone(), namespace)
        .patch("bench", &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .unwrap();
}

async fn settle(client: &Client, namespace: &str) {
    scale(client, namespace, REPLICAS).await;
    let deployments = Api::<Deployment>::namespaced(client.clone(), namespace);
    for _ in 0..300 {
        let deployment = deployments.get("bench").await.unwrap();
        let status = deployment.status.unwrap_or_default();
        if status.observed_generation == deployment.metadata.generation
            && status.replicas == Some(REPLICAS)
            && status.available_replicas == Some(REPLICAS)
        {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    panic!("the Deployment did not settle at {REPLICAS} pods within 5 minutes");
}

fn churn(client: Client, namespace: String) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            for replicas in [REPLICAS - 100, REPLICAS] {
                scale(&client, &namespace, replicas).await;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    })
}

fn row(name: &str, connections: usize, latency: &Latency, note: &str) {
    println!(
        "| {name} | {connections} | {} | {:.1} | {:.1} | {:.1} | {:.1} | {note} |",
        latency.samples, latency.p50, latency.p95, latency.p99, latency.max
    );
}

async fn phase(name: &str, config: &Config, namespace: &str, port: u16) {
    // The counter's watch budget above the example's watches.
    let budgets = Budgets {
        watches: WATCHES,
        ..Budgets::default()
    };
    let options = Options {
        budgets,
        ..Options::default()
    };
    let clients = Clients::new(config, Gate::unrestricted(), options).unwrap();
    let client = if name == "HTTP/2" {
        clients.api
    } else {
        clients.sessions
    };
    let collection = format!("/api/v1/namespaces/{namespace}/pods");

    let idle = latency(&client, &collection).await;
    row(&format!("{name}, no watches"), connections(port), &idle, "");

    let version = resource_version(&client, &collection).await;
    let watches = Watches::open(&client, &collection, &version, WATCHES).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let quiet = latency(&client, &collection).await;
    row(
        &format!("{name}, quiet watches"),
        connections(port),
        &quiet,
        "",
    );

    let generator = churn(client.clone(), namespace.to_owned());
    tokio::time::sleep(Duration::from_secs(1)).await;
    let before = watches.events();
    let busy = latency(&client, &collection).await;
    let during = watches.events() - before;
    let held = connections(port);
    generator.abort();
    row(
        &format!("{name}, watches under churn"),
        held,
        &busy,
        &format!(
            "{during} events in the window; {} of {WATCHES} watches ended",
            watches.ended()
        ),
    );

    settle(&client, namespace).await;
    let bytes = watches.close();
    println!(
        "| {name}: the watches read {:.0} MiB in all | | | | | | | |",
        bytes as f64 / (1024.0 * 1024.0)
    );
    drop(client);
    tokio::time::sleep(Duration::from_secs(2)).await;
}

#[tokio::main]
async fn main() {
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
    let port = config.cluster_url.port_u16().expect("an explicit API port");
    let collection = format!("/api/v1/namespaces/{namespace}/pods");

    println!(
        "{WATCHES} Table watches on {collection}; sequential GETs for {} s per row",
        WINDOW.as_secs()
    );
    println!();
    let api = Clients::new(&config, Gate::unrestricted(), Options::default())
        .unwrap()
        .api;
    let version = resource_version(&api, &collection).await;
    let watches = Watches::open(&api, &collection, &version, 10).await;
    tokio::time::sleep(IDLE).await;
    get(&api, &collection).await;
    println!(
        "HTTP/2, 10 watches and no request for {} s, then a GET: {} TCP connection(s).",
        IDLE.as_secs(),
        connections(port)
    );
    watches.close();
    drop(api);
    tokio::time::sleep(Duration::from_secs(2)).await;
    println!();

    println!("| Client, state | TCP connections | GETs | p50 ms | p95 | p99 | max | |");
    println!("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for name in ["HTTP/1.1", "HTTP/2", "HTTP/2", "HTTP/1.1"] {
        phase(name, &config, &namespace, port).await;
    }
}
