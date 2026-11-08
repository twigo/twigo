//! Replaces a workload's pods as `kubectl rollout restart` does (kubectl
//! v0.37.1, `pkg/polymorphichelpers/objectrestarter.go`): a strategic merge
//! patch that stamps `kubectl.kubernetes.io/restartedAt` on its pod
//! template, which its controller rolls out as its update strategy says. A
//! paused Deployment is refused, as kubectl refuses it. The plan lists the
//! pods that strategy replaces: none under `OnDelete`, and only those from
//! a StatefulSet's partition up.

use std::sync::Weak;

use http::Method;
use jiff::Timestamp;
use serde_json::{Value, json};
use twigo_ipc::{Affected, ErrorKind, IpcError, ObjectRef, ResourceRef};
use twigo_policy::friction::Risk;

use super::dependents::{Deleted, dependents};
use super::{
    ATTEMPTS, STRATEGIC_MERGE_PATCH, Target, clients_for, get, kind_words, lost, patch_as_of, same,
    sentence,
};
use crate::Core;
use crate::bus::{Finished, Planned};

const RESTARTED_AT: &str = "kubectl.kubernetes.io/restartedAt";

pub(crate) async fn restart(
    core: &Core,
    space: &str,
    target: ResourceRef,
) -> Result<Planned, IpcError> {
    let target = Target::of(core, space, target)?;
    if !target.is("apps", &["deployments", "statefulsets", "daemonsets"]) {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            "Twigo restarts deployments, stateful sets and daemon sets",
        ));
    }
    let attributes = target.attributes(Method::PATCH, None);
    core.authorize(&target.context, std::slice::from_ref(&attributes))?;
    let clients = core
        .clients(&target.context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    let object = get(&clients, &target.path).await?;
    let kind = kind_words(object["kind"].as_str().unwrap_or_default());
    let what = format!("{kind} {}", target.name);
    if object["spec"]["paused"] == true {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            format!("{what} is paused, so it cannot restart until its rollout resumes"),
        ));
    }
    let uid = object["metadata"]["uid"].as_str().unwrap_or_default();
    let namespace = target.namespace.as_deref().unwrap_or_default();
    let following = dependents(
        &clients,
        &[Deleted {
            group: &target.resource.group,
            resource: &target.resource.resource,
            namespace,
            uid,
        }],
    )
    .await;
    let pods: Vec<_> = following
        .objects
        .into_iter()
        .filter(|object| object.group.is_empty() && object.kind == "Pod")
        .collect();
    let (said, pods) = replaced(&target, &object, pods);
    let mut consequences = vec![said];
    consequences.extend(following.unknown);
    let affected = if pods.is_empty() {
        Vec::new()
    } else {
        vec![Affected {
            title: "Replaces".to_owned(),
            objects: pods,
        }]
    };
    let workload = format!("{}/{}", target.resource.name(), target.name);
    let kubectl = target.kubectl(&["rollout", "restart", &workload])?;
    let place = target.place();
    let context = target.context.clone();
    let connection = clients.connection();
    let (this, done) = (core.this.clone(), format!("Restarted {what}"));
    let run = target.clone();
    let uid = uid.to_owned();
    Ok(Planned {
        question: format!("Restart {what}{place} on {context}?"),
        confirm: format!("Restart {kind}"),
        destructive: false,
        doing: format!("Restarting {what}"),
        consequences,
        affected,
        kubectl,
        command: "restart",
        target: attributes.target(),
        writes: vec![attributes],
        context,
        connection,
        space: Some(space.to_owned()),
        risk: Risk::Lasting,
        run: Box::new(move |_| Box::pin(send(this, connection, run, uid, what, done))),
    })
}

/// What a new template does to `pods` of `object`, and those it replaces,
/// as its controller rolls it out (kubernetes v1.37.1,
/// `pkg/controller/statefulset/stateful_set_control.go`, `updateStatefulSet`;
/// `pkg/controller/daemon/daemon_controller.go`, `updateDaemonSet`).
fn replaced(target: &Target, object: &Value, pods: Vec<ObjectRef>) -> (String, Vec<ObjectRef>) {
    let strategy = if target.resource.resource == "deployments" {
        &object["spec"]["strategy"]
    } else {
        &object["spec"]["updateStrategy"]
    };
    match strategy["type"].as_str() {
        Some("OnDelete") => (
            "Its pods keep running: its update strategy is OnDelete, so each takes the new template only once it is deleted.".to_owned(),
            Vec::new(),
        ),
        Some("Recreate") => (
            "All its pods stop before new ones start, as its update strategy is Recreate.".to_owned(),
            pods,
        ),
        _ if target.resource.resource == "statefulsets" => {
            // Its partition counts from its first ordinal.
            let partition = strategy["rollingUpdate"]["partition"].as_u64().unwrap_or(0);
            let start = object["spec"]["ordinals"]["start"].as_u64().unwrap_or(0);
            if partition == 0 {
                return (
                    "Its pods are replaced in turn, as its update strategy says.".to_owned(),
                    pods,
                );
            }
            let prefix = format!("{}-", target.name);
            let from = start + partition;
            let pods = pods
                .into_iter()
                .filter(|pod| {
                    pod.name
                        .strip_prefix(&prefix)
                        .and_then(|ordinal| ordinal.parse::<u64>().ok())
                        .is_some_and(|ordinal| ordinal >= from)
                })
                .collect();
            (
                format!(
                    "Its pods from ordinal {from} up are replaced in turn; those below its partition keep running."
                ),
                pods,
            )
        }
        _ => (
            "Its pods are replaced in turn, as its update strategy says.".to_owned(),
            pods,
        ),
    }
}

async fn send(
    core: Weak<Core>,
    connection: Option<u64>,
    target: Target,
    uid: String,
    what: String,
    done: String,
) -> Result<Finished, IpcError> {
    let (_, clients) = clients_for(&core, &target.context, connection, "restarted nothing").await?;
    let now = Timestamp::now().strftime("%Y-%m-%dT%H:%M:%SZ").to_string();
    let patch = json!({
        "spec": { "template": { "metadata": { "annotations": { RESTARTED_AT: now } } } }
    });
    for attempt in 0..ATTEMPTS {
        let object = get(&clients, &target.path).await?;
        same(&object, &uid, &what, "restarted nothing")?;
        if patch_as_of(
            &clients,
            &target.path,
            STRATEGIC_MERGE_PATCH,
            &patch,
            &object,
        )
        .await?
        .is_some()
        {
            return Ok(Finished::Done(done));
        }
        lost(attempt).await;
    }
    Err(IpcError::new(
        ErrorKind::Conflict,
        format!(
            "{} kept changing, so Twigo restarted nothing",
            sentence(&what)
        ),
    ))
}
