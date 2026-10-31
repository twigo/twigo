use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::{AsyncBufReadExt, StreamExt};
use http::{Request, Version};
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::api::{AttachParams, DeleteParams, LogParams, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::runtime::{conditions, wait};
use kube::{Api, Client, Config};
use serde_json::json;
use tokio::io::AsyncReadExt;
use twigo_cache::table::request::{self, WatchFrom};
use twigo_kube::client::Clients;

async fn clients() -> Clients {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: these tests create namespaces and pods, so they run only against kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    Clients::new(config).unwrap()
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
async fn the_api_client_speaks_http2() {
    let clients = clients().await;
    assert_eq!(version(&clients.api).await, Version::HTTP_2);
    assert_eq!(version(&clients.sessions).await, Version::HTTP_11);
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn requests_go_through_while_watches_hold_streams() {
    let clients = clients().await;
    let ns = namespace(&clients.api, "streams").await;
    let path = format!("/api/v1/namespaces/{ns}/pods");
    let mut watches = Vec::new();
    for _ in 0..20 {
        let watch = request::watch(&path, WatchFrom::ResourceVersion("0"), 60);
        watches.push(clients.api.request_stream(watch).await.unwrap());
    }
    let answered = tokio::time::timeout(Duration::from_secs(10), version(&clients.api)).await;
    assert_eq!(answered.expect("a GET within 10 s"), Version::HTTP_2);
    drop(watches);
    delete_namespace(&clients.api, &ns).await;
}

async fn busybox(pods: &Api<Pod>, name: &str, script: &str) {
    let pod: Pod = serde_json::from_value(json!({
        "metadata": { "name": name },
        "spec": {
            "terminationGracePeriodSeconds": 0,
            "containers": [{
                "name": name,
                "image": "registry.k8s.io/e2e-test-images/busybox:1.36.1-1",
                "command": ["sh", "-c", script]
            }]
        }
    }))
    .unwrap();
    pods.create(&PostParams::default(), &pod).await.unwrap();
    let running = wait::await_condition(pods.clone(), name, conditions::is_pod_running());
    tokio::time::timeout(Duration::from_secs(180), running)
        .await
        .expect("the pod runs within three minutes")
        .unwrap();
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn logs_follow_over_http2() {
    let clients = clients().await;
    let ns = namespace(&clients.api, "logs").await;
    let pods = Api::<Pod>::namespaced(clients.api.clone(), &ns);
    busybox(&pods, "talker", "echo ready; exec sleep 3600").await;

    let params = LogParams {
        follow: true,
        ..LogParams::default()
    };
    let mut lines = pods.log_stream("talker", &params).await.unwrap().lines();
    let first = tokio::time::timeout(Duration::from_secs(30), lines.next())
        .await
        .expect("a log line within 30 s")
        .unwrap()
        .unwrap();
    assert_eq!(first, "ready");

    delete_namespace(&clients.api, &ns).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn exec_needs_the_sessions_client() {
    let clients = clients().await;
    let ns = namespace(&clients.api, "exec").await;
    let pods = Api::<Pod>::namespaced(clients.api.clone(), &ns);
    busybox(&pods, "shell", "exec sleep 3600").await;

    let params = AttachParams::default().stderr(false);
    let sessions = Api::<Pod>::namespaced(clients.sessions.clone(), &ns);
    let mut process = sessions
        .exec("shell", ["echo", "ok"], &params)
        .await
        .unwrap();
    let mut output = String::new();
    process
        .stdout()
        .unwrap()
        .read_to_string(&mut output)
        .await
        .unwrap();
    process.join().await.unwrap();
    assert_eq!(output, "ok\n");

    let Err(error) = pods.exec("shell", ["echo", "ok"], &params).await else {
        panic!("exec over HTTP/2 must fail: the WebSocket upgrade needs HTTP/1.1");
    };
    assert!(
        matches!(error, kube::Error::UpgradeConnection(_)),
        "{error}"
    );
    assert!(error.to_string().contains("400"), "{error}");

    delete_namespace(&clients.api, &ns).await;
}
