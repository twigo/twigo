//! A port-forward's data path (ARCHITECTURE 4.6): a local port on the
//! loopbacks that reaches a port of a pod, of the pods behind a Service or
//! of a workload's. It knows nothing of spaces, state or policy: its owner
//! hands it a hub, a target and a bound port, and follows what its status
//! says.
//!
//! The listener lives as long as the forward, whatever happens to pods. Each
//! accepted connection holds a place among the context's sessions, goes to
//! the forward's current pod and is its own WebSocket. The hub's
//! subscriptions to the target exist only while someone uses the forward: a
//! connection, or a proof that a person or the space's connecting asked for.

mod cause;
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
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, MissedTickBehavior, sleep_until};
use twigo_cache::hub::{Hub, Resource};
use twigo_ipc::{ErrorKind, ForwardState, Gvr, IpcError};

use crate::pods::Reach;
use cause::{Cause, Lift};
use connect::{Connect, Kube};
use connection::Fault;
use pick::{Chosen, Known, Pick};
use watching::{UNANSWERED_YET, Watching};

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
/// How long the first stream is watched for the pod's refusal, from the
/// upgrade's return: a port that nothing listens on answered on the error
/// channel within 1.51 ms of it, over 60 tries (3 runs of 20, load average
/// 73.8 to 75.0) on kind 1.37 with containerd 2.3.4 (2026-11-12,
/// `forward::live`).
const PROBE_WINDOW: Duration = Duration::from_millis(250);
const ACCEPT_PAUSE: Duration = Duration::from_millis(100);
const LISTENING_PROBE: Duration = Duration::from_secs(1);
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

/// How a forward begins.
pub enum Begin {
    /// A person's start, which proves at once that a pod can be reached.
    Started,
    /// Restored at a start of the app: it waits, listening, and asks its
    /// cluster at its first connection or once its space connects.
    Restored,
    /// Restored while its context's mode or the catalog refuses it: failed
    /// with that from its first instant, until it is lifted.
    Refused(IpcError),
}

enum Control {
    Restart,
    Connected,
    SignedIn,
    Refuse(IpcError),
    Allow,
    Handled(oneshot::Sender<()>),
}

/// A forward, which closes its port and its connections when dropped.
pub struct Forward {
    shared: Arc<Shared>,
    status: watch::Receiver<Status>,
    control: mpsc::UnboundedSender<Control>,
    /// Where its listeners send what they accept.
    sockets: mpsc::UnboundedSender<Socket>,
    addresses: Vec<String>,
    task: JoinHandle<()>,
    accepting: Option<Accepting>,
}

impl Forward {
    /// Starts a forward on `listeners`, as `begin` says. Needs the runtime.
    pub fn spawn(hub: Hub, config: Config, listeners: Listeners, begin: Begin) -> Self {
        let addresses = listeners.addresses();
        let (sender, sockets) = mpsc::unbounded_channel();
        let accepting = listeners.accept(&sender);
        Self::spawn_with(
            hub,
            config,
            (sender, sockets),
            (addresses, Some(accepting)),
            begin,
            Arc::new(Kube),
        )
    }

    /// A forward that serves the sockets that arrive on `sockets`, listening
    /// on `listening`.
    fn spawn_with(
        hub: Hub,
        config: Config,
        (sender, sockets): (mpsc::UnboundedSender<Socket>, Sockets),
        (addresses, accepting): (Vec<String>, Option<Accepting>),
        begin: Begin,
        connect: Arc<dyn Connect>,
    ) -> Self {
        let (phase, state, proof) = match begin {
            Begin::Started => {
                let proof = Proof::new(Asker::Person);
                (Phase::Starting, ForwardState::Starting, Some(proof))
            }
            Begin::Restored => (Phase::Restored, ForwardState::Restored, None),
            Begin::Refused(error) => {
                let lift = Cause::from(error.clone()).lift();
                (Phase::Failed(lift), ForwardState::Failed { error }, None)
            }
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
            shared: Arc::clone(&shared),
            sockets,
            control: control_rx,
            reports: reports_rx,
            tasks: JoinSet::new(),
            phase,
            proof,
            watching: None,
            opening: None,
            accepted: 0,
            failed_after: 0,
            cut: 0,
        };
        Self {
            shared,
            status: status_rx,
            control,
            sockets: sender,
            addresses,
            task: tokio::spawn(supervisor.run()),
            accepting,
        }
    }

    pub fn status(&self) -> watch::Receiver<Status> {
        self.status.clone()
    }

    pub fn addresses(&self) -> &[String] {
        &self.addresses
    }

    /// The bytes to the pod and from it so far, which the status shows with
    /// a delay.
    pub fn bytes(&self) -> (u64, u64) {
        (
            self.shared.sent.load(Ordering::Relaxed),
            self.shared.received.load(Ordering::Relaxed),
        )
    }

    /// Listens on `listeners` in place of its own, which are closed when it
    /// returns. Its state, its connections and what it is doing stay.
    pub fn rebind(&mut self, listeners: Listeners) {
        self.addresses = listeners.addresses();
        self.accepting = Some(listeners.accept(&self.sockets));
    }

    /// A person's start or resume: it forgets the pods it avoided, and one
    /// that failed proves again that a pod can be reached. Any other stays
    /// as it is.
    pub fn restart(&self) {
        // The supervisor lives as long as the forward.
        let _ = self.control.send(Control::Restart);
    }

    /// Its space's clients were made: a forward that waits, or that failed
    /// for a credential, proves that a pod can be reached, which it does
    /// without a connection. Any other stays as it is.
    pub fn connected(&self) {
        let _ = self.control.send(Control::Connected);
    }

    /// A sign-in the person started got a credential: a forward that failed
    /// for its credential proves once that a pod can be reached, as its
    /// space's connecting would. Any other stays as it is.
    pub fn signed_in(&self) {
        let _ = self.control.send(Control::SignedIn);
    }

    /// Ends every connection and fails the forward with `error`, which
    /// keeps listening and closes what it accepts, until [`Forward::allow`]
    /// or [`Forward::restart`].
    pub fn refuse(&self, error: IpcError) {
        let _ = self.control.send(Control::Refuse(error));
    }

    /// Lifts a refusal: the forward waits, as at a start of the app, and
    /// asks nothing by itself.
    pub fn allow(&self) {
        let _ = self.control.send(Control::Allow);
    }

    /// Resolves once the forward has handled what was sent to it before, so
    /// its status says what that did.
    pub fn handled(&self) -> BoxFuture<'static, ()> {
        let (done, handled) = oneshot::channel();
        let _ = self.control.send(Control::Handled(done));
        async move {
            let _ = handled.await;
        }
        .boxed()
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

    /// The pod to go to, which the status names once it is chosen, and no
    /// longer when a choice finds none.
    fn choose(&self, now: Instant) -> Chosen {
        let chosen = self.pick().choose(now);
        let named = match &chosen {
            Chosen::Pod(candidate) => Some(candidate),
            Chosen::None(_) => None,
            Chosen::Fault(_) | Chosen::Refused(_) | Chosen::Unknown(_) => return chosen,
        };
        self.update(|status| {
            let pod = named.map(|candidate| candidate.name.to_string());
            let pod_port = named.map(|candidate| candidate.port);
            let changed = status.pod != pod || status.pod_port != pod_port;
            status.pod = pod;
            status.pod_port = pod_port;
            changed
        });
        chosen
    }

    fn know(&self, known: Known) {
        self.pick().set(known);
        self.picked.send_modify(|picks| *picks += 1);
    }

    fn forget(&self) {
        self.pick().forget();
        self.picked.send_modify(|picks| *picks += 1);
    }

    fn served(&self, key: &str) {
        self.pick().served(key);
        self.picked.send_modify(|picks| *picks += 1);
    }

    fn failed(&self, key: &str) {
        self.pick().failed(key, Instant::now());
    }

    /// The upgrade to a pod behind a Service or a workload answered 404, in
    /// `words`: whether another pod is left, which the status names then.
    fn left(&self, key: &str, words: String) -> bool {
        let now = Instant::now();
        self.pick().left(key, words, now);
        matches!(self.choose(now), Chosen::Pod(_))
    }

    fn report(&self, report: Report) {
        // The supervisor lives as long as the connections.
        let _ = self.reports.send(report);
    }
}

/// What the connection of a number says.
enum Report {
    /// A pod sent it bytes, so the forward works.
    Served(u64),
    /// Why it ended, or a 404 of its pod, after which it chooses again.
    Failed(u64, Fault),
}

/// An open connection, which the status counts while it lives.
struct Open {
    shared: Arc<Shared>,
    number: u64,
}

impl Open {
    fn new(shared: &Arc<Shared>, number: u64) -> Self {
        shared.update(|status| {
            status.connections += 1;
            true
        });
        Self {
            shared: Arc::clone(shared),
            number,
        }
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        self.shared.update(|status| {
            status.connections -= 1;
            true
        });
    }
}

/// What the forward says, as its status's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Listening, and it has asked nothing: since the app started, or since
    /// a refusal was lifted.
    Restored,
    /// A person's proof is under way.
    Starting,
    Ready,
    /// No pod can be reached now, for the reason the status gives.
    Reconnecting,
    /// Listening, and closing what it accepts unless its target is gone,
    /// until a person starts it again, a refusal is lifted, or what `Lift`
    /// names.
    Failed(Lift),
}

/// Who asked for the proof under way: finding a pod and opening a first
/// stream to its port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Asker {
    /// A start or a resume of a forward that did not run or that failed. It
    /// says `Starting`, holds the forward with no connection, and ends
    /// `Ready` or `Failed` within the waits' bounds: any failure fails the
    /// forward.
    Person,
    /// The space connecting, which proves a forward that waits, or that
    /// failed for a credential, with no connection, within the same bounds;
    /// so does a sign-in the person started, for a forward that failed for
    /// its credential. A system's proof, as below.
    Space,
    /// A connection, or the forward's own tries while it has connections. A
    /// system's proof keeps the forward's words, says `Reconnecting` for
    /// what may pass, and fails the forward only for what does not.
    Connection,
}

struct Proof {
    by: Asker,
    probe: Option<BoxFuture<'static, Result<(), connection::Over>>>,
    received_at_probe: u64,
    /// The next try, when the last one failed.
    retry: Option<Instant>,
    retries: ExponentialBackoff,
    /// When a proof asked with no connection gives up waiting for a pod.
    no_pod_by: Option<Instant>,
}

impl Proof {
    fn new(by: Asker) -> Self {
        Self {
            by,
            probe: None,
            received_at_probe: 0,
            retry: None,
            retries: retries(),
            no_pod_by: None,
        }
    }

    fn deadline(&self) -> Option<Instant> {
        match (self.retry, self.no_pod_by) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
}

/// A pause between tries to prove a forward: 0.5–5 s with jitter, as the
/// hub's (ARCHITECTURE 3.2).
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
    proof: Option<Proof>,
    watching: Option<Watching>,
    opening: Option<BoxFuture<'static, Result<Watching, IpcError>>>,
    accepted: u64,
    /// How many had been when the `failure` was set: a connection with a
    /// greater number was opened after it.
    failed_after: u64,
    /// How many had been when the forward last failed: what a connection up
    /// to that number reports changes no state.
    cut: u64,
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

async fn probed(proof: &mut Option<Proof>) -> Result<(), connection::Over> {
    match proof.as_mut().and_then(|proof| proof.probe.as_mut()) {
        Some(probe) => probe.await,
        None => pending().await,
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
        loop {
            self.settle();
            let deadline = self.proof.as_ref().and_then(Proof::deadline);
            // A connection reports before its task ends, and its report is
            // read first.
            tokio::select! {
                biased;
                Some(control) = self.control.recv() => self.control(control),
                Some(report) = self.reports.recv() => self.report(report),
                Some(socket) = self.sockets.recv() => self.accepted(socket),
                Some(_) = self.tasks.join_next(), if !self.tasks.is_empty() => self.publish(),
                opened = ready(&mut self.opening) => self.opened(opened),
                () = changed(&mut self.watching) => self.look(),
                proved = probed(&mut self.proof) => self.proved(proved),
                () = at(deadline) => self.timed_out(),
                _ = publish.tick(), if !self.tasks.is_empty() => self.publish(),
            }
        }
    }

    /// Whether someone uses the forward: an open connection, as the status
    /// counts them, or a proof asked with no connection.
    fn used(&self) -> bool {
        self.shared.status.borrow().connections > 0
            || self
                .proof
                .as_ref()
                .is_some_and(|proof| proof.by != Asker::Connection)
    }

    fn person(&self) -> bool {
        self.proof
            .as_ref()
            .is_some_and(|proof| proof.by == Asker::Person)
    }

    /// Run after every event (a control, a report, a socket, the end of a
    /// connection, a change the hub tells, a probe's end, a timer). A forward
    /// nobody uses, before or after the step its proof takes here, holds no
    /// subscription, opens no stream and has no timer armed, keeping its
    /// words: a proof under way ends, and only a probe in flight stays, for
    /// its result. A forward that is used and cannot reach a pod proves, and
    /// it watches its target while it proves or is ready.
    fn settle(&mut self) {
        if self.used() {
            if self.phase == Phase::Ready && self.proof.is_none() {
                self.ensure_watching();
                let chosen = self.shared.choose(Instant::now());
                if !matches!(chosen, Chosen::Pod(_) | Chosen::Unknown(None)) {
                    self.proof = Some(Proof::new(Asker::Connection));
                }
            }
            if self.phase == Phase::Reconnecting && self.proof.is_none() {
                self.proof = Some(Proof::new(Asker::Connection));
            }
            if self.proof.is_some() {
                self.ensure_watching();
                self.advance();
            }
        }
        if !self.used() {
            if self
                .proof
                .as_ref()
                .is_some_and(|proof| proof.probe.is_none())
            {
                self.proof = None;
            }
            self.unwatch();
        } else if self.proof.is_none() && self.phase != Phase::Ready {
            self.unwatch();
        }
    }

    fn control(&mut self, control: Control) {
        match control {
            Control::Restart => {
                self.shared.forget();
                if matches!(self.phase, Phase::Failed(_)) {
                    self.close_queued();
                    self.phase = Phase::Starting;
                    self.proof = Some(Proof::new(Asker::Person));
                    self.say(ForwardState::Starting);
                }
            }
            Control::Connected => match (self.phase, &mut self.proof) {
                (Phase::Restored | Phase::Failed(Lift::Clients), None) => {
                    self.proof = Some(Proof::new(Asker::Space));
                }
                (Phase::Restored, Some(proof)) => proof.by = Asker::Space,
                _ => {}
            },
            Control::SignedIn => {
                if self.phase == Phase::Failed(Lift::Clients) && self.proof.is_none() {
                    self.proof = Some(Proof::new(Asker::Space));
                }
            }
            Control::Refuse(error) => self.fail(error),
            Control::Allow if matches!(self.phase, Phase::Failed(_)) => {
                self.close_queued();
                self.phase = Phase::Restored;
                self.say(ForwardState::Restored);
            }
            Control::Handled(done) => {
                let _ = done.send(());
            }
            Control::Allow => {}
        }
    }

    /// What came while the forward was failed is closed, not served, unless
    /// its target is gone.
    fn close_queued(&mut self) {
        while let Ok(socket) = self.sockets.try_recv() {
            self.accepted(socket);
        }
    }

    fn accepted(&mut self, socket: Socket) {
        match self.phase {
            // Closed at once: its socket drops here.
            Phase::Failed(Lift::Asked | Lift::Clients) => return,
            Phase::Restored | Phase::Failed(Lift::Connection) if self.proof.is_none() => {
                self.proof = Some(Proof::new(Asker::Connection));
            }
            _ => {}
        }
        self.accepted += 1;
        let open = Open::new(&self.shared, self.accepted);
        let end = self.shared.end.subscribe();
        self.tasks.spawn(connection::serve(
            Arc::clone(&self.shared),
            socket,
            open,
            end,
        ));
    }

    fn ensure_watching(&mut self) {
        if self.watching.is_some() || self.opening.is_some() {
            return;
        }
        let shared = Arc::clone(&self.shared);
        self.opening =
            Some(async move { Watching::new(&shared.hub, &shared.config).await }.boxed());
    }

    fn unwatch(&mut self) {
        if self.watching.is_some() || self.opening.is_some() {
            self.watching = None;
            self.opening = None;
            self.shared.know(Known::Unknown(None));
        }
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

    /// Takes in what the hub tells; [`Supervisor::settle`] acts on it.
    fn look(&mut self) {
        let Some(watching) = &self.watching else {
            return;
        };
        self.shared
            .know(Known::from(watching.look(&self.shared.config)));
        // The pod new connections go to may have changed.
        self.shared.choose(Instant::now());
    }

    /// Takes the proof under way a step on: a probe of the pod it would
    /// reach, or what it does without one.
    fn advance(&mut self) {
        let Some(proof) = &self.proof else {
            return;
        };
        if proof.probe.is_some() || proof.retry.is_some() {
            return;
        }
        let (by, received) = (proof.by, self.shared.received.load(Ordering::Relaxed));
        match self.shared.choose(Instant::now()) {
            Chosen::Pod(candidate) => {
                let (shared, end) = (Arc::clone(&self.shared), self.shared.end.subscribe());
                let proof = self.proof.as_mut().expect("checked");
                proof.no_pod_by = None;
                proof.received_at_probe = received;
                proof.probe = Some(connection::probe(shared, candidate, end).boxed());
            }
            Chosen::Fault(cause) => self.fail(cause),
            Chosen::Refused(error) => self.unreachable(error.into(), false),
            Chosen::None(why) | Chosen::Unknown(Some(why)) if by != Asker::Person => {
                self.reconnecting(why);
            }
            Chosen::None(_) | Chosen::Unknown(_) => {
                if by != Asker::Connection {
                    self.wait_for_a_pod();
                }
            }
        }
    }

    /// A proof asked with no connection waits for a pod no longer than a
    /// connection does.
    fn wait_for_a_pod(&mut self) {
        if let Some(proof) = &mut self.proof {
            proof
                .no_pod_by
                .get_or_insert_with(|| Instant::now() + CANDIDATE_WAIT);
        }
    }

    fn proved(&mut self, proved: Result<(), connection::Over>) {
        if let Some(proof) = &mut self.proof {
            proof.probe = None;
        }
        match proved {
            Ok(()) => self.proven(),
            Err(connection::Over::Fault(fault)) => match fault {
                Fault::Fatal(error) => self.fail(error),
                // That pod is avoided: the proof chooses again.
                Fault::Left { words, .. } => self.failure(words),
                Fault::Port(words) | Fault::NoPod(words) => {
                    self.failure(words.clone());
                    self.unreachable(IpcError::new(ErrorKind::Unavailable, words).into(), true);
                }
                Fault::Transient(cause) => {
                    self.failure(cause.error().message.clone());
                    self.unreachable(cause, true);
                }
                Fault::Lost => self.pause(),
            },
            Err(connection::Over::Lost) => self.pause(),
            // The forward is failing, and the probe goes with it.
            Err(connection::Over::Ended) => {}
        }
    }

    /// A stream to a pod, or a connection that carried bytes, proved the
    /// forward. Where the forward still watches, the pods may have gone
    /// meanwhile, so they are looked at again before it says so; where
    /// nobody uses it any more, the proof's result counts.
    fn proven(&mut self) {
        let ready = match self.shared.choose(Instant::now()) {
            Chosen::Pod(_) => true,
            Chosen::Unknown(None) => self.watching.is_none() && self.opening.is_none(),
            Chosen::None(_) | Chosen::Unknown(Some(_)) | Chosen::Refused(_) | Chosen::Fault(_) => {
                false
            }
        };
        if ready {
            self.set_ready();
        } else if let Some(proof) = &mut self.proof {
            proof.probe = None;
        }
    }

    fn set_ready(&mut self) {
        self.phase = Phase::Ready;
        self.proof = None;
        self.shared.update(|status| {
            status.state = ForwardState::Ready;
            status.failure = None;
            true
        });
    }

    fn failure(&mut self, words: String) {
        self.failed_after = self.accepted;
        self.shared.update(|status| {
            status.failure = Some(words);
            true
        });
    }

    /// Waits before the next try of the proof under way.
    fn pause(&mut self) {
        if let Some(proof) = &mut self.proof {
            let pause = proof.retries.next().expect("without a limit");
            proof.retry = Some(Instant::now() + pause);
        }
    }

    /// A try to reach a pod failed: a person's proof fails the forward with
    /// it, as does a target that is gone; any other says why and, with
    /// `retry`, tries again after a pause while the forward is used.
    fn unreachable(&mut self, cause: Cause, retry: bool) {
        if self.person() || cause.is_gone() {
            self.fail(cause);
            return;
        }
        self.reconnecting(cause.into_error().message);
        if retry {
            self.pause();
        }
    }

    /// What may pass keeps the forward from its pods, which it says, unless
    /// a person's proof is under way, which ends by itself. The space's
    /// proof ends with this result, and the forward goes on proving only
    /// while it has connections.
    fn reconnecting(&mut self, reason: String) {
        if self.phase == Phase::Starting {
            return;
        }
        self.phase = Phase::Reconnecting;
        if let Some(proof) = &mut self.proof
            && proof.by == Asker::Space
        {
            proof.by = Asker::Connection;
            proof.no_pod_by = None;
        }
        self.say(ForwardState::Reconnecting { reason });
    }

    fn say(&self, state: ForwardState) {
        self.shared.update(|status| {
            let changed = status.state != state;
            status.state = state;
            changed
        });
    }

    /// Ends the connections and the proof under way, until what lifts it.
    fn fail(&mut self, cause: impl Into<Cause>) {
        let cause = cause.into();
        self.phase = Phase::Failed(cause.lift());
        self.proof = None;
        self.cut = self.accepted;
        self.shared.end.send_modify(|ends| *ends += 1);
        self.say(ForwardState::Failed {
            error: cause.into_error(),
        });
    }

    /// The `failure` follows every report, and the state only those of
    /// connections opened after the forward last failed: bytes prove a
    /// forward that is neither ready nor failed, with or without a proof
    /// under way.
    fn report(&mut self, report: Report) {
        match report {
            Report::Served(number) => {
                if number > self.failed_after {
                    self.shared.update(|status| status.failure.take().is_some());
                }
                if number > self.cut && !matches!(self.phase, Phase::Ready | Phase::Failed(_)) {
                    self.proven();
                }
            }
            Report::Failed(number, fault) => {
                if let Some(words) = fault.words() {
                    self.failure(words);
                }
                if number > self.cut {
                    self.ended(fault);
                }
            }
        }
    }

    /// What a connection that failed tells of the forward.
    fn ended(&mut self, fault: Fault) {
        match fault {
            Fault::Fatal(error) => self.fail(error),
            Fault::Port(_) | Fault::Left { alone: false, .. } => {}
            Fault::NoPod(why) | Fault::Left { words: why, .. } => self.reconnecting(why),
            Fault::Transient(cause) if cause.is_gone() => self.fail(cause),
            Fault::Transient(cause) => self.reconnecting(cause.into_error().message),
            Fault::Lost => {
                self.reconnecting("the connection to the cluster was lost".to_owned());
            }
        }
    }

    fn timed_out(&mut self) {
        let now = Instant::now();
        let Some(proof) = &mut self.proof else {
            return;
        };
        if proof.retry.is_some_and(|retry| retry <= now) {
            proof.retry = None;
        }
        if proof.no_pod_by.is_some_and(|by| by <= now) {
            proof.no_pod_by = None;
            let why = match self.shared.pick().choose(now) {
                Chosen::None(why) | Chosen::Unknown(Some(why)) => why,
                Chosen::Unknown(None) => UNANSWERED_YET.to_owned(),
                Chosen::Pod(_) | Chosen::Fault(_) | Chosen::Refused(_) => return,
            };
            self.unreachable(IpcError::new(ErrorKind::Unavailable, why).into(), false);
        }
    }

    fn publish(&mut self) {
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
        if self
            .proof
            .as_ref()
            .is_some_and(|proof| proof.probe.is_some() && received > proof.received_at_probe)
        {
            self.proven();
        }
    }
}
