use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// How much a context lets through (ARCHITECTURE 6.4). Rust owns it, and the
/// webview only shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    ReadWrite,
    Guarded,
    ReadOnly,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Mode::ReadWrite => "read-write",
            Mode::Guarded => "guarded",
            Mode::ReadOnly => "read-only",
        }
    }
}

/// What a context is marked as, by a person or its kubeconfig; a context
/// nobody marked has none. It sets the default mode and colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Environment {
    Production,
    Staging,
    Development,
    Local,
}

/// Where a context's mode comes from, highest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ModeSource {
    /// The admin's file, which the UI cannot change or unlock. `pattern` is
    /// the entry that matched the context; none when the file cannot be
    /// read, which locks every context.
    PolicyFile {
        file: String,
        pattern: Option<String>,
    },
    /// No source lists it now, so nothing says what it lets through.
    Unlisted,
    /// Only in what a request was blocked by: its name means another cluster
    /// now than the clients the request came through reach.
    Moved,
    /// The person's choice for this context.
    User,
    /// `twigo.readOnly` in its kubeconfig metadata.
    Kubeconfig,
    /// Its catalog provider.
    Provider,
    /// The default of its environment type.
    Environment { environment: Environment },
    /// Nothing says otherwise.
    Default,
}

/// What a context lets through now, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextAccess {
    /// In force now: `guarded` while a `read-only` context is unlocked.
    pub mode: Mode,
    /// Where the mode comes from, an unlock aside.
    pub source: ModeSource,
    pub environment: Option<Environment>,
    /// When an unlock ends and the context relocks, in milliseconds since
    /// the epoch.
    pub unlocked_until: Option<i64>,
}

/// Sets the person's mode for a context; none goes back to what the rest
/// says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetContextMode {
    pub context: String,
    pub mode: Option<Mode>,
}

/// Marks a context as an environment type; none says it has no type, whatever
/// its kubeconfig says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetContextEnvironment {
    pub context: String,
    pub environment: Option<Environment>,
}

/// What the person asks whether they may do in a space, as RBAC names it,
/// in one namespace or, with none, in all of them and for cluster-scoped
/// resources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AccessQuery {
    pub space: String,
    pub namespace: Option<String>,
    pub checks: Vec<Access>,
}

/// One thing RBAC may allow: `patch` on `deployments/scale` of `apps`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct Access {
    pub verb: String,
    /// Empty for the core group.
    pub group: String,
    pub resource: String,
    pub subresource: Option<String>,
}

/// What the gate takes a request for (ARCHITECTURE 6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RequestClass {
    Read,
    DryRun,
    Write,
    SecretRead,
    Forward,
    Exec,
}

/// Why the gate stopped it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BlockReason {
    /// The context's mode.
    Mode,
    /// The actor has no grant for it, whatever the mode.
    NoGrant,
    /// It needs a person's approval, and nothing can ask.
    NoApproval,
}

/// A request the gate stopped before it left the process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Blocked {
    pub context: String,
    pub mode: Mode,
    pub source: ModeSource,
    pub class: RequestClass,
    pub reason: BlockReason,
    /// What it asked for, as RBAC names it: `create`, `get`, `proxy`.
    pub verb: String,
    /// What it asked that of: `pods/web-1/exec in default`, or a path.
    pub target: String,
}

impl fmt::Display for Blocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self {
            context,
            mode,
            source,
            verb,
            target,
            ..
        } = self;
        match self.reason {
            BlockReason::Mode => {
                let mode = mode.name();
                write!(f, "{context} is {mode}")?;
                write_source(f, source)?;
            }
            BlockReason::NoGrant => write!(f, "this actor has no grant for it on {context}")?,
            BlockReason::NoApproval => {
                write!(f, "{context} asks for an approval, and nothing can ask")?;
            }
        }
        write!(f, ", so Twigo did not send {verb} {target}")
    }
}

fn write_source(f: &mut fmt::Formatter<'_>, source: &ModeSource) -> fmt::Result {
    match source {
        ModeSource::PolicyFile {
            file,
            pattern: Some(pattern),
        } => write!(f, " by {pattern} in {file}"),
        ModeSource::PolicyFile {
            file,
            pattern: None,
        } => write!(f, " because {file} cannot be read"),
        ModeSource::User => write!(f, " by your choice"),
        ModeSource::Kubeconfig => write!(f, " by its kubeconfig"),
        ModeSource::Provider => write!(f, " by its provider"),
        ModeSource::Environment { environment } => {
            write!(f, " as {environment:?} by default")
        }
        ModeSource::Default => Ok(()),
        ModeSource::Unlisted => write!(f, " because no source lists it now"),
        ModeSource::Moved => write!(f, " because it names another cluster now"),
    }
}

impl std::error::Error for Blocked {}
