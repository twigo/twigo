//! Deletes objects as `kubectl delete` does (kubectl v0.37.1,
//! `pkg/cmd/delete`): their dependents in the background, then waits until
//! each object of the uid it deleted is gone, which a new object of the same
//! name does not hold up. A precondition on that uid keeps it from deleting
//! an object that took the name after the plan. Several are the marked rows
//! of one list, so they share a resource.

use std::collections::{BTreeMap, HashSet};
use std::sync::Weak;

use futures::future::join_all;
use http::Method;
use kube::api::{DeleteParams, Preconditions, PropagationPolicy};
use serde_json::Value;
use twigo_cache::hub::{Query, Resource, RowFormat};
use twigo_cache::request::field_value;
use twigo_ipc::{Affected, ErrorKind, IpcError, ResourceRef};
use twigo_policy::friction::Risk;

use super::dependents::{Deleted, dependents};
use super::{Target, clients_for, counted, get, kind_words, kubectl, object_ref, plural, sentence};
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
    targets: Vec<ResourceRef>,
) -> Result<Planned, IpcError> {
    let Some(first) = targets.first() else {
        return Err(IpcError::new(ErrorKind::InvalidInput, "nothing to delete"));
    };
    if targets
        .iter()
        .any(|target| target.gvr != first.gvr || target.namespaced != first.namespaced)
    {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            "a delete of several objects takes them from one resource",
        ));
    }
    let targets = targets
        .into_iter()
        .map(|target| Target::of(core, space, target))
        .collect::<Result<Vec<_>, _>>()?;
    let mut names = HashSet::new();
    let targets: Vec<Target> = targets
        .into_iter()
        .filter(|target| names.insert((target.namespace.clone(), target.name.clone())))
        .collect();
    let context = targets[0].context.clone();
    let resource = targets[0].resource.clone();
    let writes: Vec<_> = targets
        .iter()
        .map(|target| target.attributes(Method::DELETE, None))
        .collect();
    // Before anything goes out: a read-only context says so at once.
    core.authorize(&context, &writes)?;
    let clients = core
        .clients(&context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    let read = join_all(targets.iter().map(|target| get(&clients, &target.path))).await;
    let (mut kept, mut gone, mut missing) = (Vec::new(), Vec::new(), None);
    for (target, read) in targets.into_iter().zip(read) {
        match read {
            Ok(object) => kept.push((target, object)),
            Err(error) if error.kind == ErrorKind::NotFound => {
                gone.push(target.name.clone());
                missing.get_or_insert(error);
            }
            Err(error) => return Err(error),
        }
    }
    if let (true, Some(error)) = (kept.is_empty(), missing) {
        return Err(error);
    }
    let (targets, objects): (Vec<Target>, Vec<Value>) = kept.into_iter().unzip();
    let writes: Vec<_> = targets
        .iter()
        .map(|target| target.attributes(Method::DELETE, None))
        .collect();
    let uids = objects
        .iter()
        .zip(&targets)
        .map(|(object, target)| {
            object["metadata"]["uid"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| {
                    IpcError::new(ErrorKind::Internal, format!("{} has no uid", target.name))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let kind = kind_words(objects[0]["kind"].as_str().unwrap_or(&resource.resource));

    let deleted: Vec<Deleted<'_>> = targets
        .iter()
        .zip(&uids)
        .filter_map(|(target, uid)| {
            Some(Deleted {
                group: &resource.group,
                resource: &resource.resource,
                namespace: target.namespace.as_deref()?,
                uid,
            })
        })
        .collect();
    let following = dependents(&clients, &deleted).await;
    let wide = WIDE.contains(&(resource.group.as_str(), resource.resource.as_str()));
    let several = targets.len() > 1;
    let mut consequences = Vec::new();
    let risk = if several {
        Risk::Wide {
            name: context.clone(),
        }
    } else if wide {
        Risk::Wide {
            name: targets[0].name.clone(),
        }
    } else if let Some((owner, owner_name)) = (resource.group.is_empty()
        && resource.resource == "pods")
        .then(|| controller(&objects[0]))
        .flatten()
    {
        consequences.push(format!(
            "Its {} {owner_name} replaces it.",
            kind_words(&owner)
        ));
        Risk::Replaced
    } else {
        Risk::Lasting
    };
    if wide {
        consequences.extend(wide_consequences(&resource, &objects, several));
    }
    consequences.extend(following.unknown);
    if !gone.is_empty() {
        consequences.push(format!(
            "Gone already, so not in this delete: {}.",
            gone.join(", ")
        ));
    }
    let mut affected = Vec::new();
    if several {
        affected.push(Affected {
            title: "Deletes".to_owned(),
            objects: objects.iter().map(object_ref).collect(),
        });
    }
    if !following.objects.is_empty() {
        affected.push(Affected {
            title: if several {
                "With them go"
            } else {
                "With it go"
            }
            .to_owned(),
            objects: following.objects,
        });
    }

    let what = if several {
        counted(targets.len(), &kind)
    } else {
        format!("{kind} {}", targets[0].name)
    };
    let place = place(&targets);
    let line = kubectl_lines(&targets, &context, &resource)?;
    let connection = clients.connection();
    let run = Run {
        core: core.this.clone(),
        connection,
        context: context.clone(),
        resource,
        kind: kind.clone(),
        what: what.clone(),
        targets: targets.into_iter().zip(uids).collect(),
    };
    Ok(Planned {
        question: format!("Delete {what}{place} from {context}?"),
        confirm: if several {
            format!("Delete {what}")
        } else {
            format!("Delete {kind}")
        },
        doing: format!("Deleting {what}"),
        destructive: true,
        consequences,
        affected,
        kubectl: line,
        command: "delete",
        target: if several {
            format!("{what}{place}")
        } else {
            writes[0].target()
        },
        writes,
        context,
        connection,
        space: Some(space.to_owned()),
        risk,
        run: Box::new(move |progress| Box::pin(run.run(progress))),
    })
}

/// ` in default`, ` in 3 namespaces`, or nothing for cluster-scoped objects.
fn place(targets: &[Target]) -> String {
    let namespaces: HashSet<_> = targets
        .iter()
        .filter_map(|target| target.namespace.as_deref())
        .collect();
    match namespaces.len() {
        0 => String::new(),
        1 => targets[0].place(),
        count => format!(" in {count} namespaces"),
    }
}

/// One kubectl command a namespace, joined so a shell runs each whatever
/// the one before answered, as the run deletes the rest when one is gone.
fn kubectl_lines(
    targets: &[Target],
    context: &str,
    resource: &Resource,
) -> Result<String, IpcError> {
    let mut by_namespace: BTreeMap<Option<&str>, Vec<&str>> = BTreeMap::new();
    for target in targets {
        by_namespace
            .entry(target.namespace.as_deref())
            .or_default()
            .push(&target.name);
    }
    let kind_name = resource.name();
    let lines = by_namespace
        .into_iter()
        .map(|(namespace, names)| {
            let mut words = vec!["kubectl", "--context", context, "delete", &kind_name];
            words.extend(names);
            if let Some(namespace) = namespace {
                words.extend(["-n", namespace]);
            }
            kubectl(&words)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(lines.join("; "))
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

fn wide_consequences(resource: &Resource, objects: &[Value], several: bool) -> Vec<String> {
    match resource.resource.as_str() {
        "namespaces" if several => vec!["Every object in them goes with them.".to_owned()],
        "namespaces" => vec!["Every object in it goes with it.".to_owned()],
        "customresourcedefinitions" => objects
            .iter()
            .filter_map(|object| object["spec"]["names"]["kind"].as_str())
            .map(|kind| format!("Every object of kind {kind} goes with it."))
            .collect(),
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
    /// `pod`.
    kind: String,
    /// `pod web-1`, `3 pods`.
    what: String,
    /// Each with the uid it read.
    targets: Vec<(Target, String)>,
}

/// How the server answered the delete of one object.
enum Answer {
    Sent(String),
    Gone,
    Replaced(String),
    Failed(String, IpcError),
}

impl Run {
    async fn run(self, progress: Progress) -> Result<Finished, IpcError> {
        let (core, clients) = clients_for(
            &self.core,
            &self.context,
            self.connection,
            "deleted nothing",
        )
        .await?;
        let sent = join_all(self.targets.iter().map(|(target, uid)| {
            let clients = &clients;
            async move {
                let options = DeleteParams {
                    propagation_policy: Some(PropagationPolicy::Background),
                    preconditions: Some(Preconditions {
                        uid: Some(uid.clone()),
                        resource_version: None,
                    }),
                    ..DeleteParams::default()
                };
                let request = super::write(
                    Method::DELETE,
                    &target.path,
                    "application/json",
                    &serde_json::to_value(&options).expect("delete options serialize"),
                );
                match clients.api.request_text(request).await {
                    Ok(_) => Answer::Sent(uid.clone()),
                    Err(kube::Error::Api(status)) if status.code == 404 => Answer::Gone,
                    Err(kube::Error::Api(status)) if status.code == 409 => {
                        Answer::Replaced(target.name.clone())
                    }
                    Err(error) => {
                        Answer::Failed(target.name.clone(), twigo_kube::errors::request(&error))
                    }
                }
            }
        }))
        .await;
        if let [only] = sent.as_slice() {
            let what = &self.what;
            match only {
                Answer::Sent(_) => {}
                Answer::Gone => {
                    return Ok(Finished::Done(format!(
                        "{} was already gone",
                        sentence(what)
                    )));
                }
                Answer::Replaced(_) => {
                    return Err(IpcError::new(
                        ErrorKind::Conflict,
                        format!(
                            "{what} was replaced since you confirmed, so Twigo deleted nothing"
                        ),
                    ));
                }
                Answer::Failed(_, error) => return Err(error.clone()),
            }
        }
        let waiting: HashSet<String> = sent
            .iter()
            .filter_map(|sent| match sent {
                Answer::Sent(uid) => Some(uid.clone()),
                _ => None,
            })
            .collect();
        let (gone, replaced, failed) = sent.iter().fold(
            (0, Vec::new(), Vec::new()),
            |(gone, mut replaced, mut failed), sent| {
                match sent {
                    Answer::Gone => return (gone + 1, replaced, failed),
                    Answer::Replaced(name) => replaced.push(name.as_str()),
                    Answer::Failed(name, error) => failed.push((name.as_str(), error)),
                    Answer::Sent(_) => {}
                }
                (gone, replaced, failed)
            },
        );
        let besides = self.besides(gone, &replaced, &failed);
        let deleted = format!("{}{besides}", self.told(waiting.len(), failed.len()));
        let finish = |text: String| match failed.first() {
            Some((_, error)) => Err(IpcError::new(error.kind, text)),
            None => Ok(Finished::Done(text)),
        };
        if waiting.is_empty() {
            return match failed.first() {
                Some((_, error)) => Err(IpcError::new(error.kind, deleted)),
                None if !replaced.is_empty() => Err(IpcError::new(ErrorKind::Conflict, deleted)),
                None => Ok(Finished::Done(deleted)),
            };
        }

        let namespaces: Vec<String> = self
            .targets
            .iter()
            .filter_map(|(target, _)| target.namespace.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let field_selector = match self.targets.as_slice() {
            [(target, _)] => Some(format!("metadata.name={}", field_value(&target.name))),
            _ => None,
        };
        let watched = core
            .hub
            .rows(Query {
                context: self.context.clone(),
                resource: self.resource.clone(),
                format: RowFormat::Metadata,
                namespaces,
                field_selector,
            })
            .await;
        let stopped = |left: usize| {
            let still = if self.targets.len() == 1 {
                self.what.clone()
            } else {
                counted(left, &self.kind)
            };
            let are = if left == 1 { "is" } else { "are" };
            Finished::Stopped(format!(
                "Stopped waiting for {still}, which {are} still being deleted{besides}"
            ))
        };
        let mut followed = match watched {
            Ok(followed) => followed,
            Err(_) => {
                return finish(format!(
                    "{deleted}; Twigo cannot watch {} go",
                    if self.targets.len() == 1 {
                        "it"
                    } else {
                        "them"
                    }
                ));
            }
        };
        tokio::select! {
            whole = followed.whole() => if whole.is_err() {
                return finish(format!(
                    "{deleted}; Twigo cannot watch {} go",
                    if self.targets.len() == 1 { "it" } else { "them" }
                ));
            },
            () = progress.stopped() => return Ok(stopped(waiting.len())),
        }
        let mut told = None;
        loop {
            let left = followed
                .items()
                .iter()
                .filter(|row| {
                    row.meta
                        .uid
                        .as_deref()
                        .is_some_and(|uid| waiting.contains(uid))
                })
                .count();
            if left == 0 {
                return finish(deleted);
            }
            if told != Some(left) {
                progress.running(if self.targets.len() == 1 {
                    format!("Waiting for {} to go", self.what)
                } else {
                    format!(
                        "Waiting for {left} of {} to go",
                        counted(waiting.len(), &self.kind)
                    )
                });
                told = Some(left);
            }
            tokio::select! {
                () = followed.changed() => {}
                () = progress.stopped() => return Ok(stopped(left)),
            }
        }
    }

    /// What it deleted: `Deleted 4 pods`, `Deleted 3 of 5 pods`.
    fn told(&self, sent: usize, failed: usize) -> String {
        if self.targets.len() == 1 {
            format!("Deleted {}", self.what)
        } else if failed == 0 {
            format!("Deleted {}", counted(sent, &self.kind))
        } else {
            format!(
                "Deleted {sent} of {}",
                counted(self.targets.len(), &self.kind)
            )
        }
    }

    /// What else happened to them, each after a semicolon: `; 1 was
    /// already gone`.
    fn besides(&self, gone: usize, replaced: &[&str], failed: &[(&str, &IpcError)]) -> String {
        let mut told = String::new();
        if gone > 0 {
            let was = if gone == 1 { "was" } else { "were" };
            told.push_str(&format!("; {gone} {was} already gone"));
        }
        if !replaced.is_empty() {
            let kind = if replaced.len() == 1 {
                self.kind.clone()
            } else {
                plural(&self.kind)
            };
            let were = if replaced.len() == 1 { "was" } else { "were" };
            told.push_str(&format!(
                "; {kind} {} {were} replaced since you confirmed, so Twigo left {}",
                replaced.join(", "),
                if replaced.len() == 1 { "it" } else { "them" }
            ));
        }
        for (name, error) in failed {
            told.push_str(&format!("; {} {name}: {}", self.kind, error.message));
        }
        told
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
