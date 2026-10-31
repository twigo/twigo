//! Resource lists: a subscription per view, filtered, sorted and windowed in
//! Rust (ARCHITECTURE 3.4), delivered as batches with flow control (3.5).

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
    /// Empty for every namespace the space covers.
    pub namespaces: Vec<String>,
    pub label_selector: Option<String>,
    pub text: Option<String>,
    pub sort: Option<Sort>,
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
