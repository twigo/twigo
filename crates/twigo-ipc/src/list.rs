//! Resource lists: a subscription per view, filtered, sorted and windowed in
//! Rust (ARCHITECTURE 3.4), delivered as batches with flow control (3.5).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ErrorKind, IpcError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Gvr {
    /// Empty for the core group.
    pub group: String,
    pub version: String,
    pub resource: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    pub space: String,
    pub gvr: Gvr,
    /// Whether the resource lives in namespaces, as discovery says: one
    /// that does not ignores `namespaces`, and one that does gets a
    /// Namespace column unless `namespaces` names one.
    pub namespaced: bool,
    /// Empty for every namespace where the person may list the resource:
    /// the cluster's when they may list it cluster-wide, else each one a
    /// review allows among the namespaces they may list. A person who may
    /// list neither gets the cluster's refusal.
    pub namespaces: Vec<String>,
    pub label_selector: Option<String>,
    /// Sent to the server, as `spec.nodeName=kind-control-plane` picks a
    /// node's pods.
    pub field_selector: Option<String>,
    /// Keeps the rows whose controller is one of the objects with these
    /// uids, as a workload's pods are its ReplicaSets'; empty keeps none.
    pub owners: Option<Vec<String>>,
    /// A substring of a shown cell in any case of ASCII letters, `!` before
    /// it to keep the rows without one, or a regex between slashes, also in
    /// any case: `/^web-\d+/`, negated as `!/…/`.
    pub text: Option<String>,
    /// The user's column choices by name, which the text filter follows
    /// besides Name: true shows a column, false hides it, and the rest show
    /// by priority 0. The server resolves them against its own columns, so
    /// a choice for a column the list lacks, such as Namespace under one
    /// namespace, does nothing. Null shows the columns of priority 0.
    pub columns: Option<BTreeMap<String, bool>>,
    /// Null, or a column the list lacks, sorts by Name.
    pub sort: Option<Sort>,
    /// A column to count the matching rows by, such as a pod's Status; one
    /// the list lacks counts nothing.
    pub count_by: Option<String>,
    /// A column to group the matching rows by; one the list lacks groups
    /// nothing.
    pub group_by: Option<Grouping>,
    /// Keeps the rows whose column holds one of the values, read as text.
    /// The counts of `count_by` come before it, so the values it drops keep
    /// theirs; a column the list lacks keeps every row.
    pub values: Option<ColumnValues>,
}

/// The rows grouped by the text of a column: the groups in the natural
/// order of their values, runs of ASCII digits by their value and ASCII
/// letters folded, the empty value last, and the rows of each group in
/// the query's sort.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Grouping {
    /// A column name from [`ListBatch::columns`].
    pub column: String,
    /// The values of the groups the window skips. Their rows still count
    /// in `total`, in `counts` and in their group's `rows`; a value no
    /// group has does nothing.
    pub collapsed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ColumnValues {
    /// A column name from [`ListBatch::columns`].
    pub column: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Sort {
    /// A column name from [`ListBatch::columns`].
    pub column: String,
    pub descending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct SubscriptionId(pub u32);

/// `start` and `end` index the rows a window reads: every matching row,
/// or with `group_by` those of the groups not collapsed, in group order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetWindow {
    pub id: SubscriptionId,
    pub start: u32,
    /// Exclusive.
    pub end: u32,
    /// Whether the list reads its metric columns now, which takes the
    /// document visible, the list's editor on screen, and the list not one
    /// inside an Overview narrower than 640 px, which always says false.
    /// Before the list's columns are known it says true, so that a list
    /// sorted by a metric is held from its first rows; once they are known,
    /// while a metric column is drawn or sorted by. Only then are the
    /// namespaces of the window's rows polled (ARCHITECTURE 3.6).
    pub metrics: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Ack {
    pub id: SubscriptionId,
    pub seq: u32,
}

/// One flush of a subscription. Rust sends the next batch only after the
/// webview acknowledged this one's `seq`, and coalesces changes meanwhile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ListBatch {
    pub seq: u32,
    /// Rows matching the query, in or out of the window, those of collapsed
    /// groups included.
    pub total: u32,
    /// Present in the first batch and whenever the server's columns change.
    pub columns: Option<Vec<Column>>,
    /// Present when the window's rows or their order changed. The view keeps
    /// exactly these rows.
    pub window: Option<Window>,
    /// Rows that entered the window or changed.
    pub upserts: Vec<Row>,
    /// The state of the rows the list shows: the least ready of the parts
    /// whose rows it holds, a part that has listed and waits for a watch
    /// counting as `stale`. While it holds no part's rows, the least ready
    /// of the parts still on their way, one whose first list broke off
    /// counting as `connecting`, and once none is, the worst refusal. So
    /// `ready`, `relisting` and `stale` say that some part's rows are shown.
    pub status: ViewState,
    /// Present in the first batch and whenever a part's state changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parts: Option<Parts>,
    /// With `count_by`: the matching rows per value of that column, present
    /// in the first batch and whenever a count changes.
    pub counts: Option<Vec<ValueCount>>,
    /// With `group_by`: the groups that hold matching rows, in group order,
    /// present once the list has the column and whenever a group appears,
    /// disappears or moves, or its rows or counts change. Empty once the
    /// list no longer has the column.
    pub groups: Option<Vec<RowGroup>>,
    /// For a list with metric columns: whether their samples arrive,
    /// present once a scope has answered or failed, and whenever it
    /// changes. Before a scope has answered, a list says the failure its
    /// last request ended in, if the core remembers one, so its first batch
    /// that shows rows has it, and the first answers correct it; with none
    /// remembered it says none, but for a stale API, which says
    /// `unavailable` with the columns. It keeps the state it said while its
    /// scopes are asked again.
    pub metrics: Option<MetricsState>,
}

/// The upstreams a list reads: one for the cluster, or one per namespace
/// (ARCHITECTURE 3.7). A part's rows are in the list once it has listed and
/// while it is not refused, whatever the other parts are.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Parts {
    pub count: u32,
    /// The parts that are not ready, each with its own state.
    pub unready: Vec<PartState>,
    /// For every namespace, the namespaces it leaves out because the person
    /// may not list the resource there; 0 for a selection, or for a
    /// cluster-wide part.
    pub omitted: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PartState {
    pub part: Part,
    pub state: ViewState,
    /// Its rows are in the list: it has listed and is not refused.
    pub shown: bool,
}

/// What one part reads. A webview that meets a kind it does not know
/// counts the part without naming it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Part {
    Cluster,
    Namespace { name: String },
}

/// What the Metrics API of a context answers. A context that does not
/// serve it has no metric columns and no usage, and so no state, but for
/// the one `Absent` says to an open object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MetricsState {
    /// It answers, and a row without a sample has none yet; also what a
    /// `waiting` usage says before any answer came.
    Ready,
    /// Served and not answering, as while metrics-server is down.
    Unavailable,
    /// The person may not list these metrics.
    Forbidden,
    /// Said only in a `Usage`, once, when the context stops serving the
    /// resource while the usage part is shown: the usage holds no figures
    /// and the webview draws none.
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ValueCount {
    pub value: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RowGroup {
    /// The column's text; empty for the rows that have none.
    pub value: String,
    /// The group's matching rows, collapsed or not.
    pub rows: u32,
    /// With `count_by`: the group's rows per value of that column, counted
    /// before `values` drops any and ordered as the list's counts are,
    /// largest first; empty without it.
    pub counts: Vec<ValueCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Window {
    /// An index into the rows the window reads, as in [`SetWindow`].
    pub start: u32,
    pub ids: Vec<RowId>,
}

/// `context/namespace/name`, or `context/name` for cluster-scoped objects.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct RowId(pub String);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Row {
    pub id: RowId,
    /// RFC 3339; the webview renders Age columns from it.
    pub created: Option<String>,
    /// RFC 3339; when the core received the print of the durations in the
    /// columns that say `printsDuration`, such as `3 (5m ago)`, which count
    /// back from this time, so the webview draws them as of now. It moves
    /// when such a duration reads another age, or the same one after its
    /// step (an event that repeated), and a list sorted by those columns
    /// reads it too.
    pub received: String,
    /// Where the generated part of the object's name starts, in UTF-16
    /// units: after its `metadata.generateName`, or at a pod's
    /// `pod-template-hash` within it, so `api-7f9c8d6b5-x2kq9` reads `api-`
    /// before what was generated. Null for a name the API server did not
    /// generate.
    pub generated: Option<u32>,
    /// One per column; null in Age columns.
    pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum Cell {
    Null,
    Bool(bool),
    Int(i64),
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub kind: ColumnKind,
    /// 0 is shown by default; higher only in the wide view.
    pub priority: i32,
    /// Its text cells hold a duration the server printed, alone (`5m`) or
    /// after a pod's count of restarts (`3 (5m ago)`), which counts back
    /// from the row's `received`; absent where false, as for most columns.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub prints_duration: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ColumnKind {
    String,
    Integer,
    Number,
    Boolean,
    Date,
    Age,
    /// Measured CPU, an integer of nanocores; null without a sample.
    Cpu,
    /// Measured memory, an integer of bytes; null without a sample.
    Memory,
    Other,
}

/// The state of a subscription, or of one part of a list (ARCHITECTURE 3.7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ViewState {
    /// Waiting for a stream slot on the connection.
    Queued,
    Connecting,
    Syncing {
        loaded: u32,
    },
    Ready,
    Relisting,
    /// No event or bookmark in time; reconnecting.
    Stale,
    Forbidden {
        verb: String,
        resource: String,
    },
    /// The credentials were rejected; the view offers to sign in.
    Unauthorized,
    Error {
        error: IpcError,
    },
}

impl ViewState {
    /// What the cluster's refusal says as an error: none for a state that is
    /// not one.
    pub fn refusal(&self) -> Option<IpcError> {
        match self {
            ViewState::Forbidden { verb, resource } => Some(IpcError::new(
                ErrorKind::Forbidden,
                format!("you may not {verb} {resource}"),
            )),
            ViewState::Unauthorized => Some(IpcError::new(
                ErrorKind::Unauthorized,
                "no credentials for this context that the cluster accepts",
            )),
            ViewState::Error { error } => Some(error.clone()),
            _ => None,
        }
    }
}
