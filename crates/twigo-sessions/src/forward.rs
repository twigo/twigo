//! A port-forward's data path (ARCHITECTURE 4.6): a local port on the
//! loopbacks that reaches a port of a pod, of the pods behind a Service or
//! of a workload's. It knows nothing of spaces, state or policy: its owner
//! hands it a hub, a target and a bound port, and follows what its status
//! says.
//!
//! The listener lives as long as the forward, whatever happens to pods. Each
//! accepted connection holds a place among the context's sessions, goes to
//! the forward's current pod and is its own WebSocket. The hub's
//! subscriptions to the target exist only while the forward proves that it
//! can be reached or has connections.

mod connect;
mod connection;
mod listen;
mod pick;
mod watching;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod live;
#[cfg(test)]
mod tests;

use std::future::pending;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use futures::FutureExt;
use futures::future::BoxFuture;
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, MissedTickBehavior, sleep_until};
use twigo_cache::hub::{Hub, Resource};
use twigo_ipc::{ErrorKind, ForwardState, Gvr, IpcError};

use crate::pods::Reach;
use connect::{Connect, Kube};
use connection::Fault;
use pick::{Chosen, Known, Pick};
use watching::Watching;

use listen::{Accepting, Socket, Sockets};

pub use listen::{BindError, Listeners, free_port, listen};

/// How long a connection waits for a pod to be a candidate, as kftray's
/// does ([`listener.rs`](https://github.com/hcavarsan/kftray/blob/v0.35.2/crates/kftray-portforward/src/kube/listener.rs#L543-L595)).
const CANDIDATE_WAIT: Duration = Duration::from_secs(20);
/// The `sessions` stack has no timeout of its own ([`Clients`](twigo_kube::client::Clients)).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the pod may stay silent once the client has closed its side:
/// the second containerd gives kubectl's clients
/// ([`sandbox_portforward_linux.go`](https://github.com/containerd/containerd/blob/v2.3.4/internal/cri/server/sandbox_portforward_linux.go#L83-L126)).
const QUIET: Duration = Duration::from_secs(1);
/// How long the first stream is watched for the pod's refusal: a port that
/// nothing listens on answered on the error channel within 36 ms of the
/// request, over 20 tries on kind 1.37 with containerd 2.3.4 (2026-11-11,
/// `forward::live`).
const PROBE_WINDOW: Duration = Duration::from_millis(250);
const ACCEPT_PAUSE: Duration = Duration::from_millis(100);
/// How often the bytes counted are published while there are connections.
const PUBLISH: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Pod,
    Service,
    Workload(Reach),
}

const KINDS: &[(&str, &str, &str, Kind)] = &[
    ("", "pods", "Pod", Kind::Pod),
    ("", "services", "Service", Kind::Service),
    (
        "apps",
        "deployments",
        "Deployment",
        Kind::Workload(Reach::Through("apps", "replicasets")),
    ),
    (
        "apps",
        "replicasets",
        "ReplicaSet",
        Kind::Workload(Reach::Owns),
    ),
    (
        "apps",
        "statefulsets",
        "StatefulSet",
        Kind::Workload(Reach::Owns),
    ),
    (
        "apps",
        "daemonsets",
        "DaemonSet",
        Kind::Workload(Reach::Owns),
    ),
];

#[derive(Debug, Clone)]
pub struct Target {
    kind: Kind,
    resource: Resource,
    /// As its tab says it: `Service`.
    label: &'static str,
    pub namespace: String,
    pub name: String,
}

impl Target {
    /// Refuses the kinds a forward cannot reach.
    pub fn new(gvr: &Gvr, namespace: String, name: String) -> Result<Self, IpcError> {
        let (_, _, label, kind) = KINDS
            .iter()
            .find(|(group, resource, ..)| *group == gvr.group && *resource == gvr.resource)
            .ok_or_else(|| {
                IpcError::new(
                    ErrorKind::InvalidInput,
                    format!(
                        "{} cannot be forwarded to: a forward reaches a pod, a Service, or the pods of a Deployment, ReplicaSet, StatefulSet or DaemonSet",
                        crate::pods::resource_name(&gvr.group, &gvr.resource)
                    ),
                )
            })?;
        if namespace.is_empty() {
            return Err(IpcError::new(
                ErrorKind::InvalidInput,
                format!("{name} names no namespace"),
            ));
        }
        Ok(Self {
            kind: *kind,
            resource: Resource {
                group: gvr.group.clone(),
                version: gvr.version.clone(),
                resource: gvr.resource.clone(),
                namespaced: true,
            },
            label,
            namespace,
            name,
        })
    }

    pub fn label(&self) -> &'static str {
        self.label
    }
}

pub struct Config {
    pub context: String,
    pub target: Target,
    /// The target's port a forward reaches: a Service's, or a container's.
    pub port: u16,
    /// Its name: a Service's port is found in a pod's slice by it, and a
    /// workload's in each of its pods.
    pub port_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub state: ForwardState,
    pub pod: Option<String>,
    pub pod_port: Option<u16>,
    pub connections: u32,
    pub queued: u32,
    pub sent: u64,
    pub received: u64,
    pub failure: Option<String>,
}

impl Status {
    fn new(state: ForwardState) -> Self {
        Self {
            state,
            pod: None,
            pod_port: None,
            connections: 0,
            queued: 0,
            sent: 0,
            received: 0,
            failure: None,
        }
    }
}

enum Control {
    Restart,
    Refuse(IpcError),
}

/// A forward, which closes its port and its connections when dropped.
pub struct Forward {
    status: watch::Receiver<Status>,
    control: mpsc::UnboundedSender<Control>,
    addresses: Vec<String>,
    task: JoinHandle<()>,
    _accepting: Option<Accepting>,
}

impl Forward {
    /// Starts a forward on `listeners`. A `restored` one waits, listening,
    /// for its first connection or for [`Forward::restart`] before it asks
    /// the cluster anything. Needs the runtime.
    pub fn spawn(hub: Hub, config: Config, listeners: Listeners, restored: bool) -> Self {
        let addresses = listeners.addresses();
        let (sockets, accepting) = listeners.accept();
        Self::spawn_with(
            hub,
            config,
            sockets,
            (addresses, Some(accepting)),
            restored,
            Arc::new(Kube),
        )
    }

    /// A forward that serves the sockets that arrive on `sockets`, listening
    /// on `listening`.
    fn spawn_with(
        hub: Hub,
        config: Config,
        sockets: Sockets,
        (addresses, accepting): (Vec<String>, Option<Accepting>),
        restored: bool,
        connect: Arc<dyn Connect>,
    ) -> Self {
        let state = if restored {
            ForwardState::Restored
        } else {
            ForwardState::Starting
        };
        let (status, status_rx) = watch::channel(Status::new(state));
        let (control, control_rx) = mpsc::unbounded_channel();
        let (reports, reports_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            hub,
            config,
            connect,
            status,
            pick: Mutex::new(Pick::new()),
            picked: watch::Sender::new(0),
            end: watch::Sender::new(0),
            reports,
            sent: AtomicU64::new(0),
            received: AtomicU64::new(0),
        });
        let supervisor = Supervisor {
            shared,
            sockets,
            control: control_rx,
            reports: reports_rx,
            tasks: JoinSet::new(),
            phase: if restored {
                Phase::Restored
            } else {
                Phase::Proving
            },
            worked: false,
            watching: None,
            opening: None,
            probe: None,
            retry: None,
            retries: retries(),
            no_pod_by: None,
        };
        Self {
            status: status_rx,
            control,
            addresses,
            task: tokio::spawn(supervisor.run()),
            _accepting: accepting,
        }
    }

    pub fn status(&self) -> watch::Receiver<Status> {
        self.status.clone()
    }

    pub fn addresses(&self) -> &[String] {
        &self.addresses
    }

    /// Starts over a forward that waits for its first connection, or that
    /// failed; any other is working already.
    pub fn restart(&self) {
        // The supervisor lives as long as the forward.
        let _ = self.control.send(Control::Restart);
    }

    /// Ends every connection and fails the forward with `error`, which
    /// keeps listening and closes what it accepts, until [`Forward::restart`].
    pub fn refuse(&self, error: IpcError) {
        let _ = self.control.send(Control::Refuse(error));
    }
}

impl Drop for Forward {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Shared {
    hub: Hub,
    config: Config,
    connect: Arc<dyn Connect>,
    status: watch::Sender<Status>,
    pick: Mutex<Pick>,
    /// Counts what changes which pod a connection takes.
    picked: watch::Sender<u64>,
    /// Counts the times every connection must end.
    end: watch::Sender<u64>,
    reports: mpsc::UnboundedSender<Report>,
    sent: AtomicU64,
    received: AtomicU64,
}

impl Shared {
    fn update(&self, change: impl FnOnce(&mut Status) -> bool) {
        self.status.send_if_modified(change);
    }

    fn pick(&self) -> std::sync::MutexGuard<'_, Pick> {
        self.pick.lock().expect("pick lock")
    }

    /// The pod to go to, which the status names once it is chosen.
    fn choose(&self) -> Chosen {
        let chosen = self.pick().choose(Instant::now());
        if let Chosen::Pod(candidate) = &chosen {
            self.update(|status| {
                let changed = status.pod.as_deref() != Some(&*candidate.name)
                    || status.pod_port != Some(candidate.port);
                status.pod = Some(candidate.name.to_string());
                status.pod_port = Some(candidate.port);
                changed
            });
        }
        chosen
    }

    fn know(&self, known: Known) {
        self.pick().set(known);
        self.picked.send_modify(|picks| *picks += 1);
    }

    fn failed(&self, key: &str) {
        self.pick().failed(key, Instant::now());
    }

    fn report(&self, report: Report) {
        // The supervisor lives as long as the connections.
        let _ = self.reports.send(report);
    }
}

enum Report {
    /// A pod sent bytes, so it works.
    Served,
    Failed(Fault),
}

struct Open(Arc<Shared>);

impl Open {
    fn new(shared: &Arc<Shared>) -> Self {
        shared.update(|status| {
            status.connections += 1;
            true
        });
        Self(Arc::clone(shared))
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        self.0.update(|status| {
            status.connections -= 1;
            true
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Listening, its cluster not asked yet.
    Restored,
    /// Finding a first pod and proving it can be reached: `Starting` until
    /// it worked once, `Reconnecting` after.
    Proving,
    Ready,
    /// Listening, and closing what it accepts.
    Failed,
}

/// A pause between tries to prove a forward that worked once: 0.5–5 s with
/// jitter, as the hub's (ARCHITECTURE 3.2).
fn retries() -> ExponentialBackoff {
    ExponentialBuilder::new()
        .with_min_delay(Duration::from_millis(500))
        .with_max_delay(Duration::from_millis(2_500))
        .with_jitter()
        .without_max_times()
        .build()
}

struct Supervisor {
    shared: Arc<Shared>,
    sockets: Sockets,
    control: mpsc::UnboundedReceiver<Control>,
    reports: mpsc::UnboundedReceiver<Report>,
    tasks: JoinSet<()>,
    phase: Phase,
    /// It reached a pod since it started over.
    worked: bool,
    watching: Option<Watching>,
    opening: Option<BoxFuture<'static, Result<Watching, IpcError>>>,
    probe: Option<BoxFuture<'static, Result<(), connection::Over>>>,
    /// The next try, when the last one failed.
    retry: Option<Instant>,
    retries: ExponentialBackoff,
    /// When a forward that never worked gives up waiting for a pod.
    no_pod_by: Option<Instant>,
}

async fn changed(watching: &mut Option<Watching>) {
    match watching {
        Some(watching) => watching.changed().await,
        None => pending().await,
    }
}

async fn ready<T>(future: &mut Option<BoxFuture<'static, T>>) -> T {
    match future {
        Some(future) => future.await,
        None => pending().await,
    }
}

fn earliest(a: Option<Instant>, b: Option<Instant>) -> Option<Instant> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

async fn at(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => pending().await,
    }
}

impl Supervisor {
    async fn run(mut self) {
        let mut publish = tokio::time::interval(PUBLISH);
        publish.set_missed_tick_behavior(MissedTickBehavior::Delay);
        if self.phase == Phase::Proving {
            self.ensure_watching();
        }
        loop {
            self.advance();
            let deadline = earliest(self.no_pod_by, self.retry);
            tokio::select! {
                Some(control) = self.control.recv() => self.control(control),
                Some(socket) = self.sockets.recv() => self.accepted(socket),
                Some(report) = self.reports.recv() => self.report(report),
                Some(_) = self.tasks.join_next(), if !self.tasks.is_empty() => self.closed(),
                () = changed(&mut self.watching) => self.look(),
                opened = ready(&mut self.opening) => self.opened(opened),
                proved = ready(&mut self.probe) => self.proved(proved),
                () = at(deadline) => self.timed_out(),
                _ = publish.tick(), if !self.tasks.is_empty() => self.publish(),
            }
        }
    }

    fn control(&mut self, control: Control) {
        match control {
            Control::Restart => {
                if matches!(self.phase, Phase::Restored | Phase::Failed) {
                    self.worked = false;
                    self.begin();
                }
            }
            Control::Refuse(error) => {
                self.shared.end.send_modify(|ends| *ends += 1);
                self.fail(error);
            }
        }
    }

    fn accepted(&mut self, socket: Socket) {
        match self.phase {
            // Closed at once: its socket drops here.
            Phase::Failed => return,
            Phase::Restored => self.begin(),
            Phase::Proving | Phase::Ready => {}
        }
        self.ensure_watching();
        let open = Open::new(&self.shared);
        let end = self.shared.end.subscribe();
        self.tasks.spawn(connection::serve(
            Arc::clone(&self.shared),
            socket,
            open,
            end,
        ));
    }

    fn begin(&mut self) {
        self.phase = Phase::Proving;
        self.retry = None;
        self.no_pod_by = None;
        self.retries = retries();
        self.shared.update(|status| {
            status.state = ForwardState::Starting;
            true
        });
        self.ensure_watching();
    }

    fn ensure_watching(&mut self) {
        if self.watching.is_some() || self.opening.is_some() {
            return;
        }
        let shared = Arc::clone(&self.shared);
        self.opening =
            Some(async move { Watching::new(&shared.hub, &shared.config).await }.boxed());
    }

    /// Lets the hub's subscriptions go.
    fn release(&mut self) {
        self.watching = None;
        self.opening = None;
        self.shared.know(Known::Unknown);
    }

    fn opened(&mut self, opened: Result<Watching, IpcError>) {
        self.opening = None;
        match opened {
            Ok(watching) => {
                self.watching = Some(watching);
                self.look();
            }
            Err(error) => self.fail(error),
        }
    }

    fn look(&mut self) {
        let Some(watching) = &self.watching else {
            return;
        };
        let known = Known::from(watching.look(&self.shared.config));
        let reaction = match &known {
            Known::Fault(error) => Some(Err(error.clone())),
            Known::Listed { candidates, why } if candidates.is_empty() => Some(Ok(why.clone())),
            _ => None,
        };
        self.shared.know(known);
        // The pod new connections go to may have changed.
        self.shared.choose();
        match reaction {
            Some(Err(error)) if matches!(self.phase, Phase::Proving | Phase::Ready) => {
                self.fail(error);
            }
            Some(Ok(why)) if self.phase == Phase::Ready => self.reconnecting(why),
            _ => {}
        }
    }

    /// Starts the proof or the wait for a pod, whichever the forward is at.
    fn advance(&mut self) {
        if self.phase != Phase::Proving || self.probe.is_some() || self.retry.is_some() {
            return;
        }
        self.ensure_watching();
        match self.shared.choose() {
            Chosen::Unknown => {}
            Chosen::Fault(error) => self.fail(error),
            Chosen::None(why) => {
                if self.worked {
                    self.reconnecting(why);
                } else if self.no_pod_by.is_none() {
                    self.no_pod_by = Some(Instant::now() + CANDIDATE_WAIT);
                }
            }
            Chosen::Pod(candidate) => {
                self.no_pod_by = None;
                let (shared, end) = (Arc::clone(&self.shared), self.shared.end.subscribe());
                self.probe = Some(connection::probe(shared, candidate, end).boxed());
            }
        }
    }

    fn proved(&mut self, proved: Result<(), connection::Over>) {
        self.probe = None;
        match proved {
            Ok(()) => {
                self.worked = true;
                self.phase = Phase::Ready;
                self.retries = retries();
                self.shared.update(|status| {
                    status.state = ForwardState::Ready;
                    status.failure = None;
                    true
                });
                if self.tasks.is_empty() {
                    self.release();
                }
            }
            Err(connection::Over::Fault(fault)) => match fault {
                Fault::Fatal(error) => self.fail(error),
                Fault::Port(words) => {
                    self.failure(words.clone());
                    self.unreachable(IpcError::new(ErrorKind::Unavailable, words));
                }
                Fault::Transient(error) => {
                    self.failure(error.message.clone());
                    self.unreachable(error);
                }
                Fault::Lost => self.pause(),
            },
            Err(connection::Over::Lost) => self.pause(),
            // The forward is failing, and the probe goes with it.
            Err(connection::Over::Ended) => {}
        }
    }

    fn failure(&self, words: String) {
        self.shared.update(|status| {
            status.failure = Some(words);
            true
        });
    }

    /// Waits before the next try to prove the forward.
    fn pause(&mut self) {
        let pause = self.retries.next().expect("without a limit");
        self.retry = Some(Instant::now() + pause);
    }

    /// A try to prove the forward failed: it fails if it never worked, else
    /// it tries again after a pause.
    fn unreachable(&mut self, error: IpcError) {
        if !self.worked {
            self.fail(error);
            return;
        }
        self.pause();
        self.reconnecting(error.message);
    }

    fn reconnecting(&mut self, reason: String) {
        self.phase = Phase::Proving;
        self.shared.update(|status| {
            let state = ForwardState::Reconnecting { reason };
            let changed = status.state != state;
            status.state = state;
            changed
        });
    }

    fn fail(&mut self, error: IpcError) {
        self.phase = Phase::Failed;
        self.probe = None;
        self.retry = None;
        self.no_pod_by = None;
        self.shared.update(|status| {
            let state = ForwardState::Failed { error };
            let changed = status.state != state;
            status.state = state;
            changed
        });
        if self.tasks.is_empty() {
            self.release();
        }
    }

    fn report(&mut self, report: Report) {
        match report {
            Report::Served => self.shared.update(|status| status.failure.take().is_some()),
            Report::Failed(Fault::Fatal(error)) => self.fail(error),
            Report::Failed(Fault::Port(words)) => self.failure(words),
            Report::Failed(Fault::Transient(error)) => {
                self.failure(error.message.clone());
                if self.phase == Phase::Ready {
                    self.reconnecting(error.message);
                }
            }
            Report::Failed(Fault::Lost) => {
                if self.phase == Phase::Ready {
                    self.reconnecting("the connection to the cluster was lost".to_owned());
                }
            }
        }
    }

    fn closed(&mut self) {
        self.publish();
        if self.tasks.is_empty() && matches!(self.phase, Phase::Ready | Phase::Failed) {
            self.release();
        }
    }

    fn timed_out(&mut self) {
        let now = Instant::now();
        if self.retry.is_some_and(|retry| retry <= now) {
            self.retry = None;
        }
        if self.no_pod_by.is_some_and(|by| by <= now) {
            self.no_pod_by = None;
            let chosen = self.shared.pick().choose(now);
            if let Chosen::None(why) = chosen {
                self.fail(IpcError::new(ErrorKind::Unavailable, why));
            }
        }
    }

    fn publish(&self) {
        let (sent, received) = (
            self.shared.sent.load(Ordering::Relaxed),
            self.shared.received.load(Ordering::Relaxed),
        );
        self.shared.update(|status| {
            let changed = status.sent != sent || status.received != received;
            status.sent = sent;
            status.received = received;
            changed
        });
    }
}
