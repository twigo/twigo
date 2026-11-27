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

/// What a context is marked as, by a person, or by its kubeconfig where that
/// tightens: Production or Staging; a context nobody marked has none. It
/// sets the default mode and colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Environment {
    Production,
    Staging,
    Development,
    Local,
}

/// Where a context's mode comes from, highest first (ARCHITECTURE 6.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ModeSource {
    /// No source lists it now, so nothing says what it lets through.
    Unlisted,
    /// Only in what a request was blocked by: its name means another cluster
    /// now than the clients the request came through reach.
    Moved,
    /// The admin's file, which the UI cannot change or unlock. `pattern` is
    /// the entry that matched the context; none when the file cannot be
    /// read, which locks every context, and `reason` says why in words that
    /// quote nothing of it: the kind of the read's failure, or where it does
    /// not parse.
    PolicyFile {
        file: String,
        pattern: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
    },
    /// The person's own protection file, which holds their modes and types,
    /// cannot be read, so every context is `read-only` until it is restored
    /// or removed and Twigo starts again. `reason` says why as the policy
    /// file's does, quoting nothing of it.
    ProtectionUnreadable { file: String, reason: String },
    /// The person's choice for this context, through a confirmed command.
    /// `overrides` is the lock it sets aside: what the kubeconfig, the
    /// provider or the type would give, where that is stricter.
    User { overrides: Option<Lock> },
    /// `twigo.readOnly` in its kubeconfig metadata with any value but
    /// `false`, the strictest of the locks.
    Kubeconfig,
    /// Its catalog provider's lock, the strictest of the locks.
    Provider,
    /// The default of its environment type, the strictest of the locks.
    Environment { environment: Environment },
    /// Nothing marks it: no type, no lock and no choice. It is `guarded`
    /// until the person says what it is, which its first write or exec asks.
    Unmarked,
}

/// A mode that a kubeconfig, a provider or a type gives, which can only
/// tighten a context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Lock {
    pub mode: Mode,
    pub source: LockSource,
}

/// Where a lock comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LockSource {
    Kubeconfig,
    Provider,
    Environment { environment: Environment },
}

/// What a context lets through now, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextAccess {
    /// In force now: `guarded` while a `read-only` context is unlocked.
    pub mode: Mode,
    /// Where the mode comes from, an unlock aside.
    pub source: ModeSource,
    /// The person's type, else its kubeconfig's where that is a lock.
    pub environment: Option<Environment>,
    /// When an unlock ends and the context relocks, in milliseconds since
    /// the epoch.
    pub unlocked_until: Option<i64>,
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
    /// The one object it is for, which a rule that lists `resourceNames`
    /// needs; none for the resource as a whole.
    pub name: Option<String>,
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
    /// A write or an exec on a context nobody marked: the person says what
    /// the context is first.
    Unmarked,
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
            BlockReason::Unmarked => write!(f, "nobody has said what {context} is yet")?,
        }
        write!(f, ", so Twigo did not send {verb} {target}")
    }
}

fn write_source(f: &mut fmt::Formatter<'_>, source: &ModeSource) -> fmt::Result {
    match source {
        ModeSource::PolicyFile {
            file,
            pattern: Some(pattern),
            ..
        } => write!(f, " by {pattern} in {file}"),
        ModeSource::PolicyFile {
            file,
            pattern: None,
            ..
        } => write!(f, " because {file} cannot be read"),
        ModeSource::ProtectionUnreadable { file, .. } => {
            write!(f, " because {file} cannot be read")
        }
        ModeSource::User { .. } => write!(f, " by your choice"),
        ModeSource::Kubeconfig => write!(f, " by its kubeconfig"),
        ModeSource::Provider => write!(f, " by its provider"),
        ModeSource::Environment { environment } => {
            write!(f, " as {environment:?} by default")
        }
        ModeSource::Unmarked => write!(f, " until you say what it is"),
        ModeSource::Unlisted => write!(f, " because no source lists it now"),
        ModeSource::Moved => write!(f, " because it names another cluster now"),
    }
}

impl std::error::Error for Blocked {}
