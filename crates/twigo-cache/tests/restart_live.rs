//! An API-server restart during a watch, the replay case of ARCHITECTURE
//! 3.8: the upstream goes stale and comes back ready with the same rows.
//! A test binary of its own, since the restart fails whatever else runs
//! against the cluster meanwhile.

use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::{Namespace, Pod, ServiceAccount};
use kube::api::{DeleteParams, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use serde_json::json;
use twigo_cache::hub::{Connect, Hub, Query, Resource, RowFormat};
use twigo_ipc::ViewState;
use twigo_kube::client::{Clients, Gate, Options};

fn docker(node: &str, args: &[&str]) -> String {
    let output = Command::new("docker")
        .arg("exec")
        .arg(node)
        .args(args)
        .output()
        .expect("docker runs");
    assert!(output.status.success(), "{args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// A new namespace, once the controller manager gave it the `default`
/// ServiceAccount that pods need: after a restart it reconnects first.
async fn namespace(admin: &kube::Client, prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let name = format!("{prefix}-{nanos}");
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap();
    Api::<Namespace>::all(admin.clone())
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
    let accounts = Api::<ServiceAccount>::namespaced(admin.clone(), &name);
    let given = async {
        while !matches!(accounts.get_opt("default").await, Ok(Some(_))) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(180), given)
        .await
        .expect("the default ServiceAccount within three minutes");
    name
}

async fn delete_namespace(admin: &kube::Client, name: &str) {
    Api::<Namespace>::all(admin.clone())
        .delete(name, &DeleteParams::default())
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_api_server_restart_leaves_the_rows_after_a_stale_spell() {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    let cluster = context.strip_prefix("kind-").unwrap_or_else(|| {
        panic!("refusing context {context:?}: this test restarts the API server of a kind cluster")
    });
    let node = format!("{cluster}-control-plane");
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    let clients =
        Arc::new(Clients::new(&config, Gate::unrestricted(), Options::default()).unwrap());
    let admin = clients.api.clone();

    let ns = namespace(&admin, "restart").await;
    let pods = Api::<Pod>::namespaced(admin.clone(), &ns);
    for name in ["p1", "p2", "p3"] {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": name },
            "spec": {
                "nodeName": "kwok-node-0",
                "containers": [{ "name": "app", "image": "fake" }]
            }
        }))
        .unwrap();
        pods.create(&PostParams::default(), &pod).await.unwrap();
    }

    let connect: Connect = {
        let clients = Arc::clone(&clients);
        Arc::new(move |_context| {
            let clients = Arc::clone(&clients);
            Box::pin(async move { Ok(clients) })
        })
    };
    let hub = Hub::new(connect);
    let mut rows = hub
        .rows(Query {
            context,
            resource: Resource {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
                namespaced: true,
            },
            format: RowFormat::Table,
            namespaces: vec![ns.clone()],
            field_selector: None,
        })
        .await
        .unwrap();
    let names = |rows: &twigo_cache::hub::Subscription<twigo_cache::table::Row>| {
        let mut names: Vec<String> = rows
            .items()
            .iter()
            .map(|row| row.meta.name.to_string())
            .collect();
        names.sort();
        names
    };
    let ready = async {
        while rows.state() != ViewState::Ready {
            rows.changed().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(60), ready)
        .await
        .expect("ready within a minute");
    assert_eq!(names(&rows), ["p1", "p2", "p3"]);

    let apiserver = docker(&node, &["crictl", "ps", "--name", "kube-apiserver", "-q"]);
    // crictl gives the stop 2 s by default, less than the API server's
    // graceful shutdown takes on a CI runner.
    docker(&node, &["crictl", "--timeout", "60s", "stop", &apiserver]);
    let mut seen = Vec::new();
    let back = async {
        loop {
            rows.changed().await;
            let state = rows.state();
            if seen.last() != Some(&state) {
                seen.push(state.clone());
            }
            if state == ViewState::Ready && seen.contains(&ViewState::Stale) {
                return;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(180), back)
        .await
        .unwrap_or_else(|_| panic!("not back within three minutes: {seen:?}"));
    assert_eq!(
        names(&rows),
        ["p1", "p2", "p3"],
        "the same rows, by {seen:?}"
    );
    eprintln!("states after the restart: {seen:?}");

    delete_namespace(&admin, &ns).await;
    // The tests after this one need the controller manager back.
    let settled = namespace(&admin, "restart-settled").await;
    delete_namespace(&admin, &settled).await;
}
