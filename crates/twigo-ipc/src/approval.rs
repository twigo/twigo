//! The approval broker (ARCHITECTURE 6.4): a process that reaches a cluster
//! through the policy proxy asks before a write or an exec in a `guarded`
//! context, and the person answers in the window the process belongs to.
//! Nothing passes while an ask waits, and a window that cannot ask denies.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::RequestClass;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct ApprovalId(pub u32);

/// What a process asks to do, for the person to allow or deny.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAsk {
    pub id: ApprovalId,
    pub context: String,
    /// The process, as Twigo named it when it gave the process its token:
    /// `Terminal 2`.
    pub process: String,
    /// What the client says it runs, `kubectl apply`, from its own
    /// `Kubectl-Command` header: a label, never checked.
    pub command: Option<String>,
    /// The word a person reads in "Allow Terminal 2 to <verb> <target>":
    /// `exec` for `pods/exec` and `attach` for `pods/attach`, which RBAC
    /// calls `create` or `get`, and RBAC's verb otherwise: `create`, `patch`,
    /// `delete`.
    pub verb: String,
    /// `write` or `exec`.
    pub class: RequestClass,
    /// As people and `kubectl` name it: `deployments/web in default`.
    pub target: String,
    /// Whom the request acts as, from `kubectl --as`, `--as-group` and
    /// `--as-uid`: the user and, when the request names them, the groups,
    /// the uid and the extras, in one line: `x, groups system:masters`.
    pub impersonate: Option<String>,
    pub detail: ApprovalDetail,
    /// Whether the context's name must be typed before it is allowed: a
    /// delete's.
    pub typed: bool,
    /// How long an answer of `lasting` holds, offered for every ask but a
    /// delete's: every write and exec of this process on this context for
    /// that long, deletes excepted.
    pub lasting_minutes: Option<u32>,
}

/// What Twigo could show of what the request would do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ApprovalDetail {
    /// The object as it is and as a dry run of the same request would store
    /// it, both masked for a Secret.
    Diff {
        /// Null for a create.
        #[ts(type = "unknown")]
        live: Value,
        #[ts(type = "unknown")]
        result: Value,
        /// The server's `Warning` headers on the dry run.
        warnings: Vec<String>,
    },
    /// What an exec runs or an attach joins; `command` is empty for an
    /// attach.
    Session {
        container: Option<String>,
        command: Vec<String>,
        tty: bool,
        stdin: bool,
    },
    /// A delete, with the propagation its options ask for.
    Delete { propagation: Option<String> },
    /// No dry run could say what it does, and why; the request's body as
    /// sent where it can be shown, never a Secret's.
    Unknown {
        reason: NoDiff,
        body: Option<String>,
    },
}

/// Why a write has no diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NoDiff {
    /// A subresource, such as `scale`, which no dry run covers.
    Subresource,
    /// An aggregated API server serves it, which may not honour a dry run.
    Aggregated,
    /// Whether an aggregated API server serves it could not be read.
    Unverified,
    /// The server refused the dry run, in its words, while the write itself
    /// may pass: a webhook that does not support dry runs.
    Refused { message: String },
    /// Not a resource Twigo can read: a path outside the API's resources, or
    /// a write that no dry run covers, as a review of authorization.k8s.io
    /// answers whatever `dryRun` says.
    NotAResource,
}

/// What the broker tells a window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ApprovalEvent {
    Asked {
        ask: Box<ApprovalAsk>,
    },
    /// The ask needs no answer any more: the process gave up, ended, or the
    /// context's mode changed.
    Withdrawn {
        id: ApprovalId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalAnswer {
    Deny,
    Once,
    /// For the ask's `lasting_minutes`.
    Lasting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AnswerApproval {
    pub id: ApprovalId,
    pub answer: ApprovalAnswer,
    /// What the person typed, for an ask with `typed`.
    pub typed: Option<String>,
}
