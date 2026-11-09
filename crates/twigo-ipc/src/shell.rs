//! A shell in a pod's container, or an attach to its main process
//! (ARCHITECTURE 4.6). A plan of the command bus says what it may do, and its
//! run answers with a session that starts once the tab has opened it with the
//! terminal's size. Over the session's channel come the bytes of its output,
//! each frame an `ArrayBuffer`, and its [`ShellEvent`]s in the same order.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{IpcError, SubscriptionId};

/// A pod a shell may be opened in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ShellPod {
    pub space: String,
    pub namespace: String,
    pub pod: String,
}

/// The containers of a pod a shell can reach, those that run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ShellContainers {
    pub containers: Vec<String>,
    /// The one its `kubectl.kubernetes.io/default-container` annotation
    /// names, when that one runs, else the first of `containers`.
    pub default: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ShellTarget {
    pub space: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ShellKind {
    /// Runs a new shell in the container.
    Shell,
    /// Joins the container's main process.
    Attach,
}

/// Starts the session a plan's run answered with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct OpenShell {
    pub id: SubscriptionId,
    pub cols: u16,
    pub rows: u16,
}

/// What the person typed or pasted, in the order the webview sends it, one
/// call at a time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ShellInput {
    pub id: SubscriptionId,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ShellResize {
    pub id: SubscriptionId,
    pub cols: u16,
    pub rows: u16,
}

/// How many bytes of output the terminal has parsed since the last ack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ShellAck {
    pub id: SubscriptionId,
    pub bytes: u32,
}

/// How a session goes; `ended` comes last, after all the output of a process
/// that ended. A session cut short by `relocked`, or by a `connectionLost`
/// from a wake, a moved route or replaced clients, sends only the output it
/// had gathered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ShellEvent {
    /// Waits for a place among the cluster's sessions (ARCHITECTURE 3.2).
    Queued,
    Connecting,
    Running,
    Ended {
        end: ShellEnd,
    },
}

/// Why a session ended; none can resume, as an exec cannot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ShellEnd {
    Exited {
        code: i32,
    },
    /// An attach ended with no exit code: the kubelet answers `Success` to
    /// any attach that did not fail, whatever the process did.
    Detached,
    /// The container has no shell to run, in the words of its runtime.
    NoShell {
        message: String,
    },
    /// It could not start: the pod has gone, or the cluster refused.
    Failed {
        error: IpcError,
    },
    /// The connection broke before the process said how it ended: a wake, a
    /// moved route, a socket that closed with no status, or a failure of the
    /// stream after output.
    ConnectionLost,
    /// The context became read-only before the session ended, whether it
    /// was parked, queued, connecting or running.
    Relocked,
}

/// What a session's channel carries: its output as bytes, and its events.
/// Only TypeScript reads this type, which Rust sends as two kinds of body.
#[derive(TS)]
#[ts(type = "ArrayBuffer | ShellEvent")]
pub struct ShellMessage;
