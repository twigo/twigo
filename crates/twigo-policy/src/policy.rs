//! Each context's mode and where it comes from (ARCHITECTURE 6.4), read
//! anew for every request, so a change reaches clients already built.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use tokio::sync::watch;
use twigo_ipc::{Blocked, ContextAccess, Environment, Mode, ModeSource};

use crate::{Actor, Attributes, Gate, PolicyFile};

/// How long an unlock lasts.
pub const UNLOCK: SignedDuration = SignedDuration::from_mins(15);

/// How long a relock may lag behind its time while the machine sleeps, as
/// timers stop with it. The gate reads the clock, so this delays only what
/// the UI hears.
const RELOCK_CHECK: Duration = Duration::from_secs(30);

/// What the catalog says of a context it lists.
#[derive(Debug, Clone, Copy, Default)]
pub struct Metadata {
    /// `twigo.readOnly` in its kubeconfig.
    pub read_only: Option<bool>,
    /// What its provider marks it as; kubeconfig contexts have none.
    pub provider: Option<Mode>,
    pub environment: Option<Environment>,
    /// Changes when what it connects to does, or what its kubeconfig says of
    /// it: an unlock holds only for what it was given on.
    pub connection: u64,
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

/// Why a command could not change a context's mode.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("{0} in {1} sets this context's mode, which Twigo cannot change")]
    PolicyFile(String, String),
    #[error("{0} cannot be read, so Twigo keeps every context read-only")]
    PolicyFileUnreadable(String),
    #[error("{0} is {1}, so there is nothing to unlock")]
    NotLocked(String, &'static str),
}

/// None for a context no source lists now.
type ReadMetadata = Box<dyn Fn(&str) -> Option<Metadata> + Send + Sync>;

pub struct Policy {
    file: PolicyFile,
    metadata: ReadMetadata,
    held: Mutex<Held>,
    changes: watch::Sender<u64>,
}

struct Held {
    choices: Choices,
    /// By context. Never stored: a restart relocks.
    unlocks: HashMap<String, Unlock>,
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
    ) -> Arc<Self> {
        Arc::new(Self {
            file,
            metadata: Box::new(metadata),
            held: Mutex::new(Held {
                choices,
                unlocks: HashMap::new(),
            }),
            changes: watch::Sender::new(0),
        })
    }

    /// Where nothing sets a mode: every context is `read-write`. For the
    /// tools and tests that own the clusters they reach.
    pub fn open() -> Arc<Self> {
        Self::new(
            PolicyFile::default(),
            |_| Some(Metadata::default()),
            Choices::default(),
        )
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
        // For good: a kubeconfig edited back gives the same fingerprint again.
        let connection = metadata.map(|metadata| metadata.connection);
        if held
            .unlocks
            .get(context)
            .is_some_and(|unlock| Some(unlock.connection) != connection)
        {
            held.unlocks.remove(context);
        }
        self.resolved(&held, context, metadata, now)
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
            None => metadata.and_then(|metadata| metadata.environment),
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
        if let Some(mode) = held.choices.modes.get(context) {
            return (*mode, ModeSource::User);
        }
        if let Some(read_only) = metadata.read_only {
            let mode = if read_only {
                Mode::ReadOnly
            } else {
                Mode::ReadWrite
            };
            return (mode, ModeSource::Kubeconfig);
        }
        if let Some(mode) = metadata.provider {
            return (mode, ModeSource::Provider);
        }
        match environment {
            Some(environment) => (
                default_mode(environment),
                ModeSource::Environment { environment },
            ),
            None => (Mode::ReadWrite, ModeSource::Default),
        }
    }

    /// Whether `attributes` may leave the process.
    pub fn authorize(
        &self,
        context: &str,
        attributes: &Attributes,
        actor: Actor,
    ) -> Result<(), Box<Blocked>> {
        self.decide(context, self.access(context), attributes, actor)
    }

    /// [`Policy::authorize`], for clients built for `connection`: once the
    /// context's name means something else, they still reach the old cluster
    /// until their owner re-opens, and no mode of the new one holds for it.
    pub(crate) fn authorize_built(
        &self,
        context: &str,
        connection: Option<u64>,
        attributes: &Attributes,
        actor: Actor,
    ) -> Result<(), Box<Blocked>> {
        let mut access = self.access(context);
        let moved = self.file.mode(context).is_none()
            && (self.metadata)(context).is_some_and(|now| Some(now.connection) != connection);
        if moved {
            access.mode = Mode::ReadOnly;
            access.source = ModeSource::Moved;
        }
        self.decide(context, access, attributes, actor)
    }

    fn connection(&self, context: &str) -> Option<u64> {
        (self.metadata)(context).map(|metadata| metadata.connection)
    }

    fn decide(
        &self,
        context: &str,
        access: ContextAccess,
        attributes: &Attributes,
        actor: Actor,
    ) -> Result<(), Box<Blocked>> {
        actor
            .decide(
                attributes.class,
                access.mode,
                self.file.allow_port_forward(),
            )
            .and_then(|()| {
                if attributes.writes_a_secret() {
                    actor.read_secrets()
                } else {
                    Ok(())
                }
            })
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

    /// The person's mode for `context`, or none for what the rest says.
    /// Ends an unlock, since the choice is what they mean now.
    pub fn set_mode(&self, context: &str, mode: Option<Mode>) -> Result<Choices, Refused> {
        self.refuse_policy_file(context)?;
        let mut held = self.held();
        held.unlocks.remove(context);
        match mode {
            Some(mode) => held.choices.modes.insert(context.to_owned(), mode),
            None => held.choices.modes.remove(context),
        };
        let choices = held.choices.clone();
        drop(held);
        self.changed();
        Ok(choices)
    }

    /// What the person marks `context` as, none for no type at all. Ends an
    /// unlock, which marking it Production again must not bring back.
    pub fn set_environment(&self, context: &str, environment: Option<Environment>) -> Choices {
        let mut held = self.held();
        held.unlocks.remove(context);
        held.choices
            .environments
            .insert(context.to_owned(), environment);
        let choices = held.choices.clone();
        drop(held);
        self.changed();
        choices
    }

    /// Lets `read-only` through as `guarded` for [`UNLOCK`].
    pub fn unlock(&self, context: &str) -> Result<(), Refused> {
        self.unlock_for(context, UNLOCK)
    }

    /// [`Policy::unlock`], for as long as a test can wait.
    pub fn unlock_for(&self, context: &str, length: SignedDuration) -> Result<(), Refused> {
        self.refuse_policy_file(context)?;
        let now = Timestamp::now();
        let metadata = (self.metadata)(context);
        // Under one lock, so a choice made meanwhile is not unlocked unasked.
        let mut held = self.held();
        let access = self.resolved(&held, context, metadata, now);
        if access.mode != Mode::ReadOnly && access.unlocked_until.is_none() {
            return Err(Refused::NotLocked(context.to_owned(), access.mode.name()));
        }
        let Some(metadata) = metadata else {
            return Err(Refused::NotLocked(
                context.to_owned(),
                "listed by no source",
            ));
        };
        let until = now.saturating_add(length).unwrap_or(Timestamp::MAX);
        held.unlocks.insert(
            context.to_owned(),
            Unlock {
                until,
                connection: metadata.connection,
            },
        );
        drop(held);
        self.changed();
        Ok(())
    }

    /// Ends an unlock now.
    pub fn relock(&self, context: &str) {
        if self.held().unlocks.remove(context).is_some() {
            self.changed();
        }
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
        let before = held.unlocks.len();
        held.unlocks.retain(|_, unlock| unlock.until > now);
        let ended = held.unlocks.len() != before;
        let next = held.unlocks.values().map(|unlock| unlock.until).min();
        drop(held);
        if ended {
            self.changed();
        }
        next.map(|next| {
            let left = now.duration_until(next).unsigned_abs();
            left.min(RELOCK_CHECK)
        })
    }

    fn refuse_policy_file(&self, context: &str) -> Result<(), Refused> {
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

fn default_mode(environment: Environment) -> Mode {
    match environment {
        Environment::Production => Mode::ReadOnly,
        Environment::Staging => Mode::Guarded,
        Environment::Development | Environment::Local => Mode::ReadWrite,
    }
}
