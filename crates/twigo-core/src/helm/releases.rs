//! The reducer: the metadata of the release Secrets in, one row a release
//! out, as the list's source (`twigo_cache::batcher::Source`).
//!
//! A release is its namespace and the `name` label of its Secrets; its row
//! shows the revision with the highest `version` label, whatever its status,
//! which `helm get` reads. That revision is fetched and decoded to its
//! summary once per uid and `resourceVersion`, four at a time, and its row
//! then has Chart, App Version, Updated and the status its payload says, or
//! the status `unreadable` and the code that keeps it from being read in
//! Problem. Helm writes a
//! revision's Secret again when its status changes: its last summary stays
//! until the new one lands, the status the label's meanwhile. A request that
//! fails says nothing of the revision: its code is in Problem beside the
//! label's status while it fails for that version of the Secret, and it is
//! asked again after the hub's backoff, or RBAC's no after the hub's pause
//! for one, and at every relist.
//!
//! The decodes need no wake of their own: the batcher drains its source at
//! every flush while nothing is unacknowledged, and a summary that lands is
//! a change of its row there, coalesced with the others as any change is.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use twigo_cache::batcher::Source;
use twigo_cache::hub::{Delta, Hub, Shown, Subscription};
use twigo_cache::meta::Meta;
use twigo_cache::store::RowKey;
use twigo_cache::table::{Cell, Column, ColumnKind, Row};
use twigo_helm::Summary;
use twigo_ipc::{ErrorCode, IpcError, Printed};

use super::fetch::{self, AT_ONCE, Failed};
use super::reads::{Reads, Stamp};

pub(super) struct Releases {
    secrets: Subscription<Row>,
    columns: Arc<[Column]>,
    held: Held,
    fetches: Fetches,
}

impl Releases {
    pub(super) fn new(secrets: Subscription<Row>, hub: Hub, context: String) -> Self {
        Self {
            secrets,
            columns: columns(),
            held: Held::default(),
            fetches: Fetches {
                hub,
                context,
                running: JoinSet::new(),
                permits: Arc::new(Semaphore::new(AT_ONCE)),
            },
        }
    }
}

impl Source for Releases {
    fn drain_shown(&mut self) -> Shown<Row> {
        let Shown {
            delta,
            status,
            parts,
        } = self.secrets.drain_shown();
        let answers = self.fetches.answers();
        let held = &mut self.held;
        let (delta, touched) = match delta {
            Delta::Reset { rows, .. } => {
                held.reset(rows);
                for (release, stamp, read) in answers {
                    held.answered(release, stamp, read);
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
                for (release, stamp, read) in answers {
                    touched.extend(held.answered(release, stamp, read));
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
        let due: Vec<Release> = held.reads.due().cloned().collect();
        let unread: Vec<Unread> = touched
            .into_iter()
            .chain(due)
            .filter_map(|release| held.unread(release))
            .collect();
        for unread in unread {
            self.fetches.fetch(unread);
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
    match (
        meta.label("name"),
        meta.label("version")
            .and_then(|version| version.parse().ok()),
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

/// A revision's summary, or the code that keeps it from being read.
pub(super) type Decoded = Result<Summary, ErrorCode>;

/// The status of a revision that cannot be read, which a list counts as
/// failing.
pub(super) const UNREADABLE: &str = "unreadable";

/// What a row shows of its newest revision beyond the labels.
#[derive(Default)]
pub(super) struct Known<'a> {
    /// Its summary, and whether it was decoded from its Secret as it stands:
    /// one decoded from an earlier version of the same Secret gives all but
    /// the status, which the label then says.
    pub(super) summary: Option<(&'a Summary, bool)>,
    /// What its decode decided keeps it from being read.
    pub(super) unreadable: Option<ErrorCode>,
    /// Why a request for it fails, while it does.
    pub(super) failing: Option<ErrorCode>,
}

impl<'a> Known<'a> {
    /// What is known of the revision whose Secret stands at `stamp`, from
    /// the last decode of its Secret and why the request for it `fails`.
    pub(super) fn of(
        stamp: &Stamp,
        decoded: Option<(&Stamp, Result<&'a Summary, ErrorCode>)>,
        fails: Option<&IpcError>,
    ) -> Self {
        let (summary, unreadable) = match decoded {
            Some((at, Ok(summary))) if at == stamp => (Some((summary, true)), None),
            Some((at, Err(code))) if at == stamp => (None, Some(code)),
            Some((at, Ok(summary))) if at.same_secret(stamp) => (Some((summary, false)), None),
            _ => (None, None),
        };
        Known {
            summary,
            unreadable,
            failing: fails.map(|error| error.code),
        }
    }

    /// Whether the cells it makes hold all that will be known until the
    /// revision changes or a fetch answers.
    pub(super) fn read(&self) -> bool {
        self.summary.is_some() || self.unreadable.is_some() || self.failing.is_some()
    }
}

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
    /// The reads of each release's newest revision.
    reads: Reads<Release, Decoded>,
}

impl Held {
    fn reset(&mut self, secrets: Vec<Arc<Row>>) {
        self.placed.clear();
        self.releases.clear();
        for secret in secrets {
            self.place(secret);
        }
        self.forget_gone();
        self.reads.relisted();
    }

    /// Forgets what was read of each release that holds no revision now.
    fn forget_gone(&mut self) {
        let releases = &self.releases;
        self.reads
            .retain(|release| newest(releases, release).is_some());
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
        if !touched.is_empty() {
            self.forget_gone();
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
            }
        }
        Some(release)
    }

    fn newest(&self, release: &Release) -> Option<&Arc<Row>> {
        newest(&self.releases, release)
    }

    /// Keeps what the fetch of the release's newest revision asked last
    /// answered, and says which release's row it changed.
    fn answered(
        &mut self,
        release: Release,
        stamp: Stamp,
        read: Result<Summary, Failed>,
    ) -> Option<Release> {
        self.reads
            .answered(release.clone(), stamp, read, |read| {
                read.map_err(|error| error.code)
            })
            .then_some(release)
    }

    /// The release's newest revision where it wants a fetch, which marks it
    /// asked.
    fn unread(&mut self, release: Release) -> Option<Unread> {
        let secret = self.newest(&release)?;
        let stamp = Stamp::of(&secret.meta);
        let name = secret.meta.name.clone();
        if !self.reads.ask(release.clone(), &stamp) {
            return None;
        }
        Some(Unread {
            release,
            stamp,
            secret: name,
        })
    }

    /// The row of a release, from its newest revision's Secret and what is
    /// known of that revision.
    fn row(&self, release: &Release) -> Option<Arc<Row>> {
        let (revision, secret) = self.releases.get(release)?.last_key_value()?;
        let stamp = Stamp::of(&secret.meta);
        let decoded = self
            .reads
            .get(release)
            .map(|(stamp, decoded)| (stamp, decoded.as_ref().map_err(|code| *code)));
        let known = Known::of(&stamp, decoded, self.reads.failure(release, &stamp));
        let (cells, created) = cells(&release.name, *revision, &secret.meta, &known);
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

/// The newest revision's Secret of a release, when it is a revision.
fn newest<'a>(
    releases: &'a HashMap<Release, BTreeMap<Option<u32>, Arc<Row>>>,
    release: &Release,
) -> Option<&'a Arc<Row>> {
    match releases.get(release)?.last_key_value()? {
        (Some(_), secret) => Some(secret),
        (None, _) => None,
    }
}

/// A release's cells, from its newest revision's Secret and what is `known`
/// of that revision; and when the revision was deployed, which Updated
/// counts from.
pub(super) fn cells(
    name: &str,
    revision: Option<u32>,
    secret: &Meta,
    known: &Known<'_>,
) -> (Box<[Cell]>, Option<i64>) {
    let label = secret
        .label("status")
        .map_or(Cell::Null, |value| Cell::Text(value.into()));
    let text = |text: Option<&str>| {
        text.filter(|text| !text.is_empty())
            .map_or(Cell::Null, |text| Cell::Text(text.into()))
    };
    let unreadable = || Cell::Text(UNREADABLE.into());
    let (revision, status, chart, app_version, created, problem) = match revision {
        None => (
            Cell::Null,
            unreadable(),
            Cell::Null,
            Cell::Null,
            None,
            Cell::Text(ErrorCode::HelmNotARelease.wire().into()),
        ),
        Some(revision) => {
            let summary = known.summary.map(|(summary, _)| summary);
            (
                Cell::Int(i64::from(revision)),
                match known.summary {
                    _ if known.unreadable.is_some() => unreadable(),
                    Some((summary, true)) => Cell::Text(summary.status().word().into()),
                    _ => label,
                },
                text(summary.and_then(Summary::chart).as_deref()),
                text(summary.and_then(Summary::app_version)),
                summary
                    .and_then(Summary::last_deployed)
                    .map(|at| at.as_millisecond()),
                known
                    .failing
                    .or(known.unreadable)
                    .map_or(Cell::Null, |code| Cell::Text(code.wire().into())),
            )
        }
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
    running: JoinSet<(Release, Stamp, Result<Summary, Failed>)>,
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
            let read =
                fetch::decoded(&hub, &context, namespace, &secret, twigo_helm::summary).await;
            (release, stamp, read)
        });
    }

    /// The decodes that ended since the last call. One whose task panicked
    /// outside its decode panics here, in the list's own task, which ends
    /// the list.
    fn answers(&mut self) -> Vec<(Release, Stamp, Result<Summary, Failed>)> {
        let mut answers = Vec::new();
        while let Some(ended) = self.running.try_join_next() {
            answers.push(twigo_panic::joined(ended));
        }
        answers
    }
}
