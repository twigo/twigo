//! The lists of pods that read their metrics: what they ask of the poller,
//! counted on the fake's request log over virtual minutes.

use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep, timeout, timeout_at};
use twigo_ipc::Discovered;
use twigo_ipc::{Cell, Gvr, ListQuery, MetricsState, Sort, ViewState};
use twigo_kube::client::{Budgets, Clients};
use twigo_kube::discovery::Cache;

use super::*;
use crate::discovery::Followers;
use crate::fake::Fake;
use crate::hub::{Hub, Query, Resource, RowFormat};
use crate::metrics::{FIRST_ANSWER, Kind, Poller};

fn polls(fake: &Fake, namespace: &str) -> usize {
    fake.count(&format!(
        "/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods"
    ))
}

fn requests_to_the_group(fake: &Fake) -> usize {
    fake.count("metrics.k8s.io/")
}

struct Metered {
    fake: Fake,
    followers: Arc<Followers>,
    poller: Poller,
    hub: Hub,
    _held: (Arc<Clients>, tempfile::TempDir),
    query: ListQuery,
    batcher: Option<Batcher>,
    batches: mpsc::UnboundedReceiver<(Instant, ListBatch)>,
    columns: Vec<twigo_ipc::Column>,
}

async fn cluster(serving: bool) -> Fake {
    let fake = Fake::default();
    if serving {
        fake.serve_metrics("v1beta1");
    }
    for (namespace, pods) in [("a", ["p1", "p2", "p3"]), ("b", ["q1", "q2", "q3"])] {
        for (at, pod) in pods.iter().enumerate() {
            fake.add("pods", Some(namespace), pod);
            let cpu = format!("{}m", (at + 1) * if namespace == "a" { 2 } else { 3 });
            fake.pod_usage(namespace, pod, &[("main", &cpu, "1Mi")]);
        }
    }
    fake
}

fn query(sort: Option<Sort>, all: bool) -> ListQuery {
    ListQuery {
        space: "kind-test".to_owned(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
        },
        namespaced: true,
        namespaces: if all {
            Vec::new()
        } else {
            vec!["a".to_owned(), "b".to_owned()]
        },
        label_selector: None,
        field_selector: None,
        owners: None,
        text: None,
        columns: None,
        sort,
        count_by: None,
        group_by: None,
        values: None,
    }
}

fn opening(poller: &Poller, followers: &Arc<Followers>) -> Opening {
    let (poller, followers) = (poller.clone(), Arc::clone(followers));
    Box::pin(async move {
        let followed = followers
            .get("kind-test", async { watch::channel(None).1 })
            .await;
        poller
            .context("kind-test", followed.api())
            .reader(Kind::Pods)
    })
}

async fn discovered(followers: &Followers) {
    let followed = followers
        .get("kind-test", async { watch::channel(None).1 })
        .await;
    let mut resources = followed.follow();
    let waited = async { while !matches!(resources.next().await, Discovered::Ready { .. }) {} };
    timeout_at(Instant::now() + Duration::from_secs(600), waited)
        .await
        .expect("discovery within ten minutes");
}

async fn open(
    hub: &Hub,
    poller: &Poller,
    followers: &Arc<Followers>,
    query: &ListQuery,
) -> (Batcher, mpsc::UnboundedReceiver<(Instant, ListBatch)>) {
    let namespaces: Vec<&str> = query.namespaces.iter().map(String::as_str).collect();
    let subscription = hub.rows(rows(&namespaces)).await.unwrap();
    let spec = Spec::new("kind-test", query).unwrap();
    let (sender, batches) = mpsc::unbounded_channel();
    let batcher = Batcher::spawn(
        subscription,
        spec,
        Some(opening(poller, followers)),
        move |batch| sender.send((Instant::now(), batch)).is_ok(),
    );
    (batcher, batches)
}

impl Metered {
    async fn start(fake: Fake, sort: Option<Sort>) -> Self {
        Self::of(fake, query(sort, false), true).await
    }

    async fn start_all(fake: Fake, sort: Option<Sort>) -> Self {
        Self::of(fake, query(sort, true), true).await
    }

    async fn of(fake: Fake, query: ListQuery, watched: bool) -> Self {
        Self::build(fake, query, watched, false).await
    }

    async fn cold(fake: Fake, sort: Option<Sort>) -> Self {
        Self::build(fake, query(sort, false), true, true).await
    }

    async fn build(fake: Fake, query: ListQuery, watched: bool, cold: bool) -> Self {
        let (hub, clients) = fake.hub(Budgets::default());
        let directory = tempfile::tempdir().unwrap();
        let followers = Arc::new(Followers::new(
            hub.clone(),
            Arc::new(Cache::new(directory.path())),
        ));
        let poller = Poller::new(hub.clone());
        if watched {
            discovered(&followers).await;
        }
        fake.state().hold_initial = cold;
        let (batcher, batches) = open(&hub, &poller, &followers, &query).await;
        Self {
            fake,
            query,
            followers,
            poller,
            hub,
            _held: (clients, directory),
            batcher: Some(batcher),
            batches,
            columns: Vec::new(),
        }
    }

    fn batcher(&self) -> &Batcher {
        self.batcher.as_ref().expect("a list is open")
    }

    async fn reopen(&mut self, sort: Option<Sort>, pause: Duration) {
        self.batcher = None;
        sleep(pause).await;
        self.query.sort = sort;
        let (batcher, batches) = open(&self.hub, &self.poller, &self.followers, &self.query).await;
        self.batcher = Some(batcher);
        self.batches = batches;
    }

    async fn watch(&mut self, time: Duration) -> Vec<ListBatch> {
        let end = Instant::now() + time;
        let mut seen = Vec::new();
        while let Ok(Some((_, batch))) = timeout_at(end, self.batches.recv()).await {
            self.batcher().ack(batch.seq);
            if let Some(columns) = &batch.columns {
                self.columns.clone_from(columns);
            }
            seen.push(batch);
        }
        seen
    }

    fn cpus(&self, batches: &[ListBatch], id: &str) -> Vec<Cell> {
        let at = self
            .columns
            .iter()
            .position(|column| column.name == "CPU")
            .expect("a CPU column");
        batches
            .iter()
            .flat_map(|batch| &batch.upserts)
            .filter(|row| row.id.0 == id)
            .map(|row| row.cells[at].clone())
            .collect()
    }
}

fn rows(namespaces: &[&str]) -> Query {
    Query {
        context: "kind-test".to_owned(),
        resource: Resource {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
            namespaced: true,
        },
        format: RowFormat::Metadata,
        namespaces: namespaces.iter().map(|name| (*name).to_owned()).collect(),
        field_selector: None,
    }
}

#[tokio::test(start_paused = true)]
async fn nothing_is_polled_before_a_window_or_while_the_columns_are_not_read() {
    let mut list = Metered::start(cluster(true).await, None).await;
    list.watch(Duration::from_secs(120)).await;
    assert_eq!(requests_to_the_group(&list.fake), 0, "no window yet");

    list.batcher().set_window(0, 6, false);
    let batches = list.watch(Duration::from_secs(120)).await;
    assert!(
        batches[0]
            .columns
            .as_ref()
            .unwrap()
            .iter()
            .any(|c| c.name == "CPU"),
        "the columns are there whatever the poller has answered"
    );
    assert_eq!(batches[0].metrics, Some(MetricsState::Ready));
    assert_eq!(requests_to_the_group(&list.fake), 0, "metrics: false");

    list.batcher().set_window(0, 6, true);
    list.watch(Duration::from_secs(2)).await;
    assert!(requests_to_the_group(&list.fake) > 0, "read now");
}

async fn first_at(list: &mut Metered) -> (Instant, ListBatch) {
    let (at, batch) = timeout(Duration::from_secs(600), list.batches.recv())
        .await
        .expect("a batch within ten minutes")
        .expect("the batcher runs");
    list.batcher().ack(batch.seq);
    if let Some(columns) = &batch.columns {
        list.columns.clone_from(columns);
    }
    (at, batch)
}

async fn first(list: &mut Metered) -> ListBatch {
    first_at(list).await.1
}

fn has_metric_columns(batch: &ListBatch) -> bool {
    let columns = batch.columns.as_ref().expect("the first batch has columns");
    ["CPU", "Memory"]
        .iter()
        .all(|name| columns.iter().any(|column| column.name == *name))
}

#[tokio::test(start_paused = true)]
async fn the_first_batch_has_the_columns_and_so_has_one_of_a_list_opened_again_after_the_last_closed()
 {
    let mut list = Metered::start(cluster(true).await, None).await;
    sleep(Duration::from_secs(1)).await;
    list.batcher().set_window(0, 6, true);
    let opened = first(&mut list).await;
    assert!(has_metric_columns(&opened), "{:?}", opened.columns);
    assert_eq!(opened.metrics, Some(MetricsState::Ready));
    assert_eq!(
        opened.upserts.len(),
        6,
        "its rows come once, with the columns"
    );

    list.reopen(None, Duration::from_secs(1)).await;
    sleep(Duration::from_secs(1)).await;
    list.batcher().set_window(0, 6, true);
    let again = first(&mut list).await;
    assert!(has_metric_columns(&again), "{:?}", again.columns);
    assert_eq!(again.metrics, Some(MetricsState::Ready));
    assert_eq!(again.upserts.len(), 6, "and nothing is sent twice");
    let rest = list.watch(Duration::from_secs(2)).await;
    assert!(
        rest.iter().all(|batch| batch.columns.is_none()),
        "the columns do not change later: {rest:?}"
    );
}

fn cells_of(batch: &ListBatch, column: &str) -> Vec<Cell> {
    let at = batch
        .columns
        .as_ref()
        .expect("the first batch has columns")
        .iter()
        .position(|candidate| candidate.name == column)
        .expect("the column");
    batch
        .upserts
        .iter()
        .map(|row| row.cells[at].clone())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_list_that_joins_a_scope_another_reads_has_its_values_and_state_in_its_first_batch() {
    let mut list = Metered::start(cluster(true).await, None).await;
    list.batcher().set_window(0, 3, true);
    list.watch(Duration::from_secs(1)).await;
    let asked = polls(&list.fake, "a");
    assert_eq!(asked, 1);

    let (second, mut batches) = open(&list.hub, &list.poller, &list.followers, &list.query).await;
    second.set_window(0, 3, true);
    let (_, joined) = batches.recv().await.expect("a first batch");
    assert_eq!(
        cells_of(&joined, "CPU"),
        [2_000_000, 4_000_000, 6_000_000].map(Cell::Int)
    );
    assert_eq!(joined.metrics, Some(MetricsState::Ready));
    assert_eq!(polls(&list.fake, "a"), asked, "no request in between");
}

#[tokio::test(start_paused = true)]
async fn a_list_that_joins_a_scope_that_refused_says_so_in_its_first_batch() {
    let fake = cluster(true).await;
    for namespace in ["a", "b"] {
        fake.state().forbidden.insert(format!(
            "/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods"
        ));
    }
    let mut list = Metered::start(fake, None).await;
    list.batcher().set_window(0, 3, true);
    let opened = list.watch(Duration::from_secs(1)).await;
    assert_eq!(
        opened.last().and_then(|batch| batch.metrics),
        Some(MetricsState::Forbidden)
    );
    let asked = polls(&list.fake, "a");

    let (second, mut batches) = open(&list.hub, &list.poller, &list.followers, &list.query).await;
    second.set_window(0, 3, true);
    let (_, joined) = batches.recv().await.expect("a first batch");
    assert_eq!(joined.metrics, Some(MetricsState::Forbidden));
    assert_eq!(polls(&list.fake, "a"), asked, "no request in between");
}

fn cpu_descending() -> Option<Sort> {
    Some(Sort {
        column: "CPU".to_owned(),
        descending: true,
    })
}

const BY_CPU: [&str; 6] = [
    "kind-test/b/q3",
    "kind-test/a/p3",
    "kind-test/b/q2",
    "kind-test/a/p2",
    "kind-test/b/q1",
    "kind-test/a/p1",
];

const BY_ID: [&str; 6] = [
    "kind-test/a/p1",
    "kind-test/a/p2",
    "kind-test/a/p3",
    "kind-test/b/q1",
    "kind-test/b/q2",
    "kind-test/b/q3",
];

fn window_ids(batch: &ListBatch) -> Vec<&str> {
    batch
        .window
        .as_ref()
        .expect("a window")
        .ids
        .iter()
        .map(|id| id.0.as_str())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_list_sorted_by_a_metric_has_its_order_and_values_in_its_first_batch() {
    let mut list = Metered::start(cluster(true).await, cpu_descending()).await;
    sleep(Duration::from_secs(1)).await;
    let asked = Instant::now();
    list.batcher().set_window(0, 6, true);
    let (at, opened) = first_at(&mut list).await;
    assert_eq!(window_ids(&opened), BY_CPU);
    assert_eq!(
        cells_of(&opened, "CPU"),
        [9, 6, 6, 4, 3, 2].map(|milli| Cell::Int(milli * 1_000_000))
    );
    assert_eq!(opened.metrics, Some(MetricsState::Ready));
    assert!(
        at - asked <= FLUSH,
        "as soon as the answers came: {:?}",
        at - asked
    );
}

#[tokio::test(start_paused = true)]
async fn a_scope_that_never_answers_lets_the_first_batch_out_at_the_bound_and_the_order_settles() {
    let fake = cluster(true).await;
    fake.state().metrics_takes = Duration::from_secs(20);
    let mut list = Metered::start(fake, cpu_descending()).await;
    sleep(Duration::from_secs(1)).await;
    let asked = Instant::now();
    list.batcher().set_window(0, 6, true);
    let (at, bounded) = first_at(&mut list).await;
    assert!(
        (FIRST_ANSWER..=FIRST_ANSWER + FLUSH).contains(&(at - asked)),
        "{:?}",
        at - asked
    );
    assert_eq!(window_ids(&bounded), BY_ID, "as it is: no sample yet");
    assert_eq!(bounded.metrics, Some(MetricsState::Ready));

    let later = list.watch(Duration::from_secs(30)).await;
    let moved = later
        .iter()
        .find(|batch| batch.window.is_some())
        .expect("the order settles when the answers come");
    assert_eq!(window_ids(moved), BY_CPU);
    assert_eq!(
        list.cpus(&later, "kind-test/b/q3").last(),
        Some(&Cell::Int(9_000_000))
    );
}

#[tokio::test(start_paused = true)]
async fn a_scope_that_refuses_lets_the_first_batch_out_at_once_saying_forbidden() {
    let fake = cluster(true).await;
    for namespace in ["a", "b"] {
        fake.state().forbidden.insert(format!(
            "/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods"
        ));
    }
    let mut list = Metered::start(fake, cpu_descending()).await;
    sleep(Duration::from_secs(1)).await;
    let asked = Instant::now();
    list.batcher().set_window(0, 6, true);
    let (at, refused) = first_at(&mut list).await;
    assert_eq!(refused.metrics, Some(MetricsState::Forbidden));
    assert_eq!(window_ids(&refused), BY_ID);
    assert!(at - asked <= FLUSH, "{:?}", at - asked);
}

#[tokio::test(start_paused = true)]
async fn a_list_not_sorted_by_a_metric_never_waits_for_the_poller() {
    let fake = cluster(true).await;
    fake.state().metrics_takes = Duration::from_secs(3600);
    let mut list = Metered::start(fake, None).await;
    sleep(Duration::from_secs(1)).await;
    let asked = Instant::now();
    list.batcher().set_window(0, 6, true);
    let (at, opened) = first_at(&mut list).await;
    assert_eq!(at, asked, "with its window");
    assert_eq!(window_ids(&opened), BY_ID);
    assert_eq!(cells_of(&opened, "CPU"), vec![Cell::Null; 6]);
}

#[tokio::test(start_paused = true)]
async fn a_list_sorted_by_a_metric_that_is_not_read_does_not_wait_either() {
    let fake = cluster(true).await;
    fake.state().metrics_takes = Duration::from_secs(3600);
    let mut list = Metered::start(fake, cpu_descending()).await;
    sleep(Duration::from_secs(1)).await;
    let asked = Instant::now();
    list.batcher().set_window(0, 6, false);
    let (at, opened) = first_at(&mut list).await;
    assert_eq!(at, asked);
    assert_eq!(window_ids(&opened), BY_ID);
    assert_eq!(requests_to_the_group(&list.fake), 0);
}

#[tokio::test(start_paused = true)]
async fn a_list_whose_rows_come_after_its_window_holds_the_first_batch_that_has_them() {
    let mut list = Metered::cold(cluster(true).await, cpu_descending()).await;
    list.batcher().set_window(0, 6, true);
    let (_, listing) = first_at(&mut list).await;
    assert_eq!(
        listing.total, 0,
        "nothing to order yet: {:?}",
        listing.status
    );
    assert_eq!(requests_to_the_group(&list.fake), 0);

    list.fake.release_initial();
    let opened = loop {
        let batch = first(&mut list).await;
        if batch.total > 0 {
            break batch;
        }
    };
    assert_eq!(window_ids(&opened), BY_CPU);
    assert_eq!(
        list.cpus(std::slice::from_ref(&opened), "kind-test/b/q3"),
        [Cell::Int(9_000_000)]
    );
}

#[tokio::test(start_paused = true)]
async fn a_list_opened_before_any_discovery_answered_gets_its_columns_once_it_does() {
    let mut list = Metered::of(cluster(true).await, query(None, false), false).await;
    list.batcher().set_window(0, 6, true);
    let before = first(&mut list).await;
    assert!(
        !has_metric_columns(&before),
        "nothing is known of the context yet"
    );

    let later = list.watch(Duration::from_secs(120)).await;
    assert!(
        later
            .iter()
            .filter_map(|batch| batch.columns.as_ref())
            .any(|columns| columns.iter().any(|column| column.name == "CPU")),
        "they arrive with the answer"
    );
}

#[tokio::test(start_paused = true)]
async fn only_the_namespaces_of_the_window_are_polled_and_they_move_with_it() {
    let mut list = Metered::start(cluster(true).await, None).await;
    list.batcher().set_window(0, 3, true);
    list.watch(Duration::from_secs(2 * 15 + 1)).await;
    assert_eq!(polls(&list.fake, "a"), 3, "the namespace of p1 to p3");
    assert_eq!(
        polls(&list.fake, "b"),
        0,
        "none for a namespace out of the window"
    );

    list.batcher().set_window(3, 6, true);
    list.watch(Duration::from_millis(100)).await;
    let (a, b) = (polls(&list.fake, "a"), polls(&list.fake, "b"));
    assert_eq!(b, 1, "the new namespace at once");
    list.watch(Duration::from_secs(3 * 15 + 5)).await;
    assert_eq!(polls(&list.fake, "a"), a, "the old one stopped at once");
    assert_eq!(polls(&list.fake, "b"), b + 3);

    list.batcher().set_window(2, 4, true);
    list.watch(Duration::from_millis(100)).await;
    assert_eq!(
        polls(&list.fake, "a"),
        a + 1,
        "both, while the window holds both"
    );
}

#[tokio::test(start_paused = true)]
async fn nothing_is_polled_while_a_batch_stays_unacknowledged() {
    let mut list = Metered::start(cluster(true).await, None).await;
    list.batcher().set_window(0, 3, true);
    list.watch(Duration::from_secs(2)).await;
    assert!(
        polls(&list.fake, "a") >= 1,
        "it polled while its batches were answered"
    );
    list.batcher().set_window(0, 2, true);
    let (_, first) = list.batches.recv().await.unwrap();
    sleep(INTERVAL + Duration::from_secs(1)).await;
    let polled = polls(&list.fake, "a");
    sleep(Duration::from_secs(600)).await;
    assert_eq!(
        polls(&list.fake, "a"),
        polled,
        "a hidden window polls nothing"
    );

    list.batcher().ack(first.seq);
    list.watch(Duration::from_secs(1)).await;
    assert_eq!(
        polls(&list.fake, "a"),
        polled + 1,
        "and again, at once, once it answers"
    );
}

#[tokio::test(start_paused = true)]
async fn sorted_by_a_metric_every_namespace_of_the_list_is_polled_until_the_sort_changes() {
    let sort = Sort {
        column: "CPU".to_owned(),
        descending: true,
    };
    let mut list = Metered::start(cluster(true).await, Some(sort)).await;
    list.batcher().set_window(0, 2, true);
    let batches = list.watch(Duration::from_secs(1)).await;
    assert_eq!(polls(&list.fake, "a"), 1);
    assert_eq!(
        polls(&list.fake, "b"),
        1,
        "the window shows only the first rows"
    );
    let ids: Vec<&str> = batches
        .iter()
        .flat_map(|batch| batch.window.iter())
        .flat_map(|window| window.ids.iter().map(|id| id.0.as_str()))
        .collect();
    assert!(
        ids.contains(&"kind-test/b/q3"),
        "the largest CPU leads: {ids:?}"
    );

    list.reopen(None, Duration::ZERO).await;
    list.batcher().set_window(0, 2, true);
    list.watch(Duration::from_secs(1)).await;
    let (a, b) = (polls(&list.fake, "a"), polls(&list.fake, "b"));
    list.watch(Duration::from_secs(2 * 15)).await;
    assert_eq!(
        polls(&list.fake, "b"),
        b,
        "the sort changed, so b is out of the window"
    );
    assert_eq!(polls(&list.fake, "a"), a + 2);
}

#[tokio::test(start_paused = true)]
async fn a_list_of_all_namespaces_sorted_by_a_metric_asks_the_cluster_and_its_namespaces_when_refused()
 {
    let sort = || Sort {
        column: "CPU".to_owned(),
        descending: true,
    };
    let mut allowed = Metered::start_all(cluster(true).await, Some(sort())).await;
    allowed.batcher().set_window(0, 6, true);
    let batches = allowed.watch(Duration::from_secs(40)).await;
    assert_eq!(allowed.fake.count("/apis/metrics.k8s.io/v1beta1/pods"), 3);
    assert_eq!(
        polls(&allowed.fake, "a") + polls(&allowed.fake, "b"),
        0,
        "one request for the cluster, none per namespace"
    );
    assert_eq!(batches[0].metrics, Some(MetricsState::Ready));

    let fake = cluster(true).await;
    fake.state()
        .forbidden
        .insert("/apis/metrics.k8s.io/v1beta1/pods".to_owned());
    let mut refused = Metered::start_all(fake, Some(sort())).await;
    refused.batcher().set_window(0, 6, true);
    let batches = refused.watch(Duration::from_secs(40)).await;
    assert!(polls(&refused.fake, "a") >= 2 && polls(&refused.fake, "b") >= 2);
    let states: Vec<_> = batches.iter().filter_map(|batch| batch.metrics).collect();
    assert_eq!(
        states.last(),
        Some(&MetricsState::Ready),
        "the namespaces answer for the list: {states:?}"
    );
    assert_eq!(
        refused.cpus(&batches, "kind-test/b/q3").last(),
        Some(&Cell::Int(9_000_000)),
        "and give it its values"
    );
}

#[tokio::test(start_paused = true)]
async fn the_cells_arrive_change_in_place_and_an_unchanged_answer_sends_no_batch() {
    let mut list = Metered::start(cluster(true).await, None).await;
    list.batcher().set_window(0, 3, true);
    let first = list.watch(Duration::from_secs(1)).await;
    assert_eq!(
        list.cpus(&first, "kind-test/a/p1"),
        [Cell::Null, Cell::Int(2_000_000)],
        "empty at first, and the value once the poller has answered"
    );

    list.fake.pod_usage("a", "p2", &[("main", "40m", "1Mi")]);
    let changed = list.watch(Duration::from_secs(15)).await;
    let [only] = &changed[..] else {
        panic!("one batch: {changed:?}");
    };
    assert_eq!(only.window, None, "the rows did not move");
    assert_eq!(only.upserts.len(), 1, "one upsert, of the row that changed");
    assert_eq!(only.upserts[0].id.0, "kind-test/a/p2");
    assert_eq!(
        list.cpus(&changed, "kind-test/a/p2").last(),
        Some(&Cell::Int(40_000_000))
    );

    list.fake.pod_usage("a", "p1", &[("main", "2m", "1Mi")]);
    let quiet = list.watch(Duration::from_secs(60)).await;
    assert!(quiet.is_empty(), "a request's time is no change: {quiet:?}");
}

#[tokio::test(start_paused = true)]
async fn a_row_that_enters_the_filters_has_the_value_the_poller_holds_though_it_never_changes() {
    let labelled = |name: &str, labels: serde_json::Value| {
        json!({
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": { "name": name, "namespace": "a", "uid": format!("uid-{name}"), "labels": labels },
        })
    };
    let fake = cluster(true).await;
    fake.put(
        "",
        "pods",
        Some("a"),
        labelled("p2", json!({ "tier": "front" })),
    );
    let mut asked = query(None, false);
    asked.label_selector = Some("tier=front".to_owned());
    let mut list = Metered::of(fake, asked, true).await;
    list.batcher().set_window(0, 6, true);
    let before = list.watch(Duration::from_secs(40)).await;
    assert_eq!(
        list.cpus(&before, "kind-test/a/p2").last(),
        Some(&Cell::Int(4_000_000))
    );
    assert!(list.cpus(&before, "kind-test/a/p1").is_empty(), "left out");

    list.fake.put(
        "",
        "pods",
        Some("a"),
        labelled("p1", json!({ "tier": "front" })),
    );
    let after = list.watch(Duration::from_secs(1)).await;
    assert_eq!(
        list.cpus(&after, "kind-test/a/p1"),
        [Cell::Int(2_000_000)],
        "its sample has held still since before it entered, so no poll would tell it again"
    );
}

#[tokio::test(start_paused = true)]
async fn a_context_without_the_api_has_no_such_columns_and_asks_nothing_of_it() {
    let mut list = Metered::start(cluster(false).await, None).await;
    list.batcher().set_window(0, 6, true);
    let batches = list.watch(Duration::from_secs(120)).await;
    let columns = batches[0].columns.as_ref().unwrap();
    assert!(
        columns
            .iter()
            .all(|column| column.name != "CPU" && column.name != "Memory"),
        "{columns:?}"
    );
    assert_eq!(batches[0].metrics, None);
    assert_eq!(requests_to_the_group(&list.fake), 0);
    assert_eq!(batches.last().unwrap().status, ViewState::Ready);
}

#[tokio::test(start_paused = true)]
async fn a_stale_api_keeps_the_columns_says_unavailable_and_recovers() {
    let fake = cluster(false).await;
    fake.stale_metrics("v1beta1");
    for namespace in ["a", "b"] {
        fake.state().no_endpoints.insert(format!(
            "/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods"
        ));
    }
    let mut list = Metered::start(fake, None).await;
    list.batcher().set_window(0, 6, true);
    let down = list.watch(Duration::from_secs(5)).await;
    let columns = down[0].columns.as_ref().unwrap();
    assert!(
        columns.iter().any(|column| column.name == "CPU"),
        "{columns:?}"
    );
    assert_eq!(down[0].metrics, Some(MetricsState::Unavailable));
    assert!(
        down.iter()
            .all(|batch| batch.metrics != Some(MetricsState::Ready))
    );

    list.fake.serve_metrics("v1beta1");
    list.fake.state().no_endpoints.clear();
    list.fake.put(
        "apiregistration.k8s.io",
        "apiservices",
        None,
        json!({
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": { "name": "v1beta1.metrics.k8s.io" },
        }),
    );
    let back = list.watch(Duration::from_secs(30)).await;
    assert!(
        back.iter()
            .any(|batch| batch.metrics == Some(MetricsState::Ready)),
        "it recovers: {:?}",
        back.iter().map(|batch| batch.metrics).collect::<Vec<_>>()
    );
    assert_eq!(
        list.cpus(&back, "kind-test/a/p1").last(),
        Some(&Cell::Int(2_000_000))
    );
}
