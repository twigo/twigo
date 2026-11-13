//! The Metrics API against a kind cluster with metrics-server and kwok
//! (`bench/cluster.sh`): a pod list gets the CPU and memory of its running
//! pods, sorted by memory it holds its values in order, in its first rows too
//! once the resources came, and an open pod and node answer what they use.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-core --test metrics_live -- --ignored

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use kube::config::Kubeconfig;
use tokio::sync::{mpsc, watch};
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    Ack, Cell, Column, Discovered, Gvr, ListBatch, ListQuery, MetricsState, ObjectBatch,
    ObjectParts, ObjectQuery, OpenObject, SetWindow, Sort, SubscriptionId, Usage,
};

const WAIT: Duration = Duration::from_secs(180);

fn cluster() -> (PathBuf, String) {
    let path: PathBuf = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG")
        .into();
    let context = Kubeconfig::read_from(&path)
        .unwrap()
        .current_context
        .unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: only kind and kwok clusters"
    );
    (path, context)
}

fn core(dir: &Path, kubeconfig: &Path, context: &str) -> (Arc<Core>, String) {
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let space = core.state.open_space(context).id;
    let (status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    tokio::spawn({
        let core = Arc::clone(&core);
        let kubeconfig = kubeconfig.to_owned();
        async move {
            let _status = status;
            core.run(followed, Some(kubeconfig)).await;
        }
    });
    (core, space)
}

struct List {
    core: Arc<Core>,
    id: SubscriptionId,
    batches: mpsc::UnboundedReceiver<ListBatch>,
    columns: Vec<Column>,
    ids: Vec<String>,
    cells: HashMap<String, Vec<Cell>>,
    metrics: Option<MetricsState>,
}

impl List {
    async fn pods(core: &Arc<Core>, space: &str, sort: Option<Sort>) -> Self {
        let (sender, batches) = mpsc::unbounded_channel();
        let query = ListQuery {
            space: space.to_owned(),
            gvr: Gvr {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
            },
            namespaced: true,
            namespaces: vec!["kube-system".to_owned()],
            label_selector: None,
            field_selector: None,
            owners: None,
            text: None,
            columns: None,
            sort,
            count_by: None,
            group_by: None,
            values: None,
        };
        let id = core
            .list_subscribe("main", query, move |batch| sender.send(batch).is_ok())
            .await
            .unwrap();
        core.list_set_window(
            "main",
            SetWindow {
                id,
                start: 0,
                end: 200,
                metrics: true,
            },
        )
        .unwrap();
        List {
            core: Arc::clone(core),
            id,
            batches,
            columns: Vec::new(),
            ids: Vec::new(),
            cells: HashMap::new(),
            metrics: None,
        }
    }

    async fn until(&mut self, wanted: impl Fn(&List) -> bool) {
        let reached = async {
            while !wanted(self) {
                let batch = self.batches.recv().await.expect("the list is open");
                self.core
                    .list_ack(
                        "main",
                        Ack {
                            id: self.id,
                            seq: batch.seq,
                        },
                    )
                    .unwrap();
                if let Some(columns) = batch.columns {
                    self.columns = columns;
                }
                if let Some(window) = batch.window {
                    self.ids = window.ids.into_iter().map(|id| id.0).collect();
                }
                for row in batch.upserts {
                    self.cells.insert(row.id.0, row.cells);
                }
                if batch.metrics.is_some() {
                    self.metrics = batch.metrics;
                }
            }
        };
        tokio::time::timeout(WAIT, reached)
            .await
            .expect("what the list waits for within 180 s");
    }

    fn column(&self, name: &str) -> Vec<&Cell> {
        let at = self
            .columns
            .iter()
            .position(|column| column.name == name)
            .unwrap_or_else(|| panic!("a {name} column in {:?}", self.columns));
        self.ids
            .iter()
            .filter_map(|id| self.cells.get(id))
            .map(|cells| &cells[at])
            .collect()
    }
}

fn used(cell: &Cell) -> Option<i64> {
    match cell {
        Cell::Int(value) => Some(*value),
        _ => None,
    }
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_pod_list_gets_the_cpu_and_memory_of_a_running_pod() {
    let (path, context) = cluster();
    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), &path, &context);
    let mut list = List::pods(&core, &space, None).await;
    list.until(|list| {
        !list.columns.is_empty() && {
            let (cpu, memory) = (list.column("CPU"), list.column("Memory"));
            cpu.iter()
                .zip(&memory)
                .any(|(cpu, memory)| used(cpu).is_some() && used(memory).is_some_and(|m| m > 0))
        }
    })
    .await;
    assert_eq!(list.metrics, Some(MetricsState::Ready));
    let names: Vec<&str> = list.columns.iter().map(|c| c.name.as_str()).collect();
    let at = |name: &str| names.iter().position(|found| *found == name).unwrap();
    assert_eq!(
        at("Memory"),
        at("CPU") + 1,
        "the metric columns, side by side"
    );
    assert!(at("CPU") < at("Age"), "before Age: {names:?}");
    core.list_unsubscribe("main", list.id).unwrap();
}

async fn opened_by_the_webview(
    core: &Arc<Core>,
    space: &str,
    sort: Option<Sort>,
) -> Vec<ListBatch> {
    let mut list = List::pods(core, space, sort).await;
    let mut seen = Vec::new();
    let reached = async {
        let mut rows = false;
        let mut after = None;
        loop {
            let waited = async {
                match after {
                    Some(end) => tokio::time::timeout_at(end, list.batches.recv())
                        .await
                        .ok()
                        .flatten(),
                    None => list.batches.recv().await,
                }
            };
            let Some(batch) = waited.await else { break };
            core.list_ack(
                "main",
                Ack {
                    id: list.id,
                    seq: batch.seq,
                },
            )
            .unwrap();
            if !rows && !batch.upserts.is_empty() {
                rows = true;
                after = Some(tokio::time::Instant::now() + Duration::from_secs(2));
            }
            seen.push(batch);
        }
    };
    tokio::time::timeout(WAIT, reached)
        .await
        .expect("a batch with rows within 180 s");
    core.list_unsubscribe("main", list.id).unwrap();
    seen
}

fn has_metric_columns(batch: &ListBatch) -> bool {
    batch.columns.as_ref().is_some_and(|columns| {
        ["CPU", "Memory"]
            .iter()
            .all(|name| columns.iter().any(|column| column.name == *name))
    })
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_list_opened_after_the_resources_came_has_its_columns_in_its_first_batch_even_opened_again()
 {
    let (path, context) = cluster();
    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), &path, &context);
    let mut resources = core.follow_resources(&space).await.unwrap();
    while !matches!(
        tokio::time::timeout(WAIT, resources.next())
            .await
            .expect("discovery within 180 s"),
        Discovered::Ready { .. }
    ) {}

    for round in 0..2 {
        let batches = opened_by_the_webview(&core, &space, None).await;
        let first = batches
            .iter()
            .find(|batch| !batch.upserts.is_empty())
            .expect("a batch with rows");
        assert!(
            has_metric_columns(first),
            "round {round}: {:?}",
            first.columns
        );
        let changed = batches
            .iter()
            .skip_while(|batch| batch.upserts.is_empty())
            .skip(1)
            .filter(|batch| batch.columns.is_some())
            .count();
        assert_eq!(
            changed, 0,
            "round {round}: the columns changed after the rows came"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_list_sorted_by_memory_descending_holds_its_values_in_order() {
    let (path, context) = cluster();
    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), &path, &context);
    let sort = Sort {
        column: "Memory".to_owned(),
        descending: true,
    };
    let mut list = List::pods(&core, &space, Some(sort)).await;
    list.until(|list| {
        !list.columns.is_empty()
            && list
                .column("Memory")
                .iter()
                .filter(|cell| used(cell).is_some())
                .count()
                >= 3
    })
    .await;
    let memory: Vec<Option<i64>> = list.column("Memory").into_iter().map(used).collect();
    let valued: Vec<i64> = memory.iter().map_while(|value| *value).collect();
    assert!(valued.len() >= 3, "{memory:?}");
    assert!(
        valued.windows(2).all(|pair| pair[0] >= pair[1]),
        "largest first: {valued:?}"
    );
    assert!(
        memory[valued.len()..].iter().all(Option::is_none),
        "rows without a value last: {memory:?}"
    );
    assert!(
        valued[0] > 10 * 1024 * 1024,
        "a real container's working set leads kwok's 1Mi: {valued:?}"
    );
    core.list_unsubscribe("main", list.id).unwrap();
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_list_sorted_by_memory_opened_after_the_resources_came_has_its_order_in_its_first_rows() {
    let (path, context) = cluster();
    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), &path, &context);
    let mut resources = core.follow_resources(&space).await.unwrap();
    while !matches!(
        tokio::time::timeout(WAIT, resources.next())
            .await
            .expect("discovery within 180 s"),
        Discovered::Ready { .. }
    ) {}
    let sort = Sort {
        column: "Memory".to_owned(),
        descending: true,
    };

    let batches = opened_by_the_webview(&core, &space, Some(sort)).await;
    let first = batches
        .iter()
        .find(|batch| !batch.upserts.is_empty())
        .expect("a batch with rows");
    let columns = first.columns.as_ref().expect("the columns come first");
    let memory = columns.iter().position(|c| c.name == "Memory").unwrap();
    let order = &first.window.as_ref().expect("a window").ids;
    let values: HashMap<_, _> = first
        .upserts
        .iter()
        .map(|row| (&row.id, used(&row.cells[memory])))
        .collect();
    let in_order: Vec<Option<i64>> = order.iter().map(|id| values[id]).collect();
    let valued: Vec<i64> = in_order.iter().map_while(|value| *value).collect();
    assert!(valued.len() >= 3, "values in the first rows: {in_order:?}");
    assert!(
        valued.windows(2).all(|pair| pair[0] >= pair[1]),
        "largest first: {valued:?}"
    );
    assert!(
        in_order[valued.len()..].iter().all(Option::is_none),
        "rows without a value last: {in_order:?}"
    );
}

async fn usage_of(
    core: &Arc<Core>,
    space: &str,
    resource: &str,
    namespace: Option<&str>,
    name: &str,
) -> Usage {
    let (sender, mut batches) = mpsc::unbounded_channel();
    let object = ObjectQuery {
        space: space.to_owned(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: resource.to_owned(),
        },
        namespaced: namespace.is_some(),
        namespace: namespace.map(str::to_owned),
        name: name.to_owned(),
    };
    let parts = ObjectParts {
        usage: true,
        ..ObjectParts::default()
    };
    let id = core
        .object_open("main", OpenObject { object, parts }, move |batch| {
            sender.send(batch).is_ok()
        })
        .await
        .unwrap();
    let found = async {
        loop {
            let batch: ObjectBatch = batches.recv().await.expect("the object is open");
            core.object_ack("main", Ack { id, seq: batch.seq }).unwrap();
            if let Some(usage) = batch.usage.filter(|usage| usage.cpu.used.is_some()) {
                return usage;
            }
        }
    };
    let usage = tokio::time::timeout(WAIT, found)
        .await
        .expect("a usage within 180 s");
    core.object_close("main", id).unwrap();
    usage
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_open_pod_and_node_answer_what_they_use() {
    let (path, context) = cluster();
    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), &path, &context);
    let node = format!(
        "{}-control-plane",
        context.strip_prefix("kind-").unwrap_or(&context)
    );

    let mut list = List::pods(&core, &space, None).await;
    list.until(|list| list.ids.iter().any(|id| id.contains("/etcd-")))
        .await;
    let etcd = list
        .ids
        .iter()
        .find(|id| id.contains("/etcd-"))
        .and_then(|id| id.rsplit('/').next())
        .unwrap()
        .to_owned();
    core.list_unsubscribe("main", list.id).unwrap();

    let pod = usage_of(&core, &space, "pods", Some("kube-system"), &etcd).await;
    assert_eq!(pod.state, MetricsState::Ready);
    assert!(pod.cpu.used.is_some_and(|used| used > 0), "{pod:?}");
    assert!(
        pod.memory.used.is_some_and(|used| used > 1024 * 1024),
        "{pod:?}"
    );
    assert_eq!(pod.containers.len(), 1, "etcd has one container");
    assert_eq!(pod.containers[0].name, "etcd");
    assert!(pod.containers[0].cpu.request.is_some(), "its request");
    assert!(pod.sampled.is_some());

    let node = usage_of(&core, &space, "nodes", None, &node).await;
    assert!(node.cpu.allocatable.is_some_and(|total| total > 0));
    assert!(node.memory.allocatable.is_some_and(|total| total > 0));
    assert!(node.memory.used.is_some_and(|used| used > 0), "{node:?}");
    assert!(node.containers.is_empty());
}
