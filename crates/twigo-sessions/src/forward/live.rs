//! A forward's streams against a kind cluster: how a pod's port that
//! nothing listens on answers, and that one that does stays silent. The pod
//! runs CoreDNS from the image kind's node holds, whose `health` plugin
//! answers HTTP on a port, so nothing is pulled. They need a kubelet, so
//! they refuse anything but `kind-*`.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-sessions --lib forward::live -- --ignored --nocapture

use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Node, Pod, ServiceAccount};
use kube::api::{DeleteParams, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use serde_json::json;
use twigo_kube::client::{Clients, Gate, Options};

use super::PROBE_WINDOW;
use super::connect::{Connect, Kube};

const WITHIN: Duration = Duration::from_secs(120);
const COREDNS: &str = "registry.k8s.io/coredns/coredns:";
const COREFILE: &str = ".:5353 {\n    health :8080\n    whoami\n}\n";

struct Live {
    clients: Clients,
    namespace: String,
}

async fn live() -> Live {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    let cluster = context.strip_prefix("kind-").unwrap_or_else(|| {
        panic!("refusing context {context:?}: these tests need a kubelet, so they run only against kind clusters")
    });
    let node = format!("{cluster}-control-plane");
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    let clients = Clients::new(&config, Gate::unrestricted(), Options::default()).unwrap();
    let image = Api::<Node>::all(clients.api.clone())
        .get(&node)
        .await
        .unwrap()
        .status
        .and_then(|status| status.images)
        .into_iter()
        .flatten()
        .flat_map(|image| image.names.unwrap_or_default())
        .find(|name| name.starts_with(COREDNS))
        .unwrap_or_else(|| panic!("{node} holds no {COREDNS}*"));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let namespace = format!("forward-live-{nanos}");
    Api::<Namespace>::all(clients.api.clone())
        .create(
            &PostParams::default(),
            &serde_json::from_value(json!({ "metadata": { "name": namespace } })).unwrap(),
        )
        .await
        .unwrap();
    let accounts = Api::<ServiceAccount>::namespaced(clients.api.clone(), &namespace);
    tokio::time::timeout(WITHIN, async {
        while !matches!(accounts.get_opt("default").await, Ok(Some(_))) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the default ServiceAccount");
    let live = Live { clients, namespace };
    live.serve(&node, &image).await;
    live
}

impl Live {
    async fn serve(&self, node: &str, image: &str) {
        let namespace = &self.namespace;
        Api::<ConfigMap>::namespaced(self.clients.api.clone(), namespace)
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "metadata": { "name": "corefile" },
                    "data": { "Corefile": COREFILE },
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let pods = Api::<Pod>::namespaced(self.clients.api.clone(), namespace);
        pods.create(
            &PostParams::default(),
            &serde_json::from_value(json!({
                "metadata": { "name": "serve" },
                "spec": {
                    "nodeName": node,
                    "terminationGracePeriodSeconds": 0,
                    "containers": [{
                        "name": "dns",
                        "image": image,
                        "imagePullPolicy": "Never",
                        "args": ["-conf", "/etc/coredns/Corefile"],
                        "ports": [{ "name": "health", "containerPort": 8080 }],
                        "volumeMounts": [{ "name": "corefile", "mountPath": "/etc/coredns" }],
                    }],
                    "volumes": [{ "name": "corefile", "configMap": { "name": "corefile" } }],
                },
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        tokio::time::timeout(WITHIN, async {
            loop {
                let ready = pods
                    .get("serve")
                    .await
                    .unwrap()
                    .status
                    .is_some_and(|status| {
                        status.conditions.into_iter().flatten().any(|condition| {
                            condition.type_ == "Ready" && condition.status == "True"
                        })
                    });
                if ready {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
        .await
        .expect("the pod is ready");
    }

    async fn delete(&self) {
        Api::<Namespace>::all(self.clients.api.clone())
            .delete(&self.namespace, &DeleteParams::default())
            .await
            .unwrap();
    }
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_port_nobody_listens_on_answers_within_the_probe_window_and_one_that_does_stays_silent() {
    let live = live().await;
    let mut arrivals = Vec::new();
    for _ in 0..20 {
        let started = Instant::now();
        let mut connected = Kube
            .connect(&live.clients.sessions, &live.namespace, "serve", 9)
            .await
            .unwrap();
        let text = tokio::time::timeout(Duration::from_secs(10), &mut connected.error)
            .await
            .expect("a port nobody listens on is answered")
            .expect("with text");
        arrivals.push((started.elapsed(), text));
    }
    let slowest = arrivals.iter().map(|(time, _)| *time).max().unwrap();
    let fastest = arrivals.iter().map(|(time, _)| *time).min().unwrap();
    eprintln!(
        "a refused port arrived in {fastest:?} to {slowest:?} over {} tries: {}",
        arrivals.len(),
        arrivals[0].1
    );

    let mut listening = Kube
        .connect(&live.clients.sessions, &live.namespace, "serve", 8080)
        .await
        .unwrap();
    let silent = tokio::time::timeout(Duration::from_secs(2), &mut listening.error)
        .await
        .is_err();
    live.delete().await;
    assert!(
        slowest < PROBE_WINDOW,
        "the probe window {PROBE_WINDOW:?} covers the slowest refusal, {slowest:?}"
    );
    assert!(silent, "a port that listens sends nothing");
}
