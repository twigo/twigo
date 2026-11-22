//! The reducer: the metadata of the release Secrets in, one row a release
//! out, as the list's source (`twigo_cache::batcher::Source`).
//!
//! A release is its namespace and the `name` label of its Secrets; its row
//! shows the revision with the highest `version` label, whatever its status,
//! which `helm get` reads. That revision is fetched and decoded to its
//! summary once per uid and `resourceVersion`, four at a time, and its row
//! then has Chart, App Version, Updated and the status its payload says, or
//! the code that keeps it from being read in Problem.
//!
//! The decodes need no wake of their own: the batcher drains its source at
//! every flush while nothing is unacknowledged, and a summary that lands is
//! a change of its row there, coalesced with the others as any change is.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use twigo_cache::batcher::Source;
use twigo_cache::hub::{Delta, Hub, Shown, Subscription};
use twigo_cache::meta::Meta;
use twigo_cache::store::RowKey;
use twigo_cache::table::{Cell, Column, ColumnKind, Row};
use twigo_helm::Summary;
use twigo_ipc::{ErrorCode, Printed};

use super::fetch;

/// How many release Secrets a list fetches at once, as the metrics poller
/// keeps to four requests (ARCHITECTURE 3.6).
const AT_ONCE: usize = 4;

pub(super) struct Releases {
    secrets: Subscription<Row>,
    columns: Arc<[Column]>,
    held: Mutex<Held>,
    fetches: Mutex<Fetches>,
}

impl Releases {
    pub(super) fn new(secrets: Subscription<Row>, hub: Hub, context: String) -> Self {
        Self {
            secrets,
            columns: columns(),
            held: Mutex::default(),
            fetches: Mutex::new(Fetches {
                hub,
                context,
                running: JoinSet::new(),
                permits: Arc::new(Semaphore::new(AT_ONCE)),
            }),
        }
    }

    fn held(&self) -> MutexGuard<'_, Held> {
        self.held.lock().expect("releases lock")
    }

    fn fetches(&self) -> MutexGuard<'_, Fetches> {
        self.fetches.lock().expect("releases lock")
    }
}

impl Source for Releases {
    fn drain_shown(&self) -> Shown<Row> {
        let Shown {
            delta,
            status,
            parts,
        } = self.secrets.drain_shown();
        let answers = self.fetches().answers();
        let mut held = self.held();
        let (delta, touched) = match delta {
            Delta::Reset { rows, .. } => {
                held.reset(rows);
                for (release, stamp, decoded) in answers {
                    held.answered(release, stamp, decoded);
                }
                let rows = held.rows();
                let touched: Vec<Release> = held.releases.keys().cloned().collect();
                let delta = Delta::Reset {
                    rows,
                    columns: Some(Arc::clone(&self.columns)),
                };
                (delta, touched)
            }
            Delta::Changed { upserted, removed } => {
                let mut touched = held.change(upserted, &removed);
                for (release, stamp, decoded) in answers {
                    touched.extend(held.answered(release, stamp, decoded));
                }
                let (mut upserted, mut removed) = (Vec::new(), Vec::new());
                for release in &touched {
                    match held.row(release) {
                        Some(row) => upserted.push(row),
                        None => removed.push(release.key()),
                    }
                }
                (
                    Delta::Changed { upserted, removed },
                    touched.into_iter().collect(),
                )
            }
        };
        let unread: Vec<Unread> = touched
            .into_iter()
            .filter_map(|release| held.unread(release))
            .collect();
        drop(held);
        let mut fetches = self.fetches();
        for unread in unread {
            fetches.fetch(unread);
        }
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

const UPDATED: &str = "Updated";

/// A release's columns, in the order of its cells.
const COLUMNS: [&str; 7] = [
    "Name",
    "Revision",
    "Status",
    "Chart",
    "App Version",
    UPDATED,
    "Problem",
];

fn columns() -> Arc<[Column]> {
    COLUMNS
        .iter()
        .map(|&name| Column {
            name: name.into(),
            kind: match name {
                "Revision" => ColumnKind::Integer,
                UPDATED => ColumnKind::Age,
                _ => ColumnKind::String,
            },
            format: if name == "Name" { "name" } else { "" }.into(),
            priority: 0,
            prints_duration: false,
        })
        .collect()
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

/// One version of a revision's Secret: Helm writes a revision again, whole,
/// when its status changes, which may change its description too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Stamp {
    uid: Option<Box<str>>,
    resource_version: Box<str>,
}

impl Stamp {
    pub(super) fn of(meta: &Meta) -> Self {
        Self {
            uid: meta.uid.clone(),
            resource_version: meta.resource_version.clone(),
        }
    }
}

/// A revision's summary, or the code that keeps it from being read.
pub(super) type Decoded = Result<Summary, ErrorCode>;

/// A newest revision that wants its decode.
struct Unread {
    release: Release,
    stamp: Stamp,
    secret: Box<str>,
}

#[derive(Default)]
struct Held {
    /// Each Secret by its key in the hub, with where it stands.
    placed: HashMap<RowKey, (Release, Option<u32>)>,
    /// The Secrets of each release by revision, the one that is no revision
    /// first.
    releases: HashMap<Release, BTreeMap<Option<u32>, Arc<Row>>>,
    /// The summary of each release's newest revision, by the version of its
    /// Secret decoded.
    decoded: HashMap<Release, (Stamp, Decoded)>,
    /// The version of each release's newest revision being fetched.
    asked: HashMap<Release, Stamp>,
}

impl Held {
    fn reset(&mut self, secrets: Vec<Arc<Row>>) {
        self.placed.clear();
        self.releases.clear();
        for secret in secrets {
            self.place(secret);
        }
        let releases = &self.releases;
        self.decoded
            .retain(|release, _| releases.contains_key(release));
        self.asked
            .retain(|release, _| releases.contains_key(release));
    }

    fn rows(&self) -> Vec<Arc<Row>> {
        self.releases
            .keys()
            .filter_map(|release| self.row(release))
            .collect()
    }

    /// The releases that changed.
    fn change(&mut self, upserted: Vec<Arc<Row>>, removed: &[RowKey]) -> HashSet<Release> {
        let mut touched: HashSet<Release> =
            removed.iter().filter_map(|key| self.lift(key)).collect();
        for secret in upserted {
            touched.insert(self.place(secret));
        }
        touched
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
                self.decoded.remove(&release);
                self.asked.remove(&release);
            }
        }
        Some(release)
    }

    /// The newest revision's Secret of a release, when it is a revision.
    fn newest(&self, release: &Release) -> Option<&Arc<Row>> {
        match self.releases.get(release)?.last_key_value()? {
            (Some(_), secret) => Some(secret),
            (None, _) => None,
        }
    }

    /// Keeps a decode of the release's newest revision as it stands, and
    /// says which release's row it changed.
    fn answered(&mut self, release: Release, stamp: Stamp, decoded: Decoded) -> Option<Release> {
        if self.asked.get(&release) == Some(&stamp) {
            self.asked.remove(&release);
        }
        let newest = self.newest(&release)?;
        if Stamp::of(&newest.meta) != stamp {
            return None;
        }
        self.decoded.insert(release.clone(), (stamp, decoded));
        Some(release)
    }

    /// The release's newest revision when no decode of it as it stands is
    /// held or under way, which marks it asked.
    fn unread(&mut self, release: Release) -> Option<Unread> {
        let secret = self.newest(&release)?;
        let stamp = Stamp::of(&secret.meta);
        let name = secret.meta.name.clone();
        let read = |held: Option<&Stamp>| held == Some(&stamp);
        if read(self.decoded.get(&release).map(|(stamp, _)| stamp))
            || read(self.asked.get(&release))
        {
            return None;
        }
        self.asked.insert(release.clone(), stamp.clone());
        Some(Unread {
            release,
            stamp,
            secret: name,
        })
    }

    /// The row of a release, from its newest revision's Secret and, once it
    /// is decoded, its summary.
    fn row(&self, release: &Release) -> Option<Arc<Row>> {
        let (revision, secret) = self.releases.get(release)?.last_key_value()?;
        let decoded = self
            .decoded
            .get(release)
            .filter(|(stamp, _)| *stamp == Stamp::of(&secret.meta))
            .map(|(_, decoded)| decoded);
        let (cells, created) = cells(&release.name, *revision, &secret.meta, decoded);
        Some(Arc::new(Row {
            meta: Meta {
                name: release.name.clone(),
                namespace: release.namespace.clone(),
                uid: None,
                resource_version: secret.meta.resource_version.clone(),
                labels: Box::default(),
                owners: Box::default(),
                created,
                received: secret.meta.received,
                generated: None,
            },
            cells,
        }))
    }
}

/// A release's cells, from its newest revision's Secret and that revision
/// decoded, if it is; and when the revision was deployed, which Updated
/// counts from.
pub(super) fn cells(
    name: &str,
    revision: Option<u32>,
    secret: &Meta,
    decoded: Option<&Decoded>,
) -> (Box<[Cell]>, Option<i64>) {
    let label = secret
        .labels
        .iter()
        .find(|(label, _)| &**label == "status")
        .map_or(Cell::Null, |(_, value)| Cell::Text(value.clone()));
    let text = |text: Option<&str>| {
        text.filter(|text| !text.is_empty())
            .map_or(Cell::Null, |text| Cell::Text(text.into()))
    };
    let (revision, status, chart, app_version, created, problem) = match (revision, decoded) {
        (None, _) => (
            Cell::Null,
            label,
            Cell::Null,
            Cell::Null,
            None,
            Cell::Text(ErrorCode::HelmNotARelease.wire().into()),
        ),
        (Some(revision), Some(Ok(summary))) => (
            Cell::Int(i64::from(revision)),
            Cell::Text(summary.status().word().into()),
            text(summary.chart().as_deref()),
            text(summary.app_version()),
            summary.last_deployed().map(|at| at.as_millisecond()),
            Cell::Null,
        ),
        (Some(revision), Some(Err(code))) => (
            Cell::Int(i64::from(revision)),
            label,
            Cell::Null,
            Cell::Null,
            None,
            Cell::Text(code.wire().into()),
        ),
        (Some(revision), None) => (
            Cell::Int(i64::from(revision)),
            label,
            Cell::Null,
            Cell::Null,
            None,
            Cell::Null,
        ),
    };
    let cells = Box::new([
        Cell::Text(name.into()),
        revision,
        status,
        chart,
        app_version,
        Cell::Age,
        problem,
    ]);
    (cells, created)
}

/// A release's cells as an overview's header prints them: every column but
/// Updated, which the header's `created` holds, and empty for a cell
/// without a value.
pub(super) fn printed(cells: &[Cell]) -> Vec<Printed> {
    COLUMNS
        .iter()
        .zip(cells)
        .filter(|(column, _)| **column != UPDATED)
        .map(|(column, cell)| Printed {
            column: (*column).to_owned(),
            value: match cell {
                Cell::Int(number) => number.to_string(),
                Cell::Text(text) => text.to_string(),
                _ => String::new(),
            },
        })
        .collect()
}

/// The decodes under way, which end with the list.
struct Fetches {
    hub: Hub,
    context: String,
    running: JoinSet<(Release, Stamp, Decoded)>,
    permits: Arc<Semaphore>,
}

impl Fetches {
    fn fetch(&mut self, unread: Unread) {
        let (hub, context, permits) = (
            self.hub.clone(),
            self.context.clone(),
            Arc::clone(&self.permits),
        );
        self.running.spawn(async move {
            let Unread {
                release,
                stamp,
                secret,
            } = unread;
            let _permit = permits
                .acquire_owned()
                .await
                .expect("a list's permits are never closed");
            let namespace = release.namespace.as_deref().unwrap_or_default();
            let decoded = match hub.clients(&context).await {
                Ok(clients) => fetch::decoded(&clients, namespace, &secret, twigo_helm::summary)
                    .await
                    .map_err(|error| error.code),
                Err(error) => Err(error.code),
            };
            (release, stamp, decoded)
        });
    }

    /// The decodes that ended since the last call. One whose task panicked
    /// outside its decode panics here, in the list's own task, which ends
    /// the list.
    fn answers(&mut self) -> Vec<(Release, Stamp, Decoded)> {
        let mut answers = Vec::new();
        while let Some(ended) = self.running.try_join_next() {
            answers.push(twigo_panic::joined(ended));
        }
        answers
    }
}
