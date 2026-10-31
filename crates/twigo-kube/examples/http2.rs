//! TCP connections and GET latency under 50 Table watches, over kube's default
//! HTTP/1.1 client and over the HTTP/2 api client, on the pods of one
//! namespace (`bench/pods.sh`); then the api client at the server's stream
//! limit.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo run --release -p twigo-kube --example http2 [namespace]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures::AsyncBufReadExt;
use http::Request;
use k8s_openapi::api::apps::v1::Deployment;
use kube::api::{Patch, PatchParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use serde_json::json;
use tokio::task::JoinHandle;
use twigo_cache::table::TableDecoder;
use twigo_cache::table::request::{self, WatchFrom};
use twigo_kube::client::Clients;

const WATCHES: usize = 50;
const SAMPLES: usize = 200;
const STREAM_LIMIT: usize = 100;

struct Watches {
    tasks: Vec<JoinHandle<()>>,
    events: Arc<AtomicU64>,
    bytes: Arc<AtomicU64>,
}

impl Watches {
    async fn open(client: &Client, path: &str, count: usize) -> Self {
        let body = client
            .request_text(request::list(path, 1, None))
            .await
            .unwrap();
        let version = TableDecoder::new()
            .decode_list(body.as_bytes())
            .unwrap()
            .resource_version;
        let events = Arc::new(AtomicU64::new(0));
        let bytes = Arc::new(AtomicU64::new(0));
        let mut tasks = Vec::new();
        for _ in 0..count {
            let watch = request::watch(path, WatchFrom::ResourceVersion(&version), 600);
            let mut stream = Box::pin(client.request_stream(watch).await.unwrap());
            let (events, bytes) = (events.clone(), bytes.clone());
            tasks.push(tokio::spawn(async move {
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
            }));
        }
        Watches {
            tasks,
            events,
            bytes,
        }
    }

    fn close(self) -> (u64, u64) {
        for task in &self.tasks {
            task.abort();
        }
        (
            self.events.load(Ordering::Relaxed),
            self.bytes.load(Ordering::Relaxed),
        )
    }
}

fn connections(port: u16) -> usize {
    let output = std::process::Command::new("lsof")
        .args([
            "-nP",
            "-a",
            "-p",
            &std::process::id().to_string(),
            &format!("-iTCP@127.0.0.1:{port}"),
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
    p50: f64,
    p95: f64,
    p99: f64,
    max: f64,
}

async fn latency(client: &Client, path: &str) -> Latency {
    let mut samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        get(client, path).await;
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    let at = |q: f64| samples[((samples.len() - 1) as f64 * q) as usize];
    Latency {
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

fn churn(client: Client, namespace: String) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            for replicas in [4750, 5000] {
                scale(&client, &namespace, replicas).await;
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    })
}

fn row(name: &str, connections: usize, latency: &Latency) {
    println!(
        "| {name} | {connections} | {:.1} | {:.1} | {:.1} | {:.1} |",
        latency.p50, latency.p95, latency.p99, latency.max
    );
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

    println!("{WATCHES} Table watches on {collection}, {SAMPLES} GETs per row");
    println!();
    println!("| Client, state | TCP connections | GET p50 ms | p95 | p99 | max |");
    println!("| --- | --- | --- | --- | --- | --- |");
    for name in ["HTTP/1.1", "HTTP/2"] {
        let clients = Clients::new(config.clone()).unwrap();
        let client = if name == "HTTP/2" {
            clients.api
        } else {
            clients.sessions
        };
        let idle = latency(&client, &collection).await;
        row(&format!("{name}, no watches"), connections(port), &idle);

        let watches = Watches::open(&client, &collection, WATCHES).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        let quiet = latency(&client, &collection).await;
        row(&format!("{name}, quiet watches"), connections(port), &quiet);

        let generator = churn(client.clone(), namespace.clone());
        tokio::time::sleep(Duration::from_secs(2)).await;
        let busy = latency(&client, &collection).await;
        let during = connections(port);
        generator.abort();
        row(&format!("{name}, watches under churn"), during, &busy);
        scale(&client, &namespace, 5000).await;

        let (events, bytes) = watches.close();
        println!(
            "| {name}: the watches read {events} events, {:.0} MiB | | | | | |",
            bytes as f64 / (1024.0 * 1024.0)
        );
        drop(client);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    println!();
    for count in [STREAM_LIMIT - 1, STREAM_LIMIT] {
        let api = Clients::new(config.clone()).unwrap().api;
        let watches = Watches::open(&api, &collection, count).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        let answered = tokio::time::timeout(Duration::from_secs(10), get(&api, &collection)).await;
        println!(
            "HTTP/2 with {count} open watches: {} TCP connection(s); a GET {}.",
            connections(port),
            if answered.is_ok() {
                "went through"
            } else {
                "waited more than 10 s"
            }
        );
        watches.close();
        drop(api);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
