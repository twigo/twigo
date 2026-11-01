use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// An exec credential plugin as the kubeconfig names it (ARCHITECTURE 6.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExecPlugin {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<EnvVar>,
    /// Identifies what the person trusts: the command, its arguments and
    /// its environment.
    pub digest: String,
    /// It may open a browser or print a device code, so it runs only while
    /// a Twigo window has the focus.
    pub signs_in: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// How a context gets its credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ContextAuth {
    /// No plugin: a token, a certificate or nothing, from the kubeconfig.
    None,
    /// The kubeconfig's entry for the context cannot be used.
    Invalid { message: String },
    /// The plugin runs only once the person trusts it.
    Untrusted { plugin: ExecPlugin },
    Plugin {
        plugin: ExecPlugin,
        status: PluginStatus,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PluginStatus {
    /// Not run since Twigo started, or since the cluster rejected its
    /// credential.
    Idle,
    /// It may ask the person to sign in, so it waits for a Twigo window to
    /// have the focus.
    Waiting,
    /// What it printed on stderr so far: device codes and URLs.
    Running {
        /// When the run started, RFC 3339.
        since: String,
        output: String,
    },
    Ready {
        /// RFC 3339; none when the credential lasts until the cluster
        /// rejects it.
        expires: Option<String>,
    },
    Failed {
        error: String,
        output: String,
        /// The kubeconfig's `installHint`, when the command was not found.
        install_hint: Option<String>,
    },
}

/// The plugins the kubeconfigs name that the person has not trusted, for
/// the review on the first start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ExecReview {
    /// The person has answered a review before, so a new plugin asks only
    /// when it is about to run.
    pub reviewed: bool,
    pub plugins: Vec<ReviewedPlugin>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReviewedPlugin {
    pub plugin: ExecPlugin,
    /// The contexts that use it.
    pub contexts: Vec<String>,
}
