//! What every decoder shares: list pages, watch events, the server's
//! statuses and how a response names its kind.

use std::borrow::Cow;
use std::sync::Arc;

use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;

use crate::table::{Column, Row};

#[derive(Debug, PartialEq)]
pub struct Page<T = Row> {
    pub items: Vec<T>,
    pub resource_version: Box<str>,
    pub continue_token: Option<Box<str>>,
}

#[derive(Debug, PartialEq)]
pub enum Event<T = Row> {
    Upsert(T),
    Delete(T),
    Bookmark {
        resource_version: Box<str>,
        initial_events_end: bool,
    },
    Error(Status),
}

#[derive(Debug, PartialEq)]
pub struct Status {
    pub code: u16,
    pub reason: Box<str>,
    pub message: Box<str>,
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("rows arrived before any column definitions")]
    NoColumns,
    #[error("a row has {found} cells for {expected} columns")]
    CellCount { expected: usize, found: usize },
    #[error("a watch event carries {0} rows instead of one")]
    RowCount(usize),
    #[error("an object has no {0}")]
    Missing(&'static str),
    #[error("unexpected object kind {0:?}")]
    UnexpectedKind(Box<str>),
}

/// Decodes the responses of one upstream: its list pages and the events of
/// its watch connections.
pub trait Decode: Send + 'static {
    type Item;

    fn decode_list(&mut self, body: &[u8]) -> Result<Page<Self::Item>, DecodeError>;

    fn decode_event(&mut self, line: &[u8]) -> Result<Event<Self::Item>, DecodeError>;

    /// The columns of a Table upstream; the decoder keeps them across pages
    /// and reconnects.
    fn columns(&self) -> Option<&Arc<[Column]>> {
        None
    }
}

pub(crate) enum Kind<'a> {
    Table,
    Status,
    Other(Cow<'a, str>),
}

pub(crate) fn peek_kind(body: &[u8]) -> Result<Kind<'_>, DecodeError> {
    #[derive(Deserialize)]
    struct Peek<'a> {
        #[serde(borrow)]
        kind: Option<Cow<'a, str>>,
    }
    let kind = serde_json::from_slice::<Peek<'_>>(body)?
        .kind
        .ok_or(DecodeError::Missing("kind"))?;
    Ok(match &*kind {
        "Table" => Kind::Table,
        "Status" => Kind::Status,
        _ => Kind::Other(kind),
    })
}

#[derive(Deserialize)]
pub(crate) struct RawEvent<'a> {
    #[serde(rename = "type")]
    pub kind: EventKind,
    #[serde(borrow)]
    pub object: &'a RawValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(crate) enum EventKind {
    Added,
    Modified,
    Deleted,
    Bookmark,
    Error,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListMeta {
    pub resource_version: Option<Box<str>>,
    #[serde(rename = "continue")]
    pub continue_token: Option<Box<str>>,
}

impl ListMeta {
    pub fn into_page<T>(self, items: Vec<T>) -> Page<T> {
        Page {
            items,
            resource_version: self.resource_version.unwrap_or_default(),
            continue_token: self.continue_token.filter(|token| !token.is_empty()),
        }
    }
}

#[derive(Deserialize)]
struct StatusObject {
    #[serde(default)]
    code: u16,
    #[serde(default)]
    reason: Box<str>,
    #[serde(default)]
    message: Box<str>,
}

pub(crate) fn status(body: &[u8]) -> Result<Status, DecodeError> {
    let status: StatusObject = serde_json::from_slice(body)?;
    Ok(Status {
        code: status.code,
        reason: status.reason,
        message: status.message,
    })
}

pub(crate) fn non_empty(resource_version: Option<Box<str>>) -> Result<Box<str>, DecodeError> {
    resource_version
        .filter(|version| !version.is_empty())
        .ok_or(DecodeError::Missing("metadata.resourceVersion"))
}

/// Go encodes a nil slice as `null`.
pub(crate) fn nullable<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::deserialize(deserializer)?.unwrap_or_default())
}
