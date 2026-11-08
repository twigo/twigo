//! Drains a node as `kubectl drain --ignore-daemonsets` does (kubectl
//! v0.37.1, `pkg/drain`): it cordons the node, evicts its pods through the
//! Eviction API, which holds a pod back with a `429` while a
//! PodDisruptionBudget would break and so is tried again every 5 s, then
//! waits until each pod of the uid it evicted is gone. DaemonSet pods stay,
//! as their controller ignores the cordon, and so do static pods, which the
//! API cannot remove. kubectl refuses a pod that no controller replaces, or
//! one with emptyDir data, unless `--force` or `--delete-emptydir-data` say
//! so: the plan finds them, takes them too and asks for the node's name
//! typed, since those pods and that data go for good. A stop leaves the
//! node cordoned and says so.

use std::collections::{HashMap, HashSet};
use std::sync::Weak;
use std::time::Duration;

use futures::future::join_all;
use http::Method;
use k8s_openapi::api::core::v1::Pod;
use serde_json::json;
use twigo_cache::hub::{Query, Resource, RowFormat};
use twigo_cache::request::field_value;
use twigo_ipc::{Affected, ErrorKind, IpcError, ObjectRef};
use twigo_kube::client::Clients;
use twigo_policy::friction::Risk;

use super::cordon::{node, patch};
use super::{STRATEGIC_MERGE_PATCH, Target, attributes, clients_for, counted, get, write};
use crate::Core;
use crate::bus::{Finished, Planned, Progress};

/// How long kubectl waits before it asks again to evict a pod a budget
/// held back (`EvictErrorRetryDelay` in `pkg/cmd/drain`).
const RETRY: Duration = Duration::from_secs(5);

/// What a drain does with a pod on the node, as kubectl's filters decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fate {
    Evict,
    /// Its DaemonSet runs it on the node whatever the cordon says.
    LeaveDaemon,
    /// The kubelet runs it from a file; the API shows only its mirror.
    LeaveStatic,
    /// What kubectl takes only with its flags: what goes for good.
    Force {
        unmanaged: bool,
        empty_dir: bool,
    },
}

/// What the plan took, so the run takes no more.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Flags {
    /// `--force`: pods no controller replaces.
    unmanaged: bool,
    /// `--delete-emptydir-data`.
    empty_dir: bool,
}

pub(crate) async fn drain(core: &Core, space: &str, name: String) -> Result<Planned, IpcError> {
    let target = node(core.context(space)?, name)?;
    let cordon = target.attributes(Method::PATCH, None);
    core.authorize(&target.context, std::slice::from_ref(&cordon))?;
    let clients = core
        .clients(&target.context)
        .await
        .map_err(|error| IpcError::from(&error))?;
    get(&clients, &target.path).await?;
    let pods = sorted(&clients, &target.name).await?;
    let pick = |wanted: &dyn Fn(Fate) -> bool| -> Vec<ObjectRef> {
        pods.iter()
            .filter(|(_, fate)| wanted(*fate))
            .map(|(pod, _)| pod_ref(pod))
            .collect()
    };
    let flags = pods
        .iter()
        .fold(Flags::default(), |flags, (_, fate)| match fate {
            Fate::Force {
                unmanaged,
                empty_dir,
            } => Flags {
                unmanaged: flags.unmanaged || *unmanaged,
                empty_dir: flags.empty_dir || *empty_dir,
            },
            _ => flags,
        });
    let evicted = pick(&|fate| matches!(fate, Fate::Evict | Fate::Force { .. }));
    let mut affected = vec![Affected {
        title: "Evicts".to_owned(),
        objects: evicted.clone(),
    }];
    for (title, objects) in [
        (
            "Gone for good, with no controller to replace them",
            pick(&|fate| {
                matches!(
                    fate,
                    Fate::Force {
                        unmanaged: true,
                        ..
                    }
                )
            }),
        ),
        (
            "Their emptyDir data goes with them",
            pick(&|fate| {
                matches!(
                    fate,
                    Fate::Force {
                        empty_dir: true,
                        ..
                    }
                )
            }),
        ),
        (
            "Stay, as their daemon sets run them on every node",
            pick(&|fate| fate == Fate::LeaveDaemon),
        ),
        (
            "Stay, as the kubelet runs them from files",
            pick(&|fate| fate == Fate::LeaveStatic),
        ),
    ] {
        if !objects.is_empty() {
            affected.push(Affected {
                title: title.to_owned(),
                objects,
            });
        }
    }
    affected.retain(|group| !group.objects.is_empty());
    let mut writes = vec![cordon];
    writes.extend(evicted.iter().map(|pod| {
        attributes(
            Method::POST,
            &format!(
                "/api/v1/namespaces/{}/pods/{}/eviction",
                pod.namespace.as_deref().unwrap_or_default(),
                pod.name
            ),
        )
    }));
    let mut words = vec!["drain", target.name.as_str(), "--ignore-daemonsets"];
    if flags.empty_dir {
        words.push("--delete-emptydir-data");
    }
    if flags.unmanaged {
        words.push("--force");
    }
    let kubectl = target.kubectl(&words)?;
    let forced = flags != Flags::default();
    let risk = if forced {
        Risk::Wide {
            name: target.name.clone(),
        }
    } else {
        Risk::Lasting
    };
    let consequences = vec![
        "It is cordoned first, and stays cordoned.".to_owned(),
        format!(
            "A disruption budget may hold a pod back; Twigo asks again every {} s.",
            RETRY.as_secs()
        ),
    ];
    let name = target.name.clone();
    let context = target.context.clone();
    let connection = clients.connection();
    let run = Run {
        core: core.this.clone(),
        connection,
        target,
        flags,
    };
    Ok(Planned {
        question: format!("Drain node {name} on {context}?"),
        confirm: if forced {
            "Drain node with force".to_owned()
        } else {
            "Drain node".to_owned()
        },
        doing: format!("Draining node {name}"),
        consequences,
        affected,
        kubectl,
        command: "drain",
        target: format!("nodes/{name}"),
        writes,
        context,
        connection,
        space: Some(space.to_owned()),
        risk,
        run: Box::new(move |progress| Box::pin(run.run(progress))),
    })
}

fn pod_ref(pod: &Pod) -> ObjectRef {
    ObjectRef {
        group: String::new(),
        version: "v1".to_owned(),
        kind: "Pod".to_owned(),
        namespace: pod.metadata.namespace.clone(),
        name: pod.metadata.name.clone().unwrap_or_default(),
    }
}

/// The node's pods, each with what a drain does with it.
async fn sorted(clients: &Clients, node: &str) -> Result<Vec<(Pod, Fate)>, IpcError> {
    let pods = pods_on(clients, node).await?;
    let mut daemon_sets: HashMap<(String, String), bool> = HashMap::new();
    let mut sorted = Vec::with_capacity(pods.len());
    for pod in pods {
        let exists = match daemon_set_of(&pod) {
            Some(key) => match daemon_sets.get(&key) {
                Some(exists) => *exists,
                None => {
                    let path = format!("/apis/apps/v1/namespaces/{}/daemonsets/{}", key.0, key.1);
                    let exists = match get(clients, &path).await {
                        Ok(_) => true,
                        Err(error) if error.kind == ErrorKind::NotFound => false,
                        Err(error) => return Err(error),
                    };
                    daemon_sets.insert(key, exists);
                    exists
                }
            },
            None => false,
        };
        let fate = fate(&pod, exists);
        sorted.push((pod, fate));
    }
    Ok(sorted)
}

fn finished(pod: &Pod) -> bool {
    matches!(
        pod.status
            .as_ref()
            .and_then(|status| status.phase.as_deref()),
        Some("Succeeded" | "Failed")
    )
}

/// The namespace and name of the DaemonSet whose running pod it is.
fn daemon_set_of(pod: &Pod) -> Option<(String, String)> {
    let owner = pod
        .metadata
        .owner_references
        .iter()
        .flatten()
        .find(|owner| owner.controller == Some(true))?;
    (owner.api_version == "apps/v1" && owner.kind == "DaemonSet" && !finished(pod)).then(|| {
        (
            pod.metadata.namespace.clone().unwrap_or_default(),
            owner.name.clone(),
        )
    })
}

/// What a drain does with a pod, as kubectl's filters decide in turn:
/// DaemonSet, mirror, local storage, unreplicated (`pkg/drain/filters.go`).
/// A pod of a DaemonSet that is gone is one no controller replaces.
fn fate(pod: &Pod, daemon_set_exists: bool) -> Fate {
    let daemon_set = daemon_set_of(pod).is_some();
    if daemon_set && daemon_set_exists {
        return Fate::LeaveDaemon;
    }
    let mirror = pod
        .metadata
        .annotations
        .as_ref()
        .is_some_and(|annotations| annotations.contains_key("kubernetes.io/config.mirror"));
    if mirror {
        return Fate::LeaveStatic;
    }
    let running = !finished(pod);
    let controlled = pod
        .metadata
        .owner_references
        .iter()
        .flatten()
        .any(|owner| owner.controller == Some(true));
    let unmanaged = daemon_set || (running && !controlled);
    let empty_dir = running
        && pod
            .spec
            .as_ref()
            .and_then(|spec| spec.volumes.as_ref())
            .is_some_and(|volumes| volumes.iter().any(|volume| volume.empty_dir.is_some()));
    if unmanaged || empty_dir {
        Fate::Force {
            unmanaged,
            empty_dir,
        }
    } else {
        Fate::Evict
    }
}

/// Every pod on the node, a page at a time, as kubectl lists them.
async fn pods_on(clients: &Clients, node: &str) -> Result<Vec<Pod>, IpcError> {
    let mut pods = Vec::new();
    let mut next: Option<String> = None;
    loop {
        let query = {
            let mut query = form_urlencoded::Serializer::new(String::new());
            query.append_pair(
                "fieldSelector",
                &format!("spec.nodeName={}", field_value(node)),
            );
            query.append_pair("limit", "500");
            if let Some(token) = &next {
                query.append_pair("continue", token);
            }
            query.finish()
        };
        let request = http::Request::get(format!("/api/v1/pods?{query}"))
            .body(Vec::new())
            .expect("a collection's path makes a request");
        let page: k8s_openapi::List<Pod> = clients
            .api
            .request(request)
            .await
            .map_err(|error| twigo_kube::errors::request(&error))?;
        pods.extend(page.items);
        match page.metadata.continue_.filter(|token| !token.is_empty()) {
            Some(token) => next = Some(token),
            None => return Ok(pods),
        }
    }
}

struct Run {
    core: Weak<Core>,
    connection: Option<u64>,
    target: Target,
    flags: Flags,
}

impl Run {
    async fn run(self, progress: Progress) -> Result<Finished, IpcError> {
        let target = &self.target;
        let name = &target.name;
        let (core, clients) = clients_for(
            &self.core,
            &target.context,
            self.connection,
            "drained nothing",
        )
        .await?;
        let node = get(&clients, &target.path).await?;
        if node["spec"]["unschedulable"] != true {
            clients
                .api
                .request_text(write(
                    Method::PATCH,
                    &target.path,
                    STRATEGIC_MERGE_PATCH,
                    &patch(true),
                ))
                .await
                .map_err(|error| twigo_kube::errors::request(&error))?;
        }
        let stays = |why: String| {
            IpcError::new(
                ErrorKind::InvalidInput,
                format!("Node {name} stays cordoned: {why}"),
            )
        };
        let pods = sorted(&clients, name)
            .await
            .map_err(|error| stays(error.message))?;
        let refused: Vec<String> = pods
            .iter()
            .filter(|(_, fate)| match fate {
                Fate::Force {
                    unmanaged,
                    empty_dir,
                } => (*unmanaged && !self.flags.unmanaged) || (*empty_dir && !self.flags.empty_dir),
                _ => false,
            })
            .map(|(pod, _)| pod_name(pod))
            .collect();
        if !refused.is_empty() {
            return Err(stays(format!(
                "{} came that the plan did not take: {}",
                counted(refused.len(), "pod"),
                refused.join(", ")
            )));
        }
        let evicted: Vec<&Pod> = pods
            .iter()
            .filter(|(_, fate)| matches!(fate, Fate::Evict | Fate::Force { .. }))
            .map(|(pod, _)| pod)
            .collect();
        let total = evicted.len();
        // Listed while the evictions go, so none that goes is missed.
        let mut followed = core
            .hub
            .rows(Query {
                context: target.context.clone(),
                resource: Resource {
                    group: String::new(),
                    version: "v1".to_owned(),
                    resource: "pods".to_owned(),
                    namespaced: true,
                },
                format: RowFormat::Metadata,
                namespaces: Vec::new(),
                field_selector: Some(format!("spec.nodeName={}", field_value(name))),
            })
            .await
            .map_err(|error| stays(error.message))?;
        progress.running(format!(
            "Evicting {} from node {name}",
            counted(total, "pod")
        ));
        // As kubectl's evictPods: one pod's failure stops none of the others,
        // and the failures are told once the rest have gone. A stop sends no
        // more and lets those in flight answer, so it knows what went.
        let results = join_all(evicted.iter().map(|pod| {
            let (clients, progress) = (&clients, &progress);
            async move {
                (
                    pod.metadata.uid.clone(),
                    evict(clients, pod, progress).await,
                )
            }
        }))
        .await;
        let uids: HashSet<String> = results
            .iter()
            .filter(|(_, evicted)| matches!(evicted, Ok(true)))
            .filter_map(|(uid, _)| uid.clone())
            .collect();
        let failed: Vec<&IpcError> = results
            .iter()
            .filter_map(|(_, evicted)| evicted.as_ref().err())
            .collect();
        let failures = failed
            .iter()
            .map(|error| error.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        let stopped = || {
            let mut told = format!(
                "Stopped draining node {name}, which stays cordoned; it evicted {} of {}",
                uids.len(),
                counted(total, "pod")
            );
            if !failed.is_empty() {
                told.push_str("; ");
                told.push_str(&failures);
            }
            Finished::Stopped(told)
        };
        if progress.stopping() {
            return Ok(stopped());
        }
        let finish = |done: String| match failed.first() {
            None => Ok(Finished::Done(done)),
            Some(first) => Err(IpcError::new(
                first.kind,
                format!("Node {name} stays cordoned: {failures}"),
            )),
        };
        tokio::select! {
            whole = followed.whole() => if whole.is_err() {
                return finish(format!(
                    "Evicted {} from node {name}; Twigo cannot watch them go",
                    counted(uids.len(), "pod")
                ));
            },
            () = progress.stopped() => return Ok(stopped()),
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
                        .is_some_and(|uid| uids.contains(uid))
                })
                .count();
            if left == 0 {
                return finish(format!("Drained node {name}"));
            }
            if told != Some(left) {
                progress.running(format!(
                    "Waiting for {left} of {} to leave node {name}",
                    counted(uids.len(), "pod")
                ));
                told = Some(left);
            }
            tokio::select! {
                () = followed.changed() => {}
                () = progress.stopped() => return Ok(stopped()),
            }
        }
    }
}

fn pod_name(pod: &Pod) -> String {
    format!(
        "{}/{}",
        pod.metadata.namespace.as_deref().unwrap_or_default(),
        pod.metadata.name.as_deref().unwrap_or_default()
    )
}

/// Evicts a pod as kubectl does, asking again while a budget holds it
/// back: whether it went, a pod gone already among them, or the drain
/// stopped first.
async fn evict(clients: &Clients, pod: &Pod, progress: &Progress) -> Result<bool, IpcError> {
    let namespace = pod.metadata.namespace.as_deref().unwrap_or_default();
    let name = pod.metadata.name.as_deref().unwrap_or_default();
    let path = format!("/api/v1/namespaces/{namespace}/pods/{name}/eviction");
    let eviction = json!({
        "apiVersion": "policy/v1",
        "kind": "Eviction",
        "metadata": { "name": name, "namespace": namespace },
        "deleteOptions": { "preconditions": { "uid": pod.metadata.uid } },
    });
    let terminating = pod.metadata.deletion_timestamp.is_some();
    loop {
        if progress.stopping() {
            return Ok(false);
        }
        match clients
            .api
            .request_text(write(Method::POST, &path, "application/json", &eviction))
            .await
        {
            Ok(_) => return Ok(true),
            // Gone, or another pod of its name: the one it listed went.
            Err(kube::Error::Api(status)) if matches!(status.code, 404 | 409) => return Ok(true),
            Err(kube::Error::Api(status)) if status.code == 429 => {
                progress.running(format!(
                    "A disruption budget holds pod {namespace}/{name} back; asking again in {} s",
                    RETRY.as_secs()
                ));
            }
            Err(kube::Error::Api(status))
                if status.code == 403 && namespace_terminating(status.details.as_ref()) =>
            {
                if terminating {
                    return Ok(true);
                }
                progress.running(format!(
                    "Namespace {namespace} is going; asking again for pod {name} in {} s",
                    RETRY.as_secs()
                ));
            }
            Err(error) => {
                let error = twigo_kube::errors::request(&error);
                return Err(IpcError::new(
                    error.kind,
                    format!("evicting pod {namespace}/{name} failed: {}", error.message),
                ));
            }
        }
        tokio::select! {
            () = tokio::time::sleep(RETRY) => {}
            () = progress.stopped() => return Ok(false),
        }
    }
}

/// Whether a refusal says the pod's namespace is being deleted, as
/// `NamespaceTerminatingCause` names it.
fn namespace_terminating(details: Option<&kube::core::response::StatusDetails>) -> bool {
    details.is_some_and(|details| {
        details
            .causes
            .iter()
            .any(|cause| cause.reason == "NamespaceTerminating")
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{Fate, fate};

    fn pod(metadata: Value, spec: Value, phase: &str) -> k8s_openapi::api::core::v1::Pod {
        serde_json::from_value(json!({
            "metadata": metadata,
            "spec": spec,
            "status": { "phase": phase },
        }))
        .unwrap()
    }

    fn owned(kind: &str, api_version: &str) -> Value {
        json!({ "name": "p", "namespace": "a", "ownerReferences": [{
            "apiVersion": api_version, "kind": kind, "name": "o", "uid": "u", "controller": true,
        }] })
    }

    #[test]
    fn a_pod_s_fate_follows_kubectl_s_filters_in_turn() {
        let plain = json!({ "containers": [] });
        let scratch = json!({ "containers": [], "volumes": [{ "name": "s", "emptyDir": {} }] });
        let alone = json!({ "name": "p", "namespace": "a" });
        let mirror = json!({ "name": "p", "namespace": "a",
            "annotations": { "kubernetes.io/config.mirror": "x" } });
        let replica = owned("ReplicaSet", "apps/v1");
        let daemon = owned("DaemonSet", "apps/v1");
        let force = |unmanaged, empty_dir| Fate::Force {
            unmanaged,
            empty_dir,
        };
        let cases = [
            (
                "managed",
                replica.clone(),
                plain.clone(),
                "Running",
                true,
                Fate::Evict,
            ),
            (
                "its daemon set's",
                daemon.clone(),
                plain.clone(),
                "Running",
                true,
                Fate::LeaveDaemon,
            ),
            (
                "of a daemon set that is gone",
                daemon.clone(),
                plain.clone(),
                "Running",
                false,
                force(true, false),
            ),
            (
                "a finished daemon set's",
                daemon,
                plain.clone(),
                "Succeeded",
                true,
                Fate::Evict,
            ),
            (
                "static",
                mirror,
                plain.clone(),
                "Running",
                false,
                Fate::LeaveStatic,
            ),
            (
                "unmanaged",
                alone.clone(),
                plain.clone(),
                "Running",
                false,
                force(true, false),
            ),
            (
                "finished and unmanaged",
                alone.clone(),
                plain,
                "Failed",
                false,
                Fate::Evict,
            ),
            (
                "with emptyDir data",
                replica,
                scratch.clone(),
                "Running",
                false,
                force(false, true),
            ),
            (
                "unmanaged, with emptyDir data",
                alone.clone(),
                scratch.clone(),
                "Pending",
                false,
                force(true, true),
            ),
            (
                "finished, with emptyDir data",
                alone,
                scratch,
                "Succeeded",
                false,
                Fate::Evict,
            ),
        ];
        for (what, metadata, spec, phase, exists, expected) in cases {
            assert_eq!(
                fate(&pod(metadata, spec, phase), exists),
                expected,
                "{what}"
            );
        }
    }
}
