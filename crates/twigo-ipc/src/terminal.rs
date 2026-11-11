//! A terminal on this machine pinned to a context (ARCHITECTURE 4.6): a pty
//! running the login shell with the login shell's environment, whose
//! `KUBECONFIG` is Twigo's file of the context followed by the user's own
//! files, or the policy proxy's file alone. It runs over the shell commands:
//! `terminal_create` parks it, and `shell_open` starts it with the terminal's
//! size.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::SubscriptionId;

/// A terminal to start for `context`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct NewTerminal {
    pub context: String,
    /// What its asks and its offers call it, as its tab does: `Terminal 2`.
    pub label: String,
}

/// A parked terminal, which starts once `shell_open` names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TerminalSession {
    pub id: SubscriptionId,
    pub kind: TerminalKind,
    /// The shell's file name: `zsh`.
    pub shell: String,
}

/// How a terminal reaches clusters, which its tab shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalKind {
    /// With the user's own credentials, every context of their kubeconfig
    /// within reach: Twigo's file first, holding the context, then the
    /// user's files.
    Kubeconfig,
    /// Only through the policy proxy, which follows each context's mode.
    Proxy { why: ProxyWhy },
}

/// Why a terminal goes through the policy proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProxyWhy {
    /// Its context was not `read-write` when it started, unlocked included.
    Mode,
    /// Its context comes from a provider, with no kubeconfig entry to point
    /// at.
    Provider,
    /// The admin's policy file says so for its context.
    PolicyFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct KubeconfigOfferId(pub u32);

/// Entries a tool wrote into a terminal's own kubeconfig, such as `aws eks
/// update-kubeconfig` does, offered for moving into the user's kubeconfig.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct KubeconfigOffer {
    pub id: KubeconfigOfferId,
    /// The terminal's label.
    pub terminal: String,
    /// The id `terminal_create` answered for the terminal, which finds its
    /// tab where labels repeat: every space has its own `Terminal 1`.
    pub session: SubscriptionId,
    /// The context the terminal was pinned to.
    pub context: String,
    pub contexts: Vec<String>,
    pub clusters: Vec<String>,
    pub users: Vec<String>,
    /// The user's file a move writes to, the one kubectl writes new entries
    /// to, as a person reads it: `~/.kube/config`.
    pub target: String,
    /// The names among these that the user's files hold already, which a
    /// move leaves out.
    pub taken: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KubeconfigOfferEvent {
    /// New, or in place of the offer of the same id, as more entries came.
    Offered { offer: KubeconfigOffer },
    /// Answered, or gone with the app's window.
    Withdrawn { id: KubeconfigOfferId },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum KubeconfigOfferAnswer {
    Move,
    Dismiss,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AnswerKubeconfigOffer {
    pub id: KubeconfigOfferId,
    pub answer: KubeconfigOfferAnswer,
}
