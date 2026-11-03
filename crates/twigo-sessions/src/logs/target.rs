//! What a logs session follows (ARCHITECTURE 4.6): a pod, or the pods a
//! workload controls, a Deployment's through its ReplicaSets and a
//! CronJob's through its Jobs, read through the hub as whole objects for
//! their containers' states.

use std::collections::HashSet;
use std::sync::Arc;

use twigo_cache::hub::{self, Delta, Hub, Query, Resource, RowFormat, Subscription};
use twigo_cache::object::Object;
use twigo_cache::store::Item;
use twigo_cache::table::{Column, Row};
use twigo_ipc::{ErrorKind, IpcError, LogTarget, ViewState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reach {
    /// The target is the pod.
    Pod,
    /// Its pods are the ones it controls.
    Owns,
    /// Its pods are those of the objects of this resource it controls.
    Through(&'static str, &'static str),
}

/// The kinds a logs tab follows, by group and resource.
const KINDS: &[(&str, &str, Reach)] = &[
    ("", "pods", Reach::Pod),
    ("apps", "deployments", Reach::Through("apps", "replicasets")),
    ("apps", "replicasets", Reach::Owns),
    ("apps", "statefulsets", Reach::Owns),
    ("apps", "daemonsets", Reach::Owns),
    ("batch", "jobs", Reach::Owns),
    ("batch", "cronjobs", Reach::Through("batch", "jobs")),
];

#[derive(Debug, Clone)]
pub struct Target {
    reach: Reach,
    resource: Resource,
    pub namespace: String,
    pub name: String,
}

impl Target {
    /// Refuses the kinds that have no pods of their own to follow.
    pub fn new(target: &LogTarget) -> Result<Self, IpcError> {
        let gvr = &target.gvr;
        let reach = KINDS
            .iter()
            .find(|(group, resource, _)| *group == gvr.group && *resource == gvr.resource)
            .map(|(_, _, reach)| *reach)
            .ok_or_else(|| IpcError {
                kind: ErrorKind::InvalidInput,
                message: format!(
                    "{} has no logs: a logs tab follows a pod, or the pods of a workload",
                    resource_name(&gvr.group, &gvr.resource)
                ),
            })?;
        if target.namespace.is_empty() {
            return Err(IpcError {
                kind: ErrorKind::InvalidInput,
                message: format!("{} names no namespace", target.name),
            });
        }
        Ok(Self {
            reach,
            resource: Resource {
                group: gvr.group.clone(),
                version: gvr.version.clone(),
                resource: gvr.resource.clone(),
                namespaced: true,
            },
            namespace: target.namespace.clone(),
            name: target.name.clone(),
        })
    }
}

fn resource_name(group: &str, resource: &str) -> String {
    if group.is_empty() {
        resource.to_owned()
    } else {
        format!("{resource}.{group}")
    }
}

fn v1(group: &str, resource: &str) -> Resource {
    Resource {
        group: group.to_owned(),
        version: "v1".to_owned(),
        resource: resource.to_owned(),
        namespaced: true,
    }
}

/// The target's subscriptions in the hub.
pub struct Followed {
    target: Subscription<Object>,
    /// The ReplicaSets or Jobs of the namespace, for a target that controls
    /// its pods through them.
    controlled: Option<Subscription<Row>>,
    /// The namespace's pods, for a workload.
    pods: Option<Subscription<Object>>,
}

impl Followed {
    pub async fn new(hub: &Hub, context: &str, target: &Target) -> Result<Self, IpcError> {
        let namespace = Some(target.namespace.clone());
        let object = hub.object(
            context,
            target.resource.clone(),
            namespace.clone(),
            &target.name,
        )?;
        let controlled = match target.reach {
            Reach::Through(group, resource) => Some(
                hub.rows(Query {
                    context: context.to_owned(),
                    resource: v1(group, resource),
                    format: RowFormat::Metadata,
                    namespaces: vec![target.namespace.clone()],
                    field_selector: None,
                })
                .await?,
            ),
            Reach::Pod | Reach::Owns => None,
        };
        let pods = match target.reach {
            Reach::Pod => None,
            Reach::Owns | Reach::Through(..) => {
                Some(hub.selected(context, v1("", "pods"), namespace, None)?)
            }
        };
        Ok(Self {
            target: object,
            controlled,
            pods,
        })
    }

    /// Whether anything changed since the last look.
    pub fn drain(&self) -> bool {
        let mut changed = drained(&self.target);
        if let Some(controlled) = &self.controlled {
            changed |= drained(controlled);
        }
        if let Some(pods) = &self.pods {
            changed |= drained(pods);
        }
        changed
    }

    /// The least ready of its subscriptions' states, or an error once the
    /// target is gone.
    pub fn state(&self, target: &Target) -> ViewState {
        let mut states = vec![self.target.state()];
        states.extend(self.controlled.as_ref().map(Subscription::state));
        states.extend(self.pods.as_ref().map(Subscription::state));
        let state = hub::combine(states.into_iter());
        if state == ViewState::Ready && self.target.listed() && self.target.items().is_empty() {
            return ViewState::Error {
                error: IpcError {
                    kind: ErrorKind::NotFound,
                    message: format!(
                        "{} {} is gone",
                        resource_name(&target.resource.group, &target.resource.resource),
                        target.name
                    ),
                },
            };
        }
        state
    }

    /// The target's pods, once its subscriptions have listed them.
    pub fn pods(&self, target: &Target) -> Option<Vec<Arc<Object>>> {
        if !self.target.listed() {
            return None;
        }
        let object = self.target.items().into_iter().next();
        if target.reach == Reach::Pod {
            return Some(object.into_iter().collect());
        }
        let pods = self.pods.as_ref().expect("a workload follows its pods");
        let controlled = self.controlled.as_ref();
        if !pods.listed() || controlled.is_some_and(|controlled| !controlled.listed()) {
            return None;
        }
        let Some(uid) = object.as_ref().and_then(|object| object.meta.uid.clone()) else {
            return Some(Vec::new());
        };
        let owners: HashSet<Box<str>> = match controlled {
            Some(controlled) => controlled
                .items()
                .iter()
                .filter(|row| controls(row.meta(), &uid))
                .filter_map(|row| row.meta.uid.clone())
                .collect(),
            None => HashSet::from([uid]),
        };
        Some(
            pods.items()
                .into_iter()
                .filter(|pod| {
                    pod.meta
                        .owners
                        .iter()
                        .any(|owner| owner.controller && owners.contains(&owner.uid))
                })
                .collect(),
        )
    }

    /// The columns the server prints for pods, Status among them.
    pub fn columns(&self) -> Option<Arc<[Column]>> {
        self.pods.as_ref().unwrap_or(&self.target).columns()
    }
}

fn controls(meta: &twigo_cache::meta::Meta, uid: &str) -> bool {
    meta.owners
        .iter()
        .any(|owner| owner.controller && &*owner.uid == uid)
}

fn drained<T: Item>(subscription: &Subscription<T>) -> bool {
    match subscription.drain() {
        Delta::Reset { .. } => true,
        Delta::Changed { upserted, removed } => !upserted.is_empty() || !removed.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use twigo_ipc::Gvr;

    use super::*;

    fn target(group: &str, resource: &str) -> Result<Target, IpcError> {
        Target::new(&LogTarget {
            space: "kind-test".to_owned(),
            gvr: Gvr {
                group: group.to_owned(),
                version: "v1".to_owned(),
                resource: resource.to_owned(),
            },
            namespace: "shop".to_owned(),
            name: "api".to_owned(),
        })
    }

    #[test]
    fn a_pod_or_a_workload_has_logs() {
        for (group, resource, _) in KINDS {
            assert!(target(group, resource).is_ok(), "{resource}");
        }
        let refused = target("", "services").unwrap_err();
        assert_eq!(refused.kind, ErrorKind::InvalidInput);
        assert!(
            refused.message.starts_with("services has no logs"),
            "{}",
            refused.message
        );
        assert!(target("apps", "pods").is_err());
    }
}
