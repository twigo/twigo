//! An open object (ARCHITECTURE 3.6, 4.3): what the drawer and the resource
//! editor show of it, described in Rust and delivered with flow control, as
//! lists are (3.5).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Gvr, IpcError, MetricsState, SubscriptionId, ViewState};

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

/// What the views of an open object ask for; Rust follows only these. The page
/// asks for the Overview on every view, so that its header and its keys hold on
/// all of them. It asks for the events and the related objects only while their
/// view is shown, for the manifest while the YAML view is shown or, in an
/// editor, an edit is held, and for the usage only of a pod or a node, on the
/// Overview, in a visible window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ObjectParts {
    /// The Overview document, its events included: Rust watches the object's
    /// events for as long as it is asked, whichever view is shown.
    pub overview: bool,
    /// The object as the YAML tab shows it, while that view is shown or an
    /// edit is held.
    pub manifest: bool,
    /// The object's events as the Events tab lists them, while that view is
    /// shown.
    pub events: bool,
    /// Its owners and the objects it owns, while the Related tab is shown.
    pub related: bool,
    /// What a pod or a node uses, read while the Overview is shown and the
    /// document is visible.
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
    /// brings the object once the context's discovery is known, else in a
    /// later one, which the usual order of events, resources first, makes
    /// rare; and in the next one when the part is asked for later. Until the
    /// scope that serves the object has answered once it is `waiting`, or
    /// says the failure its last request ended in, or `unavailable` where the
    /// API is stale; after that a `ready` usage whose `used` is null says
    /// that an answer came without the object, with the containers that run
    /// listed all the same. An object that had an answer keeps its figures
    /// while the request that serves it is asked anew.
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
    /// limits, so the webview draws the section at its height at once; an
    /// answer that comes without the pod lists them as well, with `waiting`
    /// false. False for a stale API, which says `unavailable` at once since
    /// discovery knows it without a request, and for a scope whose last
    /// request failed, which says that failure at once and is asked all the
    /// same.
    pub waiting: bool,
    /// RFC 3339, when the sample was taken; null without one, as for a
    /// pod that is not running or started a moment ago.
    pub sampled: Option<String>,
    /// A pod's sum over its containers, or the node's own figures.
    pub cpu: Measure,
    pub memory: Measure,
    /// A ready usage lists every container that runs by the pod's own status
    /// and every one that has a sample, in the pod's order, each with its
    /// request and limit; `used` is null for one the answer lacks, as for a
    /// container that has just started or restarted, whose pod metrics-server
    /// leaves out while any of its containers has no earlier point. Empty for
    /// a node and for a usage that is not ready.
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

/// An object described for people: what its header says, then sections in
/// their order, each a list of blocks from a closed set (ARCHITECTURE 4.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Overview {
    pub header: Header,
    pub sections: Vec<Section>,
}

/// What the object's page says around its name and under its views, the
/// same in the inspector and on the full page.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct Header {
    /// The controller at the top of its owners: a pod's Deployment through
    /// its ReplicaSet, a Job's CronJob. The direct controller while the one
    /// above it is not listed; None without a controller.
    pub owner: Option<ObjectRef>,
    /// The node a pod is bound to; None before it is scheduled, and for
    /// other kinds.
    pub node: Option<String>,
    /// RFC 3339, `metadata.creationTimestamp`: the object's age, which an
    /// object opened on its own has no list row to take it from.
    pub created: Option<String>,
    /// Where the generated part of its name starts, in UTF-16 units, as a
    /// list row's [`generated`](crate::Row::generated) says it, so that an
    /// object opened on its own cuts its name as the list does. The core
    /// fills it: the rule lives with the rows.
    pub generated: Option<u32>,
    /// The cells the server prints for it in a list, Name, Namespace and Age
    /// left out, from which the page takes the word of its list's health
    /// column, so the two always say the same.
    pub printed: Vec<Printed>,
    /// One sentence after that word: the first finding's title, else the
    /// object's vitals in words; empty when neither says anything.
    pub sentence: Vec<Span>,
    /// The strip under the views, in order; empty for a kind without one.
    /// A pod's CPU and Memory are not among them: they come with its usage.
    pub vitals: Vec<Vital>,
}

/// A cell the server printed for an object, as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Printed {
    pub column: String,
    pub value: String,
}

/// One cell of the vitals strip, such as `Restarts` `4` `11 d ago`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Vital {
    pub label: String,
    /// Toned only when it is abnormal.
    pub value: Value,
    /// What follows the value, quieter, such as when a pod last restarted.
    pub note: Vec<Span>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Section {
    /// Stable, such as `core.metadata`; folding is kept by it.
    pub id: String,
    pub title: String,
    /// What its header says at its end, so that it answers while folded,
    /// such as `2 volumes · 1 claim`; empty where nothing would.
    pub summary: Vec<Span>,
    /// Danger or warning when it holds what is wrong with the object, which
    /// its header marks with an edge in that tone.
    pub tone: Option<Tone>,
    /// How it opens until the person folds or opens it.
    pub fold: Fold,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Fold {
    /// Open, as the sections a triage reads first are.
    Open,
    /// One line with its summary.
    Folded,
    /// Open over what the person last chose for the kind, since it holds a
    /// finding that the Diagnostics section does not explain.
    Finding,
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
    /// What its card shows: how it ended, as its code and when, `Exited` for
    /// a termination that is its state now, whose reason the state says, and
    /// `Last exit`, with its reason, for an earlier one. Empty for a container
    /// that never ended.
    pub fields: Vec<Field>,
    /// What else kubectl describe prints of it, folded: when it started, the
    /// last termination's message, its requests and limits, command,
    /// arguments, working directory, pull policy, probes, security, image and
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
    /// Its process runs, which a shell or an attach needs.
    pub running: bool,
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
    /// They have been listed, so that an empty list means there are none:
    /// false while they are still coming, and once true it stays true,
    /// whatever `unavailable` says of a later relist.
    pub listed: bool,
    /// Why they cannot be listed, as when the person may not list events;
    /// None while they are listed or still coming.
    pub unavailable: Option<IpcError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Field {
    pub label: String,
    pub value: Value,
    /// It holds the cluster's default, as a pod's Restart policy Always:
    /// its section folds such fields behind their count.
    pub default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Value {
    Text {
        text: String,
    },
    /// RFC 3339, shown as an age, with the date in its tooltip.
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
    /// Text and times in one line that ticks, such as `code 1 (Error) · 11d
    /// ago`.
    Spans {
        spans: Vec<Span>,
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
    /// The Diagnostics section already says why it is wrong, so it shows
    /// only as its chip.
    pub explained: bool,
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
    pub unavailable: Option<IpcError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RelatedObject {
    pub target: ObjectRef,
    /// The owner reference that ties them is the controller's.
    pub controller: bool,
}
