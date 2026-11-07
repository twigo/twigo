//! Commands that change a cluster or show secret-grade data, as the command
//! bus plans and runs them (ARCHITECTURE 5.1, 6.4): the webview asks for a
//! plan by resource references, draws the friction the plan names, and runs
//! the plan by its id with what proves the friction was met.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Environment, Gvr, IpcError, Mode, SubscriptionId};

/// An object of a space, by its resource as discovery names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ResourceRef {
    pub gvr: Gvr,
    pub namespaced: bool,
    /// None for a cluster-scoped object.
    pub namespace: Option<String>,
    pub name: String,
}

/// What a person asks a command to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PlanRequest {
    /// Deletes an object as `kubectl delete` does: its dependents in the
    /// background, then waits until it is gone.
    Delete { space: String, target: ResourceRef },
    /// Shows a value of an open Secret.
    Reveal { object: SubscriptionId, key: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct PlanId(pub u32);

/// What a command will do, for the person to confirm. It runs only by its
/// id, once, on the cluster it was planned for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: PlanId,
    pub context: String,
    pub environment: Option<Environment>,
    pub mode: Mode,
    pub friction: Friction,
    /// The question a dialog asks, naming the cluster: `Delete pod web-1
    /// from kind-a?`
    pub question: String,
    /// What the confirming button says: `Delete pod`.
    pub confirm: String,
    /// What follows, a sentence each.
    pub consequences: Vec<String>,
    /// The kubectl command that does the same.
    pub kubectl: String,
    /// What a toast or the status bar says while it counts down or runs:
    /// `Deleting pod web-1`.
    pub doing: String,
}

/// What a person goes through before a plan runs, by what it risks and the
/// context's mode (ARCHITECTURE 6.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Friction {
    /// It runs as asked.
    AtOnce,
    /// A toast counts down, and the plan runs once it ends unless cancelled.
    Countdown { seconds: u32 },
    /// A dialog asks.
    Confirm,
    /// A dialog asks for `text` typed.
    Typed { text: String },
}

/// Runs a plan, with what its friction asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Execute {
    pub plan: PlanId,
    /// What the person typed, for a `typed` friction.
    pub typed: Option<String>,
}

/// How a running plan goes, over its channel; every kind but `running` is
/// the last.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OperationEvent {
    /// Under way, as it says: `Waiting for pod web-1 to go`.
    Running {
        text: String,
    },
    /// Done, as it says: `Deleted pod web-1`.
    Done {
        text: String,
    },
    /// Stopped on request, as it says, with what it sent standing.
    Stopped {
        text: String,
    },
    /// A Secret's value, shown until the Reveal ends; base64 when it is
    /// not UTF-8.
    Revealed {
        value: String,
        binary: bool,
    },
    Failed {
        error: IpcError,
    },
}
