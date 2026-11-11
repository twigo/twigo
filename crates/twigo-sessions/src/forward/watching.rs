//! The pods a forward can reach, read through the hub (ARCHITECTURE 4.6): a
//! pod by name, the pods behind a Service by its EndpointSlices, or the
//! Ready pods a workload controls. The subscriptions exist only while the
//! forward needs them.

use std::collections::BTreeMap;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::{BoxFuture, select_all};
use serde::{Deserialize, Deserializer};
use twigo_cache::hub::{Hub, Resource, Subscription};
use twigo_cache::object::Object;
use twigo_ipc::{ErrorKind, IpcError, ViewState};

use super::{Config, Kind};
use crate::pods::{Subscriptions, v1};

const SERVICE_NAME: &str = "kubernetes.io/service-name";

pub(super) const UNANSWERED: &str = "the cluster does not answer";

/// A pod a connection can go to, and the port it reaches there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Candidate {
    /// What tells it from the others: its name for the pod a forward was
    /// made for, since a pod of that name made again is the same target, and
    /// its uid for the pods behind a Service or a workload.
    pub key: Box<str>,
    pub name: Box<str>,
    pub port: u16,
}

pub(super) enum Seen {
    /// Not everything is listed yet; the cluster does not answer, when that
    /// is why.
    Unlisted(Option<String>),
    /// The credentials are rejected, which the hub gives up on, or the
    /// target is gone.
    Fault(IpcError),
    /// The cluster refuses or fails in a way the hub tries again.
    Refused(IpcError),
    Listed {
        candidates: Vec<Candidate>,
        /// Why there are none, when there are none.
        why: String,
    },
}

pub(super) enum Watching {
    Pod(Subscription<Object>),
    Service {
        service: Subscription<Object>,
        slices: Subscription<Object>,
    },
    Workload(Box<Subscriptions>),
}

impl Watching {
    pub(super) async fn new(hub: &Hub, config: &Config) -> Result<Self, IpcError> {
        let Config {
            context, target, ..
        } = config;
        let namespace = Some(target.namespace.clone());
        Ok(match target.kind {
            Kind::Pod => {
                Watching::Pod(hub.object(context, v1("", "pods"), namespace, &target.name)?)
            }
            Kind::Service => Watching::Service {
                service: hub.object(
                    context,
                    v1("", "services"),
                    namespace.clone(),
                    &target.name,
                )?,
                slices: hub.selected(
                    context,
                    Resource {
                        group: "discovery.k8s.io".to_owned(),
                        version: "v1".to_owned(),
                        resource: "endpointslices".to_owned(),
                        namespaced: true,
                    },
                    namespace,
                    None,
                )?,
            },
            Kind::Workload(reach) => Watching::Workload(Box::new(
                Subscriptions::new(
                    hub,
                    context,
                    crate::pods::Target::new(
                        reach,
                        target.resource.clone(),
                        target.namespace.clone(),
                        target.name.clone(),
                    ),
                )
                .await?,
            )),
        })
    }

    pub(super) async fn changed(&mut self) {
        let waits: Vec<BoxFuture<'_, ()>> = match self {
            Watching::Pod(pod) => vec![pod.changed().boxed()],
            Watching::Service { service, slices } => {
                vec![service.changed().boxed(), slices.changed().boxed()]
            }
            Watching::Workload(workload) => vec![workload.changed().boxed()],
        };
        select_all(waits).await;
    }

    pub(super) fn look(&self, config: &Config) -> Seen {
        let label = &config.target.label;
        let name = &config.target.name;
        match self {
            Watching::Pod(pod) => {
                let states = [pod.state()];
                if let Some(seen) = refusal(&states) {
                    return seen;
                }
                if !pod.listed() {
                    return Seen::Unlisted(unanswered(&states));
                }
                let Some(object) = pod.items().into_iter().next() else {
                    return Seen::Fault(gone(label, name));
                };
                let Ok(doc) = serde_json::from_str::<PodDoc>(object.json.get()) else {
                    return Seen::Listed {
                        candidates: Vec::new(),
                        why: format!("{label} {name} could not be read"),
                    };
                };
                if doc.status.finished() {
                    return Seen::Listed {
                        candidates: Vec::new(),
                        why: format!("{label} {name} has finished"),
                    };
                }
                Seen::Listed {
                    candidates: vec![Candidate {
                        key: name.as_str().into(),
                        name: name.as_str().into(),
                        port: config.port,
                    }],
                    why: String::new(),
                }
            }
            Watching::Service { service, slices } => {
                let states = [service.state(), slices.state()];
                if let Some(seen) = refusal(&states) {
                    return seen;
                }
                if !(service.listed() && slices.listed()) {
                    return Seen::Unlisted(unanswered(&states));
                }
                let Some(object) = service.items().into_iter().next() else {
                    return Seen::Fault(gone(label, name));
                };
                let (candidates, why) =
                    behind(&object, &slices.items(), name, config.port_name.as_deref());
                Seen::Listed { candidates, why }
            }
            Watching::Workload(workload) => {
                let states = workload.states();
                if let Some(seen) = refusal(&states) {
                    return seen;
                }
                if let Some(error) = workload.gone() {
                    return Seen::Fault(error);
                }
                let Some(pods) = workload.pods() else {
                    return Seen::Unlisted(unanswered(&states));
                };
                let candidates = ready(&pods, config.port, config.port_name.as_deref());
                let why = if candidates.is_empty() {
                    format!("no pod of {label} {name} is ready")
                } else {
                    String::new()
                };
                Seen::Listed { candidates, why }
            }
        }
    }
}

fn gone(label: &str, name: &str) -> IpcError {
    IpcError::new(ErrorKind::NotFound, format!("{label} {name} is gone"))
}

/// What the hub's states say of the cluster's refusals: only a rejected
/// credential is final, since the hub tries every other error again.
fn refusal(states: &[ViewState]) -> Option<Seen> {
    if states.contains(&ViewState::Unauthorized) {
        return Some(Seen::Fault(IpcError::new(
            ErrorKind::Unauthorized,
            "no credentials for this context that the cluster accepts",
        )));
    }
    states.iter().find_map(|state| match state {
        ViewState::Forbidden { verb, resource } => Some(Seen::Refused(IpcError::new(
            ErrorKind::Forbidden,
            format!("you may not {verb} {resource}"),
        ))),
        ViewState::Error { error } => Some(Seen::Refused(error.clone())),
        _ => None,
    })
}

/// The cluster does not answer when a subscription that has listed nothing
/// yet is reconnecting.
fn unanswered(states: &[ViewState]) -> Option<String> {
    states
        .contains(&ViewState::Stale)
        .then(|| UNANSWERED.to_owned())
}

/// A list the API server sends as `null` when it is empty.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Deserialize)]
struct PodDoc {
    metadata: PodMeta,
    #[serde(default)]
    spec: PodSpec,
    #[serde(default)]
    status: PodStatus,
}

#[derive(Deserialize)]
struct PodMeta {
    #[serde(default)]
    name: String,
    #[serde(default)]
    uid: String,
    #[serde(default, rename = "deletionTimestamp")]
    deleted: Option<String>,
}

#[derive(Default, Deserialize)]
struct PodSpec {
    #[serde(default, deserialize_with = "lenient")]
    containers: Vec<ContainerDoc>,
    #[serde(default, deserialize_with = "lenient", rename = "initContainers")]
    init_containers: Vec<ContainerDoc>,
}

#[derive(Deserialize)]
struct ContainerDoc {
    #[serde(default, deserialize_with = "lenient")]
    ports: Vec<ContainerPort>,
    /// `Always` makes an init container a sidecar, which keeps running.
    #[serde(default, rename = "restartPolicy")]
    restart_policy: Option<String>,
}

#[derive(Deserialize)]
struct ContainerPort {
    #[serde(rename = "containerPort")]
    port: u16,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    protocol: Option<String>,
}

#[derive(Default, Deserialize)]
struct PodStatus {
    #[serde(default)]
    phase: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    conditions: Vec<Condition>,
}

#[derive(Deserialize)]
struct Condition {
    #[serde(rename = "type")]
    kind: String,
    status: String,
}

impl PodStatus {
    fn finished(&self) -> bool {
        matches!(self.phase.as_deref(), Some("Succeeded" | "Failed"))
    }

    fn ready(&self) -> bool {
        self.conditions
            .iter()
            .any(|condition| condition.kind == "Ready" && condition.status == "True")
    }
}

fn is_tcp(protocol: Option<&str>) -> bool {
    protocol.is_none_or(|protocol| protocol == "TCP")
}

impl PodSpec {
    /// The container port called `name`, in the containers that run for the
    /// pod's life.
    fn port_named(&self, name: &str) -> Option<u16> {
        let sidecars = self
            .init_containers
            .iter()
            .filter(|container| container.restart_policy.as_deref() == Some("Always"));
        self.containers
            .iter()
            .chain(sidecars)
            .flat_map(|container| &container.ports)
            .find(|port| port.name.as_deref() == Some(name) && is_tcp(port.protocol.as_deref()))
            .map(|port| port.port)
    }
}

/// The Ready pods of a workload, by name, each with the port a forward
/// reaches in it: the container port of the same name where the workload's
/// port has a name, which a pod of another version may number differently,
/// else the number.
fn ready(pods: &[Arc<Object>], port: u16, name: Option<&str>) -> Vec<Candidate> {
    let mut candidates: Vec<Candidate> = pods
        .iter()
        .filter_map(|object| {
            let doc: PodDoc = serde_json::from_str(object.json.get()).ok()?;
            if doc.metadata.deleted.is_some() || doc.status.finished() || !doc.status.ready() {
                return None;
            }
            let port = match name {
                Some(name) => doc.spec.port_named(name)?,
                None => port,
            };
            Some(Candidate {
                key: doc.metadata.uid.as_str().into(),
                name: doc.metadata.name.as_str().into(),
                port,
            })
        })
        .collect();
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    candidates
}

#[derive(Deserialize)]
struct ServiceDoc {
    #[serde(default)]
    spec: ServiceSpec,
}

#[derive(Default, Deserialize)]
struct ServiceSpec {
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct SliceDoc {
    #[serde(default, deserialize_with = "lenient")]
    endpoints: Vec<Endpoint>,
    #[serde(default, deserialize_with = "lenient")]
    ports: Vec<SlicePort>,
}

#[derive(Deserialize)]
struct Endpoint {
    #[serde(default)]
    conditions: Conditions,
    #[serde(default, rename = "targetRef")]
    target: Option<TargetRef>,
}

#[derive(Default, Deserialize)]
struct Conditions {
    #[serde(default)]
    serving: Option<bool>,
    #[serde(default)]
    terminating: Option<bool>,
}

#[derive(Deserialize)]
struct TargetRef {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    uid: String,
}

#[derive(Deserialize)]
struct SlicePort {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    protocol: Option<String>,
}

/// The pods behind a Service that serve and are not going away, one per pod
/// whatever the address families it has, each with the port its slice names
/// for the Service port: slices group pods by what their named `targetPort`s
/// resolve to, so no pod spec is read
/// ([`endpointslice` utils](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/endpointslice/utils.go#L76-L102)).
/// Without one, why.
fn behind(
    service: &Object,
    slices: &[Arc<Object>],
    name: &str,
    port_name: Option<&str>,
) -> (Vec<Candidate>, String) {
    if let Ok(doc) = serde_json::from_str::<ServiceDoc>(service.json.get())
        && doc.spec.kind.as_deref() == Some("ExternalName")
    {
        return (
            Vec::new(),
            format!("Service {name} is of type ExternalName: it names a DNS record and has no pod"),
        );
    }
    let wanted = port_name.unwrap_or_default();
    let mut found: BTreeMap<Box<str>, Candidate> = BTreeMap::new();
    let (mut endpoints, mut pods, mut ready) = (0, 0, 0);
    let mut slices: Vec<&Arc<Object>> = slices
        .iter()
        .filter(|slice| {
            slice
                .meta
                .labels
                .iter()
                .any(|(key, value)| &**key == SERVICE_NAME && &**value == name)
        })
        .collect();
    slices.sort_by(|a, b| a.meta.name.cmp(&b.meta.name));
    for slice in slices {
        let Ok(doc) = serde_json::from_str::<SliceDoc>(slice.json.get()) else {
            continue;
        };
        let port = doc.ports.iter().find_map(|port| {
            (port.name.as_deref().unwrap_or_default() == wanted && is_tcp(port.protocol.as_deref()))
                .then_some(port.port)
                .flatten()
        });
        for endpoint in &doc.endpoints {
            endpoints += 1;
            let Some(target) = endpoint.target.as_ref().filter(|t| t.kind == "Pod") else {
                continue;
            };
            pods += 1;
            let serving = endpoint.conditions.serving != Some(false)
                && endpoint.conditions.terminating != Some(true);
            if !serving {
                continue;
            }
            ready += 1;
            if let Some(port) = port {
                found
                    .entry(target.uid.as_str().into())
                    .or_insert(Candidate {
                        key: target.uid.as_str().into(),
                        name: target.name.as_str().into(),
                        port,
                    });
            }
        }
    }
    let why = if !found.is_empty() {
        String::new()
    } else if endpoints > 0 && pods == 0 {
        format!("the endpoints of Service {name} are not pods, and only a pod can be forwarded to")
    } else if ready > 0 {
        let port = if wanted.is_empty() {
            "unnamed port".to_owned()
        } else {
            format!("port {wanted}")
        };
        format!("no ready pod behind Service {name} has its {port}")
    } else {
        format!("no pod behind Service {name} is ready")
    };
    let mut candidates: Vec<Candidate> = found.into_values().collect();
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    (candidates, why)
}
