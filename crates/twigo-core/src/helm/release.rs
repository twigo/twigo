//! An open release (ARCHITECTURE 3.6): its revisions are the rows of the
//! release Secrets of its namespace, the upstream the list reads, that
//! carry its `name` label, so opening it costs no watch beyond the list's.
//! The revision it shows, the latest unless one is pinned, is fetched with
//! one `GET` and decoded to its page once, held while it is shown and
//! dropped with the editor; History decodes each revision once per uid and
//! `resourceVersion` while it is shown, keeping only its line. Batches go
//! with flow control, as an open object's do (3.5).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use twigo_cache::batcher::FLUSH;
use twigo_cache::hub::{Delta, Hub, Subscription};
use twigo_cache::store::RowKey;
use twigo_cache::table::Row;
use twigo_helm::{Page, Stored};
use twigo_ipc::{
    ErrorCode, IpcError, ReleaseBatch, ReleaseParts, RevisionLine, Scrubbed, ViewState,
};
use twigo_panic::contain;

use super::fetch;
use super::releases::{Decoded, Stamp, cells, printed};

/// The seam of an open release, as `TWIGO_PANIC` names it.
pub(crate) const ITEM: &str = "helm release";

/// How many revisions History fetches at once, as the list does.
const AT_ONCE: usize = 4;

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
    /// The revision the editor shows and its page, which a Reveal reads.
    shown: Mutex<Option<(u32, Arc<Page>)>>,
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

    /// What it shows, read when asked, after it closes too.
    pub(crate) fn showing(&self) -> Showing {
        Showing(Arc::clone(&self.control))
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

/// An open release's shown revision.
#[derive(Clone)]
pub(crate) struct Showing(Arc<Control>);

impl Showing {
    /// The revision shown and its page, none while it shows no page.
    pub(crate) fn now(&self) -> Option<(u32, Arc<Page>)> {
        self.0.shown.lock().expect("release lock").clone()
    }
}

/// Runs the release; if it panics, its last batch changes nothing but the
/// state, which says why, and nothing starts it again.
async fn serve(
    target: Target,
    secrets: Subscription<Row>,
    view: (Option<u32>, ReleaseParts),
    control: Arc<Control>,
    mut send: impl FnMut(ReleaseBatch) -> bool,
) {
    let (mut seq, mut exists, mut revision, mut latest) = (0, false, None, None);
    let mut tell = |batch: ReleaseBatch| {
        (seq, exists, revision, latest) = (batch.seq, batch.exists, batch.revision, batch.latest);
        send(batch)
    };
    let ran = contain(
        ITEM,
        run(target, secrets, view, Arc::clone(&control), &mut tell),
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
        problem: None,
        overview: None,
        notes: None,
        description: None,
        values: None,
        manifest: None,
        history: None,
    });
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
    Page(u32, Stamp, Result<Arc<Page>, IpcError>),
    Line(u32, Stamp, Result<RevisionLine, IpcError>),
    Latest(Stamp, Decoded),
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
    let mut lines: HashMap<u32, (Stamp, RevisionLine)> = HashMap::new();
    let mut asked_lines: HashMap<u32, Stamp> = HashMap::new();
    let mut newest: Option<(Stamp, Decoded)> = None;
    let mut asked_newest: Option<Stamp> = None;
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
            Some(answer) = fetching.next(), if !fetching.is_empty() => {
                match answer {
                    Answer::Page(revision, stamp, page) => {
                        if asked_page.as_ref() == Some(&(revision, stamp.clone())) {
                            asked_page = None;
                            shown = Some(Shown { revision, stamp: Some(stamp), page });
                            dirty.page = true;
                            dirty.values = true;
                            dirty.manifest = true;
                        }
                    }
                    Answer::Line(revision, stamp, line) => {
                        if asked_lines.get(&revision) == Some(&stamp) {
                            asked_lines.remove(&revision);
                            let line = line
                                .unwrap_or_else(|error| unread(&revisions, revision, error));
                            lines.insert(revision, (stamp, line));
                        }
                    }
                    Answer::Latest(stamp, decoded) => {
                        if asked_newest.as_ref() == Some(&stamp) {
                            asked_newest = None;
                            newest = Some((stamp, decoded));
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
        match wanted.map(|revision| (revision, revisions.get(&revision))) {
            Some((revision, Some(held))) => {
                let current = shown.as_ref().is_some_and(|shown| {
                    shown.revision == revision && shown.stamp.as_ref() == Some(&held.stamp)
                });
                let asked = asked_page.as_ref() == Some(&(revision, held.stamp.clone()));
                if !current && !asked {
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
                }
            }
            _ => {
                shown = None;
                asked_page = None;
            }
        }
        *control.shown.lock().expect("release lock") = shown.as_ref().and_then(|shown| {
            shown
                .page
                .as_ref()
                .ok()
                .map(|page| (shown.revision, Arc::clone(page)))
        });

        // The newest revision's summary, which the overview's header prints
        // as the list's row does: the shown page's when it is that revision,
        // else decoded on its own.
        let newest_row =
            latest.and_then(|latest| revisions.get(&latest).map(|held| (latest, held)));
        let newest_decoded: Option<Decoded> = match (&newest_row, &shown) {
            (
                Some((latest, held)),
                Some(Shown {
                    revision,
                    stamp: Some(stamp),
                    page,
                }),
            ) if revision == latest && *stamp == held.stamp => Some(
                page.as_ref()
                    .map(|page| page.summary().clone())
                    .map_err(|error| error.code),
            ),
            (Some((latest, held)), _) => {
                let paged = asked_page.as_ref() == Some(&(*latest, held.stamp.clone()));
                let decoded = newest
                    .as_ref()
                    .filter(|(stamp, _)| *stamp == held.stamp)
                    .map(|(_, decoded)| decoded.clone());
                if decoded.is_none()
                    && parts.overview
                    && !paged
                    && asked_newest.as_ref() != Some(&held.stamp)
                {
                    asked_newest = Some(held.stamp.clone());
                    fetching.push(newest_of(&target, &held.row, held.stamp.clone()));
                }
                decoded
            }
            (None, _) => None,
        };

        if parts.history {
            lines.retain(|revision, (stamp, _)| {
                revisions
                    .get(revision)
                    .is_some_and(|held| held.stamp == *stamp)
            });
            for (&revision, held) in &revisions {
                let paged = asked_page.as_ref() == Some(&(revision, held.stamp.clone()));
                if paged
                    || lines.contains_key(&revision)
                    || asked_lines.get(&revision) == Some(&held.stamp)
                {
                    continue;
                }
                match &shown {
                    Some(Shown {
                        revision: at,
                        stamp: Some(stamp),
                        page: Ok(page),
                    }) if *at == revision && *stamp == held.stamp => {
                        let line = twigo_helm::line(page.summary(), Some(page.description()));
                        lines.insert(revision, (held.stamp.clone(), line));
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
        }

        let printed = newest_row
            .map(|(latest, held)| {
                printed(
                    &cells(
                        &target.name,
                        Some(latest),
                        &held.row.meta,
                        newest_decoded.as_ref(),
                    )
                    .0,
                )
            })
            .unwrap_or_default();
        let deployed = revisions
            .iter()
            .rev()
            .find(|(_, held)| label(&held.row, "status") == Some("deployed"))
            .map(|(&revision, _)| revision);
        let history = parts.history.then(|| {
            revisions
                .iter()
                .rev()
                .map(|(&revision, held)| match lines.get(&revision) {
                    Some((_, line)) => line.clone(),
                    None => labelled(revision, &held.row, None),
                })
                .collect::<Vec<_>>()
        });
        let now = Sent {
            status,
            exists: !revisions.is_empty(),
            revision: shown.as_ref().map(|shown| shown.revision),
            latest,
            problem: shown
                .as_ref()
                .and_then(|shown| shown.page.as_ref().err().cloned()),
            header: (printed, deployed),
            history,
        };
        let header_changed = sent.as_ref().is_none_or(|sent| sent.header != now.header);
        let page = shown.as_ref().and_then(|shown| shown.page.as_ref().ok());
        let overview_due = parts.overview && page.is_some() && (dirty.page || header_changed);
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
                &sent.problem,
            ) != (
                &now.status,
                now.exists,
                now.revision,
                now.latest,
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
            problem: now.problem.clone(),
            overview,
            notes,
            description,
            values: page.filter(|_| values_due).map(|page| page.values()),
            manifest: page.filter(|_| manifest_due).map(|page| page.manifest()),
            history: now.history.clone().filter(|_| history_due),
        };
        dirty.page &= !parts.overview;
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

/// A history line from a revision's labels, before it is decoded or where
/// it cannot be.
fn labelled(revision: u32, row: &Row, problem: Option<IpcError>) -> RevisionLine {
    RevisionLine {
        revision,
        status: label(row, "status").unwrap_or_default().to_owned(),
        updated: None,
        chart: None,
        app_version: None,
        description: None,
        rollback_of: None,
        problem,
    }
}

fn unread(revisions: &BTreeMap<u32, Revision>, revision: u32, error: IpcError) -> RevisionLine {
    match revisions.get(&revision) {
        Some(held) => labelled(revision, &held.row, Some(error)),
        None => RevisionLine {
            revision,
            status: String::new(),
            updated: None,
            chart: None,
            app_version: None,
            description: None,
            rollback_of: None,
            problem: Some(error),
        },
    }
}

/// Decodes the revision in `secret`, through the context's clients.
async fn decoded<T: Send + 'static>(
    target: (Hub, String, String),
    secret: Box<str>,
    decode: fn(&Stored<'_>) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    let (hub, context, namespace) = target;
    let clients = hub.clients(&context).await?;
    fetch::decoded(&clients, &namespace, &secret, decode).await
}

fn where_of(target: &Target) -> (Hub, String, String) {
    (
        target.hub.clone(),
        target.context.clone(),
        target.namespace.clone(),
    )
}

fn page_of(target: &Target, row: &Row, revision: u32, stamp: Stamp) -> BoxFuture<'static, Answer> {
    let (at, secret) = (where_of(target), row.meta.name.clone());
    Box::pin(async move {
        Answer::Page(
            revision,
            stamp,
            decoded(at, secret, twigo_helm::page).await.map(Arc::new),
        )
    })
}

fn newest_of(target: &Target, row: &Row, stamp: Stamp) -> BoxFuture<'static, Answer> {
    let (at, secret) = (where_of(target), row.meta.name.clone());
    Box::pin(async move {
        let summary = decoded(at, secret, twigo_helm::summary).await;
        Answer::Latest(stamp, summary.map_err(|error| error.code))
    })
}

fn line_of(
    target: &Target,
    row: &Row,
    revision: u32,
    stamp: Stamp,
    permits: &Arc<Semaphore>,
) -> BoxFuture<'static, Answer> {
    let (at, secret, permits) = (where_of(target), row.meta.name.clone(), Arc::clone(permits));
    Box::pin(async move {
        let _permit = permits
            .acquire_owned()
            .await
            .expect("an editor's permits are never closed");
        Answer::Line(revision, stamp, decoded(at, secret, history_line).await)
    })
}

/// A revision as History shows it, its description scrubbed of the values
/// of that revision's Secrets; its page goes once the line is made.
fn history_line(stored: &Stored<'_>) -> Result<RevisionLine, IpcError> {
    let page = twigo_helm::page(stored)?;
    let description: Scrubbed = page.description();
    Ok(twigo_helm::line(page.summary(), Some(description)))
}

#[cfg(test)]
mod tests;
