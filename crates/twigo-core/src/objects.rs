//! Open objects (ARCHITECTURE 3.6, 4.3): an Object upstream for each, and
//! while their views show them its events and the objects it owns. The
//! object is described into the Overview document and sent in batches with
//! flow control, as lists are (3.5): one task per open object flushes on a
//! 50 ms interval and keeps at most one batch unacknowledged.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use twigo_cache::batcher::FLUSH;
use twigo_cache::hub::{Delta, Hub, Query, Resource, RowFormat, Subscription};
use twigo_cache::object::Object;
use twigo_cache::request::field_value;
use twigo_cache::table::{Cell, Column, ColumnKind, Row};
use twigo_describe::{Fact, Found, Input, Need, Owned, Printed};
use twigo_ipc::{
    ErrorKind, EventList, IpcError, ObjectBatch, ObjectEvent, ObjectParts, ObjectRef, Related,
    RelatedObject, ViewState,
};

/// An open object: dropping it ends its task and its upstreams.
pub struct Opened {
    control: Arc<Control>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct Control {
    pending: Mutex<Pending>,
    wake: Notify,
    /// The object as last listed, for the values a view asks for.
    latest: Mutex<Option<Arc<Object>>>,
}

/// What the webview asked for since the task last looked.
#[derive(Default)]
struct Pending {
    parts: Option<ObjectParts>,
    acked: Option<u32>,
}

/// Where an open object lives.
pub(crate) struct Target {
    pub context: String,
    pub namespace: Option<String>,
}

impl Opened {
    pub(crate) fn spawn(
        hub: Hub,
        target: Target,
        object: Subscription<Object>,
        parts: ObjectParts,
        send: impl FnMut(ObjectBatch) -> bool + Send + 'static,
    ) -> Self {
        let control = Arc::new(Control::default());
        let task = tokio::spawn(run(hub, target, object, parts, Arc::clone(&control), send));
        Self { control, task }
    }

    pub fn set_parts(&self, parts: ObjectParts) {
        self.control.pending.lock().expect("object lock").parts = Some(parts);
        self.control.wake.notify_one();
    }

    pub fn ack(&self, seq: u32) {
        self.control.pending.lock().expect("object lock").acked = Some(seq);
        self.control.wake.notify_one();
    }

    /// The values of a ConfigMap's keys: None for a key it lacks or holds
    /// as binary data. A Secret's values stay in Rust (ARCHITECTURE 3.6).
    pub fn values(&self, keys: &[String]) -> Result<Vec<Option<String>>, IpcError> {
        let latest = self.control.latest.lock().expect("object lock").clone();
        let object = latest.ok_or_else(|| IpcError {
            kind: ErrorKind::NotFound,
            message: "the object is not listed".to_owned(),
        })?;
        let json: Value = serde_json::from_str(object.json.get()).map_err(|error| IpcError {
            kind: ErrorKind::Internal,
            message: format!("the object does not parse: {error}"),
        })?;
        values_of(&json, keys)
    }
}

/// A ConfigMap's text values; any other kind's refused, a Secret's above all.
fn values_of(object: &Value, keys: &[String]) -> Result<Vec<Option<String>>, IpcError> {
    if object["apiVersion"] != "v1" || object["kind"] != "ConfigMap" {
        return Err(IpcError {
            kind: ErrorKind::Forbidden,
            message: "only a ConfigMap's values are sent".to_owned(),
        });
    }
    Ok(keys
        .iter()
        .map(|key| object["data"][key].as_str().map(str::to_owned))
        .collect())
}

impl Drop for Opened {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// What a batch should carry once its part is shown.
#[derive(Default)]
struct Dirty {
    overview: bool,
    manifest: bool,
    events: bool,
    related: bool,
}

impl Dirty {
    fn all() -> Self {
        Dirty {
            overview: true,
            manifest: true,
            events: true,
            related: true,
        }
    }
}

/// The events, owned objects and facts held for the object with `uid`.
struct Around {
    uid: Box<str>,
    events: Option<Subscription<Object>>,
    owned: Option<Vec<(Owned, Subscription<Row>)>>,
    /// What its describer needs, while the Overview is shown.
    facts: Option<Vec<Held>>,
}

/// A need of the object's describer, followed, and what it found so far.
struct Held {
    need: Need,
    /// None when the hub refused it, which `found` then says.
    objects: Option<Subscription<Object>>,
    found: Option<Found>,
}

async fn run(
    hub: Hub,
    target: Target,
    object: Subscription<Object>,
    mut parts: ObjectParts,
    control: Arc<Control>,
    mut send: impl FnMut(ObjectBatch) -> bool,
) {
    let mut interval = tokio::time::interval(FLUSH);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut seq = 0;
    let mut unacked = None;
    let mut status: Option<ViewState> = None;
    let mut dirty = Dirty::all();
    let mut current: Option<Arc<Object>> = None;
    let mut columns: Option<Arc<[Column]>> = None;
    let mut around: Option<Around> = None;
    let mut events = EventList::default();
    let mut related = Related::default();
    let mut facts: Vec<Fact> = Vec::new();
    loop {
        let ticked = tokio::select! {
            _ = interval.tick() => true,
            () = control.wake.notified() => false,
        };
        let Pending {
            parts: asked,
            acked,
        } = std::mem::take(&mut *control.pending.lock().expect("object lock"));
        if let Some(asked) = asked {
            dirty.overview |= asked.overview && !parts.overview;
            dirty.manifest |= asked.manifest && !parts.manifest;
            dirty.events |= asked.events && !parts.events;
            dirty.related |= asked.related && !parts.related;
            parts = asked;
        }
        if acked.is_some() && acked == unacked {
            unacked = None;
        }
        if unacked.is_some() || !ticked {
            continue;
        }

        let state = object.state();
        let changed = match object.drain() {
            Delta::Reset {
                rows,
                columns: read,
            } => {
                columns = read.or_else(|| object.columns());
                current = rows.into_iter().next();
                true
            }
            Delta::Changed { upserted, removed } => {
                if let Some(last) = upserted.into_iter().last() {
                    current = Some(last);
                    true
                } else if !removed.is_empty() {
                    current = None;
                    true
                } else {
                    false
                }
            }
        };
        if changed {
            columns = object.columns().or(columns);
            *control.latest.lock().expect("object lock") = current.clone();
            dirty = Dirty {
                events: dirty.events,
                related: dirty.related,
                ..Dirty::all()
            };
        }
        let parsed: Option<Value> = current
            .as_deref()
            .and_then(|object| serde_json::from_str(object.json.get()).ok());

        let wants_events = parts.overview || parts.events;
        let uid = current.as_ref().and_then(|object| object.meta.uid.clone());
        if around.as_ref().map(|held| &held.uid) != uid.as_ref() {
            around = None;
            events = EventList::default();
            related = Related::default();
            facts = Vec::new();
            dirty.overview = true;
            dirty.events = true;
            dirty.related = true;
        }
        if let (Some(uid), Some(json)) = (&uid, &parsed) {
            let held = around.get_or_insert_with(|| Around {
                uid: uid.clone(),
                events: None,
                owned: None,
                facts: None,
            });
            if wants_events && held.events.is_none() {
                held.events = events_of(&hub, &target, json, uid).ok();
            } else if !wants_events && held.events.is_some() {
                held.events = None;
            }
            if parts.related && held.owned.is_none() {
                held.owned = Some(owned_of(&hub, &target, json).await);
            } else if !parts.related {
                held.owned = None;
            }
            if let Some(subscription) = &held.events {
                let unavailable = unavailable(&subscription.state());
                if drained(subscription) || unavailable != events.unavailable {
                    let mut listed: Vec<ObjectEvent> = subscription
                        .items()
                        .iter()
                        .filter_map(|event| serde_json::from_str(event.json.get()).ok())
                        .map(|event: Value| twigo_describe::event(&event))
                        .collect();
                    twigo_describe::newest_first(&mut listed);
                    events = EventList {
                        events: listed,
                        unavailable,
                    };
                    dirty.overview = true;
                    dirty.events = true;
                }
            }
            let mut held_anew = false;
            if parts.overview {
                let needs = twigo_describe::needs(json);
                let current = held
                    .facts
                    .as_ref()
                    .is_some_and(|facts| facts.iter().map(|held| &held.need).eq(needs.iter()));
                if !current {
                    held.facts = Some(needs_of(&hub, &target, needs));
                    held_anew = true;
                }
            } else {
                held.facts = None;
            }
            if let Some(needs) = &mut held.facts
                && (found(needs) || held_anew)
            {
                facts = needs
                    .iter()
                    .filter_map(|held| {
                        Some(Fact {
                            need: held.need.clone(),
                            found: held.found.clone()?,
                        })
                    })
                    .collect();
                dirty.overview = true;
            }
            let owned = held.owned.as_deref().unwrap_or_default();
            let mut owned_changed = false;
            for (_, subscription) in owned {
                owned_changed |= drained(subscription);
            }
            let owned_unavailable = owned
                .iter()
                .find_map(|(_, subscription)| unavailable(&subscription.state()));
            if owned_changed || changed || owned_unavailable != related.unavailable {
                related = Related {
                    owners: owners(json, target.namespace.as_deref()),
                    owned: owned_by(owned, uid, target.namespace.as_deref()),
                    unavailable: owned_unavailable,
                };
                dirty.related = true;
            }
        }

        let status_changed = status.as_ref() != Some(&state);
        let due = status_changed
            || (parts.overview && dirty.overview)
            || (parts.manifest && dirty.manifest)
            || (parts.events && dirty.events)
            || (parts.related && dirty.related);
        if !due {
            continue;
        }
        seq += 1;
        let printed = match (&current, &columns) {
            (Some(object), Some(columns)) => printed(columns, &object.cells),
            _ => Vec::new(),
        };
        let shown = Shown {
            parts,
            dirty: &dirty,
            object: parsed.as_ref(),
            printed: &printed,
            events: &events,
            related: &related,
            facts: &facts,
        };
        let batch = shown.batch(seq, state.clone());
        dirty.overview &= !parts.overview;
        dirty.manifest &= !parts.manifest;
        dirty.events &= !parts.events;
        dirty.related &= !parts.related;
        status = Some(state);
        unacked = Some(seq);
        if !send(batch) {
            return;
        }
    }
}

/// What a batch is made of.
struct Shown<'a> {
    parts: ObjectParts,
    dirty: &'a Dirty,
    object: Option<&'a Value>,
    printed: &'a [Printed],
    events: &'a EventList,
    related: &'a Related,
    facts: &'a [Fact],
}

impl Shown<'_> {
    /// Carries each part that is shown and changed since it was last sent.
    fn batch(&self, seq: u32, status: ViewState) -> ObjectBatch {
        let Shown {
            parts,
            dirty,
            object,
            printed,
            events,
            related,
            facts,
        } = self;
        ObjectBatch {
            seq,
            status,
            exists: object.is_some(),
            overview: object
                .filter(|_| parts.overview && dirty.overview)
                .map(|object| {
                    twigo_describe::describe(Input {
                        object,
                        printed,
                        events,
                        facts,
                    })
                }),
            manifest: object
                .filter(|_| parts.manifest && dirty.manifest)
                .map(|object| twigo_policy::redact::for_view(object.clone()).to_string()),
            events: (parts.events && dirty.events).then(|| (*events).clone()),
            related: (parts.related && dirty.related).then(|| (*related).clone()),
        }
    }
}

/// Why an upstream's objects cannot be listed, in its state; None while
/// they are listed or still coming.
fn unavailable(state: &ViewState) -> Option<String> {
    match state {
        ViewState::Forbidden { verb, resource } => Some(format!("You may not {verb} {resource}.")),
        ViewState::Unauthorized => Some("The cluster does not accept the credentials.".to_owned()),
        ViewState::Error { error } => Some(error.message.clone()),
        _ => None,
    }
}

/// Drains a subscription, saying whether anything changed.
fn drained<T: twigo_cache::store::Item>(subscription: &Subscription<T>) -> bool {
    match subscription.drain() {
        Delta::Reset { .. } => true,
        Delta::Changed { upserted, removed } => !upserted.is_empty() || !removed.is_empty(),
    }
}

/// The cells the server printed for the object, as text: Name, Namespace
/// and Age are the metadata section's, and empty cells and the printers'
/// `<none>` say nothing.
pub fn printed(columns: &[Column], cells: &[Cell]) -> Vec<Printed> {
    columns
        .iter()
        .zip(cells)
        .filter(|(column, _)| {
            column.kind != ColumnKind::Age
                && &*column.format != "name"
                && !column.name.eq_ignore_ascii_case("namespace")
        })
        .filter_map(|(column, cell)| {
            let value = match cell {
                Cell::Null | Cell::Age => return None,
                Cell::Bool(value) => value.to_string(),
                Cell::Int(value) => value.to_string(),
                Cell::Number(value) => value.to_string(),
                Cell::Text(text) if text.is_empty() || &**text == "<none>" => return None,
                Cell::Text(text) => text.to_string(),
            };
            Some(Printed {
                column: column.name.to_string(),
                value,
            })
        })
        .collect()
}

/// The object's events through events.k8s.io, whose field selectors read
/// `regarding.*` as `involvedObject.*` (kubernetes v1.37.0,
/// `pkg/apis/events/v1/conversion.go`). A node's come by kind and name,
/// since the kubelet reports its name as its uid; a mirror pod's by the uid
/// of the pod it mirrors, as kubectl describe reads them.
fn events_of(
    hub: &Hub,
    target: &Target,
    object: &Value,
    uid: &str,
) -> Result<Subscription<Object>, IpcError> {
    hub.selected(
        &target.context,
        Resource {
            group: "events.k8s.io".to_owned(),
            version: "v1".to_owned(),
            resource: "events".to_owned(),
            namespaced: true,
        },
        target.namespace.clone(),
        Some(events_selector(object, uid)),
    )
}

fn events_selector(object: &Value, uid: &str) -> String {
    if object["apiVersion"] == "v1" && object["kind"] == "Node" {
        format!(
            "regarding.kind=Node,regarding.name={}",
            field_value(object["metadata"]["name"].as_str().unwrap_or_default())
        )
    } else {
        let mirrored = object["metadata"]["annotations"]["kubernetes.io/config.mirror"].as_str();
        format!("regarding.uid={}", field_value(mirrored.unwrap_or(uid)))
    }
}

/// Follows each need; one the hub refuses, as when it names no resource
/// it can request, is unavailable at once.
fn needs_of(hub: &Hub, target: &Target, needs: Vec<Need>) -> Vec<Held> {
    needs
        .into_iter()
        .map(|need| {
            let objects = hub.selected(
                &target.context,
                Resource {
                    group: need.group.clone(),
                    version: need.version.clone(),
                    resource: need.resource.clone(),
                    namespaced: need.namespaced,
                },
                need.namespace.clone(),
                need.field_selector.clone(),
            );
            match objects {
                Ok(objects) => Held {
                    need,
                    objects: Some(objects),
                    found: None,
                },
                Err(error) => Held {
                    need,
                    objects: None,
                    found: Some(Found::Unavailable {
                        message: error.message,
                    }),
                },
            }
        })
        .collect()
}

/// Reads what each need found since the last look, saying whether any
/// changed: its objects once listed, or why they cannot be.
fn found(needs: &mut [Held]) -> bool {
    let mut changed = false;
    for held in needs {
        let Some(objects) = &held.objects else {
            continue;
        };
        let moved = drained(objects);
        let found = if let Some(message) = unavailable(&objects.state()) {
            Some(Found::Unavailable { message })
        } else if objects.listed() {
            if !moved && matches!(held.found, Some(Found::Listed { .. })) {
                continue;
            }
            Some(Found::Listed {
                objects: by_name(
                    objects
                        .items()
                        .iter()
                        .filter_map(|object| serde_json::from_str(object.json.get()).ok())
                        .collect(),
                ),
            })
        } else {
            None
        };
        if found != held.found {
            held.found = found;
            changed = true;
        }
    }
    changed
}

/// Objects in the order the describers' fixtures record them, by namespace
/// and name, rather than the store's, which a relist reshuffles.
fn by_name(mut objects: Vec<Value>) -> Vec<Value> {
    objects.sort_by(|a, b| {
        let key = |object: &Value| {
            (
                object["metadata"]["namespace"].as_str().map(str::to_owned),
                object["metadata"]["name"].as_str().map(str::to_owned),
            )
        };
        key(a).cmp(&key(b))
    });
    objects
}

/// The metadata of the kinds the object's kind owns, in its namespace.
async fn owned_of(hub: &Hub, target: &Target, object: &Value) -> Vec<(Owned, Subscription<Row>)> {
    let (group, _) = twigo_describe::group_version(object);
    let kind = object["kind"].as_str().unwrap_or_default();
    let Some(namespace) = &target.namespace else {
        return Vec::new();
    };
    let mut held = Vec::new();
    for owned in twigo_describe::owned(group, kind) {
        let query = Query {
            context: target.context.clone(),
            resource: Resource {
                group: owned.group.to_owned(),
                version: owned.version.to_owned(),
                resource: owned.resource.to_owned(),
                namespaced: true,
            },
            format: RowFormat::Metadata,
            namespaces: vec![namespace.clone()],
            field_selector: None,
        };
        if let Ok(subscription) = hub.rows(query).await {
            held.push((*owned, subscription));
        }
    }
    held
}

fn owners(object: &Value, namespace: Option<&str>) -> Vec<RelatedObject> {
    object["metadata"]["ownerReferences"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|owner| {
            let (group, version) = twigo_describe::group_version(owner);
            Some(RelatedObject {
                target: ObjectRef {
                    group: group.to_owned(),
                    version: version.to_owned(),
                    kind: owner["kind"].as_str()?.to_owned(),
                    namespace: namespace.map(str::to_owned),
                    name: owner["name"].as_str()?.to_owned(),
                },
                controller: owner["controller"].as_bool() == Some(true),
            })
        })
        .collect()
}

fn owned_by(
    held: &[(Owned, Subscription<Row>)],
    uid: &str,
    namespace: Option<&str>,
) -> Vec<RelatedObject> {
    let mut owned: Vec<RelatedObject> = held
        .iter()
        .flat_map(|(kind, subscription)| {
            subscription.items().into_iter().filter_map(move |row| {
                let owner = row.meta.owners.iter().find(|owner| &*owner.uid == uid)?;
                Some(RelatedObject {
                    target: ObjectRef {
                        group: kind.group.to_owned(),
                        version: kind.version.to_owned(),
                        kind: kind.kind.to_owned(),
                        namespace: namespace.map(str::to_owned),
                        name: row.meta.name.to_string(),
                    },
                    controller: owner.controller,
                })
            })
        })
        .collect();
    owned.sort_by(|a, b| (&a.target.kind, &a.target.name).cmp(&(&b.target.kind, &b.target.name)));
    owned
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_open_secret_sends_neither_its_values_nor_their_base64() {
        let secret = json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": "db",
                "namespace": "payments",
                "uid": "5c2f",
                "annotations": {
                    "kubectl.kubernetes.io/last-applied-configuration":
                        "{\"data\":{\"password\":\"aHVudGVyMg==\"}}",
                },
                "managedFields": [{ "manager": "kubectl", "fieldsV1": { "f:data": {} } }],
            },
            "type": "Opaque",
            "data": { "password": "aHVudGVyMg==" },
        });
        let related = Related::default();
        let shown = Shown {
            parts: ObjectParts {
                overview: true,
                manifest: true,
                events: true,
                related: true,
            },
            dirty: &Dirty::all(),
            object: Some(&secret),
            printed: &[Printed {
                column: "Type".to_owned(),
                value: "Opaque".to_owned(),
            }],
            events: &EventList::default(),
            related: &related,
            facts: &[],
        };
        let batch = shown.batch(1, ViewState::Ready);
        assert!(batch.overview.is_some() && batch.manifest.is_some());
        let sent = serde_json::to_string(&batch).unwrap();
        assert!(sent.contains("password"), "the key is sent: {sent}");
        assert!(
            !sent.contains("hunter2") && !sent.contains("aHVudGVyMg"),
            "{sent}"
        );
    }

    #[test]
    fn values_come_from_a_config_map_only() {
        let keys = [
            "password".to_owned(),
            "mode".to_owned(),
            "logo.png".to_owned(),
        ];
        let secret = json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "data": { "password": "aHVudGVyMg==" },
        });
        let refused = values_of(&secret, &keys).unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Forbidden);
        let config = json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": { "mode": "fast" },
            "binaryData": { "logo.png": "iVBORw0KGgo=" },
        });
        assert_eq!(
            values_of(&config, &keys).unwrap(),
            [None, Some("fast".to_owned()), None]
        );
    }

    #[test]
    fn events_are_selected_by_uid_a_node_by_name_and_a_mirror_pod_by_its_pod() {
        let pod = json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "web" } });
        assert_eq!(events_selector(&pod, "5c2f"), "regarding.uid=5c2f");
        let mirror = json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "annotations": { "kubernetes.io/config.mirror": "a,b=c" } },
        });
        assert_eq!(events_selector(&mirror, "5c2f"), r"regarding.uid=a\,b\=c");
        let node = json!({ "apiVersion": "v1", "kind": "Node", "metadata": { "name": "n=1" } });
        assert_eq!(
            events_selector(&node, "9d1e"),
            r"regarding.kind=Node,regarding.name=n\=1"
        );
    }
}
