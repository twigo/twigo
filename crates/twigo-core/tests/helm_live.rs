//! Twigo's list of Helm releases against the `helm` on `PATH`, on kind: the
//! row of a release that `helm` installed and upgraded equals what
//! `helm list` says of it, in a context that is `read-only`, and a namespace
//! the account may not read says so beside the one it may. The chart renders
//! a ConfigMap, a Secret from its values and notes that print the revision,
//! and no pod.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-core --test helm_live -- --ignored

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::authentication::v1::TokenRequest;
use k8s_openapi::api::core::v1::{Namespace, ServiceAccount};
use k8s_openapi::api::rbac::v1::{Role, RoleBinding};
use kube::api::{DeleteParams, PostParams};
use kube::config::{AuthInfo, Kubeconfig, NamedAuthInfo};
use kube::{Api, Config};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use twigo_core::{Core, Started};
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    Ack, Cell, Column, ListBatch, Mode, Part, Parts, ReleaseListQuery, SetWindow, SubscriptionId,
    ViewState,
};

const WAIT: Duration = Duration::from_secs(60);
const CHART: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/helm_chart");

fn unique() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!("{nanos}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

struct Cluster {
    kubeconfig: Kubeconfig,
    context: String,
    admin: kube::Client,
    dir: tempfile::TempDir,
    readable: String,
    refused: String,
}

impl Cluster {
    async fn connect() -> Self {
        let found = Command::new("helm").args(["version"]).output();
        assert!(
            found.is_ok_and(|output| output.status.success()),
            "these tests run helm, which must be on PATH"
        );
        let path: PathBuf = std::env::var_os("TWIGO_TEST_KUBECONFIG")
            .expect("TWIGO_TEST_KUBECONFIG")
            .into();
        let kubeconfig = Kubeconfig::read_from(&path).unwrap();
        let context = kubeconfig.current_context.clone().unwrap_or_default();
        assert!(
            context.starts_with("kind-"),
            "refusing context {context:?}: only kind clusters"
        );
        let config = Config::from_custom_kubeconfig(kubeconfig.clone(), &Default::default())
            .await
            .unwrap();
        let admin = kube::Client::try_from(config).unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::copy(&path, dir.path().join("kubeconfig")).unwrap();
        let (readable, refused) = (
            format!("core-helm-{}", unique()),
            format!("core-helm-{}", unique()),
        );
        let namespaces = Api::<Namespace>::all(admin.clone());
        for name in [&readable, &refused] {
            let namespace: Namespace =
                serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap();
            namespaces
                .create(&PostParams::default(), &namespace)
                .await
                .unwrap();
        }
        Cluster {
            kubeconfig,
            context,
            admin,
            dir,
            readable,
            refused,
        }
    }

    async fn delete(&self) {
        for name in [&self.readable, &self.refused] {
            Api::<Namespace>::all(self.admin.clone())
                .delete(name, &DeleteParams::default())
                .await
                .unwrap();
        }
    }

    fn helm(&self, args: &[&str]) -> String {
        let home = self.dir.path().join("helm");
        let output = Command::new("helm")
            .arg("--kubeconfig")
            .arg(self.dir.path().join("kubeconfig"))
            .args(["--kube-context", &self.context])
            .args(args)
            .env("HELM_CONFIG_HOME", home.join("config"))
            .env("HELM_CACHE_HOME", home.join("cache"))
            .env("HELM_DATA_HOME", home.join("data"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "helm {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn listed(&self, namespace: &str) -> HashMap<String, Value> {
        let listed = self.helm(&["list", "-n", namespace, "-o", "json"]);
        let releases: Vec<Value> = serde_json::from_str(&listed).unwrap();
        releases
            .into_iter()
            .map(|release| (release["name"].as_str().unwrap().to_owned(), release))
            .collect()
    }

    async fn account(&self) -> PathBuf {
        let home = &self.readable;
        let accounts = Api::<ServiceAccount>::namespaced(self.admin.clone(), home);
        let account: ServiceAccount =
            serde_json::from_value(json!({ "metadata": { "name": "reader" } })).unwrap();
        accounts
            .create(&PostParams::default(), &account)
            .await
            .unwrap();
        let role: Role = serde_json::from_value(json!({
            "metadata": { "name": "secrets" },
            "rules": [{ "apiGroups": [""], "resources": ["secrets"], "verbs": ["get", "list", "watch"] }]
        }))
        .unwrap();
        Api::<Role>::namespaced(self.admin.clone(), home)
            .create(&PostParams::default(), &role)
            .await
            .unwrap();
        let binding: RoleBinding = serde_json::from_value(json!({
            "metadata": { "name": "reader-secrets" },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "secrets" },
            "subjects": [{ "kind": "ServiceAccount", "name": "reader", "namespace": home }]
        }))
        .unwrap();
        Api::<RoleBinding>::namespaced(self.admin.clone(), home)
            .create(&PostParams::default(), &binding)
            .await
            .unwrap();
        let request: TokenRequest =
            serde_json::from_value(json!({ "spec": { "audiences": [] } })).unwrap();
        let token = accounts
            .create_token_request("reader", &PostParams::default(), &request)
            .await
            .unwrap()
            .status
            .unwrap()
            .token
            .expect("a token");

        let mut kubeconfig = self.kubeconfig.clone();
        kubeconfig.auth_infos = vec![NamedAuthInfo {
            name: "reader".to_owned(),
            auth_info: Some(AuthInfo {
                token: Some(token.into()),
                ..AuthInfo::default()
            }),
            ..NamedAuthInfo::default()
        }];
        for context in &mut kubeconfig.contexts {
            if let Some(context) = &mut context.context {
                context.user = Some("reader".to_owned());
            }
        }
        let path = self.dir.path().join("reader-kubeconfig");
        std::fs::write(&path, serde_json::to_string(&kubeconfig).unwrap()).unwrap();
        path
    }
}

fn core(dir: &Path, kubeconfig: PathBuf, context: &str) -> (Started, String) {
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let space = core.state.open_space(context).id;
    let (_status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    (core.start_for_tests(followed, Some(kubeconfig)), space)
}

struct Releases {
    core: Arc<Core>,
    id: SubscriptionId,
    batches: mpsc::UnboundedReceiver<ListBatch>,
    columns: Vec<Column>,
    ids: Vec<String>,
    cells: HashMap<String, Vec<Cell>>,
    parts: Option<Parts>,
}

impl Releases {
    async fn open(core: &Arc<Core>, space: &str, namespaces: &[&String]) -> Self {
        let (sender, batches) = mpsc::unbounded_channel();
        let query = ReleaseListQuery {
            space: space.to_owned(),
            namespaces: namespaces.iter().map(|name| (*name).clone()).collect(),
            text: None,
            columns: None,
            sort: None,
            count_by: None,
            group_by: None,
            values: None,
        };
        let id = core
            .helm_list_subscribe("main", query, move |batch| sender.send(batch).is_ok())
            .await
            .unwrap();
        core.list_set_window(
            "main",
            SetWindow {
                id,
                start: 0,
                end: 100,
                metrics: false,
            },
        )
        .unwrap();
        Releases {
            core: Arc::clone(core),
            id,
            batches,
            columns: Vec::new(),
            ids: Vec::new(),
            cells: HashMap::new(),
            parts: None,
        }
    }

    async fn until(&mut self, wanted: impl Fn(&Releases) -> bool) {
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
                assert!(
                    !matches!(batch.status, ViewState::Error { .. }),
                    "{:?}",
                    batch.status
                );
                if let Some(columns) = batch.columns {
                    self.columns = columns;
                }
                if let Some(window) = batch.window {
                    self.ids = window.ids.into_iter().map(|id| id.0).collect();
                }
                for row in batch.upserts {
                    self.cells.insert(row.id.0, row.cells);
                }
                if batch.parts.is_some() {
                    self.parts = batch.parts;
                }
            }
        };
        tokio::time::timeout(WAIT, reached)
            .await
            .expect("what the list waits for within a minute");
    }

    fn cell(&self, row: &str, column: &str) -> Option<&Cell> {
        let at = self.columns.iter().position(|found| found.name == column)?;
        self.cells.get(row)?.get(at)
    }

    fn revision(&self, context: &str, namespace: &str, name: &str) -> Option<i64> {
        let row = format!("{context}/{namespace}/{name}");
        if !self.ids.contains(&row) {
            return None;
        }
        match self.cell(&row, "Revision") {
            Some(Cell::Int(revision)) => Some(*revision),
            _ => None,
        }
    }
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG and helm on PATH"]
async fn the_list_shows_what_helm_lists_in_a_read_only_context_and_says_which_namespace_it_may_not_read()
 {
    let cluster = Cluster::connect().await;
    let (readable, refused) = (&cluster.readable, &cluster.refused);
    cluster.helm(&["install", "app", CHART, "-n", readable]);
    cluster.helm(&[
        "upgrade",
        "app",
        CHART,
        "-n",
        readable,
        "--set",
        "password=other",
    ]);
    cluster.helm(&["install", "hidden", CHART, "-n", refused]);
    let reader = cluster.account().await;

    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), reader, &cluster.context);
    core.catalog.contexts().await;
    core.policy
        .set_mode(&cluster.context, Some(Mode::ReadOnly))
        .unwrap();
    let mut list = Releases::open(&core, &space, &[readable, refused]).await;
    list.until(|list| list.revision(&cluster.context, readable, "app") == Some(2))
        .await;

    let helm = &cluster.listed(readable)["app"];
    let row = format!("{}/{readable}/app", cluster.context);
    assert_eq!(list.cell(&row, "Name"), Some(&Cell::Text("app".to_owned())));
    assert_eq!(
        list.cell(&row, "Namespace"),
        Some(&Cell::Text(helm["namespace"].as_str().unwrap().to_owned()))
    );
    assert_eq!(
        list.cell(&row, "Revision"),
        Some(&Cell::Int(
            helm["revision"].as_str().unwrap().parse().unwrap()
        ))
    );
    assert_eq!(
        list.cell(&row, "Status"),
        Some(&Cell::Text(helm["status"].as_str().unwrap().to_owned()))
    );

    list.until(|list| {
        list.parts
            .as_ref()
            .is_some_and(|parts| !parts.unready.is_empty())
    })
    .await;
    let parts = list.parts.as_ref().unwrap();
    assert_eq!(parts.unready.len(), 1);
    assert_eq!(
        parts.unready[0].part,
        Part::Namespace {
            name: refused.clone()
        }
    );
    assert!(matches!(
        parts.unready[0].state,
        ViewState::Forbidden { .. }
    ));
    assert!(!list.ids.iter().any(|id| id.ends_with("/hidden")));

    core.list_unsubscribe("main", list.id).unwrap();
    cluster.delete().await;
}
