//! Sets the replicas of an object with a `scale` subresource as `kubectl
//! scale` does (kubectl v0.37.1, `pkg/scale`): a merge patch of the
//! subresource's `spec.replicas`. To zero it asks first and lists the pods
//! that go; any other count runs at once with an undo (decision 1 of M2).

use std::sync::Weak;

use http::Method;
use serde_json::json;
use twigo_ipc::{Affected, ErrorKind, IpcError, ResourceRef};
use twigo_policy::friction::Risk;

use super::dependents::{Deleted, dependents};
use super::undo::{Revert, Unchanged};
use super::{MERGE_PATCH, Target, clients_for, get, kind_words, sentence, write};
use crate::Core;
use crate::bus::{Finished, Planned};

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
    if current["spec"]["replicas"].as_u64() == Some(replicas.into()) {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            format!("{} has {replicas} replicas already", sentence(&what)),
        ));
    }
    let (risk, consequences, affected) = if replicas == 0 {
        let uid = object["metadata"]["uid"].as_str().unwrap_or_default();
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
        let following = dependents(&clients, &deleted).await;
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
        (Risk::Lasting, consequences, affected)
    } else {
        (Risk::Reversible, Vec::new(), Vec::new())
    };
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
