//! The pods a target controls (ARCHITECTURE 4.6): a pod itself, or the pods
//! a workload controls by their controller reference, a Deployment's through
//! its ReplicaSets and a CronJob's through its Jobs, read through the hub as
//! whole objects. Logs follow them for their containers' states, and
//! port-forwards for the pods that can be reached.

use std::collections::HashSet;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::{BoxFuture, select_all};
use twigo_cache::hub::{self, Delta, Hub, Query, Resource, RowFormat, Subscription};
use twigo_cache::meta::Meta;
use twigo_cache::object::Object;
use twigo_cache::store::Item;
use twigo_cache::table::{Column, Row};
use twigo_ipc::{ErrorKind, IpcError, ViewState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reach {
    /// The target is the pod.
    Pod,
    /// Its pods are the ones it controls.
    Owns,
    /// Its pods are those of the objects of this resource it controls.
    Through(&'static str, &'static str),
}

#[derive(Debug, Clone)]
pub(crate) struct Target {
    reach: Reach,
    resource: Resource,
    pub namespace: String,
    pub name: String,
}

impl Target {
    pub(crate) fn new(reach: Reach, resource: Resource, namespace: String, name: String) -> Self {
        Self {
            reach,
            resource,
            namespace,
            name,
        }
    }
}

pub(crate) fn resource_name(group: &str, resource: &str) -> String {
    if group.is_empty() {
        resource.to_owned()
    } else {
        format!("{resource}.{group}")
    }
}

pub(crate) fn v1(group: &str, resource: &str) -> Resource {
    Resource {
        group: group.to_owned(),
        version: "v1".to_owned(),
        resource: resource.to_owned(),
        namespaced: true,
    }
}

/// The target's subscriptions in the hub.
pub(crate) struct Subscriptions {
    target: Target,
    /// The target itself.
    object: Subscription<Object>,
    /// The ReplicaSets or Jobs of the namespace, for a target that controls
    /// its pods through them.
    controlled: Option<Subscription<Row>>,
    /// The namespace's pods, for a workload.
    pods: Option<Subscription<Object>>,
}

impl Subscriptions {
    pub(crate) async fn new(hub: &Hub, context: &str, target: Target) -> Result<Self, IpcError> {
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
            target,
            object,
            controlled,
            pods,
        })
    }

    pub(crate) fn target(&self) -> &Target {
        &self.target
    }

    /// Whether anything changed since the last look.
    pub(crate) fn drain(&self) -> bool {
        let mut changed = drained(&self.object);
        if let Some(controlled) = &self.controlled {
            changed |= drained(controlled);
        }
        if let Some(pods) = &self.pods {
            changed |= drained(pods);
        }
        changed
    }

    /// Waits for a change of any subscription.
    pub(crate) async fn changed(&mut self) {
        let mut waits: Vec<BoxFuture<'_, ()>> = vec![self.object.changed().boxed()];
        if let Some(controlled) = &mut self.controlled {
            waits.push(controlled.changed().boxed());
        }
        if let Some(pods) = &mut self.pods {
            waits.push(pods.changed().boxed());
        }
        select_all(waits).await;
    }

    pub(crate) fn states(&self) -> Vec<ViewState> {
        let mut states = vec![self.object.state()];
        states.extend(self.controlled.as_ref().map(Subscription::state));
        states.extend(self.pods.as_ref().map(Subscription::state));
        states
    }

    /// The least ready of its subscriptions' states, or an error once the
    /// target is gone.
    pub(crate) fn state(&self) -> ViewState {
        match self.gone() {
            Some(error) => ViewState::Error { error },
            None => hub::combine(self.states().into_iter()),
        }
    }

    pub(crate) fn gone(&self) -> Option<IpcError> {
        let ready = hub::combine(self.states().into_iter()) == ViewState::Ready;
        (ready && self.object.listed() && self.object.items().is_empty()).then(|| {
            IpcError::new(
                ErrorKind::NotFound,
                format!(
                    "{} {} is gone",
                    resource_name(&self.target.resource.group, &self.target.resource.resource),
                    self.target.name
                ),
            )
        })
    }

    /// The target's pods, once its subscriptions have listed them.
    pub(crate) fn pods(&self) -> Option<Vec<Arc<Object>>> {
        if !self.object.listed() {
            return None;
        }
        let object = self.object.items().into_iter().next();
        if self.target.reach == Reach::Pod {
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
                .filter(|row| controlled_by(row.meta(), |owner| owner == &*uid))
                .filter_map(|row| row.meta.uid.clone())
                .collect(),
            None => HashSet::from([uid]),
        };
        Some(
            pods.items()
                .into_iter()
                .filter(|pod| controlled_by(&pod.meta, |owner| owners.contains(owner)))
                .collect(),
        )
    }

    /// The columns the server prints for pods, Status among them.
    pub(crate) fn columns(&self) -> Option<Arc<[Column]>> {
        self.pods.as_ref().unwrap_or(&self.object).columns()
    }
}

/// Whether a controller owner reference names an owner `owners` takes.
fn controlled_by(meta: &Meta, owners: impl Fn(&str) -> bool) -> bool {
    meta.owners
        .iter()
        .any(|owner| owner.controller && owners(&owner.uid))
}

fn drained<T: Item>(subscription: &Subscription<T>) -> bool {
    match subscription.drain() {
        Delta::Reset { .. } => true,
        Delta::Changed { upserted, removed } => !upserted.is_empty() || !removed.is_empty(),
    }
}
