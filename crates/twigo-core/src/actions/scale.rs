//! Sets the replicas of an object with a `scale` subresource as `kubectl
//! scale` does (kubectl v0.37.1, `pkg/scale`): a merge patch of the
//! subresource's `spec.replicas`. Any count runs at once with an undo
//! (decision 1 of M2), but for what an undo cannot bring back: to zero it
//! asks first and lists the pods that go, and fewer pods of a StatefulSet
//! that deletes their claims ask and list the claims.

use std::sync::Weak;

use http::Method;
use serde_json::json;
use twigo_ipc::{Affected, ErrorKind, IpcError, ObjectRef, ResourceRef};
use twigo_policy::friction::Risk;

use super::dependents::{Deleted, dependents};
use super::undo::{Asks, Revert, Unchanged};
use super::{MERGE_PATCH, Target, clients_for, get, kind_words, sentence, write};
use crate::Core;
use crate::bus::{Finished, Planned};
use twigo_kube::client::Clients;

pub(crate) async fn scale(
    core: &Core,
    space: &str,
    target: ResourceRef,
    replicas: u32,
) -> Result<Planned, IpcError> {
    let target = Target::of(core, space, target)?;
    let attributes = target.attributes(Method::PATCH, Some("scale"));
    core.authorize(&target.context, std::slice::from_ref(&attributes))?;
    let clients = core
        .clients(&target.context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    let object = get(&clients, &target.path).await?;
    let current = get(&clients, &target.subpath(Some("scale"))).await?;
    let kind = kind_words(object["kind"].as_str().unwrap_or(&target.resource.resource));
    let what = format!("{kind} {}", target.name);
    // autoscaling/v1 omits replicas at zero.
    if current["spec"]["replicas"].as_u64().unwrap_or(0) == u64::from(replicas) {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            format!("{} has {replicas} replicas already", sentence(&what)),
        ));
    }
    let from = current["spec"]["replicas"].as_u64().unwrap_or(0);
    let (risk, consequences, affected) =
        shrinking(&clients, &target, &object, from, replicas.into()).await;
    let kind_name = target.resource.name();
    let count = replicas.to_string();
    let kubectl = target.kubectl(&["scale", &kind_name, &target.name, "--replicas", &count])?;
    let place = target.place();
    let context = target.context.clone();
    let connection = clients.connection();
    let run = Run {
        core: core.this.clone(),
        connection,
        target,
        replicas,
        what: what.clone(),
        kind_name,
    };
    Ok(Planned {
        question: format!("Scale {what}{place} to {replicas} on {context}?"),
        confirm: format!("Scale to {replicas}"),
        destructive: risk == Risk::Lasting,
        doing: format!("Scaling {what} to {replicas}"),
        consequences,
        affected,
        kubectl,
        command: "scale",
        target: attributes.target(),
        writes: vec![attributes],
        context,
        connection,
        space: Some(space.to_owned()),
        risk,
        run: Box::new(move |_| Box::pin(run.run())),
    })
}

/// What setting `target`'s replicas from `from` to `to` risks, and what goes
/// with it: to zero its pods go; fewer pods of a StatefulSet whose
/// `whenScaled` is `Delete` take their claims and their data with them, as
/// its controller makes each pod it scales away its claims' owner
/// (kubernetes v1.37.1, `pkg/controller/statefulset/stateful_set_utils.go`).
/// Anything else an undo puts back.
pub(crate) async fn shrinking(
    clients: &Clients,
    target: &Target,
    object: &serde_json::Value,
    from: u64,
    to: u64,
) -> (Risk, Vec<String>, Vec<Affected>) {
    let mut consequences = Vec::new();
    let mut affected = Vec::new();
    if to == 0 {
        let uid = object["metadata"]["uid"].as_str().unwrap_or_default();
        let (said, listed) = emptied(clients, target, uid).await;
        consequences.extend(said);
        affected.extend(listed);
    }
    let deletes = object["spec"]["persistentVolumeClaimRetentionPolicy"]["whenScaled"] == "Delete";
    let (claims, unread) = if target.is("apps", &["statefulsets"]) && deletes && to < from {
        claims(clients, target, object, from, to).await
    } else {
        (Vec::new(), Vec::new())
    };
    if !claims.is_empty() || !unread.is_empty() {
        consequences.push(
            "The claims of the pods that go are deleted with them, and their data with them."
                .to_owned(),
        );
    }
    if !unread.is_empty() {
        consequences.push(format!(
            "Twigo cannot read {}, so it cannot say whether {} there.",
            unread.join(", "),
            if unread.len() == 1 {
                "it is"
            } else {
                "they are"
            }
        ));
    }
    let lasting = to == 0 || !claims.is_empty() || !unread.is_empty();
    if !claims.is_empty() {
        affected.push(Affected {
            title: "Their claims go".to_owned(),
            objects: claims,
        });
    }
    let risk = if lasting {
        Risk::Lasting
    } else {
        Risk::Reversible
    };
    (risk, consequences, affected)
}

/// The claims that exist of a StatefulSet's pods from ordinal `to` to
/// `from`, past its first ordinal: `<template>-<set>-<ordinal>`, as its
/// controller names them; and the names of those Twigo could not read.
async fn claims(
    clients: &Clients,
    target: &Target,
    object: &serde_json::Value,
    from: u64,
    to: u64,
) -> (Vec<ObjectRef>, Vec<String>) {
    let start = object["spec"]["ordinals"]["start"].as_u64().unwrap_or(0);
    let namespace = target.namespace.clone().unwrap_or_default();
    let templates: Vec<&str> = object["spec"]["volumeClaimTemplates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|template| template["metadata"]["name"].as_str())
        .collect();
    let (mut claims, mut unread) = (Vec::new(), Vec::new());
    for ordinal in start + to..start + from {
        for template in &templates {
            let name = format!("{template}-{}-{ordinal}", target.name);
            let path = format!("/api/v1/namespaces/{namespace}/persistentvolumeclaims/{name}");
            match get(clients, &path).await {
                Ok(_) => claims.push(ObjectRef {
                    group: String::new(),
                    version: "v1".to_owned(),
                    kind: "PersistentVolumeClaim".to_owned(),
                    namespace: Some(namespace.clone()),
                    name,
                }),
                Err(error) if error.kind == ErrorKind::NotFound => {}
                Err(_) => unread.push(format!("claim {name}")),
            }
        }
    }
    (claims, unread)
}

/// What scaling `target` of `uid` to zero asks about: its pods go, and
/// which.
async fn emptied(clients: &Clients, target: &Target, uid: &str) -> (Vec<String>, Vec<Affected>) {
    let deleted: Vec<Deleted<'_>> = target
        .namespace
        .as_deref()
        .map(|namespace| Deleted {
            group: &target.resource.group,
            resource: &target.resource.resource,
            namespace,
            uid,
        })
        .into_iter()
        .collect();
    let following = dependents(clients, &deleted).await;
    let pods: Vec<_> = following
        .objects
        .into_iter()
        .filter(|object| object.group.is_empty() && object.kind == "Pod")
        .collect();
    let mut consequences = vec!["Its pods go, and none take their place.".to_owned()];
    consequences.extend(following.unknown);
    let affected = if pods.is_empty() {
        Vec::new()
    } else {
        vec![Affected {
            title: "Its pods go".to_owned(),
            objects: pods,
        }]
    };
    (consequences, affected)
}

struct Run {
    core: Weak<Core>,
    connection: Option<u64>,
    target: Target,
    replicas: u32,
    /// `deployment web`.
    what: String,
    /// `deployments.apps`.
    kind_name: String,
}

impl Run {
    async fn run(self) -> Result<Finished, IpcError> {
        let target = &self.target;
        let (_, clients) = clients_for(
            &self.core,
            &target.context,
            self.connection,
            "scaled nothing",
        )
        .await?;
        let scale = target.subpath(Some("scale"));
        let before = get(&clients, &scale).await?;
        let from = before["spec"]["replicas"].as_u64().unwrap_or_default();
        let patch = json!({ "spec": { "replicas": self.replicas } });
        clients
            .api
            .request_text(write(Method::PATCH, &scale, MERGE_PATCH, &patch))
            .await
            .map_err(|error| twigo_kube::errors::request(&error))?;
        let what = &self.what;
        let done = format!("Scaled {what} to {}", self.replicas);
        // The scale's answer carries no generation: the object's, read now,
        // is what an undo holds to. The replicas changed whatever this read
        // finds, so its failure only takes the undo away.
        let Ok(object) = get(&clients, &target.path).await else {
            return Ok(Finished::Done(done));
        };
        let (Some(generation), Some(uid)) = (
            object["metadata"]["generation"].as_i64(),
            object["metadata"]["uid"].as_str(),
        ) else {
            return Ok(Finished::Done(done));
        };
        let Ok(kubectl) = target.kubectl(&[
            "scale",
            &self.kind_name,
            &target.name,
            "--current-replicas",
            &self.replicas.to_string(),
            "--replicas",
            &from.to_string(),
        ]) else {
            return Ok(Finished::Done(done));
        };
        let place = target.place();
        let context = &target.context;
        let revert = Revert {
            target: target.clone(),
            subresource: Some("scale"),
            content_type: MERGE_PATCH,
            patch: json!({ "spec": { "replicas": from } }),
            uid: uid.to_owned(),
            unchanged: Unchanged::Generation(generation),
            asks: Asks::Scale(from),
            what: what.clone(),
            past: "scaled",
            question: format!("Scale {what}{place} back to {from} on {context}?"),
            doing: format!("Scaling {what} back to {from}"),
            done: format!("Scaled {what} back to {from}"),
            kubectl,
        };
        Ok(Finished::Undoable {
            text: done,
            revert: Box::new(revert),
        })
    }
}
