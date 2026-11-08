//! Undo (decision 5 of M2): what the last action of a space changed goes
//! back for 30 s, from its toast or ⌘Z. It is refused once anyone else
//! changed the object since: its generation moved, or, for a node, which
//! has none, the field Twigo set no longer holds what it set. Status
//! changes every second on a busy object, so its resourceVersion cannot say
//! that; the write carries the one it checked instead, so nothing changes
//! between the check and the write.

use std::collections::HashMap;
use std::sync::{Mutex, Weak};
use std::time::Duration;

use http::Method;
use jiff::Timestamp;
use serde_json::Value;
use tokio::time::Instant;
use twigo_ipc::{ErrorKind, IpcError};
use twigo_policy::friction::Risk;

use super::{Target, clients_for, get, write};
use crate::Core;
use crate::bus::{Finished, Planned};

/// How long an action's undo lasts after it ends.
pub(crate) const UNDO_FOR: Duration = Duration::from_secs(30);

/// How many times an undo reads the object again when its write lost to a
/// status change, before it gives up.
const ATTEMPTS: usize = 5;

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
    pub unchanged: Unchanged,
    /// `Scale deployment web in default back to 3 on kind-a?`
    pub question: String,
    /// `Scaling deployment web back to 3`.
    pub doing: String,
    /// `Scaled deployment web back to 3`.
    pub done: String,
    /// `Deployment web changed since you scaled it`.
    pub changed: String,
    pub kubectl: String,
}

/// Each space's last action, while its undo lasts.
#[derive(Default)]
pub(crate) struct Undos {
    slots: Mutex<HashMap<String, Slot>>,
}

struct Slot {
    id: u64,
    connection: Option<u64>,
    until: Instant,
    revert: Revert,
}

impl Undos {
    fn slots(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        self.slots.lock().expect("undo lock")
    }

    /// Notes that an action of `space` ended, with what puts it back if it
    /// has an undo, made on the clients of `connection`; answers when the
    /// undo ends, in milliseconds since the epoch.
    pub(crate) fn ended(&self, space: &str, undo: Option<(Revert, Option<u64>)>) -> Option<i64> {
        let mut slots = self.slots();
        let Some((revert, connection)) = undo else {
            slots.remove(space);
            return None;
        };
        let id = slots.get(space).map_or(1, |slot| slot.id + 1);
        slots.insert(
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
        let slots = self.slots();
        let slot = slots
            .get(space)
            .filter(|slot| Instant::now() < slot.until)?;
        Some((slot.id, slot.connection, slot.revert.clone()))
    }

    /// Takes the undo a plan was made for, unless it ended or another
    /// action's took its place.
    fn take(&self, space: &str, id: u64) -> bool {
        let mut slots = self.slots();
        let live = slots
            .get(space)
            .is_some_and(|slot| slot.id == id && Instant::now() < slot.until);
        if live {
            slots.remove(space);
        }
        live
    }
}

pub(crate) fn undo(core: &Core, space: &str) -> Result<Planned, IpcError> {
    let (id, connection, revert) = core.undos.get(space).ok_or_else(|| {
        IpcError::new(
            ErrorKind::NotFound,
            "nothing in this space can be undone now",
        )
    })?;
    let attributes = revert.target.attributes(Method::PATCH, revert.subresource);
    let (this, space) = (core.this.clone(), space.to_owned());
    Ok(Planned {
        context: revert.target.context.clone(),
        connection,
        space: Some(space.clone()),
        risk: Risk::Reversible,
        target: attributes.target(),
        writes: vec![attributes],
        command: "undo",
        question: revert.question.clone(),
        confirm: "Undo".to_owned(),
        consequences: Vec::new(),
        affected: Vec::new(),
        kubectl: revert.kubectl.clone(),
        doing: revert.doing.clone(),
        run: Box::new(move |_| Box::pin(run(this, space, id, connection, revert))),
    })
}

async fn run(
    core: Weak<Core>,
    space: String,
    id: u64,
    connection: Option<u64>,
    revert: Revert,
) -> Result<Finished, IpcError> {
    let context = &revert.target.context;
    let (core, clients) = clients_for(&core, context, connection, "put nothing back").await?;
    if !core.undos.take(&space, id) {
        return Err(IpcError::new(
            ErrorKind::Conflict,
            "the undo ended before it ran, so Twigo put nothing back",
        ));
    }
    let left = || format!("{}, so Twigo left it", revert.changed);
    for _ in 0..ATTEMPTS {
        let object = get(&clients, &revert.target.path).await?;
        if !revert.unchanged.holds(&object) {
            return Err(IpcError::new(ErrorKind::Conflict, left()));
        }
        let mut patch = revert.patch.clone();
        patch["metadata"]["resourceVersion"] = object["metadata"]["resourceVersion"].clone();
        let request = write(
            Method::PATCH,
            &revert.target.subpath(revert.subresource),
            revert.content_type,
            &patch,
        );
        match clients.api.request_text(request).await {
            Ok(_) => return Ok(Finished::Done(revert.done.clone())),
            Err(kube::Error::Api(status)) if status.code == 409 => {}
            Err(error) => return Err(twigo_kube::errors::request(&error)),
        }
    }
    Err(IpcError::new(ErrorKind::Conflict, left()))
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
            unchanged: Unchanged::Flag {
                pointer: "/spec/unschedulable",
                set: true,
            },
            question: String::new(),
            doing: String::new(),
            done: String::new(),
            changed: String::new(),
            kubectl: String::new(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_undo_lasts_30_s_and_only_while_its_action_is_the_space_s_last() {
        let undos = Undos::default();
        assert!(undos.ended("s", Some((revert("a"), Some(1)))).is_some());
        let (first, connection, kept) = undos.get("s").unwrap();
        assert_eq!((connection, kept.target.name.as_str()), (Some(1), "a"));
        assert!(undos.get("other").is_none());

        undos.ended("s", Some((revert("b"), Some(1))));
        assert!(!undos.take("s", first), "a later action took its place");
        let (second, _, kept) = undos.get("s").unwrap();
        assert_eq!(kept.target.name, "b");

        tokio::time::advance(UNDO_FOR).await;
        assert!(undos.get("s").is_none());
        assert!(!undos.take("s", second), "it lasted 30 s");

        undos.ended("s", Some((revert("c"), Some(1))));
        let (third, _, _) = undos.get("s").unwrap();
        undos.ended("s", None);
        assert!(
            undos.get("s").is_none(),
            "an action without an undo ends it"
        );
        assert!(!undos.take("s", third));

        undos.ended("s", Some((revert("d"), Some(1))));
        let (fourth, _, _) = undos.get("s").unwrap();
        assert!(undos.take("s", fourth));
        assert!(!undos.take("s", fourth), "an undo runs once");
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
