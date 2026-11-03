//! A logs tab's session (ARCHITECTURE 4.6): the target's pods through the
//! hub, a stream per chosen container up to the tab's ten, the buffer they
//! fill, and the batches of its view, sent as a list's are (3.5): one task
//! flushes on a 50 ms interval, or sooner when the window moves, and keeps
//! at most one batch unacknowledged. It sends nothing before the
//! webview's first window.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
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

/// The streams a tab follows at most, so one workload cannot take the
/// cluster's 32 followed logs.
const STREAMS: usize = 10;

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
        self.ask(|pending| pending.source = Some(source));
    }

    /// Filters the buffer again; refuses a view that does not parse.
    pub fn set_view(&self, view: &LogView) -> Result<(), IpcError> {
        let spec = Spec::new(view)?;
        self.ask(|pending| pending.view = Some(spec));
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

/// A stream under way: dropping it ends its task.
struct Running {
    task: JoinHandle<()>,
    pod: watch::Sender<Arc<Value>>,
    state: StreamState,
    origin: Arc<Origin>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.task.abort();
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
    /// Streams that read all there was, with their last state.
    finished: HashMap<Key, StreamState>,
    /// Counts the sources, so what a stream of an old one still says goes.
    generation: u64,
    events: mpsc::UnboundedSender<(u64, Key, Event)>,
    incoming: mpsc::UnboundedReceiver<(u64, Key, Event)>,
    dirty: Dirty,
    sent: Option<Sent>,
    /// The entries the view kept as they came since the source or the view
    /// last changed.
    arrived: u64,
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
        } = std::mem::take(&mut *control.pending.lock().expect("session lock"));
        if let Some(source) = source {
            session.set_source(source);
        }
        if let Some(spec) = view {
            session.set_view(spec);
        }
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
            session.follow_pods();
            session.take_events();
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
            finished: HashMap::new(),
            generation: 0,
            events,
            incoming,
            dirty: Dirty::default(),
            sent: None,
            arrived: 0,
        })
    }

    fn set_source(&mut self, source: LogSource) {
        self.source = source;
        self.generation += 1;
        self.streams.clear();
        self.finished.clear();
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
        let mut marks = Vec::new();
        for pod in &pods {
            match before.remove(&pod.uid) {
                Some(_) => {}
                None if self.listed && self.reads(&pod.name) => {
                    let created = pod.created.unwrap_or_else(jiff::Timestamp::now);
                    marks.push((
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
        for gone in before.values() {
            if self.reads(&gone.name) {
                let at = now();
                marks.push((
                    at,
                    Kind::Left {
                        pod: (*gone.name).into(),
                        time: view::rfc3339(at).into(),
                    },
                ));
            }
        }
        self.listed = true;
        self.streams
            .retain(|(uid, _), _| pods.iter().any(|pod| pod.uid == *uid));
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
        self.insert(marks);
        self.dirty.pods = true;
        self.plan();
    }

    fn insert(&mut self, entries: Vec<(i64, Kind)>) {
        if entries.is_empty() {
            return;
        }
        let spec = &self.spec;
        let arrived = &mut self.arrived;
        self.buffer.insert(entries, |at, kind| {
            let judged = spec.judge(kind);
            *arrived += u64::from(spec.keeps(at, judged));
            judged
        });
        self.dirty.view = true;
    }

    /// Starts a stream for each chosen container without one, the newest
    /// pods first, while the tab has fewer than [`STREAMS`]; stops those
    /// the source no longer chooses. Streams under way keep their places.
    fn plan(&mut self) {
        let mut order: Vec<&Pod> = self
            .pods
            .iter()
            .filter(|pod| self.reads(&pod.name))
            .collect();
        order.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.name.cmp(&b.name)));
        let wanted: Vec<(Key, &Pod)> = order
            .into_iter()
            .flat_map(|pod| {
                plan::chosen(&pod.json, &self.source.containers)
                    .into_iter()
                    .map(move |container| ((Arc::clone(&pod.uid), container.into()), pod))
            })
            .filter(|(key, _)| !self.finished.contains_key(key))
            .collect();
        self.streams
            .retain(|key, _| wanted.iter().any(|(wanted, _)| wanted == key));
        let mut started = Vec::new();
        let mut held = self.streams.len();
        for (key, pod) in wanted {
            if held == STREAMS {
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
        let generation = self.generation;
        let sender = key.clone();
        let task = tokio::spawn(stream::run(stream, followed, move |event| {
            // The session may have ended, and its streams with it.
            let _ = events.send((generation, sender.clone(), event));
        }));
        let origin = Arc::new(Origin {
            pod: pod.into(),
            container: (*key.1).into(),
        });
        self.streams.insert(
            key,
            Running {
                task,
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
        let mut restarts = Vec::new();
        let mut freed = false;
        while let Ok((generation, key, event)) = self.incoming.try_recv() {
            if generation != self.generation {
                continue;
            }
            let Some(running) = self.streams.get_mut(&key) else {
                continue;
            };
            match event {
                Event::Line {
                    at,
                    level,
                    text,
                    styles,
                } => entries.push((
                    at,
                    Kind::Line {
                        origin: Arc::clone(&running.origin),
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
                        origin: Arc::clone(&running.origin),
                        time: time.into(),
                        exit_code,
                        reason: reason.map(Into::into),
                        restarting: restarting.map(Into::into),
                    },
                )),
                Event::Restarts { restarting } => {
                    restarts.push((Arc::clone(&running.origin), restarting));
                }
                Event::State(state) => {
                    if running.state != state {
                        running.state = state;
                        self.dirty.pods = true;
                    }
                }
                Event::Finished => {
                    if let Some(running) = self.streams.remove(&key) {
                        self.finished.insert(key, running.state.clone());
                    }
                    self.dirty.pods = true;
                    freed = true;
                }
            }
        }
        self.insert(entries);
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
            && arrived == sent.arrived;
        if unchanged {
            return None;
        }
        sent.status = status.clone();
        sent.total = total;
        sent.dropped = dropped;
        sent.arrived = arrived;
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
        })
    }
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

    use super::*;
    use crate::logs::buffer::{Limits, Origin};

    const SECOND: i64 = 1_000_000_000;

    fn request(name: &str) -> OpenLogs {
        OpenLogs {
            target: LogTarget {
                space: "kind-test".to_owned(),
                gvr: Gvr {
                    group: String::new(),
                    version: "v1".to_owned(),
                    resource: "pods".to_owned(),
                },
                namespace: "shop".to_owned(),
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
