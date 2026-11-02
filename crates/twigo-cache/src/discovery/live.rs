use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::Api;
use kube::api::{DeleteParams, PostParams};
use serde_json::json;
use tokio::sync::Mutex;
use tokio::time::{Instant, timeout};
use twigo_ipc::Discovered;
use twigo_kube::discovery::Cache;

use super::*;
use crate::hub::live::live;

static CLUSTER_DISCOVERY: Mutex<()> = Mutex::const_new(());

fn resources(discovered: &Discovered) -> &[twigo_ipc::Resource] {
    match discovered {
        Discovered::Ready { resources } => resources,
        Discovered::Failed { error } => panic!("discovery failed: {error:?}"),
    }
}

fn serves(discovered: &Discovered, group: &str, resource: &str) -> bool {
    resources(discovered)
        .iter()
        .any(|r| r.gvr.group == group && r.gvr.resource == resource)
}

async fn next(follower: &mut Follower) -> Discovered {
    timeout(Duration::from_secs(60), follower.next())
        .await
        .expect("discovery within a minute")
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_second_start_answers_from_the_cache_with_304() {
    let _unchanged = CLUSTER_DISCOVERY.lock().await;
    let live = live().await;
    let dir = tempfile::tempdir().unwrap();
    let cache = Arc::new(Cache::new(dir.path()));
    let (hub, clients) = live.hub(None);
    let mut first = Follower::new(hub, Arc::clone(&cache), live.context.clone()).await;
    let discovered = next(&mut first).await;
    assert!(serves(&discovered, "", "pods"));
    assert!(serves(
        &discovered,
        "apiextensions.k8s.io",
        "customresourcedefinitions"
    ));
    drop(first);
    let server = clients.server().to_string();
    let stored = cache.load(&server).unwrap().expect("a cached discovery");
    let files: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    let [file] = &files[..] else {
        panic!("one cached file, not {files:?}");
    };
    let written = std::fs::metadata(file).unwrap().modified().unwrap();

    assert_eq!(
        Discovery::refresh(&clients.api, Some(&stored))
            .await
            .unwrap(),
        None,
        "both roots answer the cached ETags with 304"
    );
    let (hub, _) = live.hub(None);
    let mut second = Follower::new(hub, cache, live.context.clone()).await;
    assert_eq!(next(&mut second).await, discovered);
    assert_eq!(
        std::fs::metadata(file).unwrap().modified().unwrap(),
        written,
        "a 304 leaves the cached file as it was"
    );
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_crd_created_while_followed_comes_without_a_restart() {
    let _changing = CLUSTER_DISCOVERY.lock().await;
    let live = live().await;
    let dir = tempfile::tempdir().unwrap();
    let (hub, _) = live.hub(None);
    let mut follower =
        Follower::new(hub, Arc::new(Cache::new(dir.path())), live.context.clone()).await;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let group = format!("discovery-{nanos}.twigo.io");
    assert!(!serves(&next(&mut follower).await, &group, "widgets"));

    let crd: CustomResourceDefinition = serde_json::from_value(json!({
        "metadata": { "name": format!("widgets.{group}") },
        "spec": {
            "group": group,
            "scope": "Namespaced",
            "names": { "plural": "widgets", "singular": "widget", "kind": "Widget" },
            "versions": [{
                "name": "v1",
                "served": true,
                "storage": true,
                "schema": { "openAPIV3Schema": { "type": "object" } }
            }]
        }
    }))
    .unwrap();
    let crds = Api::<CustomResourceDefinition>::all(live.admin.clone());
    let created = Instant::now();
    crds.create(&PostParams::default(), &crd).await.unwrap();
    let discovered = loop {
        let discovered = next(&mut follower).await;
        if serves(&discovered, &group, "widgets") {
            break discovered;
        }
    };
    eprintln!("the CRD came {:?} after its creation", created.elapsed());
    let widget = resources(&discovered)
        .iter()
        .find(|r| r.gvr.group == group)
        .unwrap();
    assert_eq!(
        (widget.gvr.version.as_str(), widget.kind.as_str()),
        ("v1", "Widget")
    );
    assert!(widget.namespaced);

    crds.delete(&format!("widgets.{group}"), &DeleteParams::default())
        .await
        .unwrap();
    while serves(&next(&mut follower).await, &group, "widgets") {}
}
