//! The query view under churn (ARCHITECTURE 3.4, 3.5): 5,000 kwok pods whose
//! restart counts `twigo-bench churn` bumps, followed by a list sorted by
//! Restarts that acknowledges each batch as the webview does; once the churn
//! stops, each window holds what a fresh list sorts there: the top, the rows
//! where the changed counts give way to the pods it left at 0, and the end.
//!
//! A test binary of its own: it creates the `bench/bench` Deployment of
//! `bench/pods.sh` at 5,000 pods, so it refuses a cluster that has the
//! namespace `bench` already, and however it ends it deletes the namespace
//! and waits until it is gone, since the live tests after it share the
//! cluster.

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use k8s_openapi::api::core::v1::Namespace;
use kube::api::DeleteParams;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use tokio::sync::mpsc;
use twigo_cache::batcher::Batcher;
use twigo_cache::hub::{Connect, Delta, Hub, Query, Resource, RowFormat};
use twigo_cache::view::{QueryView, Spec};
use twigo_ipc::{Cell, Gvr, ListBatch, ListQuery, Row, RowId, Sort, ViewState};
use twigo_kube::client::{Clients, Options};

const PODS: u32 = 5_000;
const NAMESPACE: &str = "bench";
const CHURN_SECONDS: &str = "20";
const WINDOW: u32 = 100;

fn query(context: &str) -> ListQuery {
    ListQuery {
        space: context.to_owned(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
        },
        namespaced: true,
        namespaces: vec![NAMESPACE.to_owned()],
        label_selector: None,
        field_selector: None,
        owners: None,
        text: None,
        columns: None,
        sort: Some(Sort {
            column: "Restarts".to_owned(),
            descending: true,
        }),
        count_by: Some("Status".to_owned()),
        group_by: None,
        values: None,
    }
}

fn hub_query(context: &str) -> Query {
    Query {
        context: context.to_owned(),
        resource: Resource {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
            namespaced: true,
        },
        format: RowFormat::Table,
        namespaces: vec![NAMESPACE.to_owned()],
        field_selector: None,
    }
}

/// What the webview's list holds, applied as `ListView` applies batches.
#[derive(Default)]
struct Mirror {
    total: u32,
    start: u32,
    ids: Vec<RowId>,
    rows: HashMap<RowId, Row>,
    status: Option<ViewState>,
    restarts: Option<usize>,
}

impl Mirror {
    fn apply(&mut self, batch: ListBatch) {
        if let Some(columns) = &batch.columns {
            self.restarts = columns.iter().position(|column| column.name == "Restarts");
        }
        if let Some(window) = batch.window {
            self.start = window.start;
            self.ids = window.ids;
            let shown: HashSet<&RowId> = self.ids.iter().collect();
            self.rows.retain(|id, _| shown.contains(id));
        }
        for row in batch.upserts {
            self.rows.insert(row.id.clone(), row);
        }
        self.total = batch.total;
        self.status = Some(batch.status);
    }

    /// The window's rows as ids and restart counts.
    fn shown(&self) -> Vec<(String, Cell)> {
        let at = self.restarts.expect("a Restarts column");
        self.ids
            .iter()
            .map(|id| {
                let cell = self
                    .rows
                    .get(id)
                    .map_or(Cell::Null, |row| row.cells[at].clone());
                (id.0.clone(), cell)
            })
            .collect()
    }
}

struct Live {
    batcher: Batcher,
    batches: mpsc::UnboundedReceiver<ListBatch>,
    mirror: Mirror,
}

impl Live {
    /// Applies and acknowledges every batch that comes within `wait`.
    async fn follow(&mut self, wait: Duration) {
        let deadline = tokio::time::Instant::now() + wait;
        while let Ok(Some(batch)) = tokio::time::timeout_at(deadline, self.batches.recv()).await {
            let seq = batch.seq;
            self.mirror.apply(batch);
            self.batcher.ack(seq);
        }
    }

    async fn until(&mut self, what: &str, done: impl Fn(&Mirror) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
        while !done(&self.mirror) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "{what} within ten minutes"
            );
            self.follow(Duration::from_millis(200)).await;
        }
    }
}

/// Every row a list of its own, started fresh, shows, in order.
async fn fresh(clients: &Arc<Clients>, context: &str) -> Vec<(String, Cell)> {
    let hub = Hub::new(connect(clients));
    let mut rows = hub.rows(hub_query(context)).await.unwrap();
    let listed = rows.whole().await.expect("a fresh list");
    let mut view = QueryView::new(Spec::new(context, &query(context)).unwrap());
    view.set_window(0, PODS);
    view.apply(Delta::Reset {
        rows: listed,
        columns: rows.columns(),
    });
    let mut mirror = Mirror::default();
    mirror.apply(view.batch(ViewState::Ready).unwrap());
    mirror.shown()
}

fn connect(clients: &Arc<Clients>) -> Connect {
    let clients = Arc::clone(clients);
    Arc::new(move |_| {
        let clients = Arc::clone(&clients);
        Box::pin(async move { Ok(clients) })
    })
}

fn bench_script(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(name)
}

/// Deletes the namespace, and waits until it is gone.
async fn delete_namespace(namespaces: &Api<Namespace>) {
    match namespaces.delete(NAMESPACE, &DeleteParams::default()).await {
        Ok(_) => {}
        Err(kube::Error::Api(status)) if status.code == 404 => return,
        Err(error) => panic!("could not delete the namespace {NAMESPACE}: {error}"),
    }
    let gone = async {
        while namespaces.get_opt(NAMESPACE).await.unwrap().is_some() {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(600), gone)
        .await
        .expect("the namespace gone within ten minutes");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn windows_under_churn_end_as_a_fresh_list_sorts_them() {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(&path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: only kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    let clients = Arc::new(Clients::new(&config, Options::default()).unwrap());
    let namespaces = Api::<Namespace>::all(clients.api.clone());
    assert!(
        namespaces.get_opt(NAMESPACE).await.unwrap().is_none(),
        "the cluster has the namespace {NAMESPACE} already, which this test deletes"
    );
    let outcome = AssertUnwindSafe(under_churn(&path, &context, &clients))
        .catch_unwind()
        .await;
    delete_namespace(&namespaces).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

async fn under_churn(path: &std::ffi::OsStr, context: &str, clients: &Arc<Clients>) {
    let scaled = Command::new(bench_script("pods.sh"))
        .arg(path)
        .arg(PODS.to_string())
        .status()
        .unwrap();
    assert!(scaled.success(), "bench/pods.sh: {scaled}");

    let hub = Hub::new(connect(clients));
    let (sender, batches) = mpsc::unbounded_channel();
    let batcher = Batcher::spawn(
        hub.rows(hub_query(context)).await.unwrap(),
        Spec::new(context, &query(context)).unwrap(),
        move |batch| sender.send(batch).is_ok(),
    );
    batcher.set_window(0, WINDOW);
    let mut live = Live {
        batcher,
        batches,
        mirror: Mirror::default(),
    };
    live.until("every pod listed", |mirror| {
        mirror.status == Some(ViewState::Ready) && mirror.total == PODS
    })
    .await;

    let log = std::env::temp_dir().join(format!("twigo-view-live-{}.jsonl", std::process::id()));
    let mut churn = tokio::process::Command::new(env!("CARGO_BIN_EXE_twigo-bench"))
        .args([
            "churn",
            "--rate",
            "100",
            "--seconds",
            CHURN_SECONDS,
            "--log",
        ])
        .arg(&log)
        .arg("--kubeconfig")
        .arg(path)
        .spawn()
        .unwrap();
    let churned = loop {
        tokio::select! {
            status = churn.wait() => break status.unwrap(),
            () = live.follow(Duration::from_millis(100)) => {}
        }
    };
    assert!(churned.success(), "twigo-bench churn: {churned}");
    let lines: Vec<serde_json::Value> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    std::fs::remove_file(&log).unwrap();
    // A patch that timed out may still land after the fresh list.
    let errors = lines
        .iter()
        .filter(|line| line.get("error").is_some())
        .count();
    assert_eq!(errors, 0, "patches that failed or timed out");
    let changes = lines.len();
    assert!(changes > 1_000, "only {changes} changes");

    let all = fresh(clients, context).await;
    assert_eq!(all.len() as u32, PODS);
    let unchanged = all
        .iter()
        .position(|(_, restarts)| *restarts == Cell::Text("0".to_owned()))
        .expect("pods the churn left at 0") as u32;
    assert!(unchanged > WINDOW, "only {unchanged} pods changed");
    let windows = [
        (0, WINDOW),
        (unchanged - WINDOW / 2, unchanged + WINDOW / 2),
        (PODS - WINDOW, PODS),
    ];
    for (start, end) in windows {
        let expected = &all[start as usize..end as usize];
        live.batcher.set_window(start, end);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            live.follow(Duration::from_millis(500)).await;
            let shown = live.mirror.shown();
            if live.mirror.start == start && shown == expected {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the window at {start} after {changes} changes: {:?}, a fresh list: {:?}",
                &shown[..shown.len().min(5)],
                &expected[..5]
            );
        }
        assert_eq!(live.mirror.total, PODS);
    }
}
