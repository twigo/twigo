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

use super::fetch::{self, AT_ONCE, Failed};
use super::reads::{Reads, Stamp};
use super::releases::{Decoded, Known, UNREADABLE, cells, printed};

/// The seam of an open release, as `TWIGO_PANIC` names it.
pub(crate) const ITEM: &str = "helm release";

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
    let mut landed: Vec<Answer> = Vec::new();
    let mut revisions: BTreeMap<u32, Revision> = BTreeMap::new();
    let mut placed: HashMap<RowKey, u32> = HashMap::new();
    let mut pages: Reads<(), Shown> = Reads::default();
    // The wanted revision Helm no longer keeps, said until a page lands.
    let mut gone: Option<(u32, IpcError)> = None;
    let mut lines: Reads<u32, RevisionLine> = Reads::default();
    let mut newest: Reads<(), Decoded> = Reads::default();
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
                landed.push(answer);
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
            pages.relisted();
            lines.relisted();
            newest.relisted();
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

        let latest = revisions.keys().next_back().copied();
        let wanted = pinned.or(latest);
        let wanted_held = wanted.and_then(|revision| revisions.get(&revision));
        pages.retain(|()| wanted_held.is_some());
        match wanted.map(|revision| (revision, wanted_held)) {
            Some((revision, Some(held))) => {
                if pages.ask((), &held.stamp) {
                    fetching.push(page_of(&target, &held.row, revision, held.stamp.clone()));
                }
            }
            Some((revision, None)) if latest.is_some() => {
                if gone.as_ref().is_none_or(|(at, _)| *at != revision) {
                    let error = IpcError::new(
                        ErrorCode::HelmRevisionGone,
                        format!(
                            "Helm no longer keeps revision {revision} of {}",
                            target.name
                        ),
                    );
                    gone = Some((revision, error));
                }
            }
            _ => gone = None,
        }
        let newest_row =
            latest.and_then(|latest| revisions.get(&latest).map(|held| (latest, held)));
        newest.retain(|()| newest_row.is_some());
        if let Some((latest, held)) = newest_row
            && wanted != Some(latest)
            && parts.overview
            && newest.ask((), &held.stamp)
        {
            fetching.push(newest_of(&target, &held.row, held.stamp.clone()));
        }
        // Taken after this tick's asks, so that one for a revision no longer
        // wanted is not.
        for answer in landed.drain(..) {
            match answer {
                Answer::Page(revision, stamp, page) => {
                    let kept = !matches!(page, Err(Failed::Request(_)));
                    if pages.answered((), stamp, page, |page| Shown { revision, page }) && kept {
                        gone = None;
                        dirty.page = true;
                        dirty.values = true;
                        dirty.manifest = true;
                    }
                }
                Answer::Line(revision, stamp, line) => {
                    lines.answered(revision, stamp, line, |line| {
                        line.unwrap_or_else(|error| undecoded(revision, UNREADABLE, Some(error)))
                    });
                }
                Answer::Latest(stamp, decoded) => {
                    newest.answered((), stamp, decoded, |decoded| {
                        decoded.map_err(|error| error.code)
                    });
                }
            }
        }
        // A failure of the request for the wanted revision's Secret as it
        // stands, which withdraws the page shown.
        let page_failing = wanted_held.and_then(|held| pages.failure(&(), &held.stamp));
        // So that no Reveal reads a Secret that is gone while the next page
        // is fetched.
        let shown = pages.get(&()).filter(|(stamp, _)| {
            revisions
                .values()
                .any(|held| stamp.same_secret(&held.stamp))
        });
        // The page shown is an earlier version of the wanted revision's
        // Secret, whose rewrite is decoded again.
        let rewritten = shown
            .zip(wanted_held)
            .is_some_and(|((stamp, shown), held)| {
                Some(shown.revision) == wanted && *stamp != held.stamp
            });
        let page = shown
            .filter(|_| page_failing.is_none())
            .and_then(|(stamp, shown)| shown.page.as_ref().ok().map(|page| (stamp, shown, page)));
        *control.shown.lock().expect("release lock") = page.map(|(stamp, shown, page)| ShownPage {
            revision: shown.revision,
            secret: stamp.uid().map(Into::into),
            page: Arc::clone(page),
        });
        let page = page.map(|(_, _, page)| page);

        // The newest revision's summary, which the overview's header prints
        // as the list's row does: the page's where the editor shows that
        // revision, else decoded on its own.
        let known = match newest_row {
            None => Known::default(),
            Some((latest, held)) if wanted == Some(latest) => {
                let paged =
                    shown
                        .filter(|(_, shown)| shown.revision == latest)
                        .map(|(stamp, shown)| {
                            let summary = shown.page.as_ref().map(|page| page.summary());
                            (stamp, summary.map_err(|error| error.code))
                        });
                Known::of(&held.stamp, paged, page_failing)
            }
            Some((_, held)) => {
                let decoded = newest
                    .get(&())
                    .map(|(stamp, decoded)| (stamp, decoded.as_ref().map_err(|code| *code)));
                Known::of(&held.stamp, decoded, newest.failure(&(), &held.stamp))
            }
        };

        if parts.history {
            lines.retain(|revision| revisions.contains_key(revision));
            for (&revision, held) in &revisions {
                if pages.asking(&(), &held.stamp) || !lines.wants(&revision, &held.stamp) {
                    continue;
                }
                match shown {
                    Some((stamp, Shown { page: Ok(page), .. })) if *stamp == held.stamp => {
                        lines.keep(revision, held.stamp.clone(), twigo_helm::line(page));
                    }
                    _ => {
                        lines.ask(revision, &held.stamp);
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
            .find(|(_, held)| held.row.meta.label("status") == Some("deployed"))
            .map(|(&revision, _)| revision);
        let history = parts.history.then(|| {
            revisions
                .iter()
                .rev()
                .map(|(&revision, held)| {
                    let failed = lines.failure(&revision, &held.stamp).cloned();
                    match lines.get(&revision) {
                        Some((stamp, line)) if *stamp == held.stamp => line.clone(),
                        Some((stamp, line)) if stamp.same_secret(&held.stamp) => RevisionLine {
                            status: held.row.meta.label("status").unwrap_or_default().to_owned(),
                            problem: failed,
                            ..line.clone()
                        },
                        _ => undecoded(
                            revision,
                            held.row.meta.label("status").unwrap_or_default(),
                            failed,
                        ),
                    }
                })
                .collect::<Vec<_>>()
        });
        let revision = match (page_failing, &gone) {
            (Some(_), _) => wanted,
            (None, Some((revision, _))) => Some(*revision),
            (None, None) => shown.map(|(_, shown)| shown.revision),
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
            problem: match (page_failing, &gone) {
                (Some(error), _) | (None, Some((_, error))) => Some(error.clone()),
                (None, None) => shown.and_then(|(_, shown)| shown.page.as_ref().err().cloned()),
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

/// The revision a Secret of the namespace holds of release `name`.
fn revision_of(row: &Row, name: &str) -> Option<u32> {
    (row.meta.label("name")? == name)
        .then(|| row.meta.label("version")?.parse().ok())
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
