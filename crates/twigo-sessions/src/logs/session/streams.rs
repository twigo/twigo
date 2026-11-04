//! A logs session's streams (ARCHITECTURE 4.6): one per chosen container,
//! up to the tab's ten, those stopped among them until their tasks have
//! ended, and what they say.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use twigo_cache::hub::Hub;
use twigo_ipc::{LogSource, StreamState};

use super::{Key, Pod};
use crate::logs::buffer::{Kind, Origin};
use crate::logs::plan;
use crate::logs::stream::{self, Event, Stream};

/// The streams a tab follows at most, those stopped among them until their
/// tasks have ended, so one workload cannot take the cluster's 32 followed
/// logs.
pub const STREAMS: usize = 10;

/// How long a left pod's streams may take to finish their reads: the
/// kubelet ends a follow up to `logForceCheckPeriod`, a second, after the
/// container exits (cri-client v1.37.0, `waitLogs`), and its status
/// manager deletes a finished pod right after it patches its status
/// (kubernetes v1.37.0, `pkg/kubelet/status/status_manager.go`, `syncPod`).
pub const FINISHING: Duration = Duration::from_secs(5);

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

/// A stream's task, ended when dropped.
struct Task(JoinHandle<()>);

impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What the streams said since the last look.
pub struct Taken {
    /// Their lines and ends, each with its pod's uid, in the order they
    /// came.
    pub entries: Vec<(Arc<str>, i64, Kind)>,
    /// The next starts of the instances that ended last, by their
    /// streams' origins.
    pub restarts: Vec<(Arc<Origin>, String)>,
    /// A stream's state changed, or one finished.
    pub changed: bool,
    /// A place among the tab's streams came free.
    pub freed: bool,
}

pub struct Streams {
    hub: Hub,
    context: String,
    namespace: String,
    running: HashMap<Key, Running>,
    stopped: Vec<Stopped>,
    /// The streams of an old source, aborted, which keep their places until
    /// their tasks have ended; what they said goes.
    ending: Vec<Task>,
    /// Streams that read all there was, with their last state.
    finished: HashMap<Key, StreamState>,
    /// Counts the streams started, which gives each its id, so the events
    /// of a stream neither running nor stopped, as of an old source, go.
    started: u64,
    events: mpsc::UnboundedSender<(u64, Event)>,
    incoming: mpsc::UnboundedReceiver<(u64, Event)>,
}

impl Streams {
    pub fn new(hub: Hub, context: String, namespace: String) -> Self {
        let (events, incoming) = mpsc::unbounded_channel();
        Self {
            hub,
            context,
            namespace,
            running: HashMap::new(),
            stopped: Vec::new(),
            ending: Vec::new(),
            finished: HashMap::new(),
            started: 0,
            events,
            incoming,
        }
    }

    /// Aborts every stream, for a source read anew.
    pub fn reset(&mut self) {
        let old = self.running.drain().map(|(_, running)| running.task);
        self.ending
            .extend(old.chain(self.stopped.drain(..).map(|stopped| stopped.task)));
        for task in &self.ending {
            task.0.abort();
        }
        self.finished.clear();
    }

    /// Takes the target's pods as listed again: the streams of those that
    /// left finish their reads, those that finished are forgotten, and
    /// every other stream is told its pod.
    pub fn listed(&mut self, pods: &[Pod]) {
        let left: Vec<Key> = self
            .running
            .keys()
            .filter(|(uid, _)| !pods.iter().any(|pod| pod.uid == *uid))
            .cloned()
            .collect();
        for key in &left {
            self.stop(key, true);
        }
        self.finished
            .retain(|(uid, _), _| pods.iter().any(|pod| pod.uid == *uid));
        for ((uid, _), running) in &self.running {
            if let Some(pod) = pods.iter().find(|pod| pod.uid == *uid)
                && !Arc::ptr_eq(&pod.json, &*running.pod.borrow())
            {
                running.pod.send_replace(Arc::clone(&pod.json));
            }
        }
    }

    /// Starts a stream for each container of `pods` the source chooses
    /// without one, those with an instance to read first, then the newest
    /// pods, while the tab has fewer than [`STREAMS`], the stopped streams
    /// whose tasks have not ended among them; stops those the source no
    /// longer chooses. Streams under way keep their places, but one with
    /// nothing to read gives its place up to one that can be read, as many
    /// of them as the places the stopped streams will free leave short.
    /// Whether it started any.
    pub fn plan(&mut self, mut pods: Vec<&Pod>, source: &LogSource) -> bool {
        pods.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.name.cmp(&b.name)));
        let mut wanted: Vec<(Key, &Pod, bool)> = pods
            .into_iter()
            .flat_map(|pod| {
                plan::chosen(&pod.json, &source.containers)
                    .into_iter()
                    .map(move |container| {
                        let readable = stream::readable(&pod.json, &container, source.previous);
                        ((Arc::clone(&pod.uid), container.into()), pod, readable)
                    })
            })
            .filter(|(key, ..)| !self.finished.contains_key(key))
            .collect();
        wanted.sort_by_key(|(.., readable)| !readable);
        let unwanted: Vec<Key> = self
            .running
            .keys()
            .filter(|key| !wanted.iter().any(|(wanted, ..)| wanted == *key))
            .cloned()
            .collect();
        for key in &unwanted {
            self.stop(key, false);
        }
        let lacking = wanted
            .iter()
            .filter(|(key, _, readable)| *readable && !self.running.contains_key(key))
            .count();
        let mut yielding = lacking.saturating_sub(STREAMS.saturating_sub(self.running.len()));
        for (key, _, readable) in wanted.iter().rev() {
            if yielding == 0 {
                break;
            }
            if !readable && self.stop(key, false) {
                yielding -= 1;
            }
        }
        let mut held = self.running.len() + self.stopping();
        let mut started = false;
        for (key, pod, _) in wanted {
            if held >= STREAMS {
                break;
            }
            if self.running.contains_key(&key) {
                continue;
            }
            self.start(key, pod, source);
            held += 1;
            started = true;
        }
        started
    }

    /// The stopped streams whose tasks have not ended: an abort only
    /// schedules a task's end, so each keeps its place until then.
    pub fn stopping(&self) -> usize {
        let stopped = self.stopped.iter().map(|stopped| &stopped.task);
        stopped
            .chain(&self.ending)
            .filter(|task| !task.0.is_finished())
            .count()
    }

    fn start(&mut self, key: Key, pod: &Pod, source: &LogSource) {
        let (sender, receiver) = watch::channel(Arc::clone(&pod.json));
        let origin = Arc::new(Origin {
            pod: (*pod.name).into(),
            container: (*key.1).into(),
        });
        let stream = Stream::new(
            self.hub.clone(),
            &self.context,
            &self.namespace,
            Arc::clone(&origin),
            source,
        );
        let events = self.events.clone();
        self.started += 1;
        let id = self.started;
        let task = tokio::spawn(stream::run(stream, receiver, move |event| {
            // The session may have ended, and its streams with it.
            let _ = events.send((id, event));
        }));
        self.running.insert(
            key,
            Running {
                id,
                task: Task(task),
                pod: sender,
                state: StreamState::Connecting,
                origin,
            },
        );
    }

    /// Stops a stream, which may yet have said things not taken: at once,
    /// or, when its pod left, once its read ends, within [`FINISHING`];
    /// whether it ran.
    fn stop(&mut self, key: &Key, left: bool) -> bool {
        let Some(Running {
            id, task, origin, ..
        }) = self.running.remove(key)
        else {
            return false;
        };
        if !left {
            task.0.abort();
        }
        self.stopped.push(Stopped {
            id,
            task,
            uid: Arc::clone(&key.0),
            origin,
            finishing: left.then(|| Instant::now() + FINISHING),
        });
        true
    }

    /// Takes what the streams said: their entries, their states, and the
    /// places of those whose tasks have ended.
    pub fn take(&mut self) -> Taken {
        let mut taken = Taken {
            entries: Vec::new(),
            restarts: Vec::new(),
            changed: false,
            freed: false,
        };
        let now = Instant::now();
        for stopped in &self.stopped {
            if stopped.finishing.is_some_and(|until| until <= now) {
                stopped.task.0.abort();
            }
        }
        // A stream whose task has ended has said all it will, and frees its
        // place; one that ended by itself read all there was.
        let done: Vec<Key> = self
            .running
            .iter()
            .filter(|(_, running)| running.task.0.is_finished())
            .map(|(key, _)| key.clone())
            .collect();
        let ended: Vec<u64> = self
            .stopped
            .iter()
            .filter(|stopped| stopped.task.0.is_finished())
            .map(|stopped| stopped.id)
            .collect();
        let ending = self.ending.len();
        self.ending.retain(|task| !task.0.is_finished());
        taken.freed = !ended.is_empty() || self.ending.len() < ending;
        while let Ok((id, event)) = self.incoming.try_recv() {
            let key = self
                .running
                .iter()
                .find_map(|(key, running)| (running.id == id).then(|| key.clone()));
            let (uid, origin) = match &key {
                Some(key) => (&key.0, &self.running[key].origin),
                None => match self.stopped.iter().find(|stopped| stopped.id == id) {
                    Some(stopped) => (&stopped.uid, &stopped.origin),
                    None => continue,
                },
            };
            match event {
                Event::Entry { at, kind } => taken.entries.push((Arc::clone(uid), at, kind)),
                Event::Restarts { restarting } => {
                    taken.restarts.push((Arc::clone(origin), restarting));
                }
                Event::State(state) => {
                    if let Some(running) = key.and_then(|key| self.running.get_mut(&key))
                        && running.state != state
                    {
                        running.state = state;
                        taken.changed = true;
                    }
                }
            }
        }
        self.stopped.retain(|stopped| !ended.contains(&stopped.id));
        for key in done {
            let running = self.running.remove(&key).expect("it was running");
            self.finished.insert(key, running.state);
            taken.changed = true;
            taken.freed = true;
        }
        taken
    }

    /// The state of the container's stream while one runs, or the last of
    /// the one that finished.
    pub fn state(&self, key: &Key) -> Option<&StreamState> {
        self.running
            .get(key)
            .map(|running| &running.state)
            .or_else(|| self.finished.get(key))
    }

    /// Whether a stopped stream of the pod `uid` has yet to end and have
    /// what it said taken.
    pub fn streaming(&self, uid: &str) -> bool {
        self.stopped.iter().any(|stopped| *stopped.uid == *uid)
    }
}

#[cfg(test)]
impl Streams {
    /// The running streams, by their keys and the ids their events come
    /// under.
    pub fn running(&self) -> impl Iterator<Item = (&Key, u64)> {
        self.running.iter().map(|(key, running)| (key, running.id))
    }

    pub fn stopped(&self) -> usize {
        self.stopped.len()
    }

    /// Says `event` as the stream `id` does.
    pub fn send(&self, id: u64, event: Event) {
        self.events
            .send((id, event))
            .expect("the streams take events");
    }
}
