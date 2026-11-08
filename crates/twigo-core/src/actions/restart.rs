//! Replaces a workload's pods as `kubectl rollout restart` does (kubectl
//! v0.37.1, `pkg/polymorphichelpers/objectrestarter.go`): a strategic merge
//! patch that stamps `kubectl.kubernetes.io/restartedAt` on its pod
//! template, which its controller rolls out as its update strategy says. A
//! paused Deployment is refused, as kubectl refuses it.

use std::sync::Weak;

use http::Method;
use jiff::Timestamp;
use serde_json::json;
use twigo_ipc::{Affected, ErrorKind, IpcError, ResourceRef};
use twigo_policy::friction::Risk;

use super::dependents::{Deleted, dependents};
use super::{STRATEGIC_MERGE_PATCH, Target, clients_for, get, kind_words, write};
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
    let mut consequences =
        vec!["Its pods are replaced in turn, as its update strategy says.".to_owned()];
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
    Ok(Planned {
        question: format!("Restart {what}{place} on {context}?"),
        confirm: format!("Restart {kind}"),
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
        run: Box::new(move |_| Box::pin(send(this, connection, run, done))),
    })
}

async fn send(
    core: Weak<Core>,
    connection: Option<u64>,
    target: Target,
    done: String,
) -> Result<Finished, IpcError> {
    let (_, clients) = clients_for(&core, &target.context, connection, "restarted nothing").await?;
    let now = Timestamp::now().strftime("%Y-%m-%dT%H:%M:%SZ").to_string();
    let patch = json!({
        "spec": { "template": { "metadata": { "annotations": { RESTARTED_AT: now } } } }
    });
    clients
        .api
        .request_text(write(
            Method::PATCH,
            &target.path,
            STRATEGIC_MERGE_PATCH,
            &patch,
        ))
        .await
        .map_err(|error| twigo_kube::errors::request(&error))?;
    Ok(Finished::Done(done))
}
