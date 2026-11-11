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
    /// before the others, one that says metrics, health or debug last.
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
    /// The local port a start takes when none is given: the one this port
    /// of this target had last, else `port`, else, for a `port` below 1024,
    /// `port` plus 8000.
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

/// Starts a stopped forward again, on another local port when `local` names
/// one.
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
    /// Listening. A port that has a forward already answers with that one,
    /// started again if it was stopped.
    Started { forward: Box<Forward> },
    /// The local port could not be bound, and nothing was started or kept.
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
    /// What the last connection that failed said, since the forward was
    /// last ready: a pod's port that refused, a pod that went.
    pub failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ForwardState {
    /// Listening, while the first pod is found and a first stream proves
    /// that it can be reached.
    Starting,
    /// Listening since the app started, its cluster not asked yet: the
    /// first connection, or the space's connecting, starts it.
    Restored,
    Ready,
    /// It worked, and now waits: for a pod that is ready, or for the
    /// cluster to answer.
    Reconnecting {
        reason: String,
    },
    /// Still listening, and every connection is closed at once: the target
    /// is gone, the cluster refused, or the context's mode does.
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
