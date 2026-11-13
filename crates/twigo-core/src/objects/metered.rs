//! What an open pod or node uses, over the fake API server: the requests it
//! makes counted on its log over virtual minutes, and what its batches say.

use std::collections::HashSet;
use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep, timeout_at};
use twigo_cache::discovery::Followers;
use twigo_cache::fake::Fake;
use twigo_cache::hub::Resource;
use twigo_cache::metrics::{Context, Poller, Scope};
use twigo_kube::client::{Budgets, Clients};
use twigo_kube::discovery::Cache;

use super::*;

fn requests(fake: &Fake) -> usize {
    fake.count("/apis/metrics.k8s.io/")
}

fn own_requests(fake: &Fake) -> usize {
    fake.count("/apis/metrics.k8s.io/v1beta1/namespaces/a/pods?fieldSelector")
}

const PARTS: ObjectParts = ObjectParts {
    overview: false,
    manifest: false,
    events: false,
    related: false,
    usage: true,
};

fn pod(containers: serde_json::Value) -> serde_json::Value {
    json!({
        "kind": "Pod",
        "apiVersion": "v1",
        "metadata": { "name": "web-0", "namespace": "a", "uid": "pod-uid" },
        "spec": { "containers": containers },
    })
}

fn node() -> serde_json::Value {
    json!({
        "kind": "Node",
        "apiVersion": "v1",
        "metadata": { "name": "node-1", "uid": "node-uid" },
        "status": { "allocatable": { "cpu": "16", "memory": "16355060Ki" } },
    })
}

struct Rig {
    fake: Fake,
    hub: Hub,
    context: Arc<Context>,
    _held: (Arc<Clients>, tempfile::TempDir, Followers),
    batches: mpsc::UnboundedReceiver<ObjectBatch>,
}

impl Rig {
    async fn new(fake: Fake) -> Self {
        fake.serve_metrics("v1beta1");
        let (hub, clients) = fake.hub(Budgets::default());
        let directory = tempfile::tempdir().unwrap();
        let followers = Followers::new(hub.clone(), Arc::new(Cache::new(directory.path())));
        let api = followers
            .get("kind-test", async { watch::channel(None).1 })
            .await
            .api();
        let context = Poller::new(hub.clone()).context("kind-test", api);
        let waited = async {
            while context.api().version().is_none() {
                sleep(Duration::from_millis(10)).await;
            }
        };
        timeout_at(Instant::now() + Duration::from_secs(600), waited)
            .await
            .expect("discovery within ten minutes");
        Self {
            fake,
            hub,
            context,
            _held: (clients, directory, followers),
            batches: mpsc::unbounded_channel().1,
        }
    }

    fn open(&mut self, kind: Kind, parts: ObjectParts) -> Opened {
        let (resource, namespace, name) = match kind {
            Kind::Pods => ("pods", Some("a".to_owned()), "web-0"),
            Kind::Nodes => ("nodes", None, "node-1"),
        };
        let object = self
            .hub
            .object(
                "kind-test",
                Resource {
                    group: String::new(),
                    version: "v1".to_owned(),
                    resource: resource.to_owned(),
                    namespaced: namespace.is_some(),
                },
                namespace.clone(),
                name,
            )
            .unwrap();
        let (sender, batches) = mpsc::unbounded_channel();
        self.batches = batches;
        Opened::spawn(
            self.hub.clone(),
            Target {
                context: "kind-test".to_owned(),
                namespace,
            },
            object,
            parts,
            Some(Box::pin(std::future::ready(self.context.reader(kind)))),
            move |batch| sender.send(batch).is_ok(),
        )
    }

    async fn watch(&mut self, opened: &Opened, time: Duration) -> Vec<ObjectBatch> {
        let end = Instant::now() + time;
        let mut seen = Vec::new();
        while let Ok(Some(batch)) = timeout_at(end, self.batches.recv()).await {
            opened.ack(batch.seq);
            seen.push(batch);
        }
        seen
    }
}

fn usages(batches: &[ObjectBatch]) -> Vec<&Usage> {
    batches
        .iter()
        .filter_map(|batch| batch.usage.as_ref())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_part_that_is_off_makes_no_request_and_sends_nothing() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.pod_usage("a", "web-0", &[("main", "10m", "1Mi")]);
    let mut rig = Rig::new(fake).await;
    let opened = rig.open(
        Kind::Pods,
        ObjectParts {
            usage: false,
            ..PARTS
        },
    );
    let batches = rig.watch(&opened, Duration::from_secs(120)).await;
    assert!(!batches.is_empty());
    assert!(usages(&batches).is_empty());
    assert_eq!(requests(&rig.fake), 0, "no request for a part nobody shows");

    opened.set_parts(PARTS);
    let shown = rig.watch(&opened, Duration::from_secs(2)).await;
    assert!(!usages(&shown).is_empty(), "shown now");
    assert!(requests(&rig.fake) > 0);
}

#[tokio::test(start_paused = true)]
async fn a_pod_is_its_containers_against_their_requests_and_a_container_without_a_limit_leaves_the_pod_none()
 {
    let fake = Fake::default();
    fake.put(
        "",
        "pods",
        Some("a"),
        pod(json!([
            { "name": "main", "resources": { "requests": { "cpu": "100m", "memory": "64Mi" }, "limits": { "cpu": "200m", "memory": "128Mi" } } },
            { "name": "worker", "resources": { "requests": { "cpu": "100m", "memory": "64Mi" }, "limits": { "memory": "128Mi" } } },
        ])),
    );
    fake.pod_usage(
        "a",
        "web-0",
        &[("worker", "5m", "2Mi"), ("main", "10m", "1Mi")],
    );
    let mut rig = Rig::new(fake).await;
    let opened = rig.open(
        Kind::Pods,
        ObjectParts {
            overview: true,
            ..PARTS
        },
    );
    let batches = rig.watch(&opened, Duration::from_secs(2)).await;
    assert!(
        batches.iter().any(|batch| batch.overview.is_some()),
        "the Overview is shown too"
    );
    let usage = *usages(&batches).last().expect("a usage");
    assert_eq!(usage.state, MetricsState::Ready);
    let names: Vec<&str> = usage.containers.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["main", "worker"], "in the pod's order");
    assert_eq!(usage.cpu.used, Some(15_000_000));
    assert_eq!(usage.cpu.request, Some(200_000_000));
    assert_eq!(usage.cpu.limit, None, "one of them has none");
    assert_eq!(usage.memory.limit, Some(2 * 128 * 1024 * 1024));
    assert_eq!(usage.containers[1].cpu.limit, None);
    assert!(usage.sampled.is_some());

    rig.fake.pod_usage(
        "a",
        "web-0",
        &[("worker", "6m", "2Mi"), ("main", "10m", "1Mi")],
    );
    let moved = rig.watch(&opened, Duration::from_secs(15)).await;
    let [only] = &moved[..] else {
        panic!("one batch: {moved:?}");
    };
    assert_eq!(only.usage.as_ref().unwrap().cpu.used, Some(16_000_000));
    assert!(
        only.overview.is_none(),
        "the Overview is not described again"
    );
}

#[tokio::test(start_paused = true)]
async fn a_pod_without_a_sample_answers_used_null_and_ready() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    let mut rig = Rig::new(fake).await;
    let opened = rig.open(Kind::Pods, PARTS);
    let batches = rig.watch(&opened, Duration::from_secs(40)).await;
    let usage = *usages(&batches).last().expect("a usage");
    assert_eq!(usage.state, MetricsState::Ready);
    assert_eq!(usage.cpu.used, None);
    assert_eq!(usage.memory.used, None);
    assert_eq!(usage.sampled, None);
    assert!(usage.containers.is_empty());
    assert_eq!(usages(&batches).len(), 1, "nothing changed since");
}

#[tokio::test(start_paused = true)]
async fn closing_the_object_stops_its_requests_and_a_list_of_its_namespace_serves_it_free() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.pod_usage("a", "web-0", &[("main", "10m", "1Mi")]);
    let mut rig = Rig::new(fake).await;
    let opened = rig.open(Kind::Pods, PARTS);
    rig.watch(&opened, Duration::from_secs(40)).await;
    assert!(own_requests(&rig.fake) > 0, "alone it asks for itself");

    let mut list = rig.context.reader(Kind::Pods);
    list.want(HashSet::from([Scope::Namespace("a".into())]));
    sleep(Duration::from_millis(100)).await;
    let own = own_requests(&rig.fake);
    rig.fake.pod_usage("a", "web-0", &[("main", "20m", "1Mi")]);
    let batches = rig.watch(&opened, Duration::from_secs(60)).await;
    assert_eq!(
        own_requests(&rig.fake),
        own,
        "none of its own beside the list's"
    );
    assert_eq!(
        usages(&batches).last().map(|usage| usage.cpu.used),
        Some(Some(20_000_000)),
        "and it still hears what changes"
    );

    drop(opened);
    drop(list);
    sleep(Duration::from_millis(100)).await;
    let polled = requests(&rig.fake);
    sleep(Duration::from_secs(600)).await;
    assert_eq!(requests(&rig.fake), polled, "closed, it asks for nothing");
}

#[tokio::test(start_paused = true)]
async fn a_node_uses_what_it_allocates_of() {
    let fake = Fake::default();
    fake.put("", "nodes", None, node());
    fake.node_usage("node-1", "277147502n", "2509700Ki");
    let mut rig = Rig::new(fake).await;
    let opened = rig.open(Kind::Nodes, PARTS);
    let batches = rig.watch(&opened, Duration::from_secs(2)).await;
    let usage = *usages(&batches).last().expect("a usage");
    assert_eq!(usage.cpu.used, Some(277_147_502));
    assert_eq!(usage.cpu.allocatable, Some(16_000_000_000));
    assert_eq!(usage.memory.allocatable, Some(16_355_060 * 1024));
    assert_eq!(usage.cpu.request, None);
    assert!(usage.containers.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_cluster_without_the_api_never_gets_a_usage() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    let (hub, clients) = fake.hub(Budgets::default());
    let directory = tempfile::tempdir().unwrap();
    let followers = Followers::new(hub.clone(), Arc::new(Cache::new(directory.path())));
    let api = followers
        .get("kind-test", async { watch::channel(None).1 })
        .await
        .api();
    let context = Poller::new(hub.clone()).context("kind-test", api);
    sleep(Duration::from_secs(2)).await;
    let mut rig = Rig {
        fake,
        hub,
        context,
        _held: (clients, directory, followers),
        batches: mpsc::unbounded_channel().1,
    };
    let opened = rig.open(Kind::Pods, PARTS);
    let batches = rig.watch(&opened, Duration::from_secs(60)).await;
    assert!(!batches.is_empty());
    assert!(usages(&batches).is_empty(), "no part, and no request");
    assert_eq!(requests(&rig.fake), 0);
}
