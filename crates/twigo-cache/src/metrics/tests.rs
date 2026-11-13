use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tempfile::TempDir;
use tokio::sync::watch;
use tokio::time::{Instant, sleep, timeout};
use twigo_ipc::MetricsState;
use twigo_kube::client::{Budgets, Clients};
use twigo_kube::discovery::Cache;

use super::*;
use crate::discovery::Followers;
use crate::fake::Fake;
use crate::hub::Connect;

const PODS: &str = "/apis/metrics.k8s.io/v1beta1/namespaces/a/pods";
const APISERVICES: &str = "apiservices";

struct Rig {
    fake: Fake,
    context: Arc<Context>,
    _hub: (Hub, Arc<Clients>, TempDir, Followers),
}

async fn context_of(hub: &Hub, directory: &TempDir) -> (Followers, Arc<Context>) {
    let followers = Followers::new(hub.clone(), Arc::new(Cache::new(directory.path())));
    let api = followers
        .get("kind-test", async { watch::channel(None).1 })
        .await
        .api();
    (
        followers,
        Poller::new(hub.clone()).context("kind-test", api),
    )
}

async fn rig() -> Rig {
    let fake = Fake::default();
    fake.serve_metrics("v1beta1");
    fake.pod_usage("a", "p1", &[("main", "50172044n", "204Ki")]);
    fake.pod_usage("a", "p2", &[("main", "1", "40Mi")]);
    followed(fake).await
}

async fn followed(fake: Fake) -> Rig {
    let (hub, clients) = fake.hub(Budgets::default());
    let directory = tempfile::tempdir().unwrap();
    let (followers, context) = context_of(&hub, &directory).await;
    let rig = Rig {
        fake,
        context,
        _hub: (hub, clients, directory, followers),
    };
    until(|| rig.context.api().columns(Kind::Pods)).await;
    rig
}

async fn until(mut reached: impl FnMut() -> bool) {
    let waited = async {
        while !reached() {
            sleep(Duration::from_millis(10)).await;
        }
    };
    timeout(Duration::from_secs(600), waited)
        .await
        .expect("it within ten minutes");
}

fn polls(fake: &Fake) -> usize {
    fake.count("/apis/metrics.k8s.io/")
}

fn namespace(name: &str) -> HashSet<Scope> {
    HashSet::from([Scope::Namespace(name.into())])
}

fn named(namespace: &str, name: &str) -> Scope {
    Scope::Named {
        namespace: namespace.into(),
        name: name.into(),
    }
}

fn times(fake: &Fake, start: Instant) -> Vec<u64> {
    fake.state()
        .requests
        .iter()
        .filter(|(_, uri)| uri.contains("/apis/metrics.k8s.io/"))
        .map(|(at, _)| (*at - start).as_secs())
        .collect()
}

fn keys(update: &Update) -> Vec<(String, Option<i64>)> {
    let mut keys: Vec<_> = update
        .changes
        .iter()
        .map(|change| {
            (
                format!("{}/{}", change.namespace, change.name),
                change.sample.as_ref().map(|sample| sample.cpu),
            )
        })
        .collect();
    keys.sort();
    keys
}

#[test]
fn the_fake_answers_a_server_that_is_down_as_the_recorded_one_did() {
    let recorded: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../tests/fixtures/metrics-unavailable.json"
    ))
    .unwrap();
    let (content_type, body) = crate::fake::NO_ENDPOINTS;
    assert_eq!(recorded["status"], 503);
    assert_eq!(recorded["contentType"], content_type);
    assert_eq!(recorded["body"], body);
}

#[tokio::test(start_paused = true)]
async fn a_scope_is_polled_at_once_and_every_interval_while_a_reader_wants_it_and_never_after() {
    let rig = rig().await;
    let start = Instant::now();
    sleep(INTERVAL * 4).await;
    assert_eq!(polls(&rig.fake), 0, "no request before a reader");

    let mut reader = rig.context.reader(Kind::Pods);
    let wanted = Instant::now();
    reader.want(namespace("a"));
    until(|| polls(&rig.fake) > 0).await;
    let first_poll = rig
        .fake
        .state()
        .requests
        .iter()
        .find(|(_, uri)| uri.contains("/apis/metrics.k8s.io/"))
        .map(|(at, _)| *at);
    assert_eq!(first_poll, Some(wanted), "the first poll comes at once");
    sleep(INTERVAL * 4 + Duration::from_secs(1)).await;
    let first = (wanted - start).as_secs();
    assert_eq!(
        times(&rig.fake, start),
        (0..=4)
            .map(|n| first + INTERVAL.as_secs() * n)
            .collect::<Vec<_>>(),
        "one per interval"
    );

    drop(reader);
    let after = polls(&rig.fake);
    sleep(INTERVAL * 20).await;
    assert_eq!(polls(&rig.fake), after, "none once the last reader let go");
}

#[tokio::test(start_paused = true)]
async fn two_readers_of_a_scope_share_one_request_per_interval() {
    let rig = rig().await;
    let (mut one, mut two) = (
        rig.context.reader(Kind::Pods),
        rig.context.reader(Kind::Pods),
    );
    one.want(namespace("a"));
    two.want(namespace("a"));
    sleep(INTERVAL * 4 + Duration::from_secs(1)).await;
    assert_eq!(polls(&rig.fake), 5);
    for reader in [&one, &two] {
        assert_eq!(
            keys(&reader.drain()).len(),
            0,
            "told by a reset, not by changes"
        );
    }
    drop(one);
    sleep(INTERVAL * 2).await;
    assert_eq!(polls(&rig.fake), 7, "the other still wants it");
}

#[tokio::test(start_paused = true)]
async fn a_reader_hears_only_the_keys_whose_values_changed_appeared_or_went() {
    let rig = rig().await;
    rig.fake
        .pod_usage("a", "multi", &[("b", "1m", "1Mi"), ("a", "2m", "1Mi")]);
    let mut reader = rig.context.reader(Kind::Pods);
    reader.want(namespace("a"));
    until(|| polls(&rig.fake) > 0).await;
    sleep(Duration::from_millis(1)).await;
    let first = reader.drain();
    assert_eq!(first.state, Some(MetricsState::Ready));
    let [reset] = &first.resets[..] else {
        panic!("one reset: {first:?}");
    };
    assert_eq!(reset.scope, Scope::Namespace("a".into()));
    assert_eq!(reset.samples.len(), 3);
    assert!(first.changes.is_empty());

    sleep(INTERVAL * 3).await;
    let quiet = reader.drain();
    assert!(
        quiet.resets.is_empty() && quiet.changes.is_empty(),
        "the containers came in another order and the request's time moved: {quiet:?}"
    );

    rig.fake.pod_usage("a", "p1", &[("main", "60m", "204Ki")]);
    rig.fake.pod_usage("a", "new", &[("main", "3m", "1Mi")]);
    rig.fake.delete_from(GROUP, "pods", Some("a"), "p2");
    sleep(INTERVAL).await;
    let changed = reader.drain();
    assert_eq!(
        keys(&changed),
        [
            ("a/new".to_owned(), Some(3_000_000)),
            ("a/p1".to_owned(), Some(60_000_000)),
            ("a/p2".to_owned(), None),
        ],
        "a pod that left the answer has no sample, and no zero"
    );
}

#[tokio::test(start_paused = true)]
async fn an_answer_that_does_not_serve_the_service_is_a_state_with_no_values_and_recovers() {
    let rig = rig().await;
    let mut reader = rig.context.reader(Kind::Pods);
    reader.want(namespace("a"));
    sleep(Duration::from_millis(1)).await;
    assert_eq!(reader.drain().state, Some(MetricsState::Ready));

    rig.fake.state().no_endpoints.insert(PODS.to_owned());
    sleep(INTERVAL + Duration::from_secs(1)).await;
    let down = reader.drain();
    assert_eq!(down.state, Some(MetricsState::Unavailable));
    assert_eq!(
        keys(&down),
        [("a/p1".to_owned(), None), ("a/p2".to_owned(), None)],
        "nothing on screen as a value"
    );
    let failed = polls(&rig.fake);
    sleep(Duration::from_secs(14)).await;
    assert!(
        polls(&rig.fake) >= failed + 3,
        "a failure retries on the backoff, not in 15 s: {} polls",
        polls(&rig.fake) - failed
    );

    rig.fake.state().no_endpoints.clear();
    let mut back = Update::default();
    until(|| {
        let update = reader.drain();
        back.changes.extend(update.changes);
        update.state == Some(MetricsState::Ready)
    })
    .await;
    assert_eq!(
        keys(&back),
        [
            ("a/p1".to_owned(), Some(50_172_044)),
            ("a/p2".to_owned(), Some(1_000_000_000))
        ],
        "its values come back"
    );
    let polled = polls(&rig.fake);
    sleep(INTERVAL * 2 + Duration::from_secs(1)).await;
    assert_eq!(polls(&rig.fake), polled + 2, "an answer resets the backoff");
}

#[tokio::test(start_paused = true)]
async fn a_refused_person_is_forbidden_and_the_scope_recovers_when_allowed() {
    let rig = rig().await;
    rig.fake.state().forbidden.insert(PODS.to_owned());
    let mut reader = rig.context.reader(Kind::Pods);
    reader.want(namespace("a"));
    let mut other = rig.context.reader(Kind::Pods);
    other.want(namespace("b"));
    until(|| reader.drain().state == Some(MetricsState::Forbidden)).await;
    assert_eq!(
        other.drain().state,
        Some(MetricsState::Ready),
        "only the scope refused"
    );
    let mut both = rig.context.reader(Kind::Pods);
    both.want(namespace("a").into_iter().chain(namespace("b")).collect());
    sleep(Duration::from_millis(1)).await;
    assert_eq!(
        both.drain().state,
        Some(MetricsState::Forbidden),
        "forbidden outranks ready over several scopes"
    );

    rig.fake.state().forbidden.clear();
    until(|| reader.drain().state == Some(MetricsState::Ready)).await;
}

#[tokio::test(start_paused = true)]
async fn a_pod_alone_asks_for_itself_and_none_when_a_list_reads_its_namespace() {
    let rig = rig().await;
    let start = Instant::now();
    let mut alone = rig.context.reader(Kind::Pods);
    alone.want(HashSet::from([named("a", "p1")]));
    sleep(Duration::from_millis(1)).await;
    assert_eq!(
        rig.fake
            .count("namespaces/a/pods?fieldSelector=metadata.name%3Dp1"),
        1
    );
    let heard = alone.drain();
    let [reset] = &heard.resets[..] else {
        panic!("{heard:?}");
    };
    assert_eq!(reset.samples.len(), 1, "its own pod only");

    let mut list = rig.context.reader(Kind::Pods);
    list.want(namespace("a"));
    sleep(Duration::from_millis(1)).await;
    let polled = polls(&rig.fake);
    sleep(INTERVAL * 3).await;
    assert_eq!(
        polls(&rig.fake),
        polled + 3,
        "one request for the list, none of its own for the pod: {:?}",
        times(&rig.fake, start)
    );
    assert_eq!(
        rig.fake.count("fieldSelector"),
        1,
        "the pod's own request ended"
    );
    rig.fake.pod_usage("a", "p1", &[("main", "70m", "1Mi")]);
    rig.fake.pod_usage("a", "p2", &[("main", "80m", "1Mi")]);
    sleep(INTERVAL).await;
    assert_eq!(
        keys(&alone.drain()),
        [("a/p1".to_owned(), Some(70_000_000))],
        "the pod hears its own key from the list's answer"
    );

    let before = polls(&rig.fake);
    let mut late = rig.context.reader(Kind::Pods);
    late.want(HashSet::from([named("a", "p2")]));
    let heard = late.drain();
    assert_eq!(
        heard
            .resets
            .iter()
            .map(|reset| &reset.scope)
            .collect::<Vec<_>>(),
        [&Scope::Namespace("a".into())],
        "a pod wanted while its namespace is polled is told from that answer"
    );
    assert_eq!(polls(&rig.fake), before, "with no request of its own");
    drop(late);

    drop(list);
    sleep(Duration::from_millis(1)).await;
    assert_eq!(
        rig.fake.count("fieldSelector"),
        2,
        "alone again, it asks for itself at once"
    );
}

#[tokio::test(start_paused = true)]
async fn nodes_have_one_scope_and_the_cluster_one_covers_the_namespaces() {
    let rig = rig().await;
    rig.fake.node_usage("n1", "277147502n", "2509700Ki");
    let mut nodes = rig.context.reader(Kind::Nodes);
    nodes.want(HashSet::from([Scope::Cluster]));
    sleep(Duration::from_millis(1)).await;
    let heard = nodes.drain();
    let sample = heard.resets[0].samples.get("", "n1").unwrap().clone();
    assert_eq!((sample.cpu, sample.memory), (277_147_502, 2_569_932_800));
    assert_eq!(rig.fake.count("/apis/metrics.k8s.io/v1beta1/nodes"), 1);

    let mut pods = rig.context.reader(Kind::Pods);
    pods.want(
        namespace("a")
            .into_iter()
            .chain([Scope::Namespace("b".into())])
            .collect(),
    );
    let mut cluster = rig.context.reader(Kind::Pods);
    cluster.want(HashSet::from([Scope::Cluster]));
    sleep(Duration::from_millis(1)).await;
    let before = polls(&rig.fake);
    sleep(INTERVAL * 2).await;
    assert_eq!(
        polls(&rig.fake) - before,
        2 + 2,
        "the cluster's and the nodes', every interval, none per namespace"
    );
}

#[tokio::test(start_paused = true)]
async fn what_a_context_serves_follows_the_cluster_and_a_stale_api_keeps_its_columns() {
    let fake = Fake::default();
    let apiservice = |name: &str| {
        json!({
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": { "name": name },
        })
    };
    let rig = followed_without_metrics(fake.clone()).await;
    assert_eq!(rig.context.api(), Api::Absent, "no metrics-server");
    assert!(!rig.context.api().columns(Kind::Pods));

    fake.serve_metrics("v1beta1");
    fake.put(
        "apiregistration.k8s.io",
        APISERVICES,
        None,
        apiservice("v1beta1.metrics.k8s.io"),
    );
    until(|| rig.context.api().columns(Kind::Nodes)).await;
    assert_eq!(
        rig.context.api(),
        Api::Served {
            version: "v1beta1",
            pods: true,
            nodes: true
        }
    );

    fake.stale_metrics("v1beta1");
    fake.put(
        "apiregistration.k8s.io",
        APISERVICES,
        None,
        apiservice("v1beta1.metrics.k8s.io"),
    );
    until(|| rig.context.api().stale()).await;
    assert!(
        rig.context.api().columns(Kind::Pods),
        "stale counts as served"
    );
    assert!(rig.context.api().columns(Kind::Nodes));

    fake.serve_metrics("v1beta1");
    fake.put(
        "apiregistration.k8s.io",
        APISERVICES,
        None,
        apiservice("v1beta1.metrics.k8s.io"),
    );
    until(|| !rig.context.api().stale()).await;

    fake.state().served.remove(GROUP);
    fake.delete_from(
        "apiregistration.k8s.io",
        APISERVICES,
        None,
        "v1beta1.metrics.k8s.io",
    );
    until(|| rig.context.api() == Api::Absent).await;
}

async fn followed_without_metrics(fake: Fake) -> Rig {
    let (hub, clients) = fake.hub(Budgets::default());
    let directory = tempfile::tempdir().unwrap();
    let (followers, context) = context_of(&hub, &directory).await;
    sleep(Duration::from_secs(1)).await;
    Rig {
        fake,
        context,
        _hub: (hub, clients, directory, followers),
    }
}

#[tokio::test(start_paused = true)]
async fn v1_comes_before_v1beta1() {
    let fake = Fake::default();
    fake.serve_metrics("v1");
    let rig = followed(fake).await;
    assert_eq!(
        rig.context.api(),
        Api::Served {
            version: "v1",
            pods: true,
            nodes: true
        }
    );
    let mut reader = rig.context.reader(Kind::Pods);
    reader.want(namespace("a"));
    sleep(Duration::from_millis(1)).await;
    assert_eq!(
        rig.fake.count("/apis/metrics.k8s.io/v1/namespaces/a/pods"),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn a_poll_follows_clients_abandoned_meanwhile() {
    let fake = Fake::default();
    fake.serve_metrics("v1beta1");
    fake.pod_usage("a", "p1", &[("main", "1m", "1Mi")]);
    let first = fake.clients(Budgets::default());
    let second = fake.clients(Budgets::default());
    let switched = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let connect: Connect = {
        let (first, second, switched) = (
            Arc::clone(&first),
            Arc::clone(&second),
            Arc::clone(&switched),
        );
        Arc::new(move |_context| {
            let now = switched.load(std::sync::atomic::Ordering::Relaxed);
            let clients = Arc::clone(if now { &second } else { &first });
            Box::pin(async move { Ok(clients) })
        })
    };
    let directory = tempfile::tempdir().unwrap();
    let hub = Hub::new(connect);
    let (_followers, context) = context_of(&hub, &directory).await;
    until(|| context.api().columns(Kind::Pods)).await;
    let mut reader = context.reader(Kind::Pods);
    reader.want(namespace("a"));
    sleep(Duration::from_millis(1)).await;
    let polled = polls(&fake);
    switched.store(true, std::sync::atomic::Ordering::Relaxed);
    first.connections().abandon();
    sleep(Duration::from_secs(1)).await;
    assert_eq!(
        polls(&fake),
        polled + 1,
        "it listed over the new clients without waiting out its 15 s"
    );
}
