//! Resource lists: a subscription per view, filtered, sorted and windowed in
//! Rust (ARCHITECTURE 3.4), delivered as batches with flow control (3.5).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::IpcError;

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
    /// Empty for every namespace the space covers.
    pub namespaces: Vec<String>,
    pub label_selector: Option<String>,
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
    /// Keeps the rows whose column holds one of the values, read as text.
    /// The counts of `count_by` come before it, so the values it drops keep
    /// theirs; a column the list lacks keeps every row.
    pub values: Option<ColumnValues>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetWindow {
    pub id: SubscriptionId,
    pub start: u32,
    /// Exclusive.
    pub end: u32,
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
    /// Rows matching the query, in or out of the window.
    pub total: u32,
    /// Present in the first batch and whenever the server's columns change.
    pub columns: Option<Vec<Column>>,
    /// Present when the window's rows or their order changed. The view keeps
    /// exactly these rows.
    pub window: Option<Window>,
    /// Rows that entered the window or changed.
    pub upserts: Vec<Row>,
    pub status: ViewState,
    /// With `count_by`: the matching rows per value of that column, present
    /// in the first batch and whenever a count changes.
    pub counts: Option<Vec<ValueCount>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ValueCount {
    pub value: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Window {
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
pub struct Column {
    pub name: String,
    pub kind: ColumnKind,
    /// 0 is shown by default; higher only in the wide view.
    pub priority: i32,
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
    Other,
}

/// The state of the upstream behind a subscription (ARCHITECTURE 3.7).
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
