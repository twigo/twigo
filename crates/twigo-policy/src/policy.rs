//! Each context's mode and where it comes from (ARCHITECTURE 6.4), read
//! anew for every request, so a change reaches clients already built.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use tokio::sync::watch;
use twigo_ipc::{
    BlockReason, Blocked, ContextAccess, Environment, Friction, Lock, LockSource, Mode, ModeSource,
    RequestClass,
};

use crate::{Actor, Approval, Attributes, Audit, By, Entry, Gate, PolicyFile};

/// How long an unlock lasts.
pub const UNLOCK: SignedDuration = SignedDuration::from_mins(15);

/// How long a relock may lag behind its time while the machine sleeps, as
/// timers stop with it. The gate reads the clock, so this delays only what
/// the UI hears.
const RELOCK_CHECK: Duration = Duration::from_secs(30);

/// What a provider can lock a context to: a lock only tightens, so it never
/// says `read-write`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderLock {
    Guarded,
    ReadOnly,
}

impl ProviderLock {
    fn mode(self) -> Mode {
        match self {
            ProviderLock::Guarded => Mode::Guarded,
            ProviderLock::ReadOnly => Mode::ReadOnly,
        }
    }
}

/// What a kubeconfig's `twigo.environment` can lock a context to: a type
/// there only tightens, so Development and Local say nothing (D16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeLock {
    Production,
    Staging,
}

impl TypeLock {
    /// The lock a kubeconfig's `environment` gives, none for a type that
    /// would lower the context's mode.
    pub fn of(environment: Environment) -> Option<Self> {
        match environment {
            Environment::Production => Some(TypeLock::Production),
            Environment::Staging => Some(TypeLock::Staging),
            Environment::Development | Environment::Local => None,
        }
    }

    fn environment(self) -> Environment {
        match self {
            TypeLock::Production => Environment::Production,
            TypeLock::Staging => Environment::Staging,
        }
    }
}

/// What the catalog says of a context it lists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Metadata {
    /// `twigo.readOnly` in its kubeconfig, a lock to `read-only`.
    pub read_only: bool,
    /// What its provider locks it to; kubeconfig contexts have none.
    pub provider: Option<ProviderLock>,
    /// The type its kubeconfig locks it to.
    pub environment: Option<TypeLock>,
    /// Changes when what it connects to does, or what its kubeconfig says of
    /// it: an unlock holds only for what it was given on.
    pub connection: u64,
    /// Changes with each change of the rest, and when the context is listed
    /// again, and never comes back to a value it had, so that what holds to
    /// it ends with a change that went back.
    pub revision: u64,
}

/// What the person chose, by context.
/// @todo: move the mode and the type to settings.json once the settings files come in M3
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Choices {
    #[serde(default, deserialize_with = "each")]
    pub modes: BTreeMap<String, Mode>,
    /// None says it has no type, whatever its kubeconfig says.
    #[serde(default, deserialize_with = "each")]
    pub environments: BTreeMap<String, Option<Environment>>,
}

/// A value that does not read back costs that value only (ARCHITECTURE 4.8),
/// and not the other contexts' locks.
fn each<'de, D, T>(deserializer: D) -> Result<BTreeMap<String, T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let values = BTreeMap::<String, serde_json::Value>::deserialize(deserializer)?;
    Ok(values
        .into_iter()
        .filter_map(|(context, value)| Some((context, serde_json::from_value(value).ok()?)))
        .collect())
}

/// A change of a context's protection that a person asks for (ARCHITECTURE
/// 6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Change {
    /// The person's mode, none for what its locks say.
    Mode { mode: Option<Mode> },
    /// The person's type, none for no type whatever its kubeconfig says.
    Type { environment: Option<Environment> },
    /// `read-only` through as `guarded` for [`UNLOCK`].
    Unlock,
}

/// A change as a plan shows it: what the context is before and after, and
/// what [`Policy::change`] holds it to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedChange {
    pub change: Change,
    pub before: ContextAccess,
    pub after: ContextAccess,
    /// [`Policy::changes_of`] the context when it was planned.
    changes: u64,
    /// [`Metadata::revision`] of the context when it was planned.
    revision: u64,
}

/// Why a command could not change a context's mode.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("{0} in {1} sets this context's mode, which Twigo cannot change")]
    PolicyFile(String, String),
    #[error("{0} cannot be read, so Twigo keeps every context read-only")]
    PolicyFileUnreadable(String),
    #[error("{0} is {1}, so there is nothing to unlock")]
    NotLocked(String, &'static str),
    #[error("no source lists {0}, so Twigo changed nothing of it")]
    Unlisted(String),
    #[error("what {0} lets through changed since Twigo asked, so Twigo changed nothing")]
    Changed(String),
}

/// None for a context no source lists now.
type ReadMetadata = Box<dyn Fn(&str) -> Option<Metadata> + Send + Sync>;

pub struct Policy {
    file: PolicyFile,
    metadata: ReadMetadata,
    /// The type of a context the person has not marked: Local in
    /// [`Policy::open`], none in the app's, where such a context asks.
    assumed: Option<Environment>,
    held: Mutex<Held>,
    changes: watch::Sender<u64>,
    audit: Audit,
}

#[derive(Clone)]
struct Held {
    choices: Choices,
    /// By context. Never stored: a restart relocks.
    unlocks: HashMap<String, Unlock>,
    /// By context: how many times a choice, an unlock or its end changed
    /// what it lets through.
    changed: HashMap<String, u64>,
}

impl Held {
    fn changed(&mut self, context: &str) {
        *self.changed.entry(context.to_owned()).or_default() += 1;
    }

    fn changes_of(&self, context: &str) -> u64 {
        self.changed.get(context).copied().unwrap_or_default()
    }

    fn end_unlock(&mut self, context: &str) -> bool {
        let ended = self.unlocks.remove(context).is_some();
        if ended {
            self.changed(context);
        }
        ended
    }

    /// Ends for good an unlock given on another connection than the
    /// context's now: a kubeconfig edited back gives the same fingerprint
    /// again. Says why, as the audit log names it.
    fn end_moved(&mut self, context: &str, metadata: Option<Metadata>) -> Option<&'static str> {
        let unlock = self.unlocks.get(context)?;
        let by = match metadata {
            None => "unlisted",
            Some(metadata) if metadata.connection != unlock.connection => "moved",
            Some(_) => return None,
        };
        self.end_unlock(context);
        Some(by)
    }

    /// Makes `change`. A choice ends an unlock, since it is what the person
    /// means now, and marking a context Production again must not bring an
    /// unlock back.
    fn make(&mut self, context: &str, change: Change, metadata: &Metadata, until: Timestamp) {
        match change {
            Change::Mode { mode } => {
                self.unlocks.remove(context);
                match mode {
                    Some(mode) => self.choices.modes.insert(context.to_owned(), mode),
                    None => self.choices.modes.remove(context),
                };
            }
            Change::Type { environment } => {
                self.unlocks.remove(context);
                self.choices
                    .environments
                    .insert(context.to_owned(), environment);
            }
            Change::Unlock => {
                let unlock = Unlock {
                    until,
                    connection: metadata.connection,
                };
                self.unlocks.insert(context.to_owned(), unlock);
            }
        }
        self.changed(context);
    }
}

#[derive(Clone, Copy)]
struct Unlock {
    until: Timestamp,
    /// [`Metadata::connection`] as it was given.
    connection: u64,
}

impl Policy {
    pub fn new(
        file: PolicyFile,
        metadata: impl Fn(&str) -> Option<Metadata> + Send + Sync + 'static,
        choices: Choices,
        audit: Audit,
    ) -> Arc<Self> {
        Self::assuming(file, metadata, choices, audit, None)
    }

    /// Where every context is a Local one, so `read-write`: for the tools
    /// and tests that own the clusters they reach.
    pub fn open() -> Arc<Self> {
        Self::assuming(
            PolicyFile::default(),
            |_| Some(Metadata::default()),
            Choices::default(),
            Audit::off(),
            Some(Environment::Local),
        )
    }

    fn assuming(
        file: PolicyFile,
        metadata: impl Fn(&str) -> Option<Metadata> + Send + Sync + 'static,
        choices: Choices,
        audit: Audit,
        assumed: Option<Environment>,
    ) -> Arc<Self> {
        Arc::new(Self {
            file,
            metadata: Box::new(metadata),
            assumed,
            held: Mutex::new(Held {
                choices,
                unlocks: HashMap::new(),
                changed: HashMap::new(),
            }),
            changes: watch::Sender::new(0),
            audit,
        })
    }

    /// Where the gate logs the writes it sends or stops, and the command
    /// bus what a person confirmed.
    pub fn audit(&self) -> &Audit {
        &self.audit
    }

    /// The gate of `actor` on `context`, for clients built from what the
    /// catalog says of it now.
    pub fn gate(self: &Arc<Self>, context: &str, actor: Actor) -> Gate {
        let connection = self.connection(context);
        Gate::new(Arc::clone(self), context, actor, connection)
    }

    /// The gate of clients built for `connection`, a [`Metadata::connection`]
    /// read with what they are built from.
    pub fn gate_for(self: &Arc<Self>, context: &str, actor: Actor, connection: u64) -> Gate {
        Gate::new(Arc::clone(self), context, actor, Some(connection))
    }

    /// Ticks at every change of what [`Policy::access`] answers.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn access(&self, context: &str) -> ContextAccess {
        self.access_at(context, Timestamp::now())
    }

    fn access_at(&self, context: &str, now: Timestamp) -> ContextAccess {
        let metadata = (self.metadata)(context);
        let mut held = self.held();
        let ended = held.end_moved(context, metadata);
        let access = self.resolved(&held, context, metadata, now);
        drop(held);
        self.relocked(context, ended);
        access
    }

    fn resolved(
        &self,
        held: &Held,
        context: &str,
        metadata: Option<Metadata>,
        now: Timestamp,
    ) -> ContextAccess {
        let environment = match held.choices.environments.get(context) {
            Some(marked) => *marked,
            None => self.assumed.or_else(|| {
                metadata
                    .and_then(|metadata| metadata.environment)
                    .map(TypeLock::environment)
            }),
        };
        let (mode, source) = self.resolve(context, held, metadata, environment);
        let unlocked = held
            .unlocks
            .get(context)
            .filter(|unlock| unlock.until > now);
        match unlocked {
            Some(unlock)
                if mode == Mode::ReadOnly && !matches!(source, ModeSource::PolicyFile { .. }) =>
            {
                ContextAccess {
                    mode: Mode::Guarded,
                    source,
                    environment,
                    unlocked_until: Some(unlock.until.as_millisecond()),
                }
            }
            _ => ContextAccess {
                mode,
                source,
                environment,
                unlocked_until: None,
            },
        }
    }

    fn resolve(
        &self,
        context: &str,
        held: &Held,
        metadata: Option<Metadata>,
        environment: Option<Environment>,
    ) -> (Mode, ModeSource) {
        if let Some(set) = self.file.mode(context) {
            return set;
        }
        // Clients built before it went may still run, and what its kubeconfig
        // said of it is no longer known.
        let Some(metadata) = metadata else {
            return (Mode::ReadOnly, ModeSource::Unlisted);
        };
        let lock = strictest(&metadata, environment);
        if let Some(mode) = held.choices.modes.get(context) {
            let overrides = lock.filter(|lock| lock.mode > *mode);
            return (*mode, ModeSource::User { overrides });
        }
        match lock {
            Some(Lock { mode, source }) => (mode, mode_source(source)),
            None => (Mode::Guarded, ModeSource::Unmarked),
        }
    }

    /// Whether `attributes` may leave the process, with no approval.
    pub fn authorize(
        &self,
        context: &str,
        attributes: &Attributes,
        actor: Actor,
    ) -> Result<(), Box<Blocked>> {
        self.decide(context, self.access(context), attributes, actor, None)
            .map(|_| ())
    }

    /// Whether a person's approval of exactly this request would let it
    /// through now: what the gate refuses for want of an approval that no
    /// answer can give, such as an agent's write to a Secret, is never asked
    /// about.
    pub fn approvable(&self, context: &str, attributes: &Attributes, actor: Actor) -> bool {
        let (access, exact) = (
            self.access(context),
            Approval::once(context, actor, attributes),
        );
        self.decide(context, access, attributes, actor, Some(&exact))
            .is_ok()
    }

    /// [`Policy::authorize`], for clients built for `connection`, of a
    /// request that carries `approval`: once the context's name means
    /// something else, they still reach the old cluster until their owner
    /// re-opens, and no mode of the new one holds for it. Says the mode it
    /// let the request through in.
    pub(crate) fn authorize_built(
        &self,
        context: &str,
        connection: Option<u64>,
        attributes: &Attributes,
        actor: Actor,
        approval: Option<&Approval>,
    ) -> Result<Mode, Box<Blocked>> {
        let mut access = self.access(context);
        let moved = self.file.mode(context).is_none()
            && (self.metadata)(context).is_some_and(|now| Some(now.connection) != connection);
        if moved {
            access.mode = Mode::ReadOnly;
            access.source = ModeSource::Moved;
        }
        self.decide(context, access, attributes, actor, approval)
    }

    /// Whether the admin's policy file has `context`'s terminals go through
    /// the policy proxy, whatever its mode (ARCHITECTURE 4.6).
    pub fn uses_policy_proxy(&self, context: &str) -> bool {
        self.file.uses_policy_proxy(context)
    }

    /// What the context connects to now, as [`Metadata::connection`] says;
    /// none while no source lists it.
    pub fn connection(&self, context: &str) -> Option<u64> {
        (self.metadata)(context).map(|metadata| metadata.connection)
    }

    /// [`Metadata::revision`] of what the catalog says of the context now;
    /// none while no source lists it.
    pub fn revision(&self, context: &str) -> Option<u64> {
        (self.metadata)(context).map(|metadata| metadata.revision)
    }

    fn decide(
        &self,
        context: &str,
        access: ContextAccess,
        attributes: &Attributes,
        actor: Actor,
        approval: Option<&Approval>,
    ) -> Result<Mode, Box<Blocked>> {
        let approved = || {
            approval.is_some_and(|approval| {
                approval.covers(context, actor, attributes, Timestamp::now())
            })
        };
        let unmarked = access.source == ModeSource::Unmarked
            && matches!(attributes.class, RequestClass::Write | RequestClass::Exec);
        let decided = if unmarked {
            Err(BlockReason::Unmarked)
        } else {
            actor.decide(
                attributes.class,
                access.mode,
                self.file.allow_port_forward(),
                approved,
            )
        };
        decided
            .and_then(|()| {
                if attributes.writes_a_secret() {
                    actor.read_secrets()
                } else {
                    Ok(())
                }
            })
            .map(|()| access.mode)
            .map_err(|reason| {
                Box::new(Blocked {
                    context: context.to_owned(),
                    mode: access.mode,
                    source: access.source,
                    class: attributes.class,
                    reason,
                    verb: attributes.verb.clone(),
                    target: attributes.target(),
                })
            })
    }

    /// What `change` would leave `context` with now: refused where no source
    /// lists it, a mode or an unlock where the admin's policy file sets its
    /// mode, and an unlock where it is not `read-only`.
    pub fn plan(&self, context: &str, change: Change) -> Result<PlannedChange, Refused> {
        self.refuse_policy_file(context, change)?;
        let now = Timestamp::now();
        let metadata =
            (self.metadata)(context).ok_or_else(|| Refused::Unlisted(context.to_owned()))?;
        let mut held = self.held();
        let ended = held.end_moved(context, Some(metadata));
        let before = self.resolved(&held, context, Some(metadata), now);
        let mut changed = held.clone();
        changed.make(context, change, &metadata, unlocked_until(now, UNLOCK));
        let planned = PlannedChange {
            change,
            after: self.resolved(&changed, context, Some(metadata), now),
            changes: held.changes_of(context),
            revision: metadata.revision,
            before,
        };
        drop(held);
        self.relocked(context, ended);
        refuse_unlock(context, change, &planned.before)?;
        Ok(planned)
    }

    /// Makes a change a person confirmed through `friction`, while the
    /// context stands as it was planned: a choice, an unlock or its end, or
    /// what the catalog says of it meanwhile refuses it. The audit log
    /// records it.
    pub fn change(
        &self,
        context: &str,
        planned: &PlannedChange,
        friction: &Friction,
    ) -> Result<Choices, Refused> {
        let change = planned.change;
        let (before, after, choices) =
            self.make(context, change, UNLOCK, |held, before, metadata| {
                let stands = *before == planned.before
                    && held.changes_of(context) == planned.changes
                    && metadata.revision == planned.revision;
                stands
                    .then_some(())
                    .ok_or_else(|| Refused::Changed(context.to_owned()))
            })?;
        self.audit.record(&Entry::Protection {
            context,
            change: &change,
            before: &before,
            after: &after,
            by: By::Plan { friction },
        });
        Ok(choices)
    }

    /// Marks an unmarked context as `environment`, the answer to the ask of
    /// `actor`'s process `process`, while nothing has marked it meanwhile
    /// and it still connects to `connection`, as the ask's request does. The
    /// audit log records it, naming the process.
    pub fn mark(
        &self,
        context: &str,
        connection: u64,
        environment: Environment,
        actor: Actor,
        process: &str,
    ) -> Result<Choices, Refused> {
        let change = Change::Type {
            environment: Some(environment),
        };
        let (before, after, choices) =
            self.make(context, change, UNLOCK, |_, before, metadata| {
                let unmarked =
                    before.source == ModeSource::Unmarked && metadata.connection == connection;
                unmarked
                    .then_some(())
                    .ok_or_else(|| Refused::Changed(context.to_owned()))
            })?;
        self.audit.record(&Entry::Protection {
            context,
            change: &change,
            before: &before,
            after: &after,
            by: By::Ask {
                actor: actor.name(),
                process,
            },
        });
        Ok(choices)
    }

    /// Makes `change` once `check` lets it, given what the context is now,
    /// under the lock every decision reads: says what it was and what it
    /// is, and the person's choices to keep.
    fn make(
        &self,
        context: &str,
        change: Change,
        unlock: SignedDuration,
        check: impl FnOnce(&Held, &ContextAccess, &Metadata) -> Result<(), Refused>,
    ) -> Result<(ContextAccess, ContextAccess, Choices), Refused> {
        self.refuse_policy_file(context, change)?;
        let now = Timestamp::now();
        let metadata =
            (self.metadata)(context).ok_or_else(|| Refused::Unlisted(context.to_owned()))?;
        let mut held = self.held();
        let ended = held.end_moved(context, Some(metadata));
        let before = self.resolved(&held, context, Some(metadata), now);
        let checked = check(&held, &before, &metadata);
        if checked.is_ok() {
            held.make(context, change, &metadata, unlocked_until(now, unlock));
        }
        let after = self.resolved(&held, context, Some(metadata), now);
        let choices = held.choices.clone();
        drop(held);
        self.relocked(context, ended);
        checked?;
        self.changed();
        Ok((before, after, choices))
    }

    /// Ends an unlock now, which the audit log records.
    pub fn relock(&self, context: &str) {
        let ended = self.held().end_unlock(context);
        if ended {
            self.changed();
        }
        self.relocked(context, ended.then_some("command"));
    }

    /// Records an unlock that ended `by` a relock, its time, or the context
    /// naming another cluster or none.
    fn relocked(&self, context: &str, by: Option<&str>) {
        if let Some(by) = by {
            self.audit.record(&Entry::Relocked { context, by });
        }
    }

    /// How many times a choice, an unlock or its end changed what `context`
    /// lets through: what someone holds to it lasts only while this stays,
    /// and [`Policy::revision`] too.
    pub fn changes_of(&self, context: &str) -> u64 {
        self.held().changes_of(context)
    }

    /// Tells [`Policy::changes`] as each unlock ends, while the policy lives.
    pub async fn follow_unlocks(&self) {
        let mut changes = self.changes();
        loop {
            let wait = self.expire(Timestamp::now());
            match wait {
                Some(wait) => {
                    tokio::select! {
                        () = tokio::time::sleep(wait) => {}
                        changed = changes.changed() => if changed.is_err() { return },
                    }
                }
                None => {
                    if changes.changed().await.is_err() {
                        return;
                    }
                }
            }
        }
    }

    /// Drops the unlocks that have ended, and says how long to wait before
    /// looking again, while any runs.
    fn expire(&self, now: Timestamp) -> Option<Duration> {
        let mut held = self.held();
        let ended: Vec<String> = held
            .unlocks
            .iter()
            .filter(|(_, unlock)| unlock.until <= now)
            .map(|(context, _)| context.clone())
            .collect();
        for context in &ended {
            held.end_unlock(context);
        }
        let next = held.unlocks.values().map(|unlock| unlock.until).min();
        drop(held);
        if !ended.is_empty() {
            self.changed();
        }
        for context in &ended {
            self.relocked(context, Some("time"));
        }
        next.map(|next| {
            let left = now.duration_until(next).unsigned_abs();
            left.min(RELOCK_CHECK)
        })
    }

    /// Refuses a mode or an unlock where the admin's policy file sets the
    /// context's mode; a type there names and colours the context and lowers
    /// nothing.
    fn refuse_policy_file(&self, context: &str, change: Change) -> Result<(), Refused> {
        if matches!(change, Change::Type { .. }) {
            return Ok(());
        }
        match self.file.mode(context) {
            Some((_, ModeSource::PolicyFile { file, pattern })) => Err(match pattern {
                Some(pattern) => Refused::PolicyFile(pattern, file),
                None => Refused::PolicyFileUnreadable(file),
            }),
            _ => Ok(()),
        }
    }

    fn changed(&self) {
        self.changes.send_modify(|count| *count += 1);
    }

    fn held(&self) -> MutexGuard<'_, Held> {
        self.held.lock().expect("policy lock")
    }
}

#[cfg(any(test, feature = "test-util"))]
impl Policy {
    /// The person's mode for `context`, or none for what its locks say,
    /// unplanned and unrecorded, for the tests that set a mode.
    pub fn set_mode(&self, context: &str, mode: Option<Mode>) -> Result<Choices, Refused> {
        let change = Change::Mode { mode };
        Ok(self.make(context, change, UNLOCK, |_, _, _| Ok(()))?.2)
    }

    /// The person's type for `context`, none for no type, unplanned and
    /// unrecorded, for the tests that mark one.
    pub fn set_environment(
        &self,
        context: &str,
        environment: Option<Environment>,
    ) -> Result<Choices, Refused> {
        let change = Change::Type { environment };
        Ok(self.make(context, change, UNLOCK, |_, _, _| Ok(()))?.2)
    }

    /// Lets `read-only` through as `guarded` for [`UNLOCK`], unplanned and
    /// unrecorded.
    pub fn unlock(&self, context: &str) -> Result<(), Refused> {
        self.unlock_for(context, UNLOCK)
    }

    /// [`Policy::unlock`], for as long as a test can wait.
    pub fn unlock_for(&self, context: &str, length: SignedDuration) -> Result<(), Refused> {
        let change = Change::Unlock;
        self.make(context, change, length, |_, before, _| {
            refuse_unlock(context, change, before)
        })
        .map(|_| ())
    }
}

/// Refuses an unlock of a context that is not `read-only`: one unlocked
/// already may be unlocked anew.
fn refuse_unlock(context: &str, change: Change, before: &ContextAccess) -> Result<(), Refused> {
    let locked = before.mode == Mode::ReadOnly || before.unlocked_until.is_some();
    if change == Change::Unlock && !locked {
        return Err(Refused::NotLocked(context.to_owned(), before.mode.name()));
    }
    Ok(())
}

fn unlocked_until(now: Timestamp, length: SignedDuration) -> Timestamp {
    now.saturating_add(length).unwrap_or(Timestamp::MAX)
}

/// The strictest of what the kubeconfig, the provider and the type lock the
/// context to; of equal ones the kubeconfig's, then the provider's, then the
/// type's.
fn strictest(metadata: &Metadata, environment: Option<Environment>) -> Option<Lock> {
    let locks = [
        metadata.read_only.then_some(Lock {
            mode: Mode::ReadOnly,
            source: LockSource::Kubeconfig,
        }),
        metadata.provider.map(|provider| Lock {
            mode: provider.mode(),
            source: LockSource::Provider,
        }),
        environment.map(|environment| Lock {
            mode: default_mode(environment),
            source: LockSource::Environment { environment },
        }),
    ];
    locks
        .into_iter()
        .flatten()
        .reduce(|kept, next| if next.mode > kept.mode { next } else { kept })
}

fn mode_source(source: LockSource) -> ModeSource {
    match source {
        LockSource::Kubeconfig => ModeSource::Kubeconfig,
        LockSource::Provider => ModeSource::Provider,
        LockSource::Environment { environment } => ModeSource::Environment { environment },
    }
}

fn default_mode(environment: Environment) -> Mode {
    match environment {
        Environment::Production => Mode::ReadOnly,
        Environment::Staging => Mode::Guarded,
        Environment::Development | Environment::Local => Mode::ReadWrite,
    }
}
