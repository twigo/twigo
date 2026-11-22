//! The reducer: the metadata of the release Secrets in, one row a release
//! out, as the list's source (`twigo_cache::batcher::Source`).
//!
//! A release is its namespace and the `name` label of its Secrets; its row
//! shows the revision with the highest `version` label, whatever its status,
//! which `helm get` reads. Chart, App Version and Updated stay empty until
//! the revision is decoded. Each revision's Secret stays held as the hub
//! holds it, so its name, uid and `resourceVersion` are at hand to decode it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use twigo_cache::batcher::Source;
use twigo_cache::hub::{Delta, Shown, Subscription};
use twigo_cache::meta::Meta;
use twigo_cache::store::RowKey;
use twigo_cache::table::{Cell, Column, ColumnKind, Row};
use twigo_ipc::ErrorCode;

pub(super) struct Releases {
    secrets: Subscription<Row>,
    columns: Arc<[Column]>,
    held: Mutex<Held>,
}

impl Releases {
    pub(super) fn new(secrets: Subscription<Row>) -> Self {
        Self {
            secrets,
            columns: columns(),
            held: Mutex::default(),
        }
    }

    fn held(&self) -> MutexGuard<'_, Held> {
        self.held.lock().expect("releases lock")
    }
}

impl Source for Releases {
    fn drain_shown(&self) -> Shown<Row> {
        let Shown {
            delta,
            status,
            parts,
        } = self.secrets.drain_shown();
        let delta = match delta {
            Delta::Reset { rows, .. } => Delta::Reset {
                rows: self.held().reset(rows),
                columns: Some(Arc::clone(&self.columns)),
            },
            Delta::Changed { upserted, removed } => {
                let (upserted, removed) = self.held().change(upserted, &removed);
                Delta::Changed { upserted, removed }
            }
        };
        Shown {
            delta,
            status,
            parts,
        }
    }

    fn resolved(&self) -> bool {
        self.secrets.resolved()
    }
}

const NAME: &str = "Name";
const REVISION: &str = "Revision";
const STATUS: &str = "Status";
const CHART: &str = "Chart";
const APP_VERSION: &str = "App Version";
const UPDATED: &str = "Updated";
const PROBLEM: &str = "Problem";

fn columns() -> Arc<[Column]> {
    let column = |name: &str, kind, format: &str| Column {
        name: name.into(),
        kind,
        format: format.into(),
        priority: 0,
        prints_duration: false,
    };
    [
        column(NAME, ColumnKind::String, "name"),
        column(REVISION, ColumnKind::Integer, ""),
        column(STATUS, ColumnKind::String, ""),
        column(CHART, ColumnKind::String, ""),
        column(APP_VERSION, ColumnKind::String, ""),
        column(UPDATED, ColumnKind::Age, ""),
        column(PROBLEM, ColumnKind::String, ""),
    ]
    .into()
}

/// A release: the namespace of its Secrets and its name.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Release {
    namespace: Option<Box<str>>,
    name: Box<str>,
}

impl Release {
    fn key(&self) -> RowKey {
        RowKey::Name {
            namespace: self.namespace.clone(),
            name: self.name.clone(),
        }
    }
}

/// Which release a Secret belongs to, and as which revision. One without a
/// `name` label, or whose `version` is no revision number, is no revision of
/// a release: it is a release of its own, named as the Secret.
fn belongs(meta: &Meta) -> (Release, Option<u32>) {
    let label = |key: &str| {
        meta.labels
            .iter()
            .find(|(label, _)| &**label == key)
            .map(|(_, value)| &**value)
    };
    match (
        label("name"),
        label("version").and_then(|version| version.parse().ok()),
    ) {
        (Some(name), Some(version)) => (
            Release {
                namespace: meta.namespace.clone(),
                name: name.into(),
            },
            Some(version),
        ),
        _ => (
            Release {
                namespace: meta.namespace.clone(),
                name: meta.name.clone(),
            },
            None,
        ),
    }
}

#[derive(Default)]
struct Held {
    /// Each Secret by its key in the hub, with where it stands.
    placed: HashMap<RowKey, (Release, Option<u32>)>,
    /// The Secrets of each release by revision, the one that is no revision
    /// first.
    releases: HashMap<Release, BTreeMap<Option<u32>, Arc<Row>>>,
}

impl Held {
    fn reset(&mut self, secrets: Vec<Arc<Row>>) -> Vec<Arc<Row>> {
        *self = Self::default();
        for secret in secrets {
            self.place(secret);
        }
        self.releases
            .iter()
            .map(|(release, revisions)| row(release, revisions))
            .collect()
    }

    fn change(
        &mut self,
        upserted: Vec<Arc<Row>>,
        removed: &[RowKey],
    ) -> (Vec<Arc<Row>>, Vec<RowKey>) {
        let mut touched: HashSet<Release> =
            removed.iter().filter_map(|key| self.lift(key)).collect();
        for secret in upserted {
            touched.insert(self.place(secret));
        }
        let (mut upserted, mut removed) = (Vec::new(), Vec::new());
        for release in touched {
            match self.releases.get(&release) {
                Some(revisions) => upserted.push(row(&release, revisions)),
                None => removed.push(release.key()),
            }
        }
        (upserted, removed)
    }

    fn place(&mut self, secret: Arc<Row>) -> Release {
        let (release, revision) = belongs(&secret.meta);
        self.placed
            .insert(RowKey::of(&secret.meta), (release.clone(), revision));
        self.releases
            .entry(release.clone())
            .or_default()
            .insert(revision, secret);
        release
    }

    /// Takes a Secret off its release, which goes with its last Secret.
    fn lift(&mut self, key: &RowKey) -> Option<Release> {
        let (release, revision) = self.placed.remove(key)?;
        if let Some(revisions) = self.releases.get_mut(&release) {
            revisions.remove(&revision);
            if revisions.is_empty() {
                self.releases.remove(&release);
            }
        }
        Some(release)
    }
}

/// The row of a release, from its newest revision's Secret.
fn row(release: &Release, revisions: &BTreeMap<Option<u32>, Arc<Row>>) -> Arc<Row> {
    let (revision, secret) = revisions
        .last_key_value()
        .expect("a release with no Secret is not held");
    let status = secret
        .meta
        .labels
        .iter()
        .find(|(label, _)| &**label == "status")
        .map(|(_, value)| Cell::Text(value.clone()));
    let (revision, problem) = match revision {
        Some(revision) => (Cell::Int(i64::from(*revision)), Cell::Null),
        None => (
            Cell::Null,
            Cell::Text(ErrorCode::HelmNotARelease.wire().into()),
        ),
    };
    Arc::new(Row {
        meta: Meta {
            name: release.name.clone(),
            namespace: release.namespace.clone(),
            uid: None,
            resource_version: secret.meta.resource_version.clone(),
            labels: Box::default(),
            owners: Box::default(),
            created: None,
            received: secret.meta.received,
            generated: None,
        },
        cells: Box::new([
            Cell::Text(release.name.clone()),
            revision,
            status.unwrap_or(Cell::Null),
            Cell::Null,
            Cell::Null,
            Cell::Age,
            problem,
        ]),
    })
}
