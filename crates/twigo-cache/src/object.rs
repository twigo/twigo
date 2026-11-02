//! The decoder of Object upstreams (ARCHITECTURE 3.3): an open object, kept
//! whole in Rust, managedFields and Secret values included, with the cells
//! the server prints for it.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::decode::{
    self, Decode, DecodeError, Event, EventKind, Kind, ListMeta, Page, RawEvent, nullable,
    peek_kind,
};
use crate::meta::{Meta, RawObject};
use crate::table::{Cell, Column, RawColumn, TableDecoder};

#[derive(Debug, Clone)]
pub struct Object {
    pub meta: Meta,
    pub json: Box<RawValue>,
    /// One per column of [`Decode::columns`]: the server's printer columns,
    /// or Name and Age when it sent raw objects.
    pub cells: Box<[Cell]>,
}

/// Asks for a Table with `includeObject=Object`, whose rows carry the whole
/// object besides its cells, and keeps the columns as the Table decoder
/// does; a server without Table sends raw objects, which get the metadata
/// columns.
#[derive(Debug, Default)]
pub struct ObjectDecoder {
    table: TableDecoder,
}

impl ObjectDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    fn table_object(&self, row: TableRow<'_>) -> Result<Object, DecodeError> {
        let cells = self.table.cells(row.cells)?;
        let json = row.object.ok_or(DecodeError::Missing("object"))?;
        let parsed: RawObject = serde_json::from_str(json.get())?;
        Ok(Object {
            meta: parsed.metadata.into_meta()?,
            json: json.to_owned(),
            cells,
        })
    }

    fn raw_object(&mut self, meta: Meta, json: Box<RawValue>) -> Object {
        let cells = self.table.raw_cells(&meta);
        Object { meta, json, cells }
    }
}

impl Decode for ObjectDecoder {
    type Item = Object;

    fn decode_list(&mut self, body: &[u8]) -> Result<Page<Object>, DecodeError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct List<'a> {
            #[serde(default)]
            api_version: String,
            #[serde(default)]
            metadata: ListMeta,
            #[serde(borrow, default)]
            items: Option<Vec<&'a RawValue>>,
        }
        match peek_kind(body)? {
            Kind::Table => {
                let table: Table<'_> = serde_json::from_slice(body)?;
                self.table.update_columns(table.column_definitions);
                let objects = table
                    .rows
                    .into_iter()
                    .map(|row| self.table_object(row))
                    .collect::<Result<_, _>>()?;
                Ok(table.metadata.into_page(objects))
            }
            Kind::Other(kind) => {
                let list: List<'_> = serde_json::from_slice(body)?;
                // A list's items carry no kind or apiVersion of their own,
                // while a watch's objects do: they get the list's.
                let item_kind = kind.strip_suffix("List").unwrap_or(&kind);
                let objects = list
                    .items
                    .unwrap_or_default()
                    .into_iter()
                    .map(|item| {
                        let (meta, json) = object(item, item_kind, &list.api_version)?;
                        Ok(self.raw_object(meta, json))
                    })
                    .collect::<Result<_, DecodeError>>()?;
                Ok(list.metadata.into_page(objects))
            }
            Kind::Status => Err(DecodeError::UnexpectedKind("Status".into())),
        }
    }

    fn decode_event(&mut self, line: &[u8]) -> Result<Event<Object>, DecodeError> {
        let event: RawEvent<'_> = serde_json::from_slice(line)?;
        let body = event.object.get().as_bytes();
        match peek_kind(body)? {
            Kind::Status => Ok(Event::Error(decode::status(body)?)),
            Kind::Table => {
                let mut table: Table<'_> = serde_json::from_slice(body)?;
                self.table.update_columns(table.column_definitions);
                if table.rows.len() != 1 {
                    return Err(DecodeError::RowCount(table.rows.len()));
                }
                let Some(row) = table.rows.pop() else {
                    return Err(DecodeError::RowCount(0));
                };
                match event.kind {
                    EventKind::Bookmark => {
                        let metadata = match row.object {
                            Some(object) => serde_json::from_str::<RawObject>(object.get())?,
                            None => RawObject::default(),
                        }
                        .metadata;
                        Ok(Event::Bookmark {
                            resource_version: decode::non_empty(
                                metadata
                                    .resource_version
                                    .or(table.metadata.resource_version),
                            )?,
                            initial_events_end: metadata.initial_events_end,
                        })
                    }
                    EventKind::Added | EventKind::Modified => {
                        self.table_object(row).map(Event::Upsert)
                    }
                    EventKind::Deleted => self.table_object(row).map(Event::Delete),
                    EventKind::Error => Err(DecodeError::UnexpectedKind("Table".into())),
                }
            }
            Kind::Other(kind) => {
                let parsed: RawObject = serde_json::from_slice(body)?;
                let json = event.object.to_owned();
                let event = parsed.metadata.into_event(event.kind, &kind, |meta| meta)?;
                Ok(match event {
                    Event::Upsert(meta) => Event::Upsert(self.raw_object(meta, json)),
                    Event::Delete(meta) => Event::Delete(self.raw_object(meta, json)),
                    Event::Bookmark {
                        resource_version,
                        initial_events_end,
                    } => Event::Bookmark {
                        resource_version,
                        initial_events_end,
                    },
                    Event::Error(status) => Event::Error(status),
                })
            }
        }
    }

    fn columns(&self) -> Option<&Arc<[Column]>> {
        self.table.columns()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Table<'a> {
    #[serde(default)]
    metadata: ListMeta,
    #[serde(default)]
    column_definitions: Option<Vec<RawColumn>>,
    #[serde(borrow, default, deserialize_with = "nullable")]
    rows: Vec<TableRow<'a>>,
}

#[derive(Deserialize)]
struct TableRow<'a> {
    cells: Vec<Cell>,
    #[serde(borrow, default)]
    object: Option<&'a RawValue>,
}

/// A listed item, its kind and apiVersion put first as the server puts
/// them in a watch's objects, and its bytes otherwise as they came.
fn object(
    json: &RawValue,
    kind: &str,
    api_version: &str,
) -> Result<(Meta, Box<RawValue>), DecodeError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Typed {
        kind: Option<serde::de::IgnoredAny>,
        api_version: Option<serde::de::IgnoredAny>,
    }
    let parsed: RawObject = serde_json::from_str(json.get())?;
    let typed: Typed = serde_json::from_str(json.get())?;
    let text = json.get().trim_start();
    let rest = text
        .strip_prefix('{')
        .ok_or(DecodeError::Missing("an object"))?;
    let mut whole = String::with_capacity(text.len() + kind.len() + api_version.len() + 32);
    whole.push('{');
    if typed.kind.is_none() {
        whole.push_str(&format!(r#""kind":{},"#, serde_json::to_string(kind)?));
    }
    if typed.api_version.is_none() {
        whole.push_str(&format!(
            r#""apiVersion":{},"#,
            serde_json::to_string(api_version)?
        ));
    }
    if rest.trim_start().starts_with('}') && whole.ends_with(',') {
        whole.pop();
    }
    whole.push_str(rest);
    Ok((parsed.metadata.into_meta()?, RawValue::from_string(whole)?))
}
