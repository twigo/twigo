//! Open objects (ARCHITECTURE 3.6, 4.3): an Object upstream for each, and
//! while their views show them its events and the objects it owns. The
//! object is described into the Overview document and sent in batches with
//! flow control, as lists are (3.5): one task per open object flushes on a
//! 50 ms interval and keeps at most one batch unacknowledged.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use twigo_cache::batcher::FLUSH;
use twigo_cache::hub::{Delta, Hub, Query, Resource, RowFormat, Subscription};
use twigo_cache::object::Object;
use twigo_cache::request::field_value;
use twigo_cache::table::{Cell, Column, ColumnKind, Row};
use twigo_describe::{Fact, Found, Input, Need, Owned, Printed};
use twigo_ipc::{
    Block, ErrorKind, EventList, IpcError, ObjectBatch, ObjectEvent, ObjectParts, ObjectRef,
    Overview, Related, RelatedObject, ViewState,
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
        let object =
            latest.ok_or_else(|| IpcError::new(ErrorKind::NotFound, "the object is not listed"))?;
        let json: Value = serde_json::from_str(object.json.get()).map_err(|error| {
            IpcError::new(
                ErrorKind::Internal,
                format!("the object does not parse: {error}"),
            )
        })?;
        values_of(&json, keys)
    }
}

/// A ConfigMap's text values; any other kind's refused, a Secret's above all.
fn values_of(object: &Value, keys: &[String]) -> Result<Vec<Option<String>>, IpcError> {
    if object["apiVersion"] != "v1" || object["kind"] != "ConfigMap" {
        return Err(IpcError::new(
            ErrorKind::Forbidden,
            "only a ConfigMap's values are sent".to_owned(),
        ));
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
    let mut last_lines = LastLines::new();
    loop {
        let ticked = tokio::select! {
            _ = interval.tick() => true,
            () = control.wake.notified() => false,
            Some((key, line)) = last_lines.read.recv() => {
                last_lines.lines.insert(key, line);
                dirty.overview = true;
                false
            }
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
            let wanted = parts.overview.then(|| twigo_describe::needs(json));
            if let Some(found) = follow_needs(&mut held.facts, wanted, &hub, &target) {
                facts = found;
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
        let mut batch = shown.batch(seq, state.clone());
        if let (Some(overview), Some(json), Some(uid)) = (&mut batch.overview, &parsed, &uid) {
            last_lines.fill(overview, json, uid, &hub, &target);
        }
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

/// A container's previous instance, by its pod's uid, its name and its
/// restart count, so a restart reads it again.
type Previous = (Box<str>, String, u64);

/// The last lines of the previous instances that a pod's findings name,
/// read once each with `tailLines=1&previous=true`.
struct LastLines {
    lines: HashMap<Previous, Option<String>>,
    asked: HashSet<Previous>,
    sent: mpsc::UnboundedSender<(Previous, Option<String>)>,
    read: mpsc::UnboundedReceiver<(Previous, Option<String>)>,
}

impl LastLines {
    fn new() -> Self {
        let (sent, read) = mpsc::unbounded_channel();
        Self {
            lines: HashMap::new(),
            asked: HashSet::new(),
            sent,
            read,
        }
    }

    /// Gives each container finding with a previous instance the last line
    /// read, and asks for those not read yet.
    fn fill(
        &mut self,
        overview: &mut Overview,
        pod: &Value,
        uid: &str,
        hub: &Hub,
        target: &Target,
    ) {
        let findings = overview
            .sections
            .iter_mut()
            .flat_map(|section| &mut section.blocks)
            .filter_map(|block| match block {
                Block::Diagnostics { findings } => Some(findings),
                _ => None,
            })
            .flatten();
        for finding in findings {
            let Some(logs) = finding.logs.as_mut().filter(|logs| logs.previous) else {
                continue;
            };
            let key = (
                uid.into(),
                logs.container.clone(),
                restarts(pod, &logs.container),
            );
            if let Some(line) = self.lines.get(&key) {
                logs.last_line.clone_from(line);
                continue;
            }
            let (Some(namespace), Some(name)) =
                (&target.namespace, pod["metadata"]["name"].as_str())
            else {
                continue;
            };
            if self.asked.insert(key.clone()) {
                let (hub, context, namespace, name) = (
                    hub.clone(),
                    target.context.clone(),
                    namespace.clone(),
                    name.to_owned(),
                );
                let sent = self.sent.clone();
                let running = status(pod, &logs.container)
                    .is_some_and(|status| status["state"]["running"].is_object());
                tokio::spawn(async move {
                    let line = last_line(&hub, &context, &namespace, &name, &key.1, running).await;
                    // The object may have closed meanwhile.
                    let _ = sent.send((key, line));
                });
            }
        }
    }
}

fn status<'a>(pod: &'a Value, container: &str) -> Option<&'a Value> {
    ["containerStatuses", "initContainerStatuses"]
        .iter()
        .flat_map(|key| pod["status"][key].as_array().into_iter().flatten())
        .find(|status| status["name"] == container)
}

fn restarts(pod: &Value, container: &str) -> u64 {
    status(pod, container)
        .and_then(|status| status["restartCount"].as_u64())
        .unwrap_or_default()
}

/// The last line the container's instance that ended last wrote, without
/// its escapes; None when it wrote none or it cannot be read.
///
/// The kubelet keeps one ended instance of a container, so that one is
/// read: the previous instance while a new one runs, else the one the
/// kubelet reads without `previous`, the ended current one or, in a crash
/// loop's back-off, the last (`validateContainerLogStatus`, kubernetes
/// v1.37.0). With `previous` there a quick crash loop's status may still
/// name an instance the kubelet removed. A body it cannot read says why in
/// a line without a time.
async fn last_line(
    hub: &Hub,
    context: &str,
    namespace: &str,
    pod: &str,
    container: &str,
    running: bool,
) -> Option<String> {
    let clients = hub.clients(context).await.ok()?;
    let params = kube::api::LogParams {
        container: Some(container.to_owned()),
        previous: running,
        tail_lines: Some(1),
        timestamps: true,
        ..kube::api::LogParams::default()
    };
    let request = kube::core::Request::new(format!("/api/v1/namespaces/{namespace}/pods"))
        .logs(pod, &params)
        .ok()?;
    let text = clients.api.request_text(request).await.ok()?;
    let line = twigo_sessions::logs::line::parse(text.lines().last()?.as_bytes());
    line.at?;
    Some(line.text).filter(|text| !text.is_empty())
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

/// Holds the needs `wanted` while the Overview is shown, None letting them
/// go, and reads what they found: the facts when they changed, or when the
/// needs are held anew, so what a need the hub refused already says goes
/// out at once.
fn follow_needs(
    held: &mut Option<Vec<Held>>,
    wanted: Option<Vec<Need>>,
    hub: &Hub,
    target: &Target,
) -> Option<Vec<Fact>> {
    let Some(wanted) = wanted else {
        *held = None;
        return None;
    };
    let current = held
        .as_ref()
        .is_some_and(|held| held.iter().map(|held| &held.need).eq(wanted.iter()));
    let anew = !current;
    if anew {
        *held = Some(needs_of(hub, target, wanted));
    }
    let needs = held.as_mut()?;
    (found(needs) || anew).then(|| facts_of(needs))
}

/// What the needs found so far, for the describer.
fn facts_of(needs: &[Held]) -> Vec<Fact> {
    needs
        .iter()
        .filter_map(|held| {
            Some(Fact {
                need: held.need.clone(),
                found: held.found.clone()?,
            })
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

    #[tokio::test]
    async fn a_need_the_hub_refuses_reaches_the_describer_when_held() {
        let connect: twigo_cache::hub::Connect = Arc::new(|_context| {
            Box::pin(async {
                Err(IpcError::new(
                    ErrorKind::Unavailable,
                    "no cluster".to_owned(),
                ))
            })
        });
        let hub = Hub::new(connect);
        let target = Target {
            context: "kind-test".to_owned(),
            namespace: None,
        };
        let need = Need {
            group: "apps".to_owned(),
            version: "v1".to_owned(),
            resource: "replicasets".to_owned(),
            namespaced: true,
            namespace: Some("a/b".to_owned()),
            field_selector: None,
        };
        let mut held = None;
        let facts = follow_needs(&mut held, Some(vec![need.clone()]), &hub, &target)
            .expect("the refusal goes out when the need is held");
        let [
            Fact {
                need: found_for,
                found: Found::Unavailable { message },
            },
        ] = &facts[..]
        else {
            panic!("an unavailable fact: {facts:?}");
        };
        assert_eq!(found_for, &need);
        assert!(message.contains("a/b"), "{message}");
        assert_eq!(
            follow_needs(&mut held, Some(vec![need]), &hub, &target),
            None,
            "nothing new the next time"
        );
        assert_eq!(follow_needs(&mut held, None, &hub, &target), None);
        assert!(held.is_none(), "let go once the Overview hides");
    }

    #[tokio::test]
    async fn a_crashed_containers_last_line_is_read_once_per_restart() {
        let connect: twigo_cache::hub::Connect = Arc::new(|_context| {
            Box::pin(async {
                Err(IpcError::new(
                    ErrorKind::Unavailable,
                    "no cluster".to_owned(),
                ))
            })
        });
        let hub = Hub::new(connect);
        let target = Target {
            context: "kind-test".to_owned(),
            namespace: Some("shop".to_owned()),
        };
        let pod = |restarts: u64| {
            json!({
                "metadata": { "name": "api-0" },
                "status": { "containerStatuses": [{ "name": "api", "restartCount": restarts }] },
            })
        };
        let overview = || Overview {
            sections: vec![twigo_ipc::Section {
                id: "core.diagnostics".to_owned(),
                title: "Diagnostics".to_owned(),
                blocks: vec![Block::Diagnostics {
                    findings: vec![twigo_ipc::Finding {
                        tone: twigo_ipc::Tone::Danger,
                        title: "Container api keeps crashing".to_owned(),
                        detail: Vec::new(),
                        message: None,
                        logs: Some(twigo_ipc::FindingLogs {
                            container: "api".to_owned(),
                            previous: true,
                            last_line: None,
                        }),
                    }],
                }],
            }],
        };
        let last_line = |overview: &Overview| {
            let Block::Diagnostics { findings } = &overview.sections[0].blocks[0] else {
                unreachable!();
            };
            findings[0].logs.as_ref().unwrap().last_line.clone()
        };
        let mut lines = LastLines::new();
        let mut shown = overview();
        lines.fill(&mut shown, &pod(3), "5c2f", &hub, &target);
        let (key, read) = lines.read.recv().await.unwrap();
        assert_eq!(
            (key.clone(), read),
            (("5c2f".into(), "api".to_owned(), 3), None)
        );
        lines.lines.insert(key, Some("panic: boom".to_owned()));

        let mut shown = overview();
        lines.fill(&mut shown, &pod(3), "5c2f", &hub, &target);
        assert_eq!(last_line(&shown).as_deref(), Some("panic: boom"));
        assert!(lines.read.try_recv().is_err(), "read once");

        let mut shown = overview();
        lines.fill(&mut shown, &pod(4), "5c2f", &hub, &target);
        assert_eq!(last_line(&shown), None);
        let (key, _) = lines.read.recv().await.unwrap();
        assert_eq!(key.2, 4, "read again after a restart");
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
