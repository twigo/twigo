//! Undo (decision 5 of M2): what the last action of a space changed goes
//! back for 30 s, from its toast or ⌘Z; the last is the one that started
//! last. It is refused once anyone else changed the object since: it was
//! replaced, its generation moved, or, for a node, which has none, the field
//! Twigo set no longer holds what it set. Status changes every second on a
//! busy object, so its resourceVersion cannot say that; the write carries
//! the one it checked instead, so nothing changes between the check and the
//! write.

use std::collections::HashMap;
use std::sync::{Mutex, Weak};
use std::time::Duration;

use http::Method;
use jiff::Timestamp;
use serde_json::Value;
use tokio::time::Instant;
use twigo_ipc::{ErrorKind, IpcError};
use twigo_policy::friction::Risk;

use super::{ATTEMPTS, Target, clients_for, get, lost, patch_as_of, sentence};
use crate::Core;
use crate::bus::{Finished, Planned};

/// How long an action's undo lasts after it ends.
pub(crate) const UNDO_FOR: Duration = Duration::from_secs(30);

/// What an undo asks before it runs, as a plan of the same write would.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Asks {
    Nothing,
    /// It scales to these replicas, which asks as a scale to them does.
    Scale(u64),
    /// It suspends a Job, which asks as a suspend does.
    Suspend,
    /// It resumes a CronJob, which asks as a resume does.
    Resume,
}

/// How an undo knows that nobody else changed the object since.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Unchanged {
    /// Its generation is what Twigo's write left.
    Generation(i64),
    /// The boolean at the JSON pointer still holds what Twigo set; a
    /// missing one is false.
    Flag { pointer: &'static str, set: bool },
}

impl Unchanged {
    fn holds(&self, object: &Value) -> bool {
        match self {
            Unchanged::Generation(generation) => {
                object["metadata"]["generation"].as_i64() == Some(*generation)
            }
            Unchanged::Flag { pointer, set } => {
                object
                    .pointer(pointer)
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    == *set
            }
        }
    }
}

/// What a finished action can put back.
#[derive(Debug, Clone)]
pub(crate) struct Revert {
    pub target: Target,
    /// What it writes to: the object itself, or its `scale`.
    pub subresource: Option<&'static str>,
    pub content_type: &'static str,
    /// The patch that puts it back, to which the undo adds the
    /// resourceVersion it checked.
    pub patch: Value,
    /// The object's uid as Twigo wrote it, so a new object of its name is
    /// left alone.
    pub uid: String,
    pub unchanged: Unchanged,
    pub asks: Asks,
    /// What its plan says when it asks nothing.
    pub said: Vec<String>,
    /// `deployment web`.
    pub what: String,
    /// What the action did, as `changed since you … it` reads: `scaled`.
    pub past: &'static str,
    /// `Scale deployment web in default back to 3 on kind-a?`
    pub question: String,
    /// `Scaling deployment web back to 3`.
    pub doing: String,
    /// `Scaled deployment web back to 3`.
    pub done: String,
    pub kubectl: String,
}

/// Each space's last action, while its undo lasts.
#[derive(Default)]
pub(crate) struct Undos {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Numbers the actions and the undos alike, never twice.
    next: u64,
    /// The action of each space that started last.
    latest: HashMap<String, u64>,
    slots: HashMap<String, Slot>,
}

struct Slot {
    id: u64,
    connection: Option<u64>,
    until: Instant,
    revert: Revert,
}

impl Undos {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("undo lock")
    }

    /// Notes that an action of `space` starts to run, which ends the
    /// space's undo; answers the ticket that says, as it ends, whether it
    /// is still the space's last.
    pub(crate) fn started(&self, space: &str) -> u64 {
        let mut inner = self.inner();
        inner.next += 1;
        let ticket = inner.next;
        inner.latest.insert(space.to_owned(), ticket);
        inner.slots.remove(space);
        ticket
    }

    /// Notes that the action of `ticket` ended, with what puts it back if it
    /// has an undo, made on the clients of `connection`, kept while no later
    /// action of the space started; answers when the undo ends, in
    /// milliseconds since the epoch.
    pub(crate) fn ended(
        &self,
        space: &str,
        ticket: u64,
        undo: Option<(Revert, Option<u64>)>,
    ) -> Option<i64> {
        let mut inner = self.inner();
        if inner.latest.get(space) != Some(&ticket) {
            return None;
        }
        let (revert, connection) = undo?;
        inner.next += 1;
        let id = inner.next;
        inner.slots.insert(
            space.to_owned(),
            Slot {
                id,
                connection,
                until: Instant::now() + UNDO_FOR,
                revert,
            },
        );
        let lasts = i64::try_from(UNDO_FOR.as_millis()).expect("30 s in milliseconds");
        Some(Timestamp::now().as_millisecond() + lasts)
    }

    fn get(&self, space: &str) -> Option<(u64, Option<u64>, Revert)> {
        let inner = self.inner();
        let slot = inner
            .slots
            .get(space)
            .filter(|slot| Instant::now() < slot.until)?;
        Some((slot.id, slot.connection, slot.revert.clone()))
    }

    /// Takes the undo a plan was made for, unless it ended or another
    /// action's took its place.
    fn take(&self, space: &str, id: u64) -> bool {
        let mut inner = self.inner();
        let live = inner
            .slots
            .get(space)
            .is_some_and(|slot| slot.id == id && Instant::now() < slot.until);
        if live {
            inner.slots.remove(space);
        }
        live
    }
}

pub(crate) async fn undo(core: &Core, space: &str) -> Result<Planned, IpcError> {
    let (id, connection, revert) = core.undos.get(space).ok_or_else(|| {
        IpcError::new(
            ErrorKind::NotFound,
            "nothing in this space can be undone now",
        )
    })?;
    let attributes = revert.target.attributes(Method::PATCH, revert.subresource);
    let (risk, consequences, affected) = match revert.asks {
        Asks::Nothing => (Risk::Reversible, revert.said.clone(), Vec::new()),
        Asks::Resume => (Risk::Lasting, revert.said.clone(), Vec::new()),
        asks => {
            let target = &revert.target;
            core.authorize(&target.context, std::slice::from_ref(&attributes))?;
            let clients = core
                .clients(&target.context)
                .await
                .map_err(|error| IpcError::from(&error))?;
            if clients.connection() != connection {
                return Err(IpcError::new(
                    ErrorKind::Conflict,
                    format!(
                        "{} names another cluster now than the one you changed, so nothing can be undone there",
                        target.context
                    ),
                ));
            }
            let object = get(&clients, &target.path).await?;
            if let Some(how) = ended_since(&revert, &object) {
                return Err(how);
            }
            match asks {
                Asks::Scale(replicas) => {
                    let current = get(&clients, &target.subpath(Some("scale"))).await?;
                    let from = current["spec"]["replicas"].as_u64().unwrap_or(0);
                    super::scale::shrinking(&clients, target, &object, from, replicas).await
                }
                _ => super::suspend::stopping(&clients, target, &object).await,
            }
        }
    };
    let (this, space) = (core.this.clone(), space.to_owned());
    let destructive = risk == Risk::Lasting && revert.asks != Asks::Resume;
    Ok(Planned {
        context: revert.target.context.clone(),
        connection,
        // It takes its own undo as it runs, and leaves a later one standing.
        space: None,
        risk,
        target: attributes.target(),
        writes: vec![attributes],
        command: "undo",
        question: revert.question.clone(),
        confirm: "Undo".to_owned(),
        destructive,
        consequences,
        affected,
        kubectl: revert.kubectl.clone(),
        doing: revert.doing.clone(),
        run: Box::new(move |_| Box::pin(run(this, space, id, connection, revert))),
    })
}

/// Refuses the undo of a Job's suspend or resume once the Job ended, which
/// its controller then leaves be, whatever `spec.suspend` says; its
/// generation does not say so, as only its status moved.
fn ended_since(revert: &Revert, object: &Value) -> Option<IpcError> {
    if !revert.target.is("batch", &["jobs"]) {
        return None;
    }
    let how = super::suspend::ended(object)?;
    Some(IpcError::new(
        ErrorKind::Conflict,
        format!(
            "{} {how} since you {} it, so Twigo left it",
            sentence(&revert.what),
            revert.past
        ),
    ))
}

async fn run(
    core: Weak<Core>,
    space: String,
    id: u64,
    connection: Option<u64>,
    revert: Revert,
) -> Result<Finished, IpcError> {
    let context = &revert.target.context;
    // Taken as its run starts, as the webview takes it once the run was
    // accepted, so a run that cannot reach the cluster leaves none behind.
    let taken = core
        .upgrade()
        .is_some_and(|core| core.undos.take(&space, id));
    if !taken {
        return Err(IpcError::new(
            ErrorKind::Conflict,
            "the undo ended before it ran, so Twigo put nothing back",
        ));
    }
    let (_, clients) = clients_for(&core, context, connection, "put nothing back").await?;
    let (what, past) = (sentence(&revert.what), revert.past);
    let left = |why: String| IpcError::new(ErrorKind::Conflict, format!("{why}, so Twigo left it"));
    for attempt in 0..ATTEMPTS {
        let object = get(&clients, &revert.target.path).await?;
        if object["metadata"]["uid"].as_str() != Some(revert.uid.as_str()) {
            return Err(left(format!("{what} was replaced since you {past} it")));
        }
        if !revert.unchanged.holds(&object) {
            return Err(left(format!("{what} changed since you {past} it")));
        }
        if let Some(how) = ended_since(&revert, &object) {
            return Err(how);
        }
        let path = revert.target.subpath(revert.subresource);
        if patch_as_of(&clients, &path, revert.content_type, &revert.patch, &object)
            .await?
            .is_some()
        {
            return Ok(Finished::Done(revert.done.clone()));
        }
        lost(attempt).await;
    }
    Err(left(format!("{what} kept changing")))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use twigo_cache::hub::Resource;

    use super::{Revert, UNDO_FOR, Unchanged, Undos};
    use crate::actions::Target;

    fn revert(name: &str) -> Revert {
        let nodes = Resource {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "nodes".to_owned(),
            namespaced: false,
        };
        Revert {
            target: Target::in_context("kind-a".to_owned(), nodes, None, name.to_owned()).unwrap(),
            subresource: None,
            content_type: super::super::STRATEGIC_MERGE_PATCH,
            patch: json!({ "spec": { "unschedulable": null } }),
            uid: "u-1".to_owned(),
            asks: super::Asks::Nothing,
            said: Vec::new(),
            unchanged: Unchanged::Flag {
                pointer: "/spec/unschedulable",
                set: true,
            },
            what: format!("node {name}"),
            past: "cordoned",
            question: String::new(),
            doing: String::new(),
            done: String::new(),
            kubectl: String::new(),
        }
    }

    /// Runs an action of `space` from start to end.
    fn action(undos: &Undos, space: &str, undo: Option<&str>) -> Option<i64> {
        let ticket = undos.started(space);
        undos.ended(space, ticket, undo.map(|name| (revert(name), Some(1))))
    }

    #[tokio::test(start_paused = true)]
    async fn an_undo_lasts_30_s_and_only_while_its_action_is_the_space_s_last() {
        let undos = Undos::default();
        assert!(action(&undos, "s", Some("a")).is_some());
        let (first, connection, kept) = undos.get("s").unwrap();
        assert_eq!((connection, kept.target.name.as_str()), (Some(1), "a"));
        assert!(undos.get("other").is_none());

        action(&undos, "s", Some("b"));
        assert!(!undos.take("s", first), "a later action took its place");
        let (second, _, kept) = undos.get("s").unwrap();
        assert_eq!(kept.target.name, "b");

        tokio::time::advance(UNDO_FOR).await;
        assert!(undos.get("s").is_none());
        assert!(!undos.take("s", second), "it lasted 30 s");

        action(&undos, "s", Some("c"));
        let (third, _, _) = undos.get("s").unwrap();
        action(&undos, "s", None);
        assert!(
            undos.get("s").is_none(),
            "an action without an undo ends it"
        );
        action(&undos, "s", Some("d"));
        assert!(
            !undos.take("s", third),
            "a removed undo's id is never another's"
        );
        let (fourth, _, _) = undos.get("s").unwrap();
        assert!(undos.take("s", fourth));
        assert!(!undos.take("s", fourth), "an undo runs once");
    }

    #[tokio::test(start_paused = true)]
    async fn the_last_action_is_the_one_that_started_last() {
        let undos = Undos::default();
        action(&undos, "s", Some("a"));
        let long = undos.started("s");
        assert!(undos.get("s").is_none(), "a start ends the undo before it");
        action(&undos, "s", Some("b"));
        assert_eq!(undos.ended("s", long, None), None);
        let (_, _, kept) = undos.get("s").unwrap();
        assert_eq!(kept.target.name, "b", "an earlier action ends after it");
        let started = undos.started("s");
        assert_eq!(undos.ended("s", long, Some((revert("c"), Some(1)))), None);
        assert!(undos.get("s").is_none());
        assert!(
            undos
                .ended("s", started, Some((revert("e"), Some(1))))
                .is_some()
        );
    }

    #[tokio::test]
    async fn an_undo_that_cannot_reach_its_cluster_is_gone_all_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let kubeconfig = dir.path().join("config");
        std::fs::write(
            &kubeconfig,
            "clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]\nusers: [{ name: u, user: {} }]\ncontexts: [{ name: kind-b, context: { cluster: c, user: u } }]\n",
        )
        .unwrap();
        let core = crate::Core::new(
            dir.path(),
            &dir.path().join("cache"),
            &dir.path().join("policy.json"),
        );
        let (_status, followed) = tokio::sync::watch::channel(twigo_env::Status::Resolved(
            std::sync::Arc::new(twigo_env::ShellEnv::from_iter([])),
        ));
        tokio::spawn({
            let core = std::sync::Arc::clone(&core);
            async move { core.run(followed, Some(kubeconfig)).await }
        });
        action(&core.undos, "s", Some("kwok-node-5"));
        let (id, connection, revert) = core.undos.get("s").unwrap();
        let weak = std::sync::Arc::downgrade(&core);
        let Err(error) = super::run(weak, "s".to_owned(), id, connection, revert).await else {
            panic!("an undo without its cluster ran");
        };
        assert_eq!(
            error.kind,
            twigo_ipc::ErrorKind::NotFound,
            "{}",
            error.message
        );
        assert!(core.undos.get("s").is_none());
    }

    #[test]
    fn an_object_is_unchanged_only_while_its_generation_or_flag_holds() {
        let at = |generation: i64| json!({ "metadata": { "generation": generation } });
        assert!(Unchanged::Generation(4).holds(&at(4)));
        assert!(!Unchanged::Generation(4).holds(&at(5)));
        let cordoned = Unchanged::Flag {
            pointer: "/spec/unschedulable",
            set: true,
        };
        let uncordoned = Unchanged::Flag {
            pointer: "/spec/unschedulable",
            set: false,
        };
        let node = |spec: serde_json::Value| json!({ "spec": spec });
        assert!(cordoned.holds(&node(json!({ "unschedulable": true }))));
        assert!(!cordoned.holds(&node(json!({}))));
        assert!(uncordoned.holds(&node(json!({}))));
        assert!(!uncordoned.holds(&node(json!({ "unschedulable": true }))));
    }
}
