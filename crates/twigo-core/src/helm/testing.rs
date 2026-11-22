//! Release Secrets as Helm's Secrets driver writes them, for the tests on
//! the fake: the release's JSON gzipped at its best compression and in
//! base64, which the API puts in base64 again
//! ([util.go](https://github.com/helm/helm/blob/v4.3.2/pkg/storage/driver/util.go#L38-L57),
//! [secrets.go](https://github.com/helm/helm/blob/v4.3.2/pkg/storage/driver/secrets.go#L247-L285)).

use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use twigo_cache::fake::Fake;
use twigo_cache::hub::Hub;
use twigo_ipc::{
    Ack, Execute, IpcError, OpenRelease, OperationEvent, Overview, Plan, ReleaseBatch,
    ReleaseManifest, ReleaseParts, ReleaseRef, ReleaseValues, RevisionLine, Scrubbed,
    SubscriptionId, ViewState,
};
use twigo_kube::client::{Budgets, Clients};

use crate::Core;

use super::fetch::secret_name;

/// A revision of a release of the chart `demo`, whose chart version and
/// `last_deployed` tell its revisions apart.
pub(crate) fn release(namespace: &str, name: &str, version: u32, status: &str) -> Value {
    json!({
        "name": name,
        "namespace": namespace,
        "version": version,
        "info": {
            "first_deployed": "2026-11-01T10:00:00Z",
            "last_deployed": format!("2026-11-{:02}T10:00:00Z", version.min(28)),
            "status": status,
            "description": "Install complete",
            "notes": format!("Revision {version} of {name}"),
        },
        "chart": {
            "metadata": { "name": "demo", "version": format!("1.{version}.0"), "appVersion": "2.0" },
            "values": { "replicas": 1 },
        },
        "config": { "image": format!("demo:{version}") },
        "manifest": format!(
            "---\n# Source: demo/templates/config.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {name}\ndata:\n  revision: \"{version}\"\n"
        ),
    })
}

/// Helm's base64 of the gzip of `release`'s JSON.
pub(crate) fn encoded(release: &Value) -> Vec<u8> {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::best());
    gzip.write_all(&serde_json::to_vec(release).unwrap())
        .unwrap();
    STANDARD.encode(gzip.finish().unwrap()).into_bytes()
}

/// `release` stored in `namespace`, its labels saying `status`.
pub(crate) fn put(fake: &Fake, release: &Value, status: &str) {
    let namespace = release["namespace"].as_str().unwrap();
    let name = release["name"].as_str().unwrap();
    let version = u32::try_from(release["version"].as_u64().unwrap()).unwrap();
    put_payload(fake, namespace, name, version, status, &encoded(release));
}

/// A release Secret whose `release` key holds `payload` under the API's
/// base64.
pub(crate) fn put_payload(
    fake: &Fake,
    namespace: &str,
    name: &str,
    version: u32,
    status: &str,
    payload: &[u8],
) {
    fake.put(
        "",
        "secrets",
        Some(namespace),
        json!({
            "kind": "Secret",
            "apiVersion": "v1",
            "type": "helm.sh/release.v1",
            "metadata": {
                "name": secret_name(name, version),
                "namespace": namespace,
                "uid": format!("{namespace}-{name}-{version}"),
                "labels": {
                    "owner": "helm",
                    "name": name,
                    "version": version.to_string(),
                    "status": status,
                },
            },
            "data": { "release": STANDARD.encode(payload) },
        }),
    );
}

/// How many `GET`s the fake had of a revision's Secret.
pub(crate) fn gets(fake: &Fake, namespace: &str, name: &str, version: u32) -> usize {
    let path = format!(
        "/api/v1/namespaces/{namespace}/secrets/{}",
        secret_name(name, version)
    );
    fake.state()
        .requests
        .iter()
        .filter(|(_, request)| request.ends_with(&path))
        .count()
}

/// What an open release's batches showed, each part as last sent; a batch
/// with a problem, or once nothing exists, leaves no part of a revision.
#[derive(Default)]
pub(crate) struct Shown {
    pub status: Option<ViewState>,
    pub exists: bool,
    pub revision: Option<u32>,
    pub latest: Option<u32>,
    pub problem: Option<IpcError>,
    pub overview: Option<Overview>,
    pub notes: Option<Scrubbed>,
    pub description: Option<Scrubbed>,
    pub values: Option<ReleaseValues>,
    pub manifest: Option<ReleaseManifest>,
    pub history: Option<Vec<RevisionLine>>,
}

impl Shown {
    fn apply(&mut self, batch: ReleaseBatch) {
        if batch.problem.is_some() || !batch.exists {
            self.overview = None;
            self.notes = None;
            self.description = None;
            self.values = None;
            self.manifest = None;
        }
        self.status = Some(batch.status);
        self.exists = batch.exists;
        self.revision = batch.revision;
        self.latest = batch.latest;
        self.problem = batch.problem;
        if batch.overview.is_some() {
            self.overview = batch.overview;
            self.notes = batch.notes;
            self.description = batch.description;
        }
        if batch.values.is_some() {
            self.values = batch.values;
        }
        if batch.manifest.is_some() {
            self.manifest = batch.manifest;
        }
        if batch.history.is_some() {
            self.history = batch.history;
        }
    }

    /// The cells its overview's header printed, as `column=value`.
    pub(crate) fn printed(&self) -> Vec<String> {
        self.overview
            .iter()
            .flat_map(|overview| &overview.header.printed)
            .map(|cell| format!("{}={}", cell.column, cell.value))
            .collect()
    }
}

/// An open release's batches, read as the webview reads them.
pub(crate) struct Watched {
    batches: mpsc::UnboundedReceiver<ReleaseBatch>,
    pub shown: Shown,
    /// Every batch, as it went.
    pub sent: Vec<ReleaseBatch>,
}

impl Watched {
    /// The reader, and the `send` an open release takes.
    pub(crate) fn new() -> (Self, impl FnMut(ReleaseBatch) -> bool + Send + 'static) {
        let (sender, batches) = mpsc::unbounded_channel();
        let watched = Self {
            batches,
            shown: Shown::default(),
            sent: Vec::new(),
        };
        (watched, move |batch| sender.send(batch).is_ok())
    }

    /// The next batch, acknowledged through `ack`.
    pub(crate) async fn next(&mut self, ack: impl Fn(u32)) -> ReleaseBatch {
        let received = tokio::time::timeout(Duration::from_secs(600), self.batches.recv()).await;
        let batch = received
            .expect("a batch within ten minutes")
            .expect("the release is open");
        ack(batch.seq);
        self.sent.push(batch.clone());
        batch
    }

    /// Reads batches until `done` holds of what they showed.
    pub(crate) async fn until(
        &mut self,
        ack: impl Fn(u32),
        what: &str,
        done: impl Fn(&Shown) -> bool,
    ) {
        let reached = async {
            while !done(&self.shown) {
                let batch = self.next(&ack).await;
                self.shown.apply(batch);
            }
        };
        let within = tokio::time::timeout(Duration::from_secs(600), reached).await;
        assert!(within.is_ok(), "{what} not within ten minutes");
    }
}

/// A core over the fake's hub, which keeps the fake's clients alive, with
/// the space of the context `kind-test`.
pub(crate) struct Over {
    pub core: Arc<Core>,
    pub space: String,
    _hub: Arc<Clients>,
}

impl Over {
    pub(crate) fn new(fake: &Fake, dir: &Path) -> Self {
        let (hub, clients): (Hub, _) = fake.hub(Budgets::default());
        let core = Core::over(dir, hub);
        let space = core.state.open_space("kind-test").id;
        Self {
            core,
            space,
            _hub: clients,
        }
    }

    /// Opens `namespace/name` in the window `main`.
    pub(crate) async fn open(
        &self,
        namespace: &str,
        name: &str,
        revision: Option<u32>,
        parts: ReleaseParts,
    ) -> (SubscriptionId, Watched) {
        let (watched, send) = Watched::new();
        let request = OpenRelease {
            release: ReleaseRef {
                space: self.space.clone(),
                namespace: namespace.to_owned(),
                name: name.to_owned(),
            },
            revision,
            parts,
        };
        let id = self
            .core
            .helm_release_open("main", request, send)
            .await
            .unwrap();
        (id, watched)
    }

    pub(crate) fn ack(&self, id: SubscriptionId) -> impl Fn(u32) + '_ {
        move |seq| self.core.helm_release_ack("main", Ack { id, seq }).unwrap()
    }

    /// Runs a plan and gathers its events until the last.
    pub(crate) async fn run(&self, plan: &Plan) -> Vec<OperationEvent> {
        let (sender, mut events) = mpsc::unbounded_channel();
        let execute = Execute {
            plan: plan.id,
            typed: None,
        };
        self.core
            .command_execute("main", execute, move |event| sender.send(event).is_ok())
            .await
            .unwrap();
        let mut told = Vec::new();
        while let Some(event) = events.recv().await {
            let last = !matches!(event, OperationEvent::Running { .. });
            told.push(event);
            if last {
                break;
            }
        }
        told
    }
}
