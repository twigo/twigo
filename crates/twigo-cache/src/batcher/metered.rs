//! The lists of pods that read their metrics: what they ask of the poller,
//! counted on the fake's request log over virtual minutes.

use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep, timeout_at};
use twigo_ipc::{Cell, Gvr, ListQuery, MetricsState, Sort, ViewState};
use twigo_kube::client::{Budgets, Clients};
use twigo_kube::discovery::Cache;

use super::*;
use crate::fake::Fake;
use crate::hub::{Hub, Query, Resource, RowFormat};
use crate::metrics::{Kind, Poller};

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
    poller: Poller,
    hub: Hub,
    _held: (Arc<Clients>, tempfile::TempDir),
    batcher: Batcher,
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

fn query(sort: Option<Sort>) -> ListQuery {
    ListQuery {
        space: "kind-test".to_owned(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
        },
        namespaced: true,
        namespaces: vec!["a".to_owned(), "b".to_owned()],
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

async fn open(
    fake: &Fake,
    hub: &Hub,
    poller: &Poller,
    sort: Option<Sort>,
) -> (Batcher, mpsc::UnboundedReceiver<(Instant, ListBatch)>) {
    let context = poller.context("kind-test", watch::channel(None).1).await;
    let answered = async {
        while fake.state().served.contains_key(crate::metrics::GROUP)
            && context.api().version().is_none()
        {
            sleep(Duration::from_millis(10)).await;
        }
        sleep(Duration::from_secs(1)).await;
    };
    timeout_at(Instant::now() + Duration::from_secs(600), answered)
        .await
        .expect("discovery within ten minutes");
    let subscription = hub.rows(rows(&["a", "b"])).await.unwrap();
    let spec = Spec::new("kind-test", &query(sort)).unwrap();
    let (sender, batches) = mpsc::unbounded_channel();
    let batcher = Batcher::spawn(
        subscription,
        spec,
        Some(Box::pin(std::future::ready(context.reader(Kind::Pods)))),
        move |batch| sender.send((Instant::now(), batch)).is_ok(),
    );
    (batcher, batches)
}

impl Metered {
    async fn start(fake: Fake, sort: Option<Sort>) -> Self {
        let (hub, clients) = fake.hub(Budgets::default());
        let directory = tempfile::tempdir().unwrap();
        let poller = Poller::new(hub.clone(), Arc::new(Cache::new(directory.path())));
        let (batcher, batches) = open(&fake, &hub, &poller, sort).await;
        Self {
            fake,
            poller,
            hub,
            _held: (clients, directory),
            batcher,
            batches,
            columns: Vec::new(),
        }
    }

    async fn reopen(&mut self, sort: Option<Sort>) {
        let (batcher, batches) = open(&self.fake, &self.hub, &self.poller, sort).await;
        self.batcher = batcher;
        self.batches = batches;
    }

    async fn watch(&mut self, time: Duration) -> Vec<ListBatch> {
        let end = Instant::now() + time;
        let mut seen = Vec::new();
        while let Ok(Some((_, batch))) = timeout_at(end, self.batches.recv()).await {
            self.batcher.ack(batch.seq);
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

    list.batcher.set_window(0, 6, false);
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

    list.batcher.set_window(0, 6, true);
    list.watch(Duration::from_secs(2)).await;
    assert!(requests_to_the_group(&list.fake) > 0, "read now");
}

#[tokio::test(start_paused = true)]
async fn only_the_namespaces_of_the_window_are_polled_and_they_move_with_it() {
    let mut list = Metered::start(cluster(true).await, None).await;
    list.batcher.set_window(0, 3, true);
    list.watch(Duration::from_secs(2 * 15 + 1)).await;
    assert_eq!(polls(&list.fake, "a"), 3, "the namespace of p1 to p3");
    assert_eq!(
        polls(&list.fake, "b"),
        0,
        "none for a namespace out of the window"
    );

    list.batcher.set_window(3, 6, true);
    list.watch(Duration::from_millis(100)).await;
    let (a, b) = (polls(&list.fake, "a"), polls(&list.fake, "b"));
    assert_eq!(b, 1, "the new namespace at once");
    list.watch(Duration::from_secs(3 * 15 + 5)).await;
    assert_eq!(polls(&list.fake, "a"), a, "the old one stopped at once");
    assert_eq!(polls(&list.fake, "b"), b + 3);

    list.batcher.set_window(2, 4, true);
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
    list.batcher.set_window(0, 3, true);
    list.watch(Duration::from_secs(2)).await;
    assert!(
        polls(&list.fake, "a") >= 1,
        "it polled while its batches were answered"
    );
    list.batcher.set_window(0, 2, true);
    let (_, first) = list.batches.recv().await.unwrap();
    sleep(INTERVAL + Duration::from_secs(1)).await;
    let polled = polls(&list.fake, "a");
    sleep(Duration::from_secs(600)).await;
    assert_eq!(
        polls(&list.fake, "a"),
        polled,
        "a hidden window polls nothing"
    );

    list.batcher.ack(first.seq);
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
    list.batcher.set_window(0, 2, true);
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

    list.reopen(None).await;
    list.batcher.set_window(0, 2, true);
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
async fn the_cells_arrive_change_in_place_and_an_unchanged_answer_sends_no_batch() {
    let mut list = Metered::start(cluster(true).await, None).await;
    list.batcher.set_window(0, 3, true);
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
async fn a_context_without_the_api_has_no_such_columns_and_asks_nothing_of_it() {
    let mut list = Metered::start(cluster(false).await, None).await;
    list.batcher.set_window(0, 6, true);
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
    list.batcher.set_window(0, 6, true);
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
