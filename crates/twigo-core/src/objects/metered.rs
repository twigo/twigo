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
use twigo_ipc::Measure;
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

fn pod_of(namespace: &str, name: &str) -> serde_json::Value {
    let mut pod = pod(json!([{ "name": "main" }]));
    pod["metadata"]["namespace"] = json!(namespace);
    pod["metadata"]["name"] = json!(name);
    pod["metadata"]["uid"] = json!(format!("{name}-uid"));
    pod
}

fn node() -> serde_json::Value {
    json!({
        "kind": "Node",
        "apiVersion": "v1",
        "metadata": { "name": "node-1", "uid": "node-uid" },
        "status": { "allocatable": { "cpu": "16", "memory": "16355060Ki" } },
    })
}

fn started() -> serde_json::Value {
    json!({ "running": { "startedAt": "2026-11-13T16:00:00Z" } })
}

fn pod_in_every_state() -> serde_json::Value {
    let mut pod = pod(json!([
        { "name": "worker", "resources": { "requests": { "cpu": "100m" } } },
        { "name": "api" },
        { "name": "web", "resources": {
            "requests": { "cpu": "200m", "memory": "64Mi" },
            "limits": { "cpu": "1", "memory": "128Mi" },
        } },
    ]));
    pod["spec"]["initContainers"] = json!([
        { "name": "migrate" },
        { "name": "proxy", "restartPolicy": "Always", "resources": { "limits": { "memory": "32Mi" } } },
    ]);
    pod["spec"]["ephemeralContainers"] = json!([{ "name": "debugger" }]);
    pod["status"] = json!({
        "containerStatuses": [
            { "name": "web", "state": started() },
            { "name": "worker", "state": { "waiting": { "reason": "CrashLoopBackOff" } } },
            { "name": "api", "state": started() },
        ],
        "initContainerStatuses": [
            { "name": "proxy", "state": started() },
            { "name": "migrate", "state": { "terminated": { "exitCode": 0, "reason": "Completed" } } },
        ],
        "ephemeralContainerStatuses": [{ "name": "debugger", "state": started() }],
    });
    pod
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
        if !fake
            .state()
            .served
            .contains_key(twigo_cache::metrics::GROUP)
        {
            fake.serve_metrics("v1beta1");
        }
        let (hub, clients) = fake.hub(Budgets::default());
        let directory = tempfile::tempdir().unwrap();
        let followers = Followers::new(hub.clone(), Arc::new(Cache::new(directory.path())));
        let followed = followers
            .get("kind-test", async { watch::channel(None).1 })
            .await;
        let context = Poller::new(hub.clone()).context("kind-test", &followed);
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
        match kind {
            Kind::Pods => self.open_object(kind, Some("a"), "web-0", parts),
            Kind::Nodes => self.open_object(kind, None, "node-1", parts),
        }
    }

    fn open_object(
        &mut self,
        kind: Kind,
        namespace: Option<&str>,
        name: &str,
        parts: ObjectParts,
    ) -> Opened {
        let resource = match kind {
            Kind::Pods => "pods",
            Kind::Nodes => "nodes",
        };
        let namespace = namespace.map(str::to_owned);
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
async fn a_pod_replaced_under_its_name_takes_the_sample_of_the_old_one_with_it() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.pod_usage("a", "web-0", &[("main", "10m", "1Mi")]);
    let mut rig = Rig::new(fake).await;
    let opened = rig.open(Kind::Pods, PARTS);
    let first = rig.watch(&opened, Duration::from_secs(2)).await;
    assert_eq!(usages(&first).last().unwrap().cpu.used, Some(10_000_000));

    let mut replaced = pod(json!([{ "name": "main", "resources": { "limits": { "cpu": "1" } } }]));
    replaced["metadata"]["uid"] = json!("new-uid");
    rig.fake.put("", "pods", Some("a"), replaced);
    let after = rig.watch(&opened, Duration::from_secs(5)).await;
    let usage = *usages(&after).last().expect("a usage for the new pod");
    assert_eq!(
        usage.cpu.used, None,
        "the old pod's use against the new pod's limits"
    );

    rig.fake.pod_usage("a", "web-0", &[("main", "20m", "1Mi")]);
    let next = rig.watch(&opened, Duration::from_secs(15)).await;
    let usage = *usages(&next).last().expect("its own sample");
    assert_eq!(usage.cpu.used, Some(20_000_000));
    assert_eq!(usage.cpu.limit, Some(1_000_000_000));
}

#[tokio::test(start_paused = true)]
async fn a_context_that_stops_serving_the_resource_withdraws_the_usage_once() {
    let apiservice = || {
        json!({
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": { "name": "v1beta1.metrics.k8s.io" },
        })
    };
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.pod_usage("a", "web-0", &[("main", "10m", "1Mi")]);
    fake.put("apiregistration.k8s.io", "apiservices", None, apiservice());
    let mut rig = Rig::new(fake).await;
    let opened = rig.open(Kind::Pods, PARTS);
    let shown = rig.watch(&opened, Duration::from_secs(2)).await;
    assert_eq!(usages(&shown).last().unwrap().cpu.used, Some(10_000_000));

    rig.fake.state().served.remove(twigo_cache::metrics::GROUP);
    rig.fake.delete_from(
        "apiregistration.k8s.io",
        "apiservices",
        None,
        "v1beta1.metrics.k8s.io",
    );
    let gone = rig.watch(&opened, Duration::from_secs(30)).await;
    let [withdrawn] = &usages(&gone)[..] else {
        panic!("one usage: {:?}", usages(&gone));
    };
    assert_eq!(withdrawn.state, MetricsState::Absent);
    assert_eq!(withdrawn.cpu.used, None);
    assert!(withdrawn.containers.is_empty());
    let later = rig.watch(&opened, Duration::from_secs(120)).await;
    assert!(usages(&later).is_empty(), "said once");

    rig.fake.serve_metrics("v1beta1");
    rig.fake
        .put("apiregistration.k8s.io", "apiservices", None, apiservice());
    let back = rig.watch(&opened, Duration::from_secs(30)).await;
    let usage = *usages(&back).last().expect("a usage again");
    assert_eq!(usage.state, MetricsState::Ready);
    assert_eq!(usage.cpu.used, Some(10_000_000));
}

#[tokio::test(start_paused = true)]
async fn a_context_whose_stale_api_is_uninstalled_withdraws_the_usage_too() {
    let apiservice = || {
        json!({
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": { "name": "v1beta1.metrics.k8s.io" },
        })
    };
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.put("apiregistration.k8s.io", "apiservices", None, apiservice());
    let mut rig = Rig::new(fake).await;
    rig.fake.stale_metrics("v1beta1");
    rig.fake
        .state()
        .no_endpoints
        .insert("/apis/metrics.k8s.io/v1beta1/namespaces/a/pods".to_owned());
    rig.fake
        .put("apiregistration.k8s.io", "apiservices", None, apiservice());
    let opened = rig.open(Kind::Pods, PARTS);
    let down = rig.watch(&opened, Duration::from_secs(30)).await;
    assert_eq!(
        usages(&down).last().map(|usage| usage.state),
        Some(MetricsState::Unavailable),
        "metrics-server is down"
    );

    rig.fake.state().served.remove(twigo_cache::metrics::GROUP);
    rig.fake.delete_from(
        "apiregistration.k8s.io",
        "apiservices",
        None,
        "v1beta1.metrics.k8s.io",
    );
    let gone = rig.watch(&opened, Duration::from_secs(120)).await;
    assert_eq!(
        usages(&gone).last().map(|usage| usage.state),
        Some(MetricsState::Absent),
        "and then uninstalled"
    );
}

#[tokio::test(start_paused = true)]
async fn a_pod_alone_says_that_it_waits_until_its_scope_answers_and_the_answer_replaces_it() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.pod_usage("a", "web-0", &[("main", "10m", "1Mi")]);
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let opened = rig.open(Kind::Pods, PARTS);
    let early = rig.watch(&opened, Duration::from_secs(2)).await;
    assert!(!early.is_empty(), "the object itself is sent");
    let [waiting] = &usages(&early)[..] else {
        panic!("one usage: {:?}", usages(&early));
    };
    assert!(waiting.waiting, "no figure before its scope answered");
    assert_eq!(waiting.state, MetricsState::Ready);
    assert_eq!(waiting.cpu.used, None);

    let after = rig.watch(&opened, Duration::from_secs(5)).await;
    let [first] = &usages(&after)[..] else {
        panic!("one usage: {:?}", usages(&after));
    };
    assert!(!first.waiting);
    assert_eq!(first.state, MetricsState::Ready);
    assert_eq!(first.cpu.used, Some(10_000_000));
    assert_eq!(first.memory.used, Some(1_048_576));
}

#[tokio::test(start_paused = true)]
async fn a_scope_that_refuses_is_waited_for_and_then_says_forbidden_and_never_ready_again() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.state()
        .forbidden
        .insert("/apis/metrics.k8s.io/v1beta1/namespaces/a/pods".to_owned());
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let opened = rig.open(Kind::Pods, PARTS);
    let batches = rig.watch(&opened, Duration::from_secs(40)).await;
    let said: Vec<(MetricsState, bool)> = usages(&batches)
        .iter()
        .map(|usage| (usage.state, usage.waiting))
        .collect();
    assert_eq!(
        said,
        [
            (MetricsState::Ready, true),
            (MetricsState::Forbidden, false)
        ],
        "waiting, then the refusal, once"
    );
    assert_eq!(usages(&batches)[1].cpu.used, None);
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
async fn a_pod_missing_from_an_answer_says_used_null_and_ready_once_the_answer_came() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let opened = rig.open(Kind::Pods, PARTS);
    let early = rig.watch(&opened, Duration::from_secs(2)).await;
    assert!(
        usages(&early).iter().all(|usage| usage.waiting),
        "nothing is known before it"
    );
    let batches = rig.watch(&opened, Duration::from_secs(40)).await;
    let usage = *usages(&batches).last().expect("a usage");
    assert!(!usage.waiting);
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

fn figures(batches: &[ObjectBatch]) -> Vec<(bool, Option<i64>)> {
    usages(batches)
        .iter()
        .map(|usage| (usage.waiting, usage.cpu.used))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_usage_that_has_figures_never_goes_back_to_waiting_while_its_request_is_replaced() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod_in_every_state());
    fake.pod_usage(
        "a",
        "web-0",
        &[
            ("debugger", "1m", "1Mi"),
            ("web", "10m", "2Mi"),
            ("api", "2m", "1Mi"),
            ("proxy", "3m", "3Mi"),
        ],
    );
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(1);
    let overview = ObjectParts {
        overview: true,
        ..PARTS
    };
    let opened = rig.open(Kind::Pods, overview);
    let alone = rig.watch(&opened, Duration::from_secs(5)).await;
    assert_eq!(
        figures(&alone),
        [(true, None), (false, Some(16_000_000))],
        "waiting once, then the figures"
    );

    let mut list = rig.context.reader(Kind::Pods);
    list.want(HashSet::from([Scope::Namespace("a".into())]));
    let joined = rig.watch(&opened, Duration::from_secs(5)).await;
    assert!(
        usages(&joined).iter().all(|usage| !usage.waiting),
        "a list reads its namespace, so its request replaces the pod's own: {:?}",
        figures(&joined)
    );

    list.want(HashSet::new());
    let left = rig.watch(&opened, Duration::from_secs(5)).await;
    assert!(
        usages(&left).iter().all(|usage| !usage.waiting),
        "the list's window leaves the namespace, and the pod asks for itself again: {:?}",
        figures(&left)
    );
    drop(list);

    opened.set_parts(ObjectParts {
        usage: false,
        ..overview
    });
    rig.watch(&opened, Duration::from_secs(5)).await;
    opened.set_parts(overview);
    let back = rig.watch(&opened, Duration::from_secs(5)).await;
    assert_eq!(
        figures(&back),
        [(false, Some(16_000_000))],
        "the part shown again has the figures at once, and the new request changes none"
    );
}

#[tokio::test(start_paused = true)]
async fn a_node_that_has_figures_keeps_them_when_the_part_is_hidden_and_shown() {
    let fake = Fake::default();
    fake.put("", "nodes", None, node());
    fake.node_usage("node-1", "277147502n", "2509700Ki");
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(1);
    let opened = rig.open(Kind::Nodes, PARTS);
    rig.watch(&opened, Duration::from_secs(5)).await;

    opened.set_parts(ObjectParts {
        usage: false,
        ..PARTS
    });
    rig.watch(&opened, Duration::from_secs(5)).await;
    opened.set_parts(PARTS);
    let back = rig.watch(&opened, Duration::from_secs(5)).await;
    assert_eq!(figures(&back), [(false, Some(277_147_502))]);
}

#[tokio::test(start_paused = true)]
async fn a_pod_replaced_under_its_name_while_its_request_is_replaced_waits_for_its_own_answer() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.pod_usage("a", "web-0", &[("main", "10m", "1Mi")]);
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(1);
    let opened = rig.open(Kind::Pods, PARTS);
    rig.watch(&opened, Duration::from_secs(5)).await;

    let mut list = rig.context.reader(Kind::Pods);
    list.want(HashSet::from([Scope::Namespace("a".into())]));
    let mut replaced = pod(json!([{ "name": "main" }]));
    replaced["metadata"]["uid"] = json!("new-uid");
    rig.fake.put("", "pods", Some("a"), replaced);
    let after = rig.watch(&opened, Duration::from_millis(500)).await;
    assert_eq!(
        figures(&after),
        [(true, None)],
        "no answer has come for the new pod"
    );
}

#[tokio::test(start_paused = true)]
async fn a_replaced_request_that_fails_takes_the_figures_with_it() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.pod_usage("a", "web-0", &[("main", "10m", "1Mi")]);
    let mut rig = Rig::new(fake).await;
    let opened = rig.open(Kind::Pods, PARTS);
    let shown = rig.watch(&opened, Duration::from_secs(5)).await;
    assert_eq!(usages(&shown).last().unwrap().cpu.used, Some(10_000_000));

    rig.fake
        .state()
        .no_endpoints
        .insert("/apis/metrics.k8s.io/v1beta1/namespaces/a/pods".to_owned());
    let mut list = rig.context.reader(Kind::Pods);
    list.want(HashSet::from([Scope::Namespace("a".into())]));
    list.want(HashSet::new());
    let failed = rig.watch(&opened, Duration::from_secs(5)).await;
    let usage = *usages(&failed).last().expect("the failure is said");
    assert_eq!(usage.state, MetricsState::Unavailable);
    assert!(!usage.waiting);
    assert_eq!(
        usage.cpu.used, None,
        "figures of an answer the failure ended"
    );
}

fn with_overview(batches: &[ObjectBatch]) -> &ObjectBatch {
    batches
        .iter()
        .find(|batch| batch.overview.is_some())
        .expect("the Overview")
}

fn said(batch: &ObjectBatch) -> Option<(MetricsState, bool)> {
    batch
        .usage
        .as_ref()
        .map(|usage| (usage.state, usage.waiting))
}

#[tokio::test(start_paused = true)]
async fn a_pod_of_a_namespace_that_refused_says_so_with_its_overview_and_the_answer_replaces_it() {
    let overview = ObjectParts {
        overview: true,
        ..PARTS
    };
    let fake = Fake::default();
    for (namespace, name) in [("a", "web-0"), ("a", "web-1"), ("b", "web-2")] {
        fake.put("", "pods", Some(namespace), pod_of(namespace, name));
        fake.pod_usage(namespace, name, &[("main", "10m", "1Mi")]);
    }
    fake.state()
        .forbidden
        .insert("/apis/metrics.k8s.io/v1beta1/namespaces/a/pods".to_owned());
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let first = rig.open_object(Kind::Pods, Some("a"), "web-0", overview);
    let refused = rig.watch(&first, Duration::from_secs(10)).await;
    assert_eq!(
        refused.iter().filter_map(said).collect::<Vec<_>>(),
        [
            (MetricsState::Ready, true),
            (MetricsState::Forbidden, false)
        ],
        "waiting, then the refusal"
    );
    drop(first);
    sleep(Duration::from_millis(100)).await;

    let second = rig.open_object(Kind::Pods, Some("a"), "web-1", overview);
    let opened = rig.watch(&second, Duration::from_secs(1)).await;
    assert_eq!(
        said(with_overview(&opened)),
        Some((MetricsState::Forbidden, false)),
        "the refusal of its namespace, with its Overview"
    );
    assert_eq!(
        with_overview(&opened).usage.as_ref().unwrap().cpu.used,
        None
    );

    rig.fake.state().forbidden.clear();
    let allowed = rig.watch(&second, Duration::from_secs(25)).await;
    let usage = *usages(&allowed).last().expect("the answer");
    assert_eq!(
        (usage.state, usage.waiting, usage.cpu.used),
        (MetricsState::Ready, false, Some(10_000_000)),
        "the refusal ended, and the figures replace it"
    );
    drop(second);
    sleep(Duration::from_millis(100)).await;

    let elsewhere = rig.open_object(Kind::Pods, Some("b"), "web-2", overview);
    let waiting = rig.watch(&elsewhere, Duration::from_secs(1)).await;
    assert_eq!(
        said(with_overview(&waiting)),
        Some((MetricsState::Ready, true)),
        "another namespace has refused nothing"
    );
}

#[tokio::test(start_paused = true)]
async fn a_refused_node_does_not_make_a_pod_say_it_and_a_node_says_it_with_its_overview() {
    let overview = ObjectParts {
        overview: true,
        ..PARTS
    };
    let fake = Fake::default();
    fake.put("", "nodes", None, node());
    fake.put("", "pods", Some("b"), pod_of("b", "web-2"));
    fake.state()
        .forbidden
        .insert("/apis/metrics.k8s.io/v1beta1/nodes".to_owned());
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let first = rig.open(Kind::Nodes, overview);
    rig.watch(&first, Duration::from_secs(10)).await;
    drop(first);
    sleep(Duration::from_millis(100)).await;

    let pod = rig.open_object(Kind::Pods, Some("b"), "web-2", overview);
    let waiting = rig.watch(&pod, Duration::from_secs(1)).await;
    assert_eq!(
        said(with_overview(&waiting)),
        Some((MetricsState::Ready, true))
    );
    drop(pod);
    sleep(Duration::from_millis(100)).await;

    let node = rig.open(Kind::Nodes, overview);
    let refused = rig.watch(&node, Duration::from_secs(1)).await;
    assert_eq!(
        said(with_overview(&refused)),
        Some((MetricsState::Forbidden, false))
    );
    assert_eq!(
        with_overview(&refused)
            .usage
            .as_ref()
            .unwrap()
            .cpu
            .allocatable,
        Some(16_000_000_000),
        "what the node allocates is known without a sample"
    );
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
    let followed = followers
        .get("kind-test", async { watch::channel(None).1 })
        .await;
    let context = Poller::new(hub.clone()).context("kind-test", &followed);
    sleep(Duration::from_secs(2)).await;
    let mut rig = Rig {
        fake,
        hub,
        context,
        _held: (clients, directory, followers),
        batches: mpsc::unbounded_channel().1,
    };
    let opened = rig.open(
        Kind::Pods,
        ObjectParts {
            overview: true,
            ..PARTS
        },
    );
    let batches = rig.watch(&opened, Duration::from_secs(60)).await;
    assert!(batches.iter().any(|batch| batch.overview.is_some()));
    assert!(usages(&batches).is_empty(), "no part, and no request");
    assert_eq!(requests(&rig.fake), 0);
}

#[tokio::test(start_paused = true)]
async fn the_overview_comes_with_a_usage_that_names_the_containers_that_run() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod_in_every_state());
    fake.pod_usage(
        "a",
        "web-0",
        &[
            ("debugger", "1m", "1Mi"),
            ("web", "10m", "2Mi"),
            ("api", "2m", "1Mi"),
            ("proxy", "3m", "3Mi"),
        ],
    );
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let opened = rig.open(
        Kind::Pods,
        ObjectParts {
            overview: true,
            ..PARTS
        },
    );
    let early = rig.watch(&opened, Duration::from_secs(2)).await;
    let with = early
        .iter()
        .find(|batch| batch.overview.is_some())
        .expect("the Overview");
    let waiting = with
        .usage
        .as_ref()
        .expect("a usage in the Overview's batch");
    assert!(waiting.waiting);
    assert_eq!(waiting.state, MetricsState::Ready);
    assert_eq!(waiting.cpu, Measure::default());
    assert_eq!(waiting.memory, Measure::default());
    assert_eq!(waiting.sampled, None);
    let names = |usage: &Usage| -> Vec<String> {
        usage.containers.iter().map(|c| c.name.clone()).collect()
    };
    assert_eq!(
        names(waiting),
        ["proxy", "api", "web", "debugger"],
        "those that run, the finished and the crash-looping left out, in the spec's order"
    );
    let web = &waiting.containers[2];
    assert_eq!(web.cpu.used, None);
    assert_eq!(web.cpu.request, Some(200_000_000));
    assert_eq!(web.cpu.limit, Some(1_000_000_000));
    assert_eq!(web.memory.limit, Some(128 * 1024 * 1024));
    assert_eq!(waiting.containers[0].memory.limit, Some(32 * 1024 * 1024));
    assert_eq!(usages(&early).len(), 1, "said once");

    let after = rig.watch(&opened, Duration::from_secs(5)).await;
    let [answer] = &usages(&after)[..] else {
        panic!("one usage: {:?}", usages(&after));
    };
    assert!(!answer.waiting);
    assert_eq!(answer.cpu.used, Some(16_000_000));
    assert_eq!(
        names(answer),
        names(waiting),
        "the answer lists the containers the waiting usage named"
    );
    assert!(answer.containers.iter().all(|c| c.cpu.used.is_some()));
    assert_eq!(answer.containers[2].cpu.request, web.cpu.request);
}

#[tokio::test(start_paused = true)]
async fn a_node_waits_with_no_containers_and_its_answer_replaces_it() {
    let fake = Fake::default();
    fake.put("", "nodes", None, node());
    fake.node_usage("node-1", "277147502n", "2509700Ki");
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let opened = rig.open(
        Kind::Nodes,
        ObjectParts {
            overview: true,
            ..PARTS
        },
    );
    let early = rig.watch(&opened, Duration::from_secs(2)).await;
    let with = early
        .iter()
        .find(|batch| batch.overview.is_some())
        .expect("the Overview");
    let waiting = with
        .usage
        .as_ref()
        .expect("a usage in the Overview's batch");
    assert!(waiting.waiting);
    assert_eq!(waiting.state, MetricsState::Ready);
    assert_eq!(waiting.cpu, Measure::default());
    assert_eq!(waiting.memory, Measure::default());
    assert!(waiting.containers.is_empty());

    let after = rig.watch(&opened, Duration::from_secs(5)).await;
    let [answer] = &usages(&after)[..] else {
        panic!("one usage: {:?}", usages(&after));
    };
    assert!(!answer.waiting);
    assert_eq!(answer.cpu.used, Some(277_147_502));
    assert_eq!(answer.cpu.allocatable, Some(16_000_000_000));
}

#[tokio::test(start_paused = true)]
async fn a_stale_api_says_unavailable_with_the_overview_before_any_request_answers() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod_in_every_state());
    fake.stale_metrics("v1beta1");
    fake.state()
        .no_endpoints
        .insert("/apis/metrics.k8s.io/v1beta1/namespaces/a/pods".to_owned());
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let opened = rig.open(
        Kind::Pods,
        ObjectParts {
            overview: true,
            ..PARTS
        },
    );
    let early = rig.watch(&opened, Duration::from_secs(2)).await;
    let with = early
        .iter()
        .find(|batch| batch.overview.is_some())
        .expect("the Overview");
    let first = with
        .usage
        .as_ref()
        .expect("a usage in the Overview's batch");
    assert_eq!(first.state, MetricsState::Unavailable);
    assert!(!first.waiting, "discovery knows it without a request");
    assert_eq!(first.cpu.used, None);

    let after = rig.watch(&opened, Duration::from_secs(5)).await;
    assert!(
        usages(&after)
            .iter()
            .all(|usage| usage.state == MetricsState::Unavailable && !usage.waiting),
        "the failure says the same"
    );
}

#[tokio::test(start_paused = true)]
async fn a_part_asked_for_later_has_the_waiting_usage_in_the_next_batch() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod_in_every_state());
    fake.pod_usage("a", "web-0", &[("web", "10m", "2Mi")]);
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let opened = rig.open(
        Kind::Pods,
        ObjectParts {
            overview: true,
            usage: false,
            ..PARTS
        },
    );
    let before = rig.watch(&opened, Duration::from_secs(2)).await;
    assert!(usages(&before).is_empty());

    opened.set_parts(ObjectParts {
        overview: true,
        ..PARTS
    });
    let next = rig.watch(&opened, Duration::from_millis(500)).await;
    let [batch] = &next[..] else {
        panic!("one batch: {next:?}");
    };
    let waiting = batch.usage.as_ref().expect("the usage in the next batch");
    assert!(waiting.waiting);
    assert_eq!(waiting.containers.len(), 4);
}

#[tokio::test(start_paused = true)]
async fn a_part_asked_for_later_has_the_figures_in_the_next_batch_where_a_list_read_the_scope() {
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod_in_every_state());
    fake.pod_usage("a", "web-0", &[("web", "10m", "2Mi")]);
    let mut rig = Rig::new(fake).await;
    let mut list = rig.context.reader(Kind::Pods);
    list.want(HashSet::from([Scope::Namespace("a".into())]));
    sleep(Duration::from_secs(1)).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3);
    let opened = rig.open(
        Kind::Pods,
        ObjectParts {
            overview: true,
            usage: false,
            ..PARTS
        },
    );
    let before = rig.watch(&opened, Duration::from_secs(1)).await;
    assert!(usages(&before).is_empty());

    opened.set_parts(ObjectParts {
        overview: true,
        ..PARTS
    });
    let next = rig.watch(&opened, Duration::from_millis(500)).await;
    let [batch] = &next[..] else {
        panic!("one batch: {next:?}");
    };
    let usage = batch.usage.as_ref().expect("the usage in the next batch");
    assert!(!usage.waiting, "the list's answer is held already");
    assert_eq!(usage.cpu.used, Some(10_000_000));
    assert_eq!(usage.containers.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn an_api_that_turns_stale_while_the_usage_waits_is_said_at_once() {
    let apiservice = || {
        json!({
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": { "name": "v1beta1.metrics.k8s.io" },
        })
    };
    let fake = Fake::default();
    fake.put("", "pods", Some("a"), pod(json!([{ "name": "main" }])));
    fake.put("apiregistration.k8s.io", "apiservices", None, apiservice());
    let mut rig = Rig::new(fake).await;
    rig.fake.state().metrics_takes = Duration::from_secs(3600);
    let opened = rig.open(Kind::Pods, PARTS);
    let early = rig.watch(&opened, Duration::from_secs(2)).await;
    let [waiting] = &usages(&early)[..] else {
        panic!("one usage: {:?}", usages(&early));
    };
    assert!(waiting.waiting);

    rig.fake.stale_metrics("v1beta1");
    rig.fake
        .put("apiregistration.k8s.io", "apiservices", None, apiservice());
    let after = rig.watch(&opened, Duration::from_secs(30)).await;
    let [stale] = &usages(&after)[..] else {
        panic!("one usage: {:?}", usages(&after));
    };
    assert_eq!(stale.state, MetricsState::Unavailable);
    assert!(!stale.waiting);
}
