//! A logs tab's session (ARCHITECTURE 4.6): the target's pods through the
//! hub, a stream per chosen container up to the tab's ten, the buffer they
//! fill, and the batches of its view, sent as a list's are (3.5): one task
//! flushes on a 50 ms interval, or sooner when the window moves, and keeps
//! at most one batch unacknowledged. It sends nothing before the
//! webview's first window.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};
use twigo_cache::batcher::FLUSH;
use twigo_cache::hub::Hub;
use twigo_cache::object::Object;
use twigo_cache::table::{Cell, Column};
use twigo_ipc::{
    Histogram, IpcError, LogBatch, LogContainer, LogEntries, LogMatches, LogPod, LogSource,
    LogView, LogWindow, ObjectRef, OpenLogs, StreamState, ViewState,
};

use crate::logs::buffer::{Buffer, Kind, LIMITS, Origin};
use crate::logs::stream::{self, Event, Stream};
use crate::logs::target::{Followed, Target};
use crate::logs::view::{self, Spec};
use crate::logs::{now, plan};

/// The streams a tab follows at most, those stopped among them until their
/// tasks have ended, so one workload cannot take the cluster's 32 followed
/// logs.
const STREAMS: usize = 10;

/// How long a left pod's streams may take to finish their reads: the
/// kubelet ends a follow up to `logForceCheckPeriod`, a second, after the
/// container exits (cri-client v1.37.0, `waitLogs`), and its status
/// manager deletes a finished pod right after it patches its status
/// (kubernetes v1.37.0, `pkg/kubelet/status/status_manager.go`, `syncPod`).
const FINISHING: Duration = Duration::from_secs(5);

/// A running session: dropping it ends its task, its streams and its
/// subscriptions.
pub struct Session {
    control: Arc<Control>,
    task: JoinHandle<()>,
    name: String,
}

#[derive(Default)]
struct Control {
    pending: Mutex<Pending>,
    wake: Notify,
}

/// What the webview asked for since the task last looked.
#[derive(Default)]
struct Pending {
    source: Option<LogSource>,
    view: Option<Spec>,
    window: Option<LogWindow>,
    acked: Option<u32>,
    lines: Vec<(bool, oneshot::Sender<Vec<u8>>)>,
    /// The source and view changes asked for, each counted though only the
    /// last of each kind applies.
    changes: u32,
}

impl Session {
    /// Refuses a target of a kind without pods of its own, and a view
    /// whose filter, search or range does not parse; sends each batch
    /// through `send` until it says the webview is gone.
    pub async fn open(
        hub: Hub,
        context: String,
        request: OpenLogs,
        send: impl FnMut(LogBatch) -> bool + Send + 'static,
    ) -> Result<Self, IpcError> {
        let session = Run::new(hub, context, request).await?;
        let control = Arc::new(Control::default());
        let name = session.target.name.clone();
        let task = tokio::spawn(run(session, Arc::clone(&control), send));
        Ok(Self {
            control,
            task,
            name,
        })
    }

    /// The target's name, for the file its lines are saved to.
    pub fn name(&self) -> &str {
        &self.name
    }

    fn ask(&self, ask: impl FnOnce(&mut Pending)) {
        ask(&mut self.control.pending.lock().expect("session lock"));
        self.control.wake.notify_one();
    }

    /// Reopens the streams for what the source reads, into an empty buffer.
    pub fn set_source(&self, source: LogSource) {
        self.ask(|pending| {
            pending.source = Some(source);
            pending.changes += 1;
        });
    }

    /// Filters the buffer again; refuses a view that does not parse.
    pub fn set_view(&self, view: &LogView) -> Result<(), IpcError> {
        let spec = Spec::new(view)?;
        self.ask(|pending| {
            pending.view = Some(spec);
            pending.changes += 1;
        });
        Ok(())
    }

    pub fn set_window(&self, window: LogWindow) {
        self.ask(|pending| pending.window = Some(window));
    }

    pub fn ack(&self, seq: u32) {
        self.ask(|pending| pending.acked = Some(seq));
    }

    /// The lines as a file, those the view keeps or every one buffered.
    pub fn lines(&self, filtered: bool) -> oneshot::Receiver<Vec<u8>> {
        let (reply, lines) = oneshot::channel();
        self.ask(|pending| pending.lines.push((filtered, reply)));
        lines
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A pod's container, by the pod's uid, which a pod made again under its
/// name does not share.
type Key = (Arc<str>, Arc<str>);

/// A pod of the target, as last listed.
struct Pod {
    uid: Arc<str>,
    name: Arc<str>,
    generated: Option<u32>,
    created: Option<jiff::Timestamp>,
    version: Box<str>,
    status: String,
    json: Arc<Value>,
}

impl Pod {
    fn new(object: &Object, columns: Option<&[Column]>, json: Arc<Value>) -> Option<Self> {
        let printed = columns
            .and_then(|columns| columns.iter().position(|column| &*column.name == "Status"))
            .and_then(|at| match object.cells.get(at) {
                Some(Cell::Text(text)) => Some(text.to_string()),
                _ => None,
            });
        let status = printed
            .or_else(|| json["status"]["phase"].as_str().map(str::to_owned))
            .unwrap_or_default();
        Some(Self {
            uid: object.meta.uid.as_deref()?.into(),
            name: (&*object.meta.name).into(),
            generated: object.meta.generated,
            created: object.meta.created,
            version: object.meta.resource_version.clone(),
            status,
            json,
        })
    }
}

/// A stream under way.
struct Running {
    /// The id its events come under, its own in the session.
    id: u64,
    task: Task,
    /// Tells it its pod; dropped, it lets the stream end once its read
    /// does.
    pod: watch::Sender<Arc<Value>>,
    state: StreamState,
    origin: Arc<Origin>,
}

/// A stream stopped, as when its pod left: kept until its task has ended
/// and what it said is taken, which may come after.
struct Stopped {
    id: u64,
    task: Task,
    /// Its pod's uid.
    uid: Arc<str>,
    origin: Arc<Origin>,
    /// Until when the stream of a pod that left may finish its read.
    finishing: Option<Instant>,
}

/// A pod that left, whose `Left` entry waits until its streams have
/// ended, so it comes after the last of their entries.
struct Leaving {
    uid: Arc<str>,
    pod: Box<str>,
    /// When the session saw it leave.
    at: i64,
}

/// What a pod's streams wrote.
struct Written {
    /// When its first entry stands.
    first: i64,
    /// The time and id of its latest entry.
    last: (i64, u64),
}

/// A stream's task, ended when dropped.
struct Task(JoinHandle<()>);

impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What changed since the last batch.
#[derive(Default)]
struct Dirty {
    pods: bool,
    view: bool,
}

/// What the last batch said.
struct Sent {
    status: ViewState,
    pods: Vec<LogPod>,
    total: u32,
    window: LogEntries,
    matches: LogMatches,
    histogram: Histogram,
    dropped: u64,
    arrived: u64,
    changes: u32,
}

struct Run {
    hub: Hub,
    context: String,
    target: Target,
    followed: Followed,
    source: LogSource,
    spec: Spec,
    window: Option<LogWindow>,
    buffer: Buffer,
    /// By name.
    pods: Vec<Pod>,
    /// The target's pods were listed once, so those that come later join.
    listed: bool,
    streams: HashMap<Key, Running>,
    stopped: Vec<Stopped>,
    /// The streams of an old source, aborted, which keep their places until
    /// their tasks have ended; what they said goes.
    ending: Vec<Task>,
    /// Streams that read all there was, with their last state.
    finished: HashMap<Key, StreamState>,
    /// What each pod's streams wrote, by its uid: its `Joined` stands just
    /// before the first entry and its `Left` just after the latest while
    /// the buffer holds it, whatever the clocks of its node, the API server
    /// and the session say.
    written: HashMap<Arc<str>, Written>,
    /// The id and time of each `Joined` entry, by its pod's uid, until the
    /// pod left; the bound keeps it while the pod has written nothing.
    joined: HashMap<Arc<str>, (u64, i64)>,
    leaving: Vec<Leaving>,
    /// Counts the streams started, which gives each its id, so the events
    /// of a stream neither running nor stopped, as of an old source, go.
    started: u64,
    events: mpsc::UnboundedSender<(u64, Event)>,
    incoming: mpsc::UnboundedReceiver<(u64, Event)>,
    dirty: Dirty,
    sent: Option<Sent>,
    /// The entries the view kept as they came since the source or the view
    /// last changed.
    arrived: u64,
    changes: u32,
}

async fn run(mut session: Run, control: Arc<Control>, mut send: impl FnMut(LogBatch) -> bool) {
    let mut interval = tokio::time::interval(FLUSH);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut seq = 0;
    let mut unacked = None;
    let mut moved = false;
    loop {
        let ticked = tokio::select! {
            _ = interval.tick() => true,
            () = control.wake.notified() => false,
        };
        let Pending {
            source,
            view,
            window,
            acked,
            lines,
            changes,
        } = std::mem::take(&mut *control.pending.lock().expect("session lock"));
        if let Some(source) = source {
            session.set_source(source);
        }
        if let Some(spec) = view {
            session.set_view(spec);
        }
        session.changes += changes;
        if let Some(window) = window {
            session.window = Some(window);
            session.dirty.view = true;
            moved = true;
        }
        if acked.is_some() && acked == unacked {
            unacked = None;
        }
        // Lines go into the buffer on every tick, so a hidden window that
        // acknowledges nothing holds no more than the buffer's bound.
        if ticked {
            session.tick();
        }
        for (filtered, reply) in lines {
            let spec = filtered.then_some(&session.spec);
            // The caller may have gone, and the file with it.
            let _ = reply.send(view::lines(&session.buffer, spec));
        }
        if session.window.is_none() || unacked.is_some() || !(ticked || moved) {
            continue;
        }
        moved = false;
        if let Some(batch) = session.batch(seq + 1) {
            seq += 1;
            unacked = Some(seq);
            if !send(batch) {
                return;
            }
        }
    }
}

impl Run {
    async fn new(hub: Hub, context: String, request: OpenLogs) -> Result<Self, IpcError> {
        let target = Target::new(&request.target)?;
        let spec = Spec::new(&request.view)?;
        let followed = Followed::new(&hub, &context, &target).await?;
        let (events, incoming) = mpsc::unbounded_channel();
        Ok(Self {
            hub,
            context,
            target,
            followed,
            source: request.source,
            spec,
            window: None,
            buffer: Buffer::new(LIMITS),
            pods: Vec::new(),
            listed: false,
            streams: HashMap::new(),
            stopped: Vec::new(),
            ending: Vec::new(),
            finished: HashMap::new(),
            written: HashMap::new(),
            joined: HashMap::new(),
            leaving: Vec::new(),
            started: 0,
            events,
            incoming,
            dirty: Dirty::default(),
            sent: None,
            arrived: 0,
            changes: 0,
        })
    }

    fn set_source(&mut self, source: LogSource) {
        self.source = source;
        let old = self.streams.drain().map(|(_, running)| running.task);
        self.ending
            .extend(old.chain(self.stopped.drain(..).map(|stopped| stopped.task)));
        for task in &self.ending {
            task.0.abort();
        }
        self.finished.clear();
        self.written.clear();
        self.joined.clear();
        self.leaving.clear();
        self.buffer.clear();
        self.arrived = 0;
        self.dirty = Dirty {
            pods: true,
            view: true,
        };
        self.plan();
    }

    fn set_view(&mut self, spec: Spec) {
        self.buffer.judge(|kind| spec.judge(kind));
        self.spec = spec;
        self.arrived = 0;
        self.dirty.view = true;
    }

    /// Takes what the streams said before their pods may leave.
    fn tick(&mut self) {
        self.take_events();
        self.follow_pods();
        self.leave();
    }

    /// Whether the source reads the pod at all.
    fn reads(&self, pod: &str) -> bool {
        self.source
            .pods
            .as_ref()
            .is_none_or(|names| names.iter().any(|name| name == pod))
    }

    /// Reads the target's pods again when they changed: who joined and
    /// left, and what their streams are told of them.
    fn follow_pods(&mut self) {
        if !self.followed.drain() && self.listed {
            return;
        }
        let Some(objects) = self.followed.pods(&self.target) else {
            return;
        };
        let columns = self.followed.columns();
        let mut before: HashMap<Arc<str>, Pod> = std::mem::take(&mut self.pods)
            .into_iter()
            .map(|pod| (Arc::clone(&pod.uid), pod))
            .collect();
        let mut pods: Vec<Pod> = objects
            .iter()
            .filter_map(|object| {
                let kept = object
                    .meta
                    .uid
                    .as_deref()
                    .and_then(|uid| before.get(uid))
                    .filter(|pod| pod.version == object.meta.resource_version);
                let json = match kept {
                    Some(pod) => Arc::clone(&pod.json),
                    None => Arc::new(serde_json::from_str(object.json.get()).ok()?),
                };
                Pod::new(object, columns.as_deref(), json)
            })
            .collect();
        pods.sort_by(|a, b| a.name.cmp(&b.name));
        let mut joined = Vec::new();
        for pod in &pods {
            match before.remove(&pod.uid) {
                Some(_) => {}
                None if self.listed && self.reads(&pod.name) => {
                    let created = pod.created.unwrap_or_else(jiff::Timestamp::now);
                    joined.push((
                        Arc::clone(&pod.uid),
                        nanos(created),
                        Kind::Joined {
                            pod: (*pod.name).into(),
                            time: created.to_string().into(),
                            owner: controller(&pod.json).map(Box::new),
                        },
                    ));
                }
                None => {}
            }
        }
        // At its creation while the pod has no entry; its streams start
        // below, so its id is lower than any of their entries'.
        let (uids, marks): (Vec<_>, Vec<_>) = joined
            .into_iter()
            .map(|(uid, at, kind)| ((uid, at), (at, kind)))
            .unzip();
        let ids = self.add(marks);
        self.joined.extend(
            uids.into_iter()
                .zip(ids)
                .map(|((uid, at), id)| (uid, (id, at))),
        );
        self.bound();
        for gone in before.values() {
            if self.reads(&gone.name) {
                self.leaving.push(Leaving {
                    uid: Arc::clone(&gone.uid),
                    pod: (*gone.name).into(),
                    at: now(),
                });
            }
        }
        self.listed = true;
        let left: Vec<Key> = self
            .streams
            .keys()
            .filter(|(uid, _)| !pods.iter().any(|pod| pod.uid == *uid))
            .cloned()
            .collect();
        for key in &left {
            stop(&mut self.streams, &mut self.stopped, key, true);
        }
        self.finished
            .retain(|(uid, _), _| pods.iter().any(|pod| pod.uid == *uid));
        for ((uid, _), running) in &self.streams {
            if let Some(pod) = pods.iter().find(|pod| pod.uid == *uid)
                && !Arc::ptr_eq(&pod.json, &*running.pod.borrow())
            {
                running.pod.send_replace(Arc::clone(&pod.json));
            }
        }
        self.pods = pods;
        self.dirty.pods = true;
        self.plan();
    }

    /// Adds the `Left` entry of each pod that left once its streams have
    /// ended, so every entry of the pod came: just after the latest of them
    /// while the buffer holds it, else at the leave, though not before its
    /// `Joined`.
    fn leave(&mut self) {
        let (gone, waiting): (Vec<Leaving>, Vec<Leaving>) = std::mem::take(&mut self.leaving)
            .into_iter()
            .partition(|leaving| {
                !self
                    .stopped
                    .iter()
                    .any(|stopped| stopped.uid == leaving.uid)
            });
        self.leaving = waiting;
        let marks = gone
            .into_iter()
            .map(|leaving| {
                let joined = self.joined.remove(&leaving.uid);
                let at = match self.written.remove(&leaving.uid) {
                    Some(Written { last: (at, id), .. }) if self.buffer.holds(id, at) => at,
                    _ => joined.map_or(leaving.at, |(_, at)| at.max(leaving.at)),
                };
                (
                    at,
                    Kind::Left {
                        pod: leaving.pod,
                        time: view::rfc3339(leaving.at).into(),
                    },
                )
            })
            .collect();
        self.insert(marks);
    }

    /// Moves each `Joined` entry just before its pod's first entry, which
    /// may come long after the creation it stood at, or before it from a
    /// node whose clock runs behind the API server's: under its id, lower
    /// than those of its pod's entries, so it comes first at their time.
    fn place_joined(&mut self) {
        let (buffer, written) = (&mut self.buffer, &self.written);
        let mut moved = false;
        self.joined.retain(|uid, (id, at)| {
            let Some(&Written { first, .. }) = written.get(uid) else {
                return true;
            };
            if first == *at {
                return true;
            }
            moved = true;
            let kept = buffer.place(*id, *at, first);
            *at = first;
            kept
        });
        self.dirty.view |= moved;
    }

    /// Adds entries to the buffer, which holds them all until
    /// [`Run::bound`]; the ids they got, in the order they came.
    fn add(&mut self, entries: Vec<(i64, Kind)>) -> Range<u64> {
        let spec = &self.spec;
        let arrived = &mut self.arrived;
        let ids = self.buffer.insert(entries, |at, kind| {
            let judged = spec.judge(kind);
            *arrived += u64::from(spec.keeps(at, judged));
            judged
        });
        self.dirty.view |= !ids.is_empty();
        ids
    }

    /// Bounds the buffer, which keeps the `Joined` of each pod in view that
    /// has written nothing, at its creation, so that it moves to the pod's
    /// first entry once one comes.
    fn bound(&mut self) {
        let held: Vec<u64> = self
            .joined
            .iter()
            .filter(|(uid, _)| !self.written.contains_key(*uid))
            .map(|(_, &(id, _))| id)
            .collect();
        self.buffer.bound(&held);
    }

    fn insert(&mut self, entries: Vec<(i64, Kind)>) {
        self.add(entries);
        self.bound();
    }

    /// Starts a stream for each chosen container without one, those with
    /// an instance to read first, then the newest pods, while the tab has
    /// fewer than [`STREAMS`], the stopped streams whose tasks have not
    /// ended among them; stops those the source no longer chooses. Streams
    /// under way keep their places, but one with nothing to read gives its
    /// place up to one that can be read, as many of them as the places the
    /// stopped streams will free leave short.
    fn plan(&mut self) {
        let mut order: Vec<&Pod> = self
            .pods
            .iter()
            .filter(|pod| self.reads(&pod.name))
            .collect();
        order.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.name.cmp(&b.name)));
        let previous = self.source.previous;
        let mut wanted: Vec<(Key, &Pod, bool)> = order
            .into_iter()
            .flat_map(|pod| {
                plan::chosen(&pod.json, &self.source.containers)
                    .into_iter()
                    .map(move |container| {
                        let readable = stream::readable(&pod.json, &container, previous);
                        ((Arc::clone(&pod.uid), container.into()), pod, readable)
                    })
            })
            .filter(|(key, ..)| !self.finished.contains_key(key))
            .collect();
        wanted.sort_by_key(|(.., readable)| !readable);
        let unwanted: Vec<Key> = self
            .streams
            .keys()
            .filter(|key| !wanted.iter().any(|(wanted, ..)| wanted == *key))
            .cloned()
            .collect();
        for key in &unwanted {
            stop(&mut self.streams, &mut self.stopped, key, false);
        }
        let lacking = wanted
            .iter()
            .filter(|(key, _, readable)| *readable && !self.streams.contains_key(key))
            .count();
        let mut yielding = lacking.saturating_sub(STREAMS.saturating_sub(self.streams.len()));
        for (key, _, readable) in wanted.iter().rev() {
            if yielding == 0 {
                break;
            }
            if !readable && stop(&mut self.streams, &mut self.stopped, key, false) {
                yielding -= 1;
            }
        }
        let mut started = Vec::new();
        let mut held = self.streams.len() + self.stopping();
        for (key, pod, _) in wanted {
            if held >= STREAMS {
                break;
            }
            if self.streams.contains_key(&key) {
                continue;
            }
            started.push((key, Arc::clone(&pod.name), Arc::clone(&pod.json)));
            held += 1;
        }
        for (key, pod, json) in started {
            self.start(key, &pod, json);
        }
    }

    /// The stopped streams whose tasks have not ended: an abort only
    /// schedules a task's end, so each keeps its place until then.
    fn stopping(&self) -> usize {
        let stopped = self.stopped.iter().map(|stopped| &stopped.task);
        stopped
            .chain(&self.ending)
            .filter(|task| !task.0.is_finished())
            .count()
    }

    fn start(&mut self, key: Key, pod: &str, json: Arc<Value>) {
        let (told, followed) = watch::channel(json);
        let stream = Stream::new(
            self.hub.clone(),
            &self.context,
            &self.target.namespace,
            pod,
            &key.1,
            &self.source,
        );
        let events = self.events.clone();
        self.started += 1;
        let id = self.started;
        let task = tokio::spawn(stream::run(stream, followed, move |event| {
            // The session may have ended, and its streams with it.
            let _ = events.send((id, event));
        }));
        let origin = Arc::new(Origin {
            pod: pod.into(),
            container: (*key.1).into(),
        });
        self.streams.insert(
            key,
            Running {
                id,
                task: Task(task),
                pod: told,
                state: StreamState::Connecting,
                origin,
            },
        );
        self.dirty.pods = true;
    }

    /// Takes what the streams said: their lines and ends into the buffer,
    /// their states, and the places of those that finished for the next.
    fn take_events(&mut self) {
        let mut entries = Vec::new();
        let mut whose = Vec::new();
        let mut restarts = Vec::new();
        let mut freed = false;
        let now = Instant::now();
        for stopped in &self.stopped {
            if stopped.finishing.is_some_and(|until| until <= now) {
                stopped.task.0.abort();
            }
        }
        // A stopped stream whose task has ended has said all it will, and
        // frees its place, as one that ends by itself does.
        let ended: Vec<u64> = self
            .stopped
            .iter()
            .filter(|stopped| stopped.task.0.is_finished())
            .map(|stopped| stopped.id)
            .collect();
        let ending = self.ending.len();
        self.ending.retain(|task| !task.0.is_finished());
        freed |= !ended.is_empty() || self.ending.len() < ending;
        while let Ok((id, event)) = self.incoming.try_recv() {
            let key = self
                .streams
                .iter()
                .find_map(|(key, running)| (running.id == id).then(|| key.clone()));
            let (uid, origin) = match &key {
                Some(key) => (&key.0, &self.streams[key].origin),
                None => match self.stopped.iter().find(|stopped| stopped.id == id) {
                    Some(stopped) => (&stopped.uid, &stopped.origin),
                    None => continue,
                },
            };
            let origin = Arc::clone(origin);
            if let Event::Line { at, .. } | Event::Ended { at, .. } = &event {
                whose.push((Arc::clone(uid), *at));
            }
            match event {
                Event::Line {
                    at,
                    level,
                    text,
                    styles,
                } => entries.push((
                    at,
                    Kind::Line {
                        origin,
                        level,
                        text: text.into(),
                        styles: styles.into(),
                    },
                )),
                Event::Ended {
                    at,
                    time,
                    exit_code,
                    reason,
                    restarting,
                } => entries.push((
                    at,
                    Kind::Ended {
                        origin,
                        time: time.into(),
                        exit_code,
                        reason: reason.map(Into::into),
                        restarting: restarting.map(Into::into),
                    },
                )),
                Event::Restarts { restarting } => restarts.push((origin, restarting)),
                Event::State(state) => {
                    if let Some(running) = key.and_then(|key| self.streams.get_mut(&key))
                        && running.state != state
                    {
                        running.state = state;
                        self.dirty.pods = true;
                    }
                }
                Event::Finished => {
                    if let Some(key) = key
                        && let Some(running) = self.streams.remove(&key)
                    {
                        self.finished.insert(key, running.state.clone());
                        self.dirty.pods = true;
                        freed = true;
                    }
                }
            }
        }
        self.stopped.retain(|stopped| !ended.contains(&stopped.id));
        let ids = self.add(entries);
        for (id, (uid, at)) in ids.zip(whose) {
            self.written
                .entry(uid)
                .and_modify(|written| {
                    written.first = written.first.min(at);
                    written.last = written.last.max((at, id));
                })
                .or_insert(Written {
                    first: at,
                    last: (at, id),
                });
        }
        self.place_joined();
        self.bound();
        for (origin, restarting) in restarts {
            self.dirty.view |= self.buffer.restarts(&origin, restarting.into());
        }
        if freed {
            self.plan();
        }
    }

    fn log_pods(&self) -> Vec<LogPod> {
        self.pods
            .iter()
            .map(|pod| {
                let chosen = if self.reads(&pod.name) {
                    plan::chosen(&pod.json, &self.source.containers)
                } else {
                    Vec::new()
                };
                let containers = plan::containers(&pod.json)
                    .into_iter()
                    .map(|name| {
                        let key: Key = (Arc::clone(&pod.uid), name.as_str().into());
                        let stream = if !chosen.contains(&name) {
                            StreamState::Off
                        } else if let Some(running) = self.streams.get(&key) {
                            running.state.clone()
                        } else if let Some(state) = self.finished.get(&key) {
                            state.clone()
                        } else {
                            StreamState::OverLimit
                        };
                        LogContainer { name, stream }
                    })
                    .collect();
                LogPod {
                    name: pod.name.to_string(),
                    generated: pod.generated,
                    tone: twigo_describe::status_tone(&pod.status),
                    status: pod.status.clone(),
                    containers,
                }
            })
            .collect()
    }

    /// The batch of what changed since the last, every part in the first;
    /// None when nothing did.
    fn batch(&mut self, seq: u32) -> Option<LogBatch> {
        let window = self.window?;
        let status = self.followed.state(&self.target);
        let dropped = self.buffer.dropped_ever();
        let arrived = self.arrived;
        let changes = self.changes;
        let pods = (self.dirty.pods || self.sent.is_none()).then(|| self.log_pods());
        let shown = (self.dirty.view || self.sent.is_none()).then(|| {
            (
                view::total(&self.buffer, &self.spec),
                view::window(&self.buffer, &self.spec, window),
                view::matches(&self.buffer, &self.spec),
                view::histogram(&self.buffer),
            )
        });
        self.dirty = Dirty::default();
        let Some(sent) = &mut self.sent else {
            let pods = pods.expect("made for the first batch");
            let (total, window, matches, histogram) = shown.expect("made for the first batch");
            self.sent = Some(Sent {
                status: status.clone(),
                pods: pods.clone(),
                total,
                window: window.clone(),
                matches: matches.clone(),
                histogram: histogram.clone(),
                dropped,
                arrived,
                changes,
            });
            return Some(LogBatch {
                seq,
                status,
                pods: Some(pods),
                total,
                window: Some(window),
                matches: Some(matches),
                histogram: Some(histogram),
                dropped,
                arrived,
                changes,
            });
        };
        let pods = pods.filter(|pods| *pods != sent.pods);
        let (total, window, matches, histogram) = match shown {
            Some((total, window, matches, histogram)) => (
                total,
                Some(window).filter(|window| *window != sent.window),
                Some(matches).filter(|matches| *matches != sent.matches),
                Some(histogram).filter(|histogram| *histogram != sent.histogram),
            ),
            None => (sent.total, None, None, None),
        };
        let unchanged = status == sent.status
            && pods.is_none()
            && total == sent.total
            && window.is_none()
            && matches.is_none()
            && histogram.is_none()
            && dropped == sent.dropped
            && arrived == sent.arrived
            && changes == sent.changes;
        if unchanged {
            return None;
        }
        sent.status = status.clone();
        sent.total = total;
        sent.dropped = dropped;
        sent.arrived = arrived;
        sent.changes = changes;
        if let Some(pods) = &pods {
            sent.pods = pods.clone();
        }
        if let Some(window) = &window {
            sent.window = window.clone();
        }
        if let Some(matches) = &matches {
            sent.matches = matches.clone();
        }
        if let Some(histogram) = &histogram {
            sent.histogram = histogram.clone();
        }
        Some(LogBatch {
            seq,
            status,
            pods,
            total,
            window,
            matches,
            histogram,
            dropped,
            arrived,
            changes,
        })
    }
}

/// Stops a stream, which may yet have said things not taken: at once, or,
/// when its pod left, once its read ends, within [`FINISHING`].
fn stop(
    streams: &mut HashMap<Key, Running>,
    stopped: &mut Vec<Stopped>,
    key: &Key,
    left: bool,
) -> bool {
    let Some(Running {
        id, task, origin, ..
    }) = streams.remove(key)
    else {
        return false;
    };
    if !left {
        task.0.abort();
    }
    stopped.push(Stopped {
        id,
        task,
        uid: Arc::clone(&key.0),
        origin,
        finishing: left.then(|| Instant::now() + FINISHING),
    });
    true
}

/// What controls the pod, by its controller owner reference.
fn controller(pod: &Value) -> Option<ObjectRef> {
    let owner = pod["metadata"]["ownerReferences"]
        .as_array()?
        .iter()
        .find(|owner| owner["controller"] == true)?;
    let (group, version) = twigo_describe::group_version(owner);
    Some(ObjectRef {
        group: group.to_owned(),
        version: version.to_owned(),
        kind: owner["kind"].as_str()?.to_owned(),
        namespace: pod["metadata"]["namespace"].as_str().map(str::to_owned),
        name: owner["name"].as_str()?.to_owned(),
    })
}

fn nanos(time: jiff::Timestamp) -> i64 {
    i64::try_from(time.as_nanosecond()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use twigo_ipc::{Containers, Gvr, LevelFilter, LogTarget, Since};

    use twigo_ipc::LogEntry;

    use super::*;
    use crate::logs::buffer::{Limits, Origin};
    use crate::logs::fake::{Fake, NAMESPACE};

    const SECOND: i64 = 1_000_000_000;
    /// 2026-11-03T10:00:00Z.
    const T0: i64 = 1_793_700_000 * SECOND;

    fn request(name: &str) -> OpenLogs {
        OpenLogs {
            target: LogTarget {
                space: "kind-test".to_owned(),
                gvr: Gvr {
                    group: String::new(),
                    version: "v1".to_owned(),
                    resource: "pods".to_owned(),
                },
                namespace: NAMESPACE.to_owned(),
                name: name.to_owned(),
            },
            source: LogSource {
                containers: Containers::Default,
                pods: None,
                since: Since::Start,
                previous: false,
            },
            view: view(None),
        }
    }

    fn view(filter: Option<&str>) -> LogView {
        LogView {
            level: LevelFilter::All,
            filter: filter.map(str::to_owned),
            search: None,
            range: None,
        }
    }

    /// Ticks until `done` holds.
    async fn until(run: &mut Run, what: &str, done: impl Fn(&Run) -> bool) {
        let reached = async {
            loop {
                run.tick();
                if done(run) {
                    return;
                }
                tokio::time::sleep(FLUSH).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(600), reached)
            .await
            .unwrap_or_else(|_| panic!("{what} within ten minutes"));
    }

    fn texts(run: &Run) -> Vec<String> {
        run.buffer
            .entries()
            .iter()
            .map(|entry| match &entry.kind {
                Kind::Line { text, .. } => text.to_string(),
                Kind::Ended { origin, .. } => format!("{} ended", origin.container),
                Kind::Joined { pod, .. } => format!("{pod} joined"),
                Kind::Left { pod, .. } => format!("{pod} left"),
            })
            .collect()
    }

    /// `web-1` with its container `web` running `web-a`, or deleted with
    /// it killed.
    fn web(deleted: bool) -> serde_json::Value {
        let state = if deleted {
            serde_json::json!({ "terminated": { "containerID": "web-a", "exitCode": 137, "reason": "Error", "finishedAt": "2026-11-03T10:00:05Z" } })
        } else {
            serde_json::json!({ "running": { "startedAt": "2026-11-03T10:00:00Z" } })
        };
        let mut pod = serde_json::json!({
            "metadata": { "name": "web-1", "uid": "uid-web-1", "creationTimestamp": "2026-11-03T10:00:00Z" },
            "spec": { "containers": [{ "name": "web" }] },
            "status": { "phase": "Running", "containerStatuses": [
                { "name": "web", "containerID": "web-a", "state": state, "lastState": {} },
            ] },
        });
        if deleted {
            pod["metadata"]["deletionTimestamp"] = serde_json::json!("2026-11-03T10:00:04Z");
        }
        pod
    }

    /// A session over the fake whose pod `web-1` wrote three lines, and
    /// its batches, none acknowledged.
    async fn opened(fake: &Fake) -> (Session, mpsc::UnboundedReceiver<LogBatch>) {
        fake.pod(web(false));
        fake.serve("web-1", "web", Some("web-a"), None);
        for n in 1..=3 {
            fake.write(
                "web-1",
                "web",
                "web-a",
                T0 + n * SECOND,
                &format!("line {n}"),
            );
        }
        let (hub, _) = fake.hub();
        let (sent, batches) = mpsc::unbounded_channel();
        let session = Session::open(
            hub,
            "kind-test".to_owned(),
            request("web-1"),
            move |batch| sent.send(batch).is_ok(),
        )
        .await
        .unwrap();
        session.set_window(LogWindow::Tail { count: 100 });
        (session, batches)
    }

    fn lines(batch: &LogBatch) -> Vec<&str> {
        batch
            .window
            .iter()
            .flat_map(|window| &window.entries)
            .filter_map(|entry| match entry {
                LogEntry::Line { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn at_most_one_batch_goes_unacknowledged() {
        let fake = Fake::default();
        let (session, mut batches) = opened(&fake).await;
        let first = batches.recv().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        assert!(batches.try_recv().is_err(), "a second batch before the ack");

        session.ack(first.seq);
        let second = batches.recv().await.unwrap();
        assert_eq!(second.seq, first.seq + 1);
        assert_eq!(lines(&second), ["line 1", "line 2", "line 3"]);
        fake.write("web-1", "web", "web-a", T0 + 4 * SECOND, "line 4");
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        assert!(batches.try_recv().is_err(), "a third batch before the ack");
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_change_waiting_on_an_ack_goes_out_with_it() {
        let fake = Fake::default();
        let (session, mut batches) = opened(&fake).await;
        let first = batches.recv().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        session.set_window(LogWindow::Range { start: 0, end: 1 });
        tokio::time::sleep(std::time::Duration::from_secs(10) + FLUSH / 2).await;
        assert!(batches.try_recv().is_err(), "a batch before the ack");

        let acked = tokio::time::Instant::now();
        session.ack(first.seq);
        let second = batches.recv().await.unwrap();
        assert_eq!(tokio::time::Instant::now(), acked, "it waited for a tick");
        assert_eq!(lines(&second), ["line 1"]);
    }

    async fn settled(
        session: &Session,
        batches: &mut mpsc::UnboundedReceiver<LogBatch>,
    ) -> LogBatch {
        let mut last = None;
        while let Ok(Some(batch)) =
            tokio::time::timeout(std::time::Duration::from_secs(1), batches.recv()).await
        {
            session.ack(batch.seq);
            last = Some(batch);
        }
        last.expect("a batch")
    }

    async fn next(batches: &mut mpsc::UnboundedReceiver<LogBatch>) -> LogBatch {
        tokio::time::timeout(std::time::Duration::from_secs(10), batches.recv())
            .await
            .expect("a batch within ten seconds")
            .unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn a_batch_counts_every_source_and_view_change_applied() {
        let fake = Fake::default();
        let (session, mut batches) = opened(&fake).await;
        assert_eq!(settled(&session, &mut batches).await.changes, 0);

        session.set_source(request("web-1").source);
        session.set_view(&view(None)).unwrap();
        let changed = next(&mut batches).await;
        assert_eq!(changed.changes, 2);
        session.ack(changed.seq);
        let refilled = settled(&session, &mut batches).await;
        assert_eq!((refilled.changes, refilled.arrived), (2, 3));

        session.set_view(&view(None)).unwrap();
        let viewed = next(&mut batches).await;
        assert_eq!((viewed.changes, viewed.arrived), (3, 0));
        session.ack(viewed.seq);
        session.set_view(&view(None)).unwrap();
        let again = next(&mut batches).await;
        assert_eq!((again.changes, again.arrived, again.window), (4, 0, None));
    }

    #[tokio::test(start_paused = true)]
    async fn a_deleted_pods_last_entries_arrive() {
        let fake = Fake::default();
        fake.pod(web(false));
        fake.serve("web-1", "web", Some("web-a"), None);
        fake.write("web-1", "web", "web-a", T0 + SECOND, "up");
        let (hub, _) = fake.hub();
        let mut run = Run::new(hub, "kind-test".to_owned(), request("web-1"))
            .await
            .unwrap();
        until(&mut run, "its line", |run| texts(run) == ["up"]).await;

        fake.stop("web-1", "web", "web-a");
        fake.pod(web(true));
        until(&mut run, "the pod deleted", |run| {
            run.pods
                .first()
                .is_some_and(|pod| pod.json["metadata"]["deletionTimestamp"].is_string())
        })
        .await;
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        fake.delete("web-1");
        let gone = async {
            while !run
                .followed
                .pods(&run.target)
                .is_some_and(|pods| pods.is_empty())
            {
                tokio::time::sleep(FLUSH).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(600), gone)
            .await
            .unwrap();
        run.tick();
        assert_eq!(texts(&run), ["up", "web ended", "web-1 left"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stopped_streams_late_entries_arrive_until_its_task_ended() {
        let fake = Fake::default();
        fake.pod(web(false));
        fake.serve("web-1", "web", Some("web-a"), None);
        fake.write("web-1", "web", "web-a", T0 + SECOND, "up");
        let (hub, _) = fake.hub();
        let mut run = Run::new(hub, "kind-test".to_owned(), request("web-1"))
            .await
            .unwrap();
        until(&mut run, "its line", |run| texts(run) == ["up"]).await;
        let id = run.streams.values().next().unwrap().id;
        fake.delete("web-1");
        until(&mut run, "the pod gone", |run| run.streams.is_empty()).await;

        let late = |text: &str| Event::Line {
            at: T0 + 2 * SECOND,
            level: None,
            text: text.to_owned(),
            styles: Vec::new(),
        };
        run.events.send((id, late("late"))).unwrap();
        run.tick();
        fake.stop("web-1", "web", "web-a");
        let read = tokio::time::Instant::now();
        until(&mut run, "its task ended", |run| run.stopped.is_empty()).await;
        assert!(read.elapsed() < FINISHING, "{:?}", read.elapsed());
        run.events.send((id, late("after its end"))).unwrap();
        run.tick();
        assert_eq!(texts(&run), ["up", "late", "web-1 left"]);
    }

    fn deleted(run: &Run) -> bool {
        run.pods
            .first()
            .is_some_and(|pod| pod.json["metadata"]["deletionTimestamp"].is_string())
    }

    #[tokio::test(start_paused = true)]
    async fn a_pods_end_arrives_when_the_pod_leaves_before_its_follow_ends() {
        let fake = Fake::default();
        fake.pod(web(false));
        fake.serve("web-1", "web", Some("web-a"), None);
        fake.write("web-1", "web", "web-a", T0 + SECOND, "up");
        let (hub, _) = fake.hub();
        let mut run = Run::new(hub, "kind-test".to_owned(), request("web-1"))
            .await
            .unwrap();
        until(&mut run, "its line", |run| texts(run) == ["up"]).await;

        fake.pod(web(true));
        until(&mut run, "the pod deleted", deleted).await;
        fake.delete("web-1");
        until(&mut run, "the pod gone", |run| run.pods.is_empty()).await;
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        fake.stop("web-1", "web", "web-a");
        until(&mut run, "its stream ended", |run| run.stopped.is_empty()).await;
        assert_eq!(texts(&run), ["up", "web ended", "web-1 left"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_left_pods_stream_that_reads_on_ends_within_a_few_seconds() {
        let fake = Fake::default();
        fake.pod(web(false));
        fake.serve("web-1", "web", Some("web-a"), None);
        fake.write("web-1", "web", "web-a", T0 + SECOND, "up");
        let (hub, _) = fake.hub();
        let mut run = Run::new(hub, "kind-test".to_owned(), request("web-1"))
            .await
            .unwrap();
        until(&mut run, "its line", |run| texts(run) == ["up"]).await;

        fake.delete("web-1");
        until(&mut run, "the pod gone", |run| run.pods.is_empty()).await;
        let left = tokio::time::Instant::now();
        until(&mut run, "its stream ended", |run| run.stopped.is_empty()).await;
        let lasted = left.elapsed();
        assert!(
            (FINISHING..FINISHING + std::time::Duration::from_secs(1)).contains(&lasted),
            "{lasted:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_left_pods_entry_comes_after_the_lines_its_streams_read_on() {
        let fake = Fake::default();
        fake.pod(web(false));
        fake.serve("web-1", "web", Some("web-a"), None);
        fake.write("web-1", "web", "web-a", T0 + SECOND, "up");
        let (hub, _) = fake.hub();
        let mut run = Run::new(hub, "kind-test".to_owned(), request("web-1"))
            .await
            .unwrap();
        until(&mut run, "its line", |run| texts(run) == ["up"]).await;

        fake.delete("web-1");
        until(&mut run, "the pod gone", |run| run.pods.is_empty()).await;
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        fake.write("web-1", "web", "web-a", now(), "after it left");
        until(&mut run, "its stream ended", |run| run.stopped.is_empty()).await;
        assert_eq!(texts(&run), ["up", "after it left", "web-1 left"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_left_pods_entry_comes_after_its_lines_from_a_clock_ahead_of_the_sessions() {
        let fake = Fake::default();
        fake.pod(web(false));
        fake.serve("web-1", "web", Some("web-a"), None);
        fake.write("web-1", "web", "web-a", now() + 10 * SECOND, "ahead");
        let (hub, _) = fake.hub();
        let mut run = Run::new(hub, "kind-test".to_owned(), request("web-1"))
            .await
            .unwrap();
        until(&mut run, "its line", |run| texts(run) == ["ahead"]).await;

        fake.stop("web-1", "web", "web-a");
        fake.delete("web-1");
        until(&mut run, "the pod gone", |run| run.pods.is_empty()).await;
        until(&mut run, "its stream ended", |run| run.stopped.is_empty()).await;
        assert_eq!(texts(&run), ["ahead", "web-1 left"]);
    }

    fn web_1(uid: &str, instance: &str, created: &str) -> serde_json::Value {
        serde_json::json!({
            "metadata": { "name": "web-1", "uid": uid, "creationTimestamp": created },
            "spec": { "containers": [{ "name": "web" }] },
            "status": { "phase": "Running", "containerStatuses": [
                { "name": "web", "containerID": instance, "state": { "running": { "startedAt": created } }, "lastState": {} },
            ] },
        })
    }

    async fn followed_web_a(fake: &Fake) -> Run {
        followed_web_a_in(fake, Buffer::new(LIMITS)).await
    }

    async fn followed_web_a_in(fake: &Fake, buffer: Buffer) -> Run {
        fake.pod(web_1("uid-a", "web-a", "2026-11-03T10:00:00Z"));
        fake.serve("web-1", "web", Some("web-a"), None);
        fake.write("web-1", "web", "web-a", now() - SECOND, "old up");
        let (hub, _) = fake.hub();
        let mut run = Run::new(hub, "kind-test".to_owned(), request("web-1"))
            .await
            .unwrap();
        run.buffer = buffer;
        until(&mut run, "its line", |run| texts(run) == ["old up"]).await;
        run
    }

    fn made_again(fake: &Fake, created: i64) {
        let created = jiff::Timestamp::from_nanosecond(i128::from(created)).unwrap();
        fake.pod(web_1("uid-b", "web-b", &created.to_string()));
        fake.serve("web-1", "web", Some("web-b"), None);
    }

    async fn new_up(fake: &Fake, run: &mut Run) {
        fake.write("web-1", "web", "web-b", now(), "new up");
        until(run, "the new pod's line", |run| {
            texts(run).iter().any(|text| text == "new up")
        })
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_made_again_under_its_name_joins_after_the_old_one_left() {
        let fake = Fake::default();
        let mut run = followed_web_a(&fake).await;
        let created = now().div_euclid(SECOND) * SECOND;
        fake.stop("web-1", "web", "web-a");
        fake.delete("web-1");
        until(&mut run, "the old pod left", |run| {
            run.pods.is_empty() && run.leaving.is_empty()
        })
        .await;
        made_again(&fake, created);
        new_up(&fake, &mut run).await;
        assert_eq!(
            texts(&run),
            ["old up", "web-1 left", "web-1 joined", "new up"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_made_again_while_the_old_ones_streams_finish_joins_after_it_left() {
        let fake = Fake::default();
        let mut run = followed_web_a(&fake).await;
        let created = now().div_euclid(SECOND) * SECOND;
        fake.delete("web-1");
        made_again(&fake, created);
        until(&mut run, "the pod made again", |run| {
            run.pods.first().is_some_and(|pod| &*pod.uid == "uid-b")
        })
        .await;
        fake.write("web-1", "web", "web-a", now(), "old after");
        fake.stop("web-1", "web", "web-a");
        until(&mut run, "the old pod left", |run| run.leaving.is_empty()).await;
        new_up(&fake, &mut run).await;
        assert_eq!(
            texts(&run),
            [
                "old up",
                "old after",
                "web-1 left",
                "web-1 joined",
                "new up"
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_made_again_seen_late_joins_before_its_first_line() {
        let fake = Fake::default();
        let mut run = followed_web_a(&fake).await;
        fake.stop("web-1", "web", "web-a");
        tokio::time::sleep(FLUSH).await;
        fake.delete("web-1");
        let created = now().div_euclid(SECOND) * SECOND;
        made_again(&fake, created);
        fake.write("web-1", "web", "web-b", now(), "new early");
        until(&mut run, "the old pod left and the new one wrote", |run| {
            run.leaving.is_empty() && texts(run).iter().any(|text| text == "new early")
        })
        .await;
        assert_eq!(
            texts(&run),
            ["old up", "web-1 left", "web-1 joined", "new early"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_made_again_while_the_old_one_still_writes_bounds_each_ones_lines() {
        let fake = Fake::default();
        let mut run = followed_web_a(&fake).await;
        let created = now().div_euclid(SECOND) * SECOND;
        fake.delete("web-1");
        made_again(&fake, created);
        until(&mut run, "the pod made again", |run| {
            run.pods.first().is_some_and(|pod| &*pod.uid == "uid-b")
        })
        .await;
        fake.write("web-1", "web", "web-b", now(), "new early");
        until(&mut run, "the new pod's first line", |run| {
            texts(run).iter().any(|text| text == "new early")
        })
        .await;
        fake.write("web-1", "web", "web-a", now(), "old after");
        fake.stop("web-1", "web", "web-a");
        until(&mut run, "the old pod left", |run| run.leaving.is_empty()).await;
        new_up(&fake, &mut run).await;
        assert_eq!(
            texts(&run),
            [
                "old up",
                "web-1 joined",
                "new early",
                "old after",
                "web-1 left",
                "new up"
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_made_again_that_leaves_first_joins_before_its_own_left() {
        let fake = Fake::default();
        let mut run = followed_web_a(&fake).await;
        let created = now().div_euclid(SECOND) * SECOND;
        fake.delete("web-1");
        made_again(&fake, created);
        until(&mut run, "the pod made again", |run| {
            run.pods.first().is_some_and(|pod| &*pod.uid == "uid-b")
        })
        .await;
        new_up(&fake, &mut run).await;
        fake.stop("web-1", "web", "web-b");
        fake.delete("web-1");
        until(&mut run, "the new pod left", |run| {
            run.pods.is_empty() && !run.leaving.iter().any(|leaving| &*leaving.uid == "uid-b")
        })
        .await;
        fake.stop("web-1", "web", "web-a");
        until(&mut run, "the old pod left", |run| run.leaving.is_empty()).await;
        assert_eq!(
            texts(&run),
            [
                "old up",
                "web-1 left",
                "web-1 joined",
                "new up",
                "web-1 left"
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_pods_joined_entry_comes_before_its_lines_from_a_clock_behind_the_api_servers() {
        let fake = Fake::default();
        let mut run = followed_web_a(&fake).await;
        fake.stop("web-1", "web", "web-a");
        fake.delete("web-1");
        until(&mut run, "the old pod left", |run| {
            run.pods.is_empty() && run.leaving.is_empty()
        })
        .await;
        made_again(&fake, (now().div_euclid(SECOND) + 10) * SECOND);
        new_up(&fake, &mut run).await;
        assert_eq!(
            texts(&run),
            ["old up", "web-1 left", "web-1 joined", "new up"]
        );
    }

    fn small() -> Buffer {
        Buffer::new(Limits {
            entries: 3,
            bytes: 1 << 20,
        })
    }

    fn other(text: &str) -> (i64, Kind) {
        (
            now(),
            Kind::Line {
                origin: Arc::new(Origin {
                    pod: "web-2".into(),
                    container: "web".into(),
                }),
                level: None,
                text: text.into(),
                styles: Box::new([]),
            },
        )
    }

    #[tokio::test(start_paused = true)]
    async fn a_left_pods_entry_stands_at_the_leave_once_the_bound_dropped_its_lines() {
        let fake = Fake::default();
        let mut run = followed_web_a_in(&fake, small()).await;
        run.insert(vec![other("other 1"), other("other 2"), other("other 3")]);
        assert_eq!(run.buffer.dropped_ever(), 1);

        fake.stop("web-1", "web", "web-a");
        fake.delete("web-1");
        until(&mut run, "the pod left", |run| {
            run.pods.is_empty() && run.leaving.is_empty()
        })
        .await;
        assert_eq!(texts(&run), ["other 2", "other 3", "web-1 left"]);
    }

    async fn made_again_after_it_left(fake: &Fake, created: i64) -> Run {
        let mut run = followed_web_a(fake).await;
        fake.stop("web-1", "web", "web-a");
        fake.delete("web-1");
        until(&mut run, "the old pod left", |run| {
            run.pods.is_empty() && run.leaving.is_empty()
        })
        .await;
        run.buffer = small();
        made_again(fake, created);
        until(&mut run, "the pod made again", |run| {
            run.pods.first().is_some_and(|pod| &*pod.uid == "uid-b")
        })
        .await;
        run
    }

    #[tokio::test(start_paused = true)]
    async fn a_pods_joined_entry_moves_to_its_first_line_that_comes_as_the_bound_reaches_it() {
        let fake = Fake::default();
        let mut run = made_again_after_it_left(&fake, now().div_euclid(SECOND) * SECOND).await;
        run.insert(vec![other("other 1"), other("other 2")]);
        assert_eq!(texts(&run), ["web-1 joined", "other 1", "other 2"]);
        new_up(&fake, &mut run).await;
        assert_eq!(texts(&run), ["other 2", "web-1 joined", "new up"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_pods_joined_entry_stays_through_the_bound_until_its_first_line() {
        let fake = Fake::default();
        let mut run = made_again_after_it_left(&fake, now().div_euclid(SECOND) * SECOND).await;
        run.insert(vec![other("other 1"), other("other 2"), other("other 3")]);
        assert_eq!(texts(&run), ["web-1 joined", "other 2", "other 3"]);
        new_up(&fake, &mut run).await;
        assert_eq!(texts(&run), ["other 3", "web-1 joined", "new up"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_that_joins_long_after_its_creation_keeps_its_joined_through_the_bound() {
        let fake = Fake::default();
        let mut run = followed_web_a_in(&fake, small()).await;
        fake.stop("web-1", "web", "web-a");
        fake.delete("web-1");
        until(&mut run, "the old pod left", |run| {
            run.pods.is_empty() && run.leaving.is_empty()
        })
        .await;
        run.insert(vec![other("other 1"), other("other 2"), other("other 3")]);
        made_again(&fake, now() - 3600 * SECOND);
        until(&mut run, "the pod made again", |run| {
            run.pods.first().is_some_and(|pod| &*pod.uid == "uid-b")
        })
        .await;
        assert_eq!(texts(&run), ["web-1 joined", "other 2", "other 3"]);
        new_up(&fake, &mut run).await;
        assert_eq!(texts(&run), ["other 3", "web-1 joined", "new up"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_made_again_while_the_old_ones_streams_finish_keeps_its_joined_through_the_bound()
    {
        let fake = Fake::default();
        let mut run = followed_web_a_in(&fake, small()).await;
        fake.delete("web-1");
        made_again(&fake, now().div_euclid(SECOND) * SECOND);
        until(&mut run, "the pod made again", |run| {
            run.pods.first().is_some_and(|pod| &*pod.uid == "uid-b")
        })
        .await;
        for n in 1..=3 {
            fake.write("web-1", "web", "web-a", now(), &format!("old after {n}"));
        }
        fake.stop("web-1", "web", "web-a");
        until(&mut run, "the old pod left", |run| run.leaving.is_empty()).await;
        new_up(&fake, &mut run).await;
        assert_eq!(texts(&run), ["web-1 left", "web-1 joined", "new up"]);
    }

    fn containers(uid: &str, instance: &str) -> serde_json::Value {
        let names: Vec<String> = (0..STREAMS).map(|n| format!("c{n}")).collect();
        serde_json::json!({
            "metadata": { "name": "web-1", "uid": uid, "creationTimestamp": "2026-11-03T10:00:00Z" },
            "spec": { "containers": names.iter().map(|name| serde_json::json!({ "name": name })).collect::<Vec<_>>() },
            "status": { "phase": "Running", "containerStatuses": names.iter().map(|name| serde_json::json!({
                "name": name,
                "containerID": format!("{name}-{instance}"),
                "state": { "running": { "startedAt": "2026-11-03T10:00:00Z" } },
            })).collect::<Vec<_>>() },
        })
    }

    fn each(instance: &str, mut act: impl FnMut(&str, &str)) {
        for n in 0..STREAMS {
            let container = format!("c{n}");
            act(&container, &format!("{container}-{instance}"));
        }
    }

    fn served(fake: &Fake, instance: &str, text: &str) {
        each(instance, |container, id| {
            fake.serve("web-1", container, Some(id), None);
            fake.write("web-1", container, id, now(), &format!("{id} {text}"));
        });
    }

    fn states(run: &Run) -> Vec<StreamState> {
        run.log_pods()
            .iter()
            .flat_map(|pod| {
                pod.containers
                    .iter()
                    .map(|container| container.stream.clone())
            })
            .collect()
    }

    fn alive(run: &Run) -> usize {
        run.streams.len() + run.stopping()
    }

    /// The most follows open at once, and the most streams whose tasks had
    /// not ended after a tick, while web-1's ten containers are followed,
    /// the pod is made again under its name with new instances, and `after`
    /// lets the old streams end, until the new ones' lines came.
    async fn replaced(fake: &Fake, after: impl FnOnce()) -> (usize, usize) {
        fake.pod(containers("uid-a", "a"));
        served(fake, "a", "up");
        let (hub, _) = fake.hub();
        let mut request = request("web-1");
        request.source.containers = Containers::All;
        let mut run = Run::new(hub, "kind-test".to_owned(), request)
            .await
            .unwrap();
        until(&mut run, "the first pod's lines", |run| {
            texts(run).len() == STREAMS
        })
        .await;
        assert_eq!(fake.follows(), STREAMS);

        fake.delete("web-1");
        fake.pod(containers("uid-b", "b"));
        served(fake, "b", "up");
        until(&mut run, "the pod made again", |run| {
            run.pods.first().is_some_and(|pod| &*pod.uid == "uid-b")
        })
        .await;
        let most = std::cell::Cell::new(0);
        let count = |_: &Run| {
            most.set(most.get().max(fake.follows()));
            most.get() > STREAMS
        };
        let more = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            until(&mut run, "more than ten follows", count),
        )
        .await;
        assert!(more.is_err(), "{} follows", most.get());
        assert_eq!(states(&run), vec![StreamState::OverLimit; STREAMS]);
        each("b", |container, id| {
            fake.write("web-1", container, id, now(), &format!("{id} waited"));
        });

        after();
        let tasks = std::cell::Cell::new(alive(&run));
        until(&mut run, "the new pod's lines", |run| {
            most.set(most.get().max(fake.follows()));
            tasks.set(tasks.get().max(alive(run)));
            texts(run)
                .iter()
                .filter(|text| text.starts_with('c') && text.contains("-b "))
                .count()
                == 2 * STREAMS
        })
        .await;
        assert_eq!(fake.follows(), STREAMS);
        (most.get(), tasks.get())
    }

    #[tokio::test(start_paused = true)]
    async fn a_left_pods_finishing_streams_keep_their_places_until_they_end() {
        let fake = Fake::default();
        let (follows, tasks) = replaced(&fake, || {
            each("a", |container, id| fake.stop("web-1", container, id));
        })
        .await;
        assert!(follows <= STREAMS, "{follows} follows");
        assert!(tasks <= STREAMS, "{tasks} tasks");
    }

    #[tokio::test(start_paused = true)]
    async fn a_source_change_keeps_the_old_streams_places_until_their_tasks_ended() {
        let fake = Fake::default();
        fake.pod(containers("uid-a", "a"));
        served(&fake, "a", "up");
        let (hub, _) = fake.hub();
        let mut request = request("web-1");
        request.source.containers = Containers::All;
        let source = request.source.clone();
        let mut run = Run::new(hub, "kind-test".to_owned(), request)
            .await
            .unwrap();
        until(&mut run, "the lines", |run| texts(run).len() == STREAMS).await;
        let metrics = tokio::runtime::Handle::current().metrics();
        let before = metrics.num_alive_tasks();

        run.set_source(source);
        let most = std::cell::Cell::new(metrics.num_alive_tasks());
        until(&mut run, "the lines read again", |run| {
            most.set(most.get().max(metrics.num_alive_tasks()));
            texts(run).len() == STREAMS
        })
        .await;
        assert!(
            most.get() <= before,
            "{} tasks, {before} before",
            most.get()
        );
        assert_eq!(fake.follows(), STREAMS);
    }

    #[tokio::test(start_paused = true)]
    async fn a_left_pods_streams_that_read_on_give_their_places_up_at_the_bound() {
        let fake = Fake::default();
        let (follows, tasks) = replaced(&fake, || {}).await;
        assert!(follows <= STREAMS, "{follows} follows");
        assert!(tasks <= STREAMS, "{tasks} tasks");
    }

    /// A session's state over a hub that never connects.
    async fn unconnected(name: &str) -> Run {
        let connect: twigo_cache::hub::Connect = Arc::new(|_| Box::pin(std::future::pending()));
        Run::new(Hub::new(connect), "kind-test".to_owned(), request(name))
            .await
            .unwrap()
    }

    fn line(at: i64, text: &str) -> (i64, Kind) {
        let origin = Arc::new(Origin {
            pod: "web-1".into(),
            container: "web".into(),
        });
        (
            at * SECOND,
            Kind::Line {
                origin,
                level: None,
                text: text.into(),
                styles: Box::new([]),
            },
        )
    }

    /// A pod created `minute` minutes after 10:00 whose container `web`
    /// runs, or waits to start.
    fn pod(name: &str, minute: i64, runs: bool) -> Pod {
        let status = if runs {
            serde_json::json!({ "name": "web", "containerID": format!("{name}-a"), "state": { "running": {} } })
        } else {
            serde_json::json!({ "name": "web", "state": { "waiting": { "reason": "ContainerCreating" } } })
        };
        let json = serde_json::json!({
            "spec": { "containers": [{ "name": "web" }] },
            "status": { "containerStatuses": [status] },
        });
        Pod {
            uid: name.into(),
            name: name.into(),
            generated: None,
            created: Some(jiff::Timestamp::from_second(1_793_700_000 + minute * 60).unwrap()),
            version: "1".into(),
            status: "Running".to_owned(),
            json: Arc::new(json),
        }
    }

    fn followed(run: &Run) -> Vec<String> {
        let mut names: Vec<String> = run.streams.keys().map(|(uid, _)| uid.to_string()).collect();
        names.sort();
        names
    }

    #[tokio::test(start_paused = true)]
    async fn containers_that_wait_to_start_give_their_places_to_those_that_can_be_read() {
        let mut run = unconnected("web").await;
        run.pods = (0..10)
            .map(|at| pod(&format!("new-{at}"), 10 + at, false))
            .chain([pod("old", 0, true)])
            .collect();
        run.plan();
        assert_eq!(run.streams.len(), STREAMS);
        assert!(
            followed(&run).contains(&"old".to_owned()),
            "{:?}",
            followed(&run)
        );
        assert!(!followed(&run).contains(&"new-0".to_owned()));

        run.pods.push(pod("older", 0, true));
        run.plan();
        assert_eq!(alive(&run), STREAMS);
        assert!(!followed(&run).contains(&"older".to_owned()));
        run.plan();
        assert_eq!(run.streams.len(), STREAMS - 1);
        until(&mut run, "the older pod followed", |run| {
            followed(run).contains(&"older".to_owned())
        })
        .await;
        assert_eq!(run.streams.len(), STREAMS);
        let names = followed(&run);
        assert!(
            names.contains(&"old".to_owned()) && names.contains(&"older".to_owned()),
            "{names:?}"
        );
        assert!(!names.contains(&"new-1".to_owned()), "{names:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn arrived_grows_past_the_bound_and_starts_again_with_the_view_or_source() {
        let mut run = unconnected("web-1").await;
        run.buffer = Buffer::new(Limits {
            entries: 3,
            bytes: 1 << 20,
        });
        run.window = Some(LogWindow::Tail { count: 100 });
        run.insert((1..=5).map(|at| line(at, "GET /")).collect());
        let first = run.batch(1).unwrap();
        assert_eq!((first.total, first.arrived, first.dropped), (4, 5, 2));
        run.insert(vec![line(6, "GET /"), line(7, "boom")]);
        let second = run.batch(2).unwrap();
        assert_eq!((second.total, second.arrived), (4, 7));

        run.set_view(Spec::new(&view(Some("boom"))).unwrap());
        run.insert(vec![line(8, "GET /"), line(9, "boom")]);
        assert_eq!(run.batch(3).unwrap().arrived, 1);

        run.set_source(request("web-1").source);
        run.insert(vec![line(10, "boom")]);
        assert_eq!(run.batch(4).unwrap().arrived, 1);
    }
}
