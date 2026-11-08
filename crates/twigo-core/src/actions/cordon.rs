//! Marks a node unschedulable, or schedulable again, as `kubectl cordon`
//! and `kubectl uncordon` do (kubectl v0.37.1, `pkg/drain/cordon.go`): a
//! strategic merge patch of `spec.unschedulable`, which uncordon removes.
//! Either runs at once with an undo (decision 1 of M2).

use std::sync::Weak;

use http::Method;
use serde_json::{Value, json};
use twigo_cache::hub::Resource;
use twigo_ipc::{ErrorKind, IpcError};
use twigo_policy::friction::Risk;

use super::undo::{Revert, Unchanged};
use super::{STRATEGIC_MERGE_PATCH, Target, clients_for, get, write};
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

/// The words of a cordon, or of an uncordon.
struct Words {
    verb: &'static str,
    doing: &'static str,
    done: &'static str,
}

fn words(unschedulable: bool) -> Words {
    if unschedulable {
        Words {
            verb: "cordon",
            doing: "Cordoning",
            done: "Cordoned",
        }
    } else {
        Words {
            verb: "uncordon",
            doing: "Uncordoning",
            done: "Uncordoned",
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
    if object["spec"]["unschedulable"].as_bool().unwrap_or(false) == unschedulable {
        let already = if unschedulable {
            "cordoned already"
        } else {
            "not cordoned"
        };
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            format!("Node {name} is {already}"),
        ));
    }
    let Words { verb, doing, done } = words(unschedulable);
    let context = target.context.clone();
    let connection = clients.connection();
    let consequence = if unschedulable {
        "No new pods are scheduled on it; those on it stay."
    } else {
        "New pods can be scheduled on it again."
    };
    let kubectl = target.kubectl(&[verb, name])?;
    let this = core.this.clone();
    let question = format!("{} node {name} on {context}?", super::sentence(verb));
    Ok(Planned {
        question,
        confirm: format!("{} node", super::sentence(verb)),
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
    unschedulable: bool,
    done: String,
) -> Result<Finished, IpcError> {
    let (_, clients) = clients_for(&core, &target.context, connection, "changed nothing").await?;
    clients
        .api
        .request_text(write(
            Method::PATCH,
            &target.path,
            STRATEGIC_MERGE_PATCH,
            &patch(unschedulable),
        ))
        .await
        .map_err(|error| twigo_kube::errors::request(&error))?;
    let name = target.name.clone();
    let back = words(!unschedulable);
    let revert = Revert {
        subresource: None,
        content_type: STRATEGIC_MERGE_PATCH,
        patch: patch(!unschedulable),
        unchanged: Unchanged::Flag {
            pointer: "/spec/unschedulable",
            set: unschedulable,
        },
        question: format!(
            "{} node {name} on {}?",
            super::sentence(back.verb),
            target.context
        ),
        doing: format!("{} node {name}", back.doing),
        done: format!("{} node {name}", back.done),
        changed: format!(
            "Node {name} changed since you {}ed it",
            words(unschedulable).verb
        ),
        kubectl: target.kubectl(&[back.verb, &name])?,
        target,
    };
    Ok(Finished::Undoable {
        text: format!("{done} {name}"),
        revert: Box::new(revert),
    })
}
