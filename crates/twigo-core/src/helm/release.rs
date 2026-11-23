//! An open release (ARCHITECTURE 3.6): its revisions are the rows of the
//! release Secrets of its namespace, the upstream the list reads, that
//! carry its `name` label, so opening it costs no watch beyond the list's.
//! The revision it shows, the latest unless one is pinned, is fetched with
//! one `GET` and decoded to its page once, held while it is shown and
//! dropped with the editor; History decodes each revision once per uid and
//! `resourceVersion` while it is shown, keeping only its line. A revision's
//! page and line stay while its Secret, written again, is decoded anew, the
//! status the label's meanwhile, and no overview goes until the new page
//! lands; a page goes at once when its revision no longer holds the Secret
//! it came from, whichever revision is wanted. A request that fails is said
//! while it fails for that version of the Secret, and asked again as the
//! list asks. The overview places the manifest's objects by the space's
//! discovery, and goes again when discovery answers otherwise. Batches go
//! with flow control, as an open object's do (3.5).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use twigo_cache::batcher::FLUSH;
use twigo_cache::discovery::Resources;
use twigo_cache::hub::{Delta, Hub, Subscription};
use twigo_cache::store::RowKey;
use twigo_cache::table::Row;
use twigo_helm::{Page, Stored, Summary};
use twigo_ipc::{
    Discovered, ErrorCode, IpcError, ReleaseBatch, ReleaseParts, Resource, RevisionLine, ViewState,
};
use twigo_panic::contain;

use super::fetch::{self, Failed};
use super::releases::{Decoded, Failing, Known, Stamp, UNREADABLE, cells, printed};

/// The seam of an open release, as `TWIGO_PANIC` names it.
pub(crate) const ITEM: &str = "helm release";

/// How many revisions History fetches at once, as the list does.
const AT_ONCE: usize = 4;

/// The space's discovery, once the context's follower is at hand.
pub(crate) type Discovery = BoxFuture<'static, Resources>;

/// An open release: dropping it ends its task and its upstream.
pub(crate) struct Opened {
    context: Arc<str>,
    namespace: Arc<str>,
    name: Arc<str>,
    control: Arc<Control>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct Control {
    pending: Mutex<Pending>,
    wake: Notify,
    shown: Mutex<Option<ShownPage>>,
}

/// The page an open release shows, which a Reveal reads.
#[derive(Clone)]
pub(crate) struct ShownPage {
    pub revision: u32,
    /// The uid of the Secret it was decoded from.
    pub secret: Option<Box<str>>,
    pub page: Arc<Page>,
}

/// What the webview asked for since the task last looked.
#[derive(Default)]
struct Pending {
    view: Option<(Option<u32>, ReleaseParts)>,
    acked: Option<u32>,
}

/// Where an open release lives, and who it is.
pub(crate) struct Target {
    pub hub: Hub,
    pub context: String,
    pub namespace: String,
    pub name: String,
}

impl Opened {
    pub(crate) fn spawn(
        target: Target,
        secrets: Subscription<Row>,
        revision: Option<u32>,
        parts: ReleaseParts,
        discovery: Discovery,
        send: impl FnMut(ReleaseBatch) -> bool + Send + 'static,
    ) -> Self {
        let control = Arc::new(Control::default());
        let (context, namespace, name) = (
            target.context.as_str().into(),
            target.namespace.as_str().into(),
            target.name.as_str().into(),
        );
        let task = tokio::spawn(serve(
            target,
            secrets,
            (revision, parts),
            Served::new(discovery),
            Arc::clone(&control),
            send,
        ));
        Self {
            context,
            namespace,
            name,
            control,
            task,
        }
    }

    pub(crate) fn context(&self) -> &str {
        &self.context
    }

    pub(crate) fn namespace(&self) -> &str {
        &self.namespace
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    /// The page shown, none while it shows no page.
    pub(crate) fn shown(&self) -> Option<ShownPage> {
        self.control.shown.lock().expect("release lock").clone()
    }

    pub(crate) fn set_view(&self, revision: Option<u32>, parts: ReleaseParts) {
        self.control.pending.lock().expect("release lock").view = Some((revision, parts));
        self.control.wake.notify_one();
    }

    pub(crate) fn ack(&self, seq: u32) {
        self.control.pending.lock().expect("release lock").acked = Some(seq);
        self.control.wake.notify_one();
    }
}

impl Drop for Opened {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Runs the release; if it panics, its last batch changes nothing but the
/// state, which says why, and nothing starts it again.
async fn serve(
    target: Target,
    secrets: Subscription<Row>,
    view: (Option<u32>, ReleaseParts),
    served: Served,
    control: Arc<Control>,
    mut send: impl FnMut(ReleaseBatch) -> bool,
) {
    let (mut seq, mut exists, mut revision, mut latest, mut previous) =
        (0, false, None, None, None);
    let mut tell = |batch: ReleaseBatch| {
        (seq, exists, revision, latest, previous) = (
            batch.seq,
            batch.exists,
            batch.revision,
            batch.latest,
            batch.previous,
        );
        send(batch)
    };
    let ran = contain(
        ITEM,
        run(
            target,
            secrets,
            view,
            served,
            Arc::clone(&control),
            &mut tell,
        ),
    )
    .await;
    if ran.is_ok() {
        return;
    }
    *control
        .shown
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    send(ReleaseBatch {
        seq: seq + 1,
        status: ViewState::Error {
            error: IpcError::panicked("this release's editor"),
        },
        exists,
        revision,
        latest,
        previous,
        problem: None,
        overview: None,
        notes: None,
        description: None,
        values: None,
        manifest: None,
        history: None,
    });
}

/// What the space's discovery serves, as the overview reads it: nothing
/// until the follower is at hand and has answered, and nothing while it
/// names a cluster it has not asked yet or reaches none.
struct Served {
    opening: Option<Discovery>,
    followed: Option<Resources>,
    resources: Vec<Resource>,
}

impl Served {
    fn new(opening: Discovery) -> Self {
        Self {
            opening: Some(opening),
            followed: None,
            resources: Vec::new(),
        }
    }

    /// Waits until discovery answers otherwise than it last did.
    async fn changed(&mut self) {
        loop {
            if let Some(opening) = &mut self.opening {
                self.followed = Some(opening.await);
                self.opening = None;
            }
            let Some(followed) = &mut self.followed else {
                return std::future::pending().await;
            };
            let resources = match followed.next().await {
                Discovered::Ready { resources, .. } => resources,
                Discovered::Pending { .. } | Discovered::Failed { .. } => Vec::new(),
            };
            if resources != self.resources {
                self.resources = resources;
                return;
            }
        }
    }
}

/// A revision of the release, by the Secret that holds it.
struct Revision {
    row: Arc<Row>,
    stamp: Stamp,
}

/// The revision shown, decoded, or why it cannot be.
struct Shown {
    revision: u32,
    stamp: Option<Stamp>,
    page: Result<Arc<Page>, IpcError>,
}

/// What a fetch under way answers.
enum Answer {
    Page(u32, Stamp, Result<Arc<Page>, Failed>),
    Line(u32, Stamp, Result<RevisionLine, Failed>),
    Latest(Stamp, Result<Summary, Failed>),
}

/// What changed since the last batch, for the parts that show it.
#[derive(Default)]
struct Dirty {
    page: bool,
    values: bool,
    manifest: bool,
    history: bool,
}

#[expect(
    clippy::too_many_lines,
    reason = "one loop that holds the editor's state, as an open object's does"
)]
async fn run(
    target: Target,
    secrets: Subscription<Row>,
    (mut pinned, mut parts): (Option<u32>, ReleaseParts),
    mut served: Served,
    control: Arc<Control>,
    mut send: impl FnMut(ReleaseBatch) -> bool,
) {
    let mut interval = tokio::time::interval(FLUSH);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let permits = Arc::new(Semaphore::new(AT_ONCE));
    let mut fetching: FuturesUnordered<BoxFuture<'static, Answer>> = FuturesUnordered::new();
    let mut revisions: BTreeMap<u32, Revision> = BTreeMap::new();
    let mut placed: HashMap<RowKey, u32> = HashMap::new();
    let mut shown: Option<Shown> = None;
    let mut asked_page: Option<(u32, Stamp)> = None;
    let mut page_failed: Option<(u32, Failing)> = None;
    let mut lines: HashMap<u32, (Stamp, RevisionLine)> = HashMap::new();
    let mut asked_lines: HashMap<u32, Stamp> = HashMap::new();
    let mut lines_failed: HashMap<u32, Failing> = HashMap::new();
    let mut newest: Option<(Stamp, Decoded)> = None;
    let mut asked_newest: Option<Stamp> = None;
    let mut newest_failed: Option<Failing> = None;
    let mut dirty = Dirty {
        page: true,
        values: true,
        manifest: true,
        history: true,
    };
    let mut sent: Option<Sent> = None;
    let mut seq = 0;
    let mut unacked = None;
    loop {
        let ticked = tokio::select! {
            _ = interval.tick() => true,
            () = control.wake.notified() => false,
            () = served.changed() => {
                dirty.page = true;
                false
            }
            Some(answer) = fetching.next(), if !fetching.is_empty() => {
                match answer {
                    Answer::Page(revision, stamp, page) => {
                        if asked_page.as_ref() == Some(&(revision, stamp.clone())) {
                            asked_page = None;
                            match page {
                                Err(Failed::Request(error)) => {
                                    let last = page_failed
                                        .take()
                                        .filter(|(at, _)| *at == revision)
                                        .map(|(_, failing)| failing);
                                    page_failed =
                                        Some((revision, Failing::after(last, stamp, error)));
                                }
                                page => {
                                    page_failed = None;
                                    let page = page.map_err(Failed::error);
                                    shown = Some(Shown { revision, stamp: Some(stamp), page });
                                    dirty.page = true;
                                    dirty.values = true;
                                    dirty.manifest = true;
                                }
                            }
                        }
                    }
                    Answer::Line(revision, stamp, line) => {
                        if asked_lines.get(&revision) == Some(&stamp) {
                            asked_lines.remove(&revision);
                            let last = lines_failed.remove(&revision);
                            match line {
                                Err(Failed::Request(error)) => {
                                    lines_failed
                                        .insert(revision, Failing::after(last, stamp, error));
                                }
                                line => {
                                    let line = line.unwrap_or_else(|failed| {
                                        undecoded(revision, UNREADABLE, Some(failed.error()))
                                    });
                                    lines.insert(revision, (stamp, line));
                                }
                            }
                        }
                    }
                    Answer::Latest(stamp, decoded) => {
                        if asked_newest.as_ref() == Some(&stamp) {
                            asked_newest = None;
                            match decoded {
                                Err(Failed::Request(error)) => {
                                    newest_failed =
                                        Some(Failing::after(newest_failed.take(), stamp, error));
                                }
                                decoded => {
                                    newest_failed = None;
                                    let decoded = decoded.map_err(|failed| failed.error().code);
                                    newest = Some((stamp, decoded));
                                }
                            }
                        }
                    }
                }
                false
            }
        };
        let Pending { view, acked } =
            std::mem::take(&mut *control.pending.lock().expect("release lock"));
        if let Some((revision, asked)) = view {
            dirty.page |= asked.overview && !parts.overview;
            dirty.values |= asked.values && !parts.values;
            dirty.manifest |= asked.manifest && !parts.manifest;
            dirty.history |= asked.history && !parts.history;
            pinned = revision;
            parts = asked;
        }
        if acked.is_some() && acked == unacked {
            unacked = None;
        }
        if unacked.is_some() || !ticked {
            continue;
        }

        let status = secrets.state();
        let (upserted, removed, reset) = match secrets.drain() {
            Delta::Reset { rows, .. } => (rows, Vec::new(), true),
            Delta::Changed { upserted, removed } => (upserted, removed, false),
        };
        if reset {
            revisions.clear();
            placed.clear();
            for failing in page_failed
                .iter_mut()
                .map(|(_, failing)| failing)
                .chain(lines_failed.values_mut())
                .chain(newest_failed.iter_mut())
            {
                failing.relisted();
            }
        }
        for key in &removed {
            if let Some(revision) = placed.remove(key) {
                revisions.remove(&revision);
            }
        }
        for row in upserted {
            let key = RowKey::of(&row.meta);
            if let Some(revision) = placed.remove(&key) {
                revisions.remove(&revision);
            }
            if let Some(revision) = revision_of(&row, &target.name) {
                placed.insert(key, revision);
                let stamp = Stamp::of(&row.meta);
                revisions.insert(revision, Revision { row, stamp });
            }
        }

        // So that no Reveal reads a Secret that is gone while the next page
        // is fetched.
        if shown.as_ref().is_some_and(|shown| {
            shown.stamp.as_ref().is_some_and(|stamp| {
                revisions
                    .get(&shown.revision)
                    .is_none_or(|held| !stamp.same_secret(&held.stamp))
            })
        }) {
            shown = None;
        }
        let latest = revisions.keys().next_back().copied();
        let wanted = pinned.or(latest);
        let wanted_held = wanted.and_then(|revision| revisions.get(&revision));
        match wanted.map(|revision| (revision, wanted_held)) {
            Some((revision, Some(held))) => {
                if page_failed.as_ref().is_some_and(|(at, failing)| {
                    *at != revision || !failing.same_secret(&held.stamp)
                }) {
                    page_failed = None;
                }
                let current = shown.as_ref().is_some_and(|shown| {
                    shown.revision == revision && shown.stamp.as_ref() == Some(&held.stamp)
                });
                let asked = asked_page.as_ref() == Some(&(revision, held.stamp.clone()));
                let waits = page_failed
                    .as_ref()
                    .is_some_and(|(_, failing)| failing.waits(&held.stamp));
                if !current && !asked && !waits {
                    asked_page = Some((revision, held.stamp.clone()));
                    fetching.push(page_of(&target, &held.row, revision, held.stamp.clone()));
                }
            }
            Some((revision, None)) if latest.is_some() => {
                let said = shown
                    .as_ref()
                    .is_some_and(|shown| shown.revision == revision && shown.stamp.is_none());
                if !said {
                    shown = Some(Shown {
                        revision,
                        stamp: None,
                        page: Err(IpcError::new(
                            ErrorCode::HelmRevisionGone,
                            format!(
                                "Helm no longer keeps revision {revision} of {}",
                                target.name
                            ),
                        )),
                    });
                    asked_page = None;
                    page_failed = None;
                }
            }
            _ => {
                shown = None;
                asked_page = None;
                page_failed = None;
            }
        }
        // A failure of the request for the wanted revision's Secret as it
        // stands, which withdraws the page shown.
        let page_failing = page_failed
            .as_ref()
            .map(|(_, failing)| failing)
            .filter(|failing| wanted_held.is_some_and(|held| failing.was_for(&held.stamp)));
        // The page shown is an earlier version of the wanted revision's
        // Secret, whose rewrite is decoded again.
        let rewritten = shown
            .as_ref()
            .zip(wanted_held)
            .is_some_and(|(shown, held)| {
                Some(shown.revision) == wanted
                    && shown
                        .stamp
                        .as_ref()
                        .is_some_and(|stamp| *stamp != held.stamp)
            });
        let page = shown
            .as_ref()
            .filter(|_| page_failing.is_none())
            .and_then(|shown| shown.page.as_ref().ok().map(|page| (shown, page)));
        *control.shown.lock().expect("release lock") = page.map(|(shown, page)| ShownPage {
            revision: shown.revision,
            secret: shown.stamp.as_ref().and_then(Stamp::uid).map(Into::into),
            page: Arc::clone(page),
        });
        let page = page.map(|(_, page)| page);

        // The newest revision's summary, which the overview's header prints
        // as the list's row does: the page's where the editor shows that
        // revision, else decoded on its own.
        let newest_row =
            latest.and_then(|latest| revisions.get(&latest).map(|held| (latest, held)));
        if newest_failed.as_ref().is_some_and(|failing| {
            newest_row.is_none_or(|(_, held)| !failing.same_secret(&held.stamp))
        }) {
            newest_failed = None;
        }
        let known = match newest_row {
            None => Known::default(),
            Some((latest, held)) if wanted == Some(latest) => {
                let paged = shown.as_ref().and_then(|shown| {
                    let stamp = shown.stamp.as_ref()?;
                    let summary = shown.page.as_ref().map(|page| page.summary());
                    (shown.revision == latest).then(|| (stamp, summary.map_err(|error| error.code)))
                });
                Known::of(&held.stamp, paged, page_failing)
            }
            Some((_, held)) => {
                let decoded = newest
                    .as_ref()
                    .map(|(stamp, decoded)| (stamp, decoded.as_ref().map_err(|code| *code)));
                let read = decoded.is_some_and(|(stamp, _)| *stamp == held.stamp);
                let asked = asked_newest.as_ref() == Some(&held.stamp);
                let waits = newest_failed
                    .as_ref()
                    .is_some_and(|failing| failing.waits(&held.stamp));
                if !read && !asked && !waits && parts.overview {
                    asked_newest = Some(held.stamp.clone());
                    fetching.push(newest_of(&target, &held.row, held.stamp.clone()));
                }
                Known::of(&held.stamp, decoded, newest_failed.as_ref())
            }
        };

        if parts.history {
            lines.retain(|revision, (stamp, _)| {
                revisions
                    .get(revision)
                    .is_some_and(|held| stamp.same_secret(&held.stamp))
            });
            lines_failed.retain(|revision, failing| {
                revisions
                    .get(revision)
                    .is_some_and(|held| failing.same_secret(&held.stamp))
            });
            for (&revision, held) in &revisions {
                let read = lines
                    .get(&revision)
                    .is_some_and(|(stamp, _)| *stamp == held.stamp);
                let paged = asked_page.as_ref() == Some(&(revision, held.stamp.clone()));
                let waits = lines_failed
                    .get(&revision)
                    .is_some_and(|failing| failing.waits(&held.stamp));
                if read || paged || waits || asked_lines.get(&revision) == Some(&held.stamp) {
                    continue;
                }
                match &shown {
                    Some(Shown {
                        revision: at,
                        stamp: Some(stamp),
                        page: Ok(page),
                    }) if *at == revision && *stamp == held.stamp => {
                        let line = twigo_helm::line(page);
                        lines.insert(revision, (held.stamp.clone(), line));
                        lines_failed.remove(&revision);
                    }
                    _ => {
                        asked_lines.insert(revision, held.stamp.clone());
                        fetching.push(line_of(
                            &target,
                            &held.row,
                            revision,
                            held.stamp.clone(),
                            &permits,
                        ));
                    }
                }
            }
        } else {
            lines.clear();
            asked_lines.clear();
            lines_failed.clear();
        }

        let printed = newest_row
            .map(|(latest, held)| {
                printed(&cells(&target.name, Some(latest), &held.row.meta, &known).0)
            })
            .unwrap_or_default();
        let header_read = known.read();
        let deployed = revisions
            .iter()
            .rev()
            .find(|(_, held)| label(&held.row, "status") == Some("deployed"))
            .map(|(&revision, _)| revision);
        let history = parts.history.then(|| {
            revisions
                .iter()
                .rev()
                .map(|(&revision, held)| {
                    let failed = lines_failed
                        .get(&revision)
                        .filter(|failing| failing.was_for(&held.stamp))
                        .map(|failing| failing.error().clone());
                    match lines.get(&revision) {
                        Some((stamp, line)) if *stamp == held.stamp => line.clone(),
                        Some((_, line)) => RevisionLine {
                            status: label(&held.row, "status").unwrap_or_default().to_owned(),
                            problem: failed,
                            ..line.clone()
                        },
                        None => undecoded(
                            revision,
                            label(&held.row, "status").unwrap_or_default(),
                            failed,
                        ),
                    }
                })
                .collect::<Vec<_>>()
        });
        let revision = match &page_failed {
            Some((revision, _)) => Some(*revision),
            None => shown.as_ref().map(|shown| shown.revision),
        };
        let now = Sent {
            status,
            exists: !revisions.is_empty(),
            revision,
            latest,
            previous: revision
                .filter(|revision| revisions.contains_key(revision))
                .and_then(|revision| {
                    revisions
                        .range(..revision)
                        .next_back()
                        .map(|(&previous, _)| previous)
                }),
            problem: match page_failing {
                Some(failing) => Some(failing.error().clone()),
                None => shown
                    .as_ref()
                    .and_then(|shown| shown.page.as_ref().err().cloned()),
            },
            header: (printed, deployed),
            history,
        };
        let header_changed = sent.as_ref().is_none_or(|sent| sent.header != now.header);
        let overview_due = parts.overview
            && page.is_some()
            && !rewritten
            && header_read
            && (dirty.page || header_changed);
        let values_due = parts.values && page.is_some() && dirty.values;
        let manifest_due = parts.manifest && page.is_some() && dirty.manifest;
        let history_due = now.history.is_some()
            && (dirty.history || sent.as_ref().is_none_or(|sent| sent.history != now.history));
        let state_due = sent.as_ref().is_none_or(|sent| {
            (
                &sent.status,
                sent.exists,
                sent.revision,
                sent.latest,
                sent.previous,
                &sent.problem,
            ) != (
                &now.status,
                now.exists,
                now.revision,
                now.latest,
                now.previous,
                &now.problem,
            )
        });
        if !(state_due || overview_due || values_due || manifest_due || history_due) {
            continue;
        }
        seq += 1;
        let (overview, notes, description) = match page.filter(|_| overview_due) {
            Some(page) => {
                let release = twigo_helm::Release {
                    printed: &now.header.0,
                    deployed: now.header.1,
                    resources: &served.resources,
                };
                (
                    Some(twigo_helm::overview(page, &release)),
                    Some(page.notes()),
                    Some(page.description()),
                )
            }
            None => (None, None, None),
        };
        let batch = ReleaseBatch {
            seq,
            status: now.status.clone(),
            exists: now.exists,
            revision: now.revision,
            latest: now.latest,
            previous: now.previous,
            problem: now.problem.clone(),
            overview,
            notes,
            description,
            values: page.filter(|_| values_due).map(|page| page.values()),
            manifest: page
                .filter(|_| manifest_due)
                .map(|page| page.manifest().clone()),
            history: now.history.clone().filter(|_| history_due),
        };
        dirty.page &= !overview_due;
        dirty.values &= !parts.values;
        dirty.manifest &= !parts.manifest;
        dirty.history &= !parts.history;
        sent = Some(now);
        unacked = Some(seq);
        if !send(batch) {
            return;
        }
    }
}

/// What the last batch said, to tell what changed.
struct Sent {
    status: ViewState,
    exists: bool,
    revision: Option<u32>,
    latest: Option<u32>,
    previous: Option<u32>,
    problem: Option<IpcError>,
    /// The overview header's printed cells and the deployed revision.
    header: (Vec<twigo_ipc::Printed>, Option<u32>),
    history: Option<Vec<RevisionLine>>,
}

fn label<'a>(row: &'a Row, key: &str) -> Option<&'a str> {
    row.meta
        .labels
        .iter()
        .find(|(label, _)| &**label == key)
        .map(|(_, value)| &**value)
}

/// The revision a Secret of the namespace holds of release `name`.
fn revision_of(row: &Row, name: &str) -> Option<u32> {
    (label(row, "name")? == name)
        .then(|| label(row, "version")?.parse().ok())
        .flatten()
}

/// A history line of a revision not decoded: by its label's status before
/// it is decoded or while its request fails, and `unreadable`, as the list's
/// row says it, where its Secret as it stands cannot be read.
fn undecoded(revision: u32, status: &str, problem: Option<IpcError>) -> RevisionLine {
    RevisionLine {
        revision,
        status: status.to_owned(),
        updated: None,
        chart: None,
        app_version: None,
        description: None,
        rollback_of: None,
        problem,
    }
}

/// Decodes the revision in `row`'s Secret, through the context's clients.
fn decoded<T: Send + 'static>(
    target: &Target,
    row: &Row,
    decode: fn(&Stored<'_>) -> Result<T, IpcError>,
) -> impl Future<Output = Result<T, Failed>> + Send + 'static {
    let (hub, context, namespace) = (
        target.hub.clone(),
        target.context.clone(),
        target.namespace.clone(),
    );
    let secret = row.meta.name.clone();
    async move { fetch::decoded(&hub, &context, &namespace, &secret, decode).await }
}

fn page_of(target: &Target, row: &Row, revision: u32, stamp: Stamp) -> BoxFuture<'static, Answer> {
    let page = decoded(target, row, twigo_helm::page);
    Box::pin(async move { Answer::Page(revision, stamp, page.await.map(Arc::new)) })
}

fn newest_of(target: &Target, row: &Row, stamp: Stamp) -> BoxFuture<'static, Answer> {
    let summary = decoded(target, row, twigo_helm::summary);
    Box::pin(async move { Answer::Latest(stamp, summary.await) })
}

fn line_of(
    target: &Target,
    row: &Row,
    revision: u32,
    stamp: Stamp,
    permits: &Arc<Semaphore>,
) -> BoxFuture<'static, Answer> {
    let (line, permits) = (decoded(target, row, history_line), Arc::clone(permits));
    Box::pin(async move {
        let _permit = permits
            .acquire_owned()
            .await
            .expect("an editor's permits are never closed");
        Answer::Line(revision, stamp, line.await)
    })
}

/// A revision as History shows it, its description scrubbed of the values
/// of that revision's Secrets; its page goes once the line is made.
fn history_line(stored: &Stored<'_>) -> Result<RevisionLine, IpcError> {
    twigo_helm::page(stored).map(|page| twigo_helm::line(&page))
}

#[cfg(test)]
mod tests;
