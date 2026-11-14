//! An open object (ARCHITECTURE 3.6, 4.3): what the drawer and the resource
//! editor show of it, described in Rust and delivered with flow control, as
//! lists are (3.5).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Gvr, MetricsState, SubscriptionId, ViewState};

/// Names one object of a space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ObjectQuery {
    pub space: String,
    pub gvr: Gvr,
    /// Whether the resource lives in namespaces, as discovery says.
    pub namespaced: bool,
    /// None for a cluster-scoped object.
    pub namespace: Option<String>,
    pub name: String,
}

/// What the views of an open object show; Rust follows only these.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ObjectParts {
    /// The Overview document, its events included.
    pub overview: bool,
    /// The object as the YAML tab shows it.
    pub manifest: bool,
    /// The object's events, for the Events tab.
    pub events: bool,
    /// Its owners and the objects it owns.
    pub related: bool,
    /// What a pod or a node uses, read while it is drawn and the document
    /// is visible.
    pub usage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct OpenObject {
    pub object: ObjectQuery,
    pub parts: ObjectParts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetParts {
    pub id: SubscriptionId,
    pub parts: ObjectParts,
}

/// Asks for the values of a ConfigMap's keys, which its Overview lists with
/// their sizes only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct GetValues {
    pub id: SubscriptionId,
    pub keys: Vec<String>,
}

/// One flush of an open object. Rust sends the next only after the webview
/// acknowledged this one's `seq`, and coalesces changes meanwhile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ObjectBatch {
    pub seq: u32,
    pub status: ViewState,
    /// False until the object is listed, and once it is deleted.
    pub exists: bool,
    /// Present when it changed, while the overview part is shown.
    pub overview: Option<Overview>,
    /// The object's JSON with managedFields dropped and a Secret's values
    /// replaced by their sizes; present when it changed, while the manifest
    /// part is shown.
    pub manifest: Option<String>,
    /// Present when they changed, while the events part is shown.
    pub events: Option<EventList>,
    /// Present when it changed, while the related part is shown.
    pub related: Option<Related>,
    /// Present when it changed, while the usage part is shown, for a pod
    /// or a node of a context that serves the Metrics API: in the batch that
    /// brings the object, or in the next one when the part is asked for
    /// later. Until the scope that serves the object has answered or failed
    /// once it is `waiting`, or `unavailable` where the API is stale; after
    /// that a `ready` usage whose `used` is null says that an answer came
    /// without the object.
    pub usage: Option<Usage>,
}

/// What a pod or a node uses, from the sample its list's rows show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Usage {
    pub state: MetricsState,
    /// True in a usage sent before the request that serves the object has
    /// answered once: the state is `ready`, the figures are null, and
    /// `containers` names the pod's running containers by its own status,
    /// in the order the answer lists them and with their requests and
    /// limits, so the webview draws the section at its height at once.
    /// False for a stale API, which says `unavailable` at once since
    /// discovery knows it without a request.
    pub waiting: bool,
    /// RFC 3339, when the sample was taken; null without one, as for a
    /// pod that is not running or started a moment ago.
    pub sampled: Option<String>,
    /// A pod's sum over its containers, or the node's own figures.
    pub cpu: Measure,
    pub memory: Measure,
    /// A pod's containers that have a sample, or while `waiting` those that
    /// run, in the pod's order; empty for a node.
    pub containers: Vec<ContainerUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ContainerUsage {
    pub name: String,
    pub cpu: Measure,
    pub memory: Measure,
}

/// One resource, in nanocores for CPU and bytes for memory.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Measure {
    /// Null without a sample.
    pub used: Option<i64>,
    /// A container's request, or a pod's when every container counted in
    /// `used` has one.
    pub request: Option<i64>,
    /// A container's limit, or a pod's when every container counted in
    /// `used` has one.
    pub limit: Option<i64>,
    /// A node's allocatable.
    pub allocatable: Option<i64>,
}

/// An object described for people: sections in their order, each a list of
/// blocks from a closed set (ARCHITECTURE 4.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Overview {
    pub sections: Vec<Section>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Section {
    /// Stable, such as `core.metadata`; folding is kept by it.
    pub id: String,
    pub title: String,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Fields {
        fields: Vec<Field>,
    },
    Conditions {
        conditions: Vec<Condition>,
    },
    /// A ConfigMap's or Secret's keys with their sizes.
    Data {
        entries: Vec<DataEntry>,
        /// Whether [`GetValues`] sends their values: a ConfigMap's text
        /// values, never a Secret's.
        readable: bool,
    },
    /// A part of the object, such as its spec, as nested keys.
    Tree {
        nodes: Vec<TreeNode>,
    },
    Events(EventList),
    /// What is wrong with the object, in words, first in its Overview.
    Diagnostics {
        findings: Vec<Finding>,
    },
    /// A pod's containers, or those of a pod template.
    Containers {
        containers: Vec<Container>,
    },
    /// Values under named columns, such as a pod's volumes.
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<Value>>,
    },
    /// A live resource list, such as a workload's pods.
    List(EmbeddedList),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Finding {
    /// Danger for what keeps the object from working, warning for what
    /// may.
    pub tone: Tone,
    /// What is wrong: "Container api keeps crashing".
    pub title: String,
    /// Why, as a sentence whose times are read when shown.
    pub detail: Vec<Span>,
    /// What the component that saw it said, shown as it said it: a
    /// termination message, a waiting reason's message, an event's note.
    pub message: Option<String>,
    /// A container's finding's logs, for its Previous logs and the last
    /// line its previous instance wrote.
    pub logs: Option<FindingLogs>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FindingLogs {
    pub container: String,
    /// It has a previous instance, which a logs tab reads with `previous`.
    pub previous: bool,
    /// The last line of its instance that ended last, without its escapes,
    /// once it has a previous one: null until Twigo has read it, or when it
    /// wrote none.
    pub last_line: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Span {
    Text {
        text: String,
    },
    /// RFC 3339, in the past: "2 m ago".
    Ago {
        at: String,
    },
    /// RFC 3339, in the future: "in 2 m 40 s", or "now" once it passed.
    Until {
        at: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Container {
    pub name: String,
    pub role: ContainerRole,
    pub image: String,
    /// None in a pod template, and until the kubelet reports it.
    pub state: Option<ContainerState>,
    /// As kubectl prints them: `8080/TCP (http)`.
    pub ports: Vec<String>,
    /// What its card shows: its state's times, how it last ended, its
    /// resources.
    pub fields: Vec<Field>,
    /// What else kubectl describe prints of it, folded: the last
    /// termination's message, command, probes, security, image and
    /// container IDs.
    pub details: Vec<Field>,
    /// Each variable by name, then each source of many as "From".
    pub env: Vec<Field>,
    /// By the path it is mounted at.
    pub mounts: Vec<Field>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContainerRole {
    Init,
    /// An init container that keeps running, its restart policy Always.
    Sidecar,
    Regular,
    Ephemeral,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ContainerState {
    /// "Running", "Waiting · CrashLoopBackOff", "Terminated · Completed".
    pub text: String,
    pub tone: Tone,
    pub ready: bool,
    pub restarts: u32,
}

/// A list of objects of one resource, run as any list is: the webview
/// subscribes with it in the object's space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedList {
    pub gvr: Gvr,
    /// The kind of its objects, which opening a row names.
    pub kind: String,
    pub namespaced: bool,
    /// None for every namespace, as a node's pods are.
    pub namespace: Option<String>,
    pub field_selector: Option<String>,
    /// As in [`crate::ListQuery`].
    pub owners: Option<Vec<String>>,
}

/// An object's events, newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EventList {
    pub events: Vec<ObjectEvent>,
    /// Why they cannot be listed, as when the person may not list events;
    /// None while they are listed or still coming.
    pub unavailable: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Field {
    pub label: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Value {
    Text {
        text: String,
    },
    /// RFC 3339, shown as an age with the date beside it.
    Time {
        at: String,
    },
    Link {
        target: ObjectRef,
        text: String,
    },
    Labels {
        labels: Vec<Label>,
    },
    List {
        items: Vec<Value>,
    },
    /// Text that is read as code, such as an IP, an image or a command.
    Code {
        text: String,
    },
    /// Text in a tone, such as a Ready of `0/1`.
    Toned {
        text: String,
        tone: Tone,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    Neutral,
    Success,
    Warning,
    Danger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Label {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    /// Whether this status is good news, as Ready=True is and
    /// MemoryPressure=True is not.
    pub tone: Tone,
    pub reason: Option<String>,
    pub message: Option<String>,
    /// RFC 3339.
    pub last_transition: Option<String>,
    /// RFC 3339, when its reporter last confirmed it, as a node's kubelet
    /// does.
    pub last_heartbeat: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct DataEntry {
    pub key: String,
    pub bytes: u64,
    /// From `binaryData`, or a Secret value that is not UTF-8.
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TreeNode {
    /// A map's key, or a list item's name, else its index.
    pub key: String,
    /// The key as people read it: a field's name in words, such as
    /// "Termination grace period seconds"; other keys as they are.
    pub label: String,
    pub value: TreeValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TreeValue {
    Scalar { text: String },
    Map { entries: Vec<TreeNode> },
    List { items: Vec<TreeNode> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEvent {
    /// Normal or Warning.
    #[serde(rename = "type")]
    pub kind: String,
    pub reason: String,
    pub message: String,
    /// The component that reported it.
    pub source: String,
    /// How often it happened; 1 for a single event.
    pub count: u32,
    /// RFC 3339.
    pub first: Option<String>,
    /// RFC 3339.
    pub last: Option<String>,
    /// The part of the object it is about, such as `spec.containers{app}`.
    pub field_path: Option<String>,
}

/// An object a link points at, by kind: the webview finds its resource
/// through discovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ObjectRef {
    /// Empty for the core group.
    pub group: String,
    pub version: String,
    pub kind: String,
    /// The namespace of the object that points at it, which the webview
    /// drops when discovery says the kind is cluster-scoped.
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Related {
    pub owners: Vec<RelatedObject>,
    pub owned: Vec<RelatedObject>,
    /// Why some owned objects cannot be listed.
    pub unavailable: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RelatedObject {
    pub target: ObjectRef,
    /// The owner reference that ties them is the controller's.
    pub controller: bool,
}
