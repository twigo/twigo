//! Marks a node unschedulable, or schedulable again, as `kubectl cordon`
//! and `kubectl uncordon` do (kubectl v0.37.1, `pkg/drain/cordon.go`): a
//! strategic merge patch of `spec.unschedulable`, which uncordon removes.
//! Either runs at once with an undo (decision 1 of M2). The run reads the
//! node first and writes as of that read, so its undo puts back only what
//! its own write changed: a node someone cordoned meanwhile is cordoned
//! already, as kubectl says, and offers no undo.

use std::sync::Weak;

use http::Method;
use serde_json::{Value, json};
use twigo_cache::hub::Resource;
use twigo_ipc::{ErrorKind, IpcError};
use twigo_policy::friction::Risk;

use super::undo::{Asks, Revert, Unchanged};
use super::{ATTEMPTS, STRATEGIC_MERGE_PATCH, Target, clients_for, get, patch_as_of, same};
use crate::Core;
use crate::bus::{Finished, Planned};

pub(crate) fn node(context: String, name: String) -> Result<Target, IpcError> {
    let nodes = Resource {
        group: String::new(),
        version: "v1".to_owned(),
        resource: "nodes".to_owned(),
        namespaced: false,
    };
    Target::in_context(context, nodes, None, name)
}

/// What sets `spec.unschedulable` to `unschedulable`.
pub(crate) fn patch(unschedulable: bool) -> Value {
    let value = if unschedulable {
        Value::Bool(true)
    } else {
        Value::Null
    };
    json!({ "spec": { "unschedulable": value } })
}

/// Whether `node` is cordoned, or not, as `unschedulable` says.
fn is(node: &Value, unschedulable: bool) -> bool {
    node["spec"]["unschedulable"].as_bool().unwrap_or(false) == unschedulable
}

fn already(name: &str, unschedulable: bool) -> String {
    let already = if unschedulable {
        "cordoned already"
    } else {
        "not cordoned"
    };
    format!("Node {name} is {already}")
}

/// The words of a cordon, or of an uncordon.
struct Words {
    verb: &'static str,
    doing: &'static str,
    done: &'static str,
    /// As `changed since you … it` reads.
    past: &'static str,
}

fn words(unschedulable: bool) -> Words {
    if unschedulable {
        Words {
            verb: "cordon",
            doing: "Cordoning",
            done: "Cordoned",
            past: "cordoned",
        }
    } else {
        Words {
            verb: "uncordon",
            doing: "Uncordoning",
            done: "Uncordoned",
            past: "uncordoned",
        }
    }
}

pub(crate) async fn cordon(
    core: &Core,
    space: &str,
    name: String,
    unschedulable: bool,
) -> Result<Planned, IpcError> {
    let target = node(core.context(space)?, name)?;
    let attributes = target.attributes(Method::PATCH, None);
    core.authorize(&target.context, std::slice::from_ref(&attributes))?;
    let clients = core
        .clients(&target.context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    let object = get(&clients, &target.path).await?;
    let name = &target.name;
    if is(&object, unschedulable) {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            already(name, unschedulable),
        ));
    }
    let Words {
        verb, doing, done, ..
    } = words(unschedulable);
    let context = target.context.clone();
    let connection = clients.connection();
    let consequence = if unschedulable {
        "No new pods are scheduled on it; those on it stay."
    } else {
        "New pods can be scheduled on it again."
    };
    let kubectl = target.kubectl(&[verb, name])?;
    let this = core.this.clone();
    let uid = object["metadata"]["uid"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let question = format!("{} node {name} on {context}?", super::sentence(verb));
    Ok(Planned {
        question,
        confirm: format!("{} node", super::sentence(verb)),
        destructive: false,
        doing: format!("{doing} node {name}"),
        consequences: vec![consequence.to_owned()],
        affected: Vec::new(),
        kubectl,
        command: verb,
        target: attributes.target(),
        writes: vec![attributes],
        context,
        connection,
        space: Some(space.to_owned()),
        risk: Risk::Reversible,
        run: Box::new(move |_| {
            Box::pin(send(
                this,
                connection,
                target,
                uid,
                unschedulable,
                format!("{done} node"),
            ))
        }),
    })
}

async fn send(
    core: Weak<Core>,
    connection: Option<u64>,
    target: Target,
    uid: String,
    unschedulable: bool,
    done: String,
) -> Result<Finished, IpcError> {
    let (_, clients) = clients_for(&core, &target.context, connection, "changed nothing").await?;
    let name = target.name.clone();
    let mut answer = None;
    for _ in 0..ATTEMPTS {
        let node = get(&clients, &target.path).await?;
        same(&node, &uid, &format!("node {name}"), "changed nothing")?;
        if is(&node, unschedulable) {
            return Ok(Finished::Done(already(&name, unschedulable)));
        }
        let patch = patch(unschedulable);
        answer = patch_as_of(&clients, &target.path, STRATEGIC_MERGE_PATCH, &patch, &node).await?;
        if answer.is_some() {
            break;
        }
    }
    let Some(written) = answer else {
        return Err(IpcError::new(
            ErrorKind::Conflict,
            format!("Node {name} kept changing, so Twigo changed nothing"),
        ));
    };
    let text = format!("{done} {name}");
    let back = words(!unschedulable);
    let (Some(uid), Ok(kubectl)) = (
        written["metadata"]["uid"].as_str(),
        target.kubectl(&[back.verb, &name]),
    ) else {
        return Ok(Finished::Done(text));
    };
    let revert = Revert {
        subresource: None,
        content_type: STRATEGIC_MERGE_PATCH,
        patch: patch(!unschedulable),
        uid: uid.to_owned(),
        asks: Asks::Nothing,
        unchanged: Unchanged::Flag {
            pointer: "/spec/unschedulable",
            set: unschedulable,
        },
        what: format!("node {name}"),
        past: words(unschedulable).past,
        question: format!(
            "{} node {name} on {}?",
            super::sentence(back.verb),
            target.context
        ),
        doing: format!("{} node {name}", back.doing),
        done: format!("{} node {name}", back.done),
        kubectl,
        target,
    };
    Ok(Finished::Undoable {
        text,
        revert: Box::new(revert),
    })
}
