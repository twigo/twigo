//! Twigo's Helm releases against the `helm` on `PATH`, on kind: the row of a
//! release that `helm` installed and upgraded equals what `helm list` says
//! of it, in a context that is `read-only`, and a namespace the account may
//! not read says so beside the one it may; its History is `helm history`'s,
//! each revision's notes, values and manifest are `helm get`'s once revealed
//! and hold no value before, its overview places its objects in the release's
//! namespace by the cluster's discovery, a truncated release Secret says so on its own
//! row, and a release near the 1 MiB limit opens while the runtime keeps
//! ticking. The chart renders a ConfigMap, a Secret from its values and
//! notes that print the revision, and no pod.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-core --test helm_live -- --ignored

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use jiff::Timestamp;
use k8s_openapi::ByteString;
use k8s_openapi::api::authentication::v1::TokenRequest;
use k8s_openapi::api::core::v1::{Namespace, Secret, ServiceAccount};
use k8s_openapi::api::rbac::v1::{Role, RoleBinding};
use kube::api::{DeleteParams, PostParams};
use kube::config::{AuthInfo, Kubeconfig, NamedAuthInfo};
use kube::{Api, Config};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use twigo_core::{Core, Started};
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    Ack, Block, Cell, Column, Execute, HelmPart, ListBatch, Mode, OpenRelease, OperationEvent,
    Overview, Part, Parts, PlanRequest, ReleaseBatch, ReleaseListQuery, ReleaseManifest,
    ReleaseParts, ReleaseRef, RevisionLine, SetReleaseView, SetWindow, SubscriptionId, ViewState,
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
    created: HashMap<String, Option<String>>,
    parts: Option<Parts>,
    /// Every batch, serialized as it went.
    sent: Vec<String>,
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
            created: HashMap::new(),
            parts: None,
            sent: Vec::new(),
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
                self.sent.push(serde_json::to_string(&batch).unwrap());
                if let Some(columns) = batch.columns {
                    self.columns = columns;
                }
                if let Some(window) = batch.window {
                    self.ids = window.ids.into_iter().map(|id| id.0).collect();
                }
                for row in batch.upserts {
                    self.created.insert(row.id.0.clone(), row.created);
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

    /// The text of a row's cell, empty for none.
    fn text(&self, row: &str, column: &str) -> String {
        match self.cell(row, column) {
            Some(Cell::Text(text)) => text.clone(),
            _ => String::new(),
        }
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
    let row = format!("{}/{readable}/app", cluster.context);
    list.until(|list| {
        list.revision(&cluster.context, readable, "app") == Some(2)
            && !list.text(&row, "Chart").is_empty()
    })
    .await;

    let helm = &cluster.listed(readable)["app"];
    assert_eq!(list.text(&row, "Chart"), helm["chart"].as_str().unwrap());
    assert_eq!(
        list.text(&row, "App Version"),
        helm["app_version"].as_str().unwrap()
    );
    let updated = helm["updated"].as_str().unwrap();
    let printed: Vec<&str> = updated.splitn(4, ' ').take(3).collect();
    let updated = Timestamp::strptime("%Y-%m-%d %H:%M:%S%.f %z", printed.join(" ")).unwrap();
    let created: Timestamp = list.created[&row].as_deref().unwrap().parse().unwrap();
    assert_eq!(
        created.as_millisecond(),
        updated.as_millisecond(),
        "Updated"
    );
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

const ALL: ReleaseParts = ReleaseParts {
    overview: true,
    values: true,
    manifest: true,
    history: true,
};

/// What an open release's batches showed, each part as last sent.
#[derive(Default)]
struct Shown {
    revision: Option<u32>,
    overview: bool,
    placed: Vec<String>,
    notes: Option<String>,
    values: bool,
    manifest: Option<ReleaseManifest>,
    history: Option<Vec<RevisionLine>>,
}

struct Editor {
    core: Arc<Core>,
    id: SubscriptionId,
    batches: mpsc::UnboundedReceiver<ReleaseBatch>,
    shown: Shown,
    /// Every batch, serialized as it went.
    sent: Vec<String>,
}

impl Editor {
    async fn open(core: &Arc<Core>, space: &str, namespace: &str, name: &str) -> Self {
        let (sender, batches) = mpsc::unbounded_channel();
        let request = OpenRelease {
            release: ReleaseRef {
                space: space.to_owned(),
                namespace: namespace.to_owned(),
                name: name.to_owned(),
            },
            revision: None,
            parts: ALL,
        };
        let id = core
            .helm_release_open("main", request, move |batch| sender.send(batch).is_ok())
            .await
            .unwrap();
        Editor {
            core: Arc::clone(core),
            id,
            batches,
            shown: Shown::default(),
            sent: Vec::new(),
        }
    }

    fn show(&self, revision: u32) {
        let view = SetReleaseView {
            id: self.id,
            revision: Some(revision),
            parts: ALL,
        };
        self.core.helm_release_set_view("main", view).unwrap();
    }

    async fn until(&mut self, wanted: impl Fn(&Shown) -> bool) {
        let reached = async {
            while !wanted(&self.shown) {
                let batch = self.batches.recv().await.expect("the release is open");
                let ack = Ack {
                    id: self.id,
                    seq: batch.seq,
                };
                self.core.helm_release_ack("main", ack).unwrap();
                assert!(batch.problem.is_none(), "{:?}", batch.problem);
                self.sent.push(serde_json::to_string(&batch).unwrap());
                self.shown.revision = batch.revision;
                if let Some(overview) = &batch.overview {
                    self.shown.overview = true;
                    self.shown.placed = placed(overview);
                    self.shown.notes = batch.notes.map(|notes| notes.text);
                }
                self.shown.values |= batch.values.is_some();
                if batch.manifest.is_some() {
                    self.shown.manifest = batch.manifest;
                }
                if batch.history.is_some() {
                    self.shown.history = batch.history;
                }
            }
        };
        let within = tokio::time::timeout(WAIT, reached).await;
        let shown = &self.shown;
        let lines: Vec<(u32, bool)> = shown
            .history
            .iter()
            .flatten()
            .map(|line| (line.revision, line.chart.is_some()))
            .collect();
        assert!(
            within.is_ok(),
            "not within a minute: revision {:?}, overview {}, values {}, manifest {}, lines {lines:?}",
            shown.revision,
            shown.overview,
            shown.values,
            shown.manifest.is_some()
        );
    }

    /// Every part of `revision`, and a line of each of `revisions` decoded.
    async fn whole(&mut self, revision: u32, revisions: usize) {
        self.show(revision);
        self.shown = Shown {
            history: self.shown.history.take(),
            ..Shown::default()
        };
        self.until(|shown| {
            shown.revision == Some(revision)
                && shown.overview
                && shown.values
                && shown.manifest.is_some()
                && shown.history.as_ref().is_some_and(|lines| {
                    lines.len() == revisions && lines.iter().all(|line| line.chart.is_some())
                })
        })
        .await;
    }

    /// What a Reveal of `part` of `revision` answers.
    async fn reveal(&self, revision: u32, part: HelmPart) -> String {
        let request = PlanRequest::RevealHelm {
            release: self.id,
            revision,
            part,
        };
        let plan = self.core.command_plan("main", request).await.unwrap();
        let (sender, mut events) = mpsc::unbounded_channel();
        let execute = Execute {
            plan: plan.id,
            typed: None,
        };
        self.core
            .command_execute("main", execute, move |event| sender.send(event).is_ok())
            .await
            .unwrap();
        loop {
            let event = tokio::time::timeout(WAIT, events.recv())
                .await
                .expect("the Reveal ends within a minute")
                .expect("the Reveal runs");
            match event {
                OperationEvent::Running { .. } => {}
                OperationEvent::Revealed { value, .. } => return value,
                other => panic!("the Reveal ended in {other:?}"),
            }
        }
    }
}

/// The texts of `canary` a search looks for: itself, and its base64 at each
/// of the three offsets a longer text can give it, cut to the characters its
/// bytes alone decide.
fn forms(canary: &str) -> Vec<String> {
    let mut forms = vec![canary.to_owned()];
    for offset in 0..3 {
        let mut bytes = vec![0; offset];
        bytes.extend_from_slice(canary.as_bytes());
        let encoded = STANDARD.encode(&bytes);
        let (from, to) = ((offset * 8).div_ceil(6), (offset + canary.len()) * 8 / 6);
        forms.push(encoded[from..to].to_owned());
    }
    forms
}

/// The documents of a manifest as Helm splits it, without the white space
/// around them.
fn documents(manifest: &str) -> Vec<&str> {
    let mut documents = Vec::new();
    let mut start = 0;
    let mut at = 0;
    for line in manifest.split_inclusive('\n') {
        if line.starts_with("---") {
            documents.push(&manifest[start..at]);
            start = at + line.len();
        }
        at += line.len();
    }
    documents.push(&manifest[start..]);
    documents
        .into_iter()
        .map(str::trim)
        .filter(|document| !document.is_empty())
        .collect()
}

fn placed(overview: &Overview) -> Vec<String> {
    let objects = overview
        .sections
        .iter()
        .find(|section| section.id == "helm.objects");
    let Some(Block::Table { rows, .. }) = objects.and_then(|section| section.blocks.first()) else {
        return Vec::new();
    };
    rows.iter()
        .map(|row| match &row[2] {
            twigo_ipc::Value::Text { text } => text.clone(),
            other => panic!("a text: {other:?}"),
        })
        .collect()
}

fn yaml(document: &str) -> Value {
    serde_saphyr::from_str(document).unwrap()
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG and helm on PATH"]
async fn an_open_release_shows_what_helm_gets_and_no_value_before_a_reveal() {
    let cluster = Cluster::connect().await;
    let namespace = &cluster.readable;
    let canaries = [
        format!("first-canary-{}", unique()),
        format!("second-canary-{}", unique()),
    ];
    cluster.helm(&[
        "install",
        "app",
        CHART,
        "-n",
        namespace,
        "--set",
        &format!("password={}", canaries[0]),
    ]);
    cluster.helm(&[
        "upgrade",
        "app",
        CHART,
        "-n",
        namespace,
        "--set",
        &format!("password={}", canaries[1]),
    ]);

    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(
        dir.path(),
        cluster.dir.path().join("kubeconfig"),
        &cluster.context,
    );
    core.catalog.contexts().await;
    let mut list = Releases::open(&core, &space, &[namespace]).await;
    let row = format!("{}/{namespace}/app", cluster.context);
    list.until(|list| !list.text(&row, "Chart").is_empty())
        .await;
    let mut editor = Editor::open(&core, &space, namespace, "app").await;
    editor.whole(2, 2).await;
    editor
        .until(|shown| shown.placed == [namespace.as_str(), namespace.as_str()])
        .await;
    editor.whole(1, 2).await;
    for text in list.sent.iter().chain(&editor.sent) {
        assert!(!text.contains("H4sI"), "a raw release before a Reveal");
        for (index, canary) in canaries.iter().enumerate() {
            for form in forms(canary) {
                assert!(
                    !text.contains(&form),
                    "revision {}'s password before a Reveal",
                    index + 1
                );
            }
        }
    }

    let history: Vec<Value> =
        serde_json::from_str(&cluster.helm(&["history", "app", "-n", namespace, "-o", "json"]))
            .unwrap();
    let mut lines = editor.shown.history.clone().unwrap();
    lines.reverse();
    assert_eq!(lines.len(), history.len());
    for (line, helm) in lines.iter().zip(&history) {
        assert_eq!(u64::from(line.revision), helm["revision"].as_u64().unwrap());
        assert_eq!(line.status, helm["status"].as_str().unwrap());
        assert_eq!(line.chart.as_deref(), helm["chart"].as_str());
        assert_eq!(line.app_version.as_deref(), helm["app_version"].as_str());
        assert_eq!(
            line.description.as_ref().map(|text| text.text.as_str()),
            helm["description"].as_str()
        );
        let updated: Timestamp = line.updated.as_deref().unwrap().parse().unwrap();
        let helm_updated: Timestamp = helm["updated"].as_str().unwrap().parse().unwrap();
        assert_eq!(updated, helm_updated, "revision {}", line.revision);
    }

    for revision in [1, 2] {
        if editor.shown.revision != Some(revision) {
            editor.whole(revision, 2).await;
        }
        let get = |what: &str| {
            let revision = revision.to_string();
            cluster.helm(&["get", what, "app", "-n", namespace, "--revision", &revision])
        };
        let notes = get("notes");
        let notes = notes.strip_prefix("NOTES:\n").unwrap();
        assert_eq!(
            editor.shown.notes.as_deref(),
            Some(notes.strip_suffix('\n').unwrap()),
            "revision {revision}'s notes"
        );

        let values = editor
            .reveal(
                revision,
                HelmPart::Values {
                    defaults: false,
                    path: Vec::new(),
                },
            )
            .await;
        let helm_values = cluster.helm(&[
            "get",
            "values",
            "app",
            "-n",
            namespace,
            "--revision",
            &revision.to_string(),
            "-o",
            "json",
        ]);
        assert_eq!(
            serde_json::from_str::<Value>(&values).unwrap(),
            serde_json::from_str::<Value>(&helm_values).unwrap(),
            "revision {revision}'s values"
        );

        let manifest = editor.shown.manifest.clone().unwrap();
        let helm_manifest = get("manifest");
        let (ours, theirs) = (documents(&manifest.text), documents(&helm_manifest));
        assert_eq!(ours.len(), theirs.len());
        assert_eq!(manifest.secrets.len(), 1);
        for (index, (ours, theirs)) in ours.iter().zip(&theirs).enumerate() {
            let Some(secret) = manifest
                .secrets
                .iter()
                .find(|secret| secret.document as usize == index)
            else {
                assert_eq!(ours, theirs, "document {index} of revision {revision}");
                continue;
            };
            let mut revealed = yaml(ours);
            for entry in &secret.entries {
                let part = HelmPart::Secret {
                    document: secret.document,
                    items: secret.items.clone(),
                    key: entry.key.clone(),
                };
                let value = editor.reveal(revision, part).await;
                revealed["stringData"][&entry.key] = Value::String(value);
            }
            let source = |document: &str| document.lines().next().unwrap().to_owned();
            assert_eq!(source(ours), source(theirs));
            assert_eq!(revealed, yaml(theirs), "revision {revision}'s Secret");
        }
        let password = &canaries[revision as usize - 1];
        let revealed = editor
            .reveal(
                revision,
                HelmPart::Values {
                    defaults: false,
                    path: vec![twigo_ipc::ValueStep::Key("password".to_owned())],
                },
            )
            .await;
        assert_eq!(
            serde_json::from_str::<String>(&revealed).unwrap(),
            *password
        );
    }

    let release = Api::<Secret>::namespaced(cluster.admin.clone(), namespace)
        .get("sh.helm.release.v1.app.v1")
        .await
        .unwrap();
    let stored = &release.data.unwrap()["release"].0;
    let gzip = STANDARD.decode(stored).unwrap();
    let cut = STANDARD.encode(&gzip[..gzip.len() / 2]);
    let broken: Secret = serde_json::from_value(json!({
        "metadata": {
            "name": "sh.helm.release.v1.broken.v1",
            "labels": { "owner": "helm", "name": "broken", "version": "1", "status": "deployed" },
        },
        "type": "helm.sh/release.v1",
    }))
    .unwrap();
    let broken = Secret {
        data: Some([("release".to_owned(), ByteString(cut.into_bytes()))].into()),
        ..broken
    };
    Api::<Secret>::namespaced(cluster.admin.clone(), namespace)
        .create(&PostParams::default(), &broken)
        .await
        .unwrap();
    let cut_row = format!("{}/{namespace}/broken", cluster.context);
    list.until(|list| !list.text(&cut_row, "Problem").is_empty())
        .await;
    assert_eq!(list.text(&cut_row, "Problem"), "helm.truncated");
    assert_eq!(list.text(&cut_row, "Status"), "unreadable");
    assert_eq!(
        list.text(&row, "Chart"),
        cluster.listed(namespace)["app"]["chart"].as_str().unwrap()
    );

    core.helm_release_close("main", editor.id).unwrap();
    core.list_unsubscribe("main", list.id).unwrap();
    cluster.delete().await;
}

/// A chart whose files, dashboards of words drawn from a small vocabulary,
/// it renders into ConfigMaps, so that a release stores each file twice, as
/// real dashboards' charts do: about 1 MB stored, as Kubernetes' limit for a
/// Secret allows.
fn near_the_limit(dir: &Path) -> PathBuf {
    const WORDS: [&str; 32] = [
        "cpu",
        "memory",
        "rate",
        "sum",
        "pod",
        "node",
        "latency",
        "seconds",
        "bucket",
        "total",
        "request",
        "error",
        "namespace",
        "container",
        "usage",
        "bytes",
        "network",
        "receive",
        "transmit",
        "disk",
        "read",
        "write",
        "quantile",
        "avg",
        "max",
        "min",
        "job",
        "instance",
        "panel",
        "graph",
        "legend",
        "threshold",
    ];
    let chart = dir.join("near-the-limit");
    std::fs::create_dir_all(chart.join("templates")).unwrap();
    std::fs::create_dir_all(chart.join("files")).unwrap();
    std::fs::write(
        chart.join("Chart.yaml"),
        "apiVersion: v2\nname: near-the-limit\nversion: 0.1.0\n",
    )
    .unwrap();
    std::fs::write(
        chart.join("templates/dashboards.yaml"),
        "{{- range $path, $_ := .Files.Glob \"files/*.json\" }}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ $.Release.Name }}-{{ base $path | trimSuffix \".json\" }}\ndata:\n  dashboard.json: |-\n{{ $.Files.Get $path | indent 4 }}\n{{- end }}\n",
    )
    .unwrap();
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let mut word = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        WORDS[(state % WORDS.len() as u64) as usize]
    };
    for file in 0..FILES {
        let mut text = String::from("{\"panels\": [\n");
        for panel in 0..PANELS {
            text.push_str(&format!(
                "  {{\"id\": {panel}, \"title\": \"{} {} {}\", \"expr\": \"{}({}_{}_{}{{job=\\\"{}\\\"}}[5m])\"}},\n",
                word(),
                word(),
                word(),
                word(),
                word(),
                word(),
                word(),
                word()
            ));
        }
        text.push_str("  {}\n]}\n");
        std::fs::write(chart.join(format!("files/dashboard-{file:02}.json")), text).unwrap();
    }
    chart
}

const FILES: usize = 13;
const PANELS: usize = 1400;

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG and helm on PATH"]
async fn a_release_near_the_limit_opens_while_the_runtime_keeps_ticking() {
    let cluster = Cluster::connect().await;
    let namespace = &cluster.readable;
    let chart = near_the_limit(cluster.dir.path());
    cluster.helm(&["install", "big", chart.to_str().unwrap(), "-n", namespace]);
    let release = Api::<Secret>::namespaced(cluster.admin.clone(), namespace)
        .get("sh.helm.release.v1.big.v1")
        .await
        .unwrap();
    let stored = release.data.unwrap()["release"].0.len();
    assert!(
        (900_000..=1_048_576).contains(&stored),
        "{stored} bytes stored"
    );

    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(
        dir.path(),
        cluster.dir.path().join("kubeconfig"),
        &cluster.context,
    );
    core.catalog.contexts().await;
    let longest = Arc::new(Mutex::new(Duration::ZERO));
    let ticker = tokio::spawn({
        let longest = Arc::clone(&longest);
        async move {
            loop {
                let started = tokio::time::Instant::now();
                tokio::time::sleep(Duration::from_millis(5)).await;
                let gap = started.elapsed();
                let mut longest = longest.lock().unwrap();
                *longest = (*longest).max(gap);
            }
        }
    });
    let mut editor = Editor::open(&core, &space, namespace, "big").await;
    editor
        .until(|shown| shown.overview && shown.manifest.is_some())
        .await;
    ticker.abort();
    let longest = *longest.lock().unwrap();
    let manifest = editor.shown.manifest.as_ref().unwrap();
    assert_eq!(documents(&manifest.text).len(), FILES);
    assert!(
        longest < Duration::from_millis(100),
        "the runtime stood still for {longest:?} while a release of {stored} bytes opened"
    );

    core.helm_release_close("main", editor.id).unwrap();
    cluster.delete().await;
}
