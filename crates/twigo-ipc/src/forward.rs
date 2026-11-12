//! Port-forwards (ARCHITECTURE 4.6): a local port that reaches a port of a
//! pod, of a Service's pods or of a workload's. A forward belongs to its
//! space and outlives the window: it is kept with the space's state, and the
//! window follows every space's forwards with `forwards_watch`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Gvr, IpcError};

/// Unique in the app and kept across restarts, as a `pf://` tab names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct ForwardId(pub u32);

/// What a forward reaches: a pod, a Service, or a Deployment, ReplicaSet,
/// StatefulSet or DaemonSet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ForwardTarget {
    pub space: String,
    pub gvr: Gvr,
    pub namespace: String,
    pub name: String,
}

/// The TCP ports of a target, in the order of its spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ForwardPorts {
    /// The target's kind, as its tab and its row say it: `Service`.
    pub kind: String,
    pub ports: Vec<ForwardPort>,
    /// The `port` a start without a choice takes: one whose name says HTTP
    /// or web first, then the others in the spec's order, named or not, and
    /// one whose name says metrics, health or debug last.
    pub default: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ForwardPort {
    /// What a start names: a Service's port, or a container's.
    pub port: u16,
    pub name: Option<String>,
    /// A Service's `targetPort` as written, a name or a number, when it is
    /// not `port`.
    pub target_port: Option<String>,
    /// The container that declares it, for a pod or a workload.
    pub container: Option<String>,
    pub app_protocol: Option<String>,
    /// The local port of this port's forward where it has one; else the one
    /// a start takes when none is given: the one this port of this target
    /// had last, else `port`, else, for a `port` below 1024, `port` plus
    /// 8000.
    pub local: u16,
    /// The forward of this port, when the space has one, running or stopped.
    pub forward: Option<ForwardId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct StartForward {
    pub target: ForwardTarget,
    /// A `port` of the target's [`ForwardPorts`].
    pub port: u16,
    /// None takes the port's `local`.
    pub local: Option<u16>,
}

/// Starts a forward again, on `local` when that names another port. A
/// stopped one binds its port and a failed one proves again, both
/// `Starting`. One that waits, starts, is ready or reconnects keeps its state
/// and its connections, and forgets the pods it avoided, so that its next
/// choice may take one that answered 404. One that its context's mode
/// refuses, or whose context no source lists, answers that error and stays as
/// it was: stopped, or failed with the refusal, on its port.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ResumeForward {
    pub id: ForwardId,
    pub local: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ForwardStarted {
    /// Listening: the forward as the command left it, `Starting` for one
    /// started again. A start of a port that has a forward answers as a
    /// resume of that forward does, which moves it when the start names
    /// another `local`. A start or a resume that the context's mode refuses,
    /// or whose context no source lists, answers that error and changes
    /// nothing.
    Started { forward: Box<Forward> },
    /// The local port could not be bound, and nothing was started or kept. A
    /// start of a port with no forward answers it once it has read the
    /// target, so a cluster that does not answer gives the read's error
    /// first.
    Busy {
        local: u16,
        why: BusyWhy,
        /// The next port above `local` that was free on both loopbacks when
        /// asked, from 1024 up.
        free: u16,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BusyWhy {
    /// Another process, or another forward, listens on it.
    InUse,
    /// The system does not let Twigo bind it, as a port below 1024.
    NotPermitted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    pub id: ForwardId,
    pub target: ForwardTarget,
    /// The target's kind: `Service`.
    pub kind: String,
    /// The target's port, as the start named it.
    pub port: u16,
    pub port_name: Option<String>,
    /// The port's `appProtocol`, as the target declares it, so that the
    /// webview can tell an HTTP port without another call.
    pub app_protocol: Option<String>,
    pub local: u16,
    /// The addresses it listens on: `127.0.0.1`, and `::1` where that bound.
    pub addresses: Vec<String>,
    pub state: ForwardState,
    /// The pod new connections go to, once one is chosen.
    pub pod: Option<String>,
    /// The pod's port they reach, once known.
    pub pod_port: Option<u16>,
    /// Open TCP connections, those waiting for a session included.
    pub connections: u32,
    /// Of `connections`, those waiting for a place among the context's
    /// sessions (ARCHITECTURE 3.2).
    pub queued: u32,
    /// Bytes to the pod and from it, since the app started.
    pub sent: u64,
    pub received: u64,
    /// What the last connection that failed said, until a connection opened
    /// after it carries bytes from the pod, or the forward is ready again
    /// after not being so: a pod's port that refused, a pod whose upgrade
    /// answered 404, no pod to go to within the wait, a cluster that did not
    /// answer.
    pub failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ForwardState {
    /// Listening, while the start or the resume a person asked for finds a
    /// pod and a first stream proves that it can be reached; it ends `Ready`
    /// or `Failed`.
    Starting,
    /// Listening, and not proven since the app started or since a refusal
    /// was lifted. Its first connection, or its space's connecting, makes it
    /// ask; nothing else does. It stays `Restored` while its first
    /// connection's proof is under way and if that connection leaves before
    /// the proof ends, and its space's connecting meanwhile makes that proof
    /// the space's.
    Restored,
    Ready,
    /// No pod can be reached, for the reason given: none is ready, the
    /// cluster does not answer or refuses for now, or a stream to a pod
    /// failed, which a 404 for one pod behind a Service or a workload is only
    /// when no other is left. It looks again while it has connections, and
    /// at the next one.
    Reconnecting {
        reason: String,
    },
    /// Still listening. Its connections end and what it accepts is closed at
    /// once, but for one whose target is gone, whose next connection is
    /// served to look at the target again. A start or a resume fails it for
    /// anything, what may pass too: a cluster that does not answer, no ready
    /// pod within the wait, a refused port, a 403; only a first stream lost
    /// to clients replaced or a network that moved is tried again after a
    /// pause, and a 404 for one pod behind a Service or a workload takes
    /// another while one is left. The proofs its connections, its space's
    /// connecting and a sign-in ask for fail it only for the gate's refusal,
    /// a context that no source lists, a credential failure or a target that
    /// is gone, and its context's mode and the catalog fail it too. A start
    /// or a resume starts it again, unless its context's mode or the catalog
    /// refuses it, which answers that error; a lifted refusal makes it wait,
    /// `Restored`; one whose target is gone looks at it again at its next
    /// connection, and one that failed for a credential is proven again by
    /// its space's connecting or by a sign-in the person started that gets a
    /// credential.
    Failed {
        error: IpcError,
    },
    /// Not listening; kept so that it can be started again.
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ForwardEvent {
    /// New, or changed: at most four times a second for one forward.
    Changed {
        forward: Box<Forward>,
    },
    Removed {
        id: ForwardId,
    },
}
