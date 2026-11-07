//! Deletes an object as `kubectl delete` does (kubectl v0.37.1,
//! `pkg/cmd/delete`): its dependents in the background, then waits until the
//! object of the uid it deleted is gone, which a new object of the same name
//! does not hold up. A precondition on that uid keeps it from deleting an
//! object that took the name after the plan.

use std::sync::Weak;

use http::header::CONTENT_TYPE;
use kube::api::{DeleteParams, Preconditions, PropagationPolicy};
use serde_json::Value;
use twigo_cache::hub::Resource;
use twigo_ipc::{ErrorKind, IpcError, ResourceRef};
use twigo_policy::Attributes;
use twigo_policy::friction::Risk;

use super::{kind_words, kubectl, sentence};
use crate::Core;
use crate::bus::{Finished, Planned, Progress};

/// The controllers that make a new pod for one that goes; a Job's or a
/// workflow's may not.
const REPLACING: [&str; 3] = ["ReplicaSet", "StatefulSet", "DaemonSet"];

/// Kinds whose object takes all it holds with it.
const WIDE: [(&str, &str); 3] = [
    ("", "namespaces"),
    ("", "nodes"),
    ("apiextensions.k8s.io", "customresourcedefinitions"),
];

pub(crate) async fn delete(
    core: &Core,
    space: &str,
    target: ResourceRef,
) -> Result<Planned, IpcError> {
    let context = core.context(space)?;
    let resource = Resource {
        group: target.gvr.group,
        version: target.gvr.version,
        resource: target.gvr.resource,
        namespaced: target.namespaced,
    };
    let namespace = target.namespace.filter(|_| resource.namespaced);
    let name = target.name;
    let path = resource.object_path(namespace.as_deref(), &name)?;
    // As the request reads with its body: a DELETE's class is its path's.
    let attributes = Attributes::of(
        &http::Request::delete(&path)
            .body(())
            .expect("an object's path makes a request"),
    );
    // Before anything goes out: a read-only context says so at once.
    core.authorize(&context, std::slice::from_ref(&attributes))?;
    let clients = core
        .clients(&context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    let get = http::Request::get(&path)
        .body(Vec::new())
        .expect("an object's path makes a request");
    let object: Value = clients
        .api
        .request(get)
        .await
        .map_err(|error| twigo_kube::errors::request(&error))?;
    let uid = object["metadata"]["uid"]
        .as_str()
        .ok_or_else(|| IpcError::new(ErrorKind::Internal, format!("{name} has no uid")))?
        .to_owned();
    let kind = kind_words(object["kind"].as_str().unwrap_or(&resource.resource));
    let what = format!("{kind} {name}");

    let wide = WIDE.contains(&(resource.group.as_str(), resource.resource.as_str()));
    let controller = (resource.group.is_empty() && resource.resource == "pods")
        .then(|| controller(&object))
        .flatten();
    let (risk, consequences) = match (wide, controller) {
        (true, _) => (
            Risk::Wide { name: name.clone() },
            wide_consequences(&resource, &object),
        ),
        (false, Some((owner, owner_name))) => (
            Risk::Replaced,
            vec![format!(
                "Its {} {owner_name} replaces it.",
                kind_words(&owner)
            )],
        ),
        (false, None) => (Risk::One, Vec::new()),
    };

    let options = DeleteParams {
        propagation_policy: Some(PropagationPolicy::Background),
        preconditions: Some(Preconditions {
            uid: Some(uid.clone()),
            resource_version: None,
        }),
        ..DeleteParams::default()
    };
    let request = http::Request::delete(&path)
        .header(CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&options).expect("delete options serialize"))
        .expect("an object's path makes a request");

    let kind_name = resource.name();
    let mut words = vec![
        "kubectl",
        "--context",
        &context,
        "delete",
        &kind_name,
        &name,
    ];
    if let Some(namespace) = &namespace {
        words.extend(["-n", namespace]);
    }
    let line = kubectl(&words)?;
    let place = namespace
        .as_deref()
        .map(|namespace| format!(" in {namespace}"))
        .unwrap_or_default();
    let connection = clients.connection();
    let run = Run {
        core: core.this.clone(),
        connection,
        context: context.clone(),
        resource,
        namespace,
        name: name.clone(),
        uid,
        what: what.clone(),
        request,
    };
    Ok(Planned {
        question: format!("Delete {what}{place} from {context}?"),
        confirm: format!("Delete {kind}"),
        doing: format!("Deleting {what}"),
        consequences,
        kubectl: line,
        command: "delete",
        target: attributes.target(),
        writes: vec![attributes],
        context,
        connection,
        risk,
        run: Box::new(move |progress| Box::pin(run.run(progress))),
    })
}

/// The kind and name of the pod's controller, when it is one that replaces
/// the pod.
fn controller(object: &Value) -> Option<(String, String)> {
    let owners = object["metadata"]["ownerReferences"].as_array()?;
    let owner = owners.iter().find(|owner| owner["controller"] == true)?;
    let kind = owner["kind"].as_str()?;
    let replaces = owner["apiVersion"] == "apps/v1" && REPLACING.contains(&kind);
    replaces.then(|| Some((kind.to_owned(), owner["name"].as_str()?.to_owned())))?
}

fn wide_consequences(resource: &Resource, object: &Value) -> Vec<String> {
    match resource.resource.as_str() {
        "namespaces" => vec!["Every object in it goes with it.".to_owned()],
        "customresourcedefinitions" => object["spec"]["names"]["kind"]
            .as_str()
            .map(|kind| vec![format!("Every object of kind {kind} goes with it.")])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// What the run holds of its plan.
struct Run {
    core: Weak<Core>,
    /// The connection of the clients it planned with.
    connection: Option<u64>,
    context: String,
    resource: Resource,
    namespace: Option<String>,
    name: String,
    uid: String,
    /// `pod web-1`.
    what: String,
    request: http::Request<Vec<u8>>,
}

impl Run {
    async fn run(self, progress: Progress) -> Result<Finished, IpcError> {
        let core = self
            .core
            .upgrade()
            .ok_or_else(|| IpcError::new(ErrorKind::Unavailable, "Twigo is quitting"))?;
        let clients = core
            .clients(&self.context)
            .await
            .map_err(|error| IpcError::from(&error))?;
        let what = &self.what;
        if clients.connection() != self.connection {
            return Err(IpcError::new(
                ErrorKind::Conflict,
                format!(
                    "{} names another cluster now than when Twigo asked, so it deleted nothing",
                    self.context
                ),
            ));
        }
        match clients.api.request_text(self.request).await {
            Ok(_) => {}
            Err(kube::Error::Api(status)) if status.code == 404 => {
                return Ok(Finished::Done(format!(
                    "{} was already gone",
                    sentence(what)
                )));
            }
            Err(kube::Error::Api(status)) if status.code == 409 => {
                return Err(IpcError::new(
                    ErrorKind::Conflict,
                    format!("{what} was replaced since you confirmed, so Twigo deleted nothing"),
                ));
            }
            Err(error) => return Err(twigo_kube::errors::request(&error)),
        }
        let deleted = format!("Deleted {what}");
        let stopped = || {
            Finished::Stopped(format!(
                "Stopped waiting for {what}, which is still being deleted"
            ))
        };
        let mut followed =
            core.hub
                .object(&self.context, self.resource, self.namespace, &self.name)?;
        tokio::select! {
            whole = followed.whole() => if whole.is_err() {
                return Ok(Finished::Done(format!("{deleted}; Twigo cannot watch it go")));
            },
            () = progress.stopped() => return Ok(stopped()),
        }
        let mut told = false;
        loop {
            let present = followed
                .items()
                .iter()
                .any(|object| object.meta.uid.as_deref() == Some(self.uid.as_str()));
            if !present {
                return Ok(Finished::Done(deleted));
            }
            if !told {
                progress.running(format!("Waiting for {what} to go"));
                told = true;
            }
            tokio::select! {
                () = followed.changed() => {}
                () = progress.stopped() => return Ok(stopped()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::controller;

    fn pod(owner: serde_json::Value) -> serde_json::Value {
        json!({ "metadata": { "name": "p", "ownerReferences": [owner] } })
    }

    #[test]
    fn only_a_controller_that_makes_a_new_pod_replaces_one() {
        for kind in ["ReplicaSet", "StatefulSet", "DaemonSet"] {
            let owned = pod(
                json!({ "apiVersion": "apps/v1", "kind": kind, "name": "web", "controller": true }),
            );
            assert_eq!(
                controller(&owned),
                Some((kind.to_owned(), "web".to_owned())),
                "{kind}"
            );
        }
        for owner in [
            json!({ "apiVersion": "batch/v1", "kind": "Job", "name": "migrate", "controller": true }),
            json!({ "apiVersion": "tekton.dev/v1", "kind": "TaskRun", "name": "build", "controller": true }),
            json!({ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web", "controller": false }),
        ] {
            assert_eq!(controller(&pod(owner.clone())), None, "{owner}");
        }
        assert_eq!(controller(&json!({ "metadata": { "name": "p" } })), None);
    }
}
