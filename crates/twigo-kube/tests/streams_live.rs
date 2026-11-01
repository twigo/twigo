use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http::{Request, Version};
use k8s_openapi::api::core::v1::Namespace;
use kube::api::{DeleteParams, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use serde_json::json;
use twigo_cache::table::request::{self, WatchFrom};
use twigo_kube::client::{Budgets, Clients, Options};

async fn api() -> (Client, u16) {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: this test creates a namespace, so it runs only against kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    let port = config.cluster_url.port_u16().expect("an explicit API port");
    // The counter's watch budget at the server's limit, so the limit shows.
    let budgets = Budgets {
        watches: 100,
        ..Budgets::default()
    };
    (
        Clients::new(
            &config,
            Options {
                budgets,
                ..Options::default()
            },
        )
        .unwrap()
        .api,
        port,
    )
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

async fn namespace(client: &Client, prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let name = format!("{prefix}-{nanos}");
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap();
    Api::<Namespace>::all(client.clone())
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
    name
}

async fn delete_namespace(client: &Client, name: &str) {
    Api::<Namespace>::all(client.clone())
        .delete(name, &DeleteParams::default())
        .await
        .unwrap();
}

async fn version(client: &Client) -> Version {
    let request = Request::get("/version").body(Vec::new()).unwrap();
    client
        .send(request.map(Into::into))
        .await
        .unwrap()
        .version()
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn requests_wait_for_a_free_stream() {
    let (api, port) = api().await;
    let ns = namespace(&api, "streams").await;
    let path = format!("/api/v1/namespaces/{ns}/pods");
    let opened = tokio::time::timeout(Duration::from_secs(30), async {
        let mut watches = Vec::new();
        for _ in 0..100 {
            let watch = request::watch(&path, WatchFrom::ResourceVersion("0"), 120);
            watches.push(api.request_stream(watch).await.unwrap());
        }
        watches
    });
    let mut watches = opened.await.expect("100 watches open within 30 s");
    assert_eq!(
        connections(port),
        1,
        "one connection for 100 watches; lsof counts the whole process, so this binary holds one test"
    );
    let blocked = tokio::time::timeout(Duration::from_secs(5), version(&api)).await;
    assert!(blocked.is_err(), "the server's 100 streams are all in use");

    watches.pop();
    let answered = tokio::time::timeout(Duration::from_secs(10), version(&api)).await;
    assert_eq!(
        answered.expect("a GET once a stream is free"),
        Version::HTTP_2
    );
    assert_eq!(connections(port), 1);

    drop(watches);
    delete_namespace(&api, &ns).await;
}
