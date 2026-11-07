use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::{AsyncBufReadExt, StreamExt};
use http::{Request, Version};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod};
use kube::api::{
    AttachParams, DeleteParams, ListParams, LogParams, PostParams, WatchEvent, WatchParams,
};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::runtime::{conditions, wait};
use kube::{Api, Client, Config};
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use twigo_kube::client::{Clients, Options, Slots};

struct Cluster {
    clients: Clients,
    kind: bool,
}

async fn cluster() -> Cluster {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    let kind = context.starts_with("kind-");
    assert!(
        kind || context.starts_with("kwok-"),
        "refusing context {context:?}: these tests create namespaces and pods, so they run only against kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    Cluster {
        clients: Clients::new(&config, Options::default()).unwrap(),
        kind,
    }
}

async fn kind_cluster() -> Cluster {
    let cluster = cluster().await;
    assert!(
        cluster.kind,
        "this test needs a kubelet, so it runs only against kind"
    );
    cluster
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
    let clients = cluster().await.clients;
    assert_eq!(version(&clients.api).await, Version::HTTP_2);
    assert_eq!(version(&clients.sessions).await, Version::HTTP_11);
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
    let clients = kind_cluster().await.clients;
    let ns = namespace(&clients.api, "logs").await;
    let pods = Api::<Pod>::namespaced(clients.api.clone(), &ns);
    busybox(&pods, "talker", "echo ready; exec sleep 3600").await;

    let params = LogParams {
        follow: true,
        ..LogParams::default()
    };
    let follow = Request::get(format!(
        "/api/v1/namespaces/{ns}/pods/talker/log?follow=true"
    ))
    .body(Vec::new())
    .unwrap();
    let response = clients.api.send(follow.map(Into::into)).await.unwrap();
    assert_eq!(response.version(), Version::HTTP_2);
    drop(response);

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
    let clients = kind_cluster().await.clients;
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
        matches!(&error, kube::Error::Api(status) if status.code == 400),
        "{error}"
    );

    delete_namespace(&clients.api, &ns).await;
}

async fn version_of(api: &Api<ConfigMap>) -> String {
    let list = api.list(&ListParams::default().limit(1)).await.unwrap();
    list.metadata.resource_version.unwrap()
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_retired_connection_is_replaced_by_one_on_which_every_watch_resumes() {
    let clients = cluster().await.clients;
    let ns = namespace(&clients.api, "retire").await;
    let configmaps = Api::<ConfigMap>::namespaced(clients.api.clone(), &ns);
    // Its controller adds kube-root-ca.crt to every new namespace; the
    // watches start after it.
    tokio::time::timeout(Duration::from_secs(10), async {
        while configmaps
            .get_opt("kube-root-ca.crt")
            .await
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("kube-root-ca.crt");
    let version = version_of(&configmaps).await;
    let (opened, mut opens) = mpsc::unbounded_channel();
    let (saw, mut seen) = mpsc::unbounded_channel();
    let mut watches = Vec::new();
    for _ in 0..10 {
        let (configmaps, mut version) = (configmaps.clone(), version.clone());
        let mut retired = clients.connections().retired();
        let (opened, saw) = (opened.clone(), saw.clone());
        watches.push(tokio::spawn(async move {
            let params = WatchParams::default().timeout(290);
            loop {
                let mut events = configmaps.watch(&params, &version).await.unwrap().boxed();
                opened.send(()).unwrap();
                loop {
                    tokio::select! {
                        _ = retired.changed() => break,
                        event = events.next() => match event.unwrap().unwrap() {
                            WatchEvent::Added(configmap) => {
                                saw.send(configmap.metadata.name.unwrap()).unwrap();
                            }
                            WatchEvent::Bookmark(bookmark) => {
                                version = bookmark.metadata.resource_version;
                            }
                            other => panic!("unexpected {other:?}"),
                        },
                    }
                }
            }
        }));
    }
    for _ in 0..10 {
        opens.recv().await.unwrap();
    }
    assert_eq!(clients.connections().dialled(), 1);

    clients.connections().retire();
    for _ in 0..10 {
        opens.recv().await.unwrap();
    }
    let configmap: ConfigMap =
        serde_json::from_value(json!({ "metadata": { "name": "after" } })).unwrap();
    configmaps
        .create(&PostParams::default(), &configmap)
        .await
        .unwrap();
    for _ in 0..10 {
        let name = tokio::time::timeout(Duration::from_secs(10), seen.recv()).await;
        assert_eq!(
            name.expect("every watch sees the new configmap").unwrap(),
            "after"
        );
    }
    assert_eq!(clients.connections().dialled(), 2, "one new connection");
    tokio::time::timeout(Duration::from_secs(10), async {
        while clients.connections().open() > 1 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the retired connection closes while every watch runs on the new one");

    watches.iter().for_each(|watch| watch.abort());
    delete_namespace(&clients.api, &ns).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn the_25th_watch_waits_for_one_of_24_while_a_get_answers() {
    let clients = cluster().await.clients;
    let ns = namespace(&clients.api, "budget").await;
    let configmaps = Api::<ConfigMap>::namespaced(clients.api.clone(), &ns);
    let from = version_of(&configmaps).await;
    let params = WatchParams::default().timeout(290);
    let mut watches = Vec::new();
    for _ in 0..24 {
        watches.push(configmaps.watch(&params, &from).await.unwrap().boxed());
    }
    let mut usage = clients.usage();
    assert_eq!(
        usage.borrow().watches,
        Slots {
            held: 24,
            queued: 0
        }
    );

    let waiting = {
        let (configmaps, params, from) = (configmaps.clone(), params.clone(), from.clone());
        tokio::spawn(async move { configmaps.watch(&params, &from).await.unwrap().boxed() })
    };
    let queued = usage.wait_for(|usage| usage.watches.queued == 1);
    tokio::time::timeout(Duration::from_secs(5), queued)
        .await
        .expect("the 25th watch reports queued")
        .unwrap();
    let get = tokio::time::timeout(Duration::from_secs(5), version(&clients.api)).await;
    assert_eq!(get.expect("a GET answers meanwhile"), Version::HTTP_2);
    assert!(!waiting.is_finished());

    watches.pop();
    let started = tokio::time::timeout(Duration::from_secs(10), waiting).await;
    watches.push(
        started
            .expect("the 25th watch starts once one ends")
            .unwrap(),
    );
    assert_eq!(
        usage.borrow().watches,
        Slots {
            held: 24,
            queued: 0
        }
    );

    drop(watches);
    delete_namespace(&clients.api, &ns).await;
}
