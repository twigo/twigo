//! An open object (ARCHITECTURE 3.6, 4.3): what the drawer and the resource
//! editor show of it, described in Rust and delivered with flow control, as
//! lists are (3.5).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Gvr, SubscriptionId, ViewState};

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
    /// Newest first; present when they changed, while the events part is
    /// shown.
    pub events: Option<Vec<ObjectEvent>>,
    /// Present when it changed, while the related part is shown.
    pub related: Option<Related>,
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
    /// A ConfigMap's or Secret's keys with their sizes; values are asked for
    /// with [`GetValues`], a Secret's never.
    Data {
        entries: Vec<DataEntry>,
    },
    /// A part of the object, such as its spec, as nested keys.
    Tree {
        nodes: Vec<TreeNode>,
    },
    Events {
        events: Vec<ObjectEvent>,
    },
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Related {
    pub owners: Vec<RelatedObject>,
    pub owned: Vec<RelatedObject>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RelatedObject {
    pub target: ObjectRef,
    /// The owner reference that ties them is the controller's.
    pub controller: bool,
}
