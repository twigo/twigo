//! The Table decoder (ARCHITECTURE 3.3): rows with the server's columns,
//! for every list.

use std::fmt;
use std::sync::Arc;

use serde::Deserialize;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, Visitor};

use crate::decode::{
    self, Decode, DecodeError, Event, EventKind, Kind, ListMeta, Page, RawEvent, nullable,
    peek_kind,
};
use crate::meta::{Meta, RawList, RawObject};

#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub name: Box<str>,
    pub kind: ColumnKind,
    pub format: Box<str>,
    pub priority: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnKind {
    String,
    Integer,
    Number,
    Boolean,
    /// A date the server rendered as a duration ("5m") when it encoded the row.
    Date,
    /// Computed from `creationTimestamp`; its cells are [`Cell::Age`].
    Age,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Bool(bool),
    Int(i64),
    Number(f64),
    Text(Box<str>),
    Age,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub meta: Meta,
    pub cells: Box<[Cell]>,
}

impl Row {
    /// A Metadata upstream's row.
    pub fn without_cells(meta: Meta) -> Self {
        Row {
            meta,
            cells: Box::default(),
        }
    }
}

/// Decodes the Table responses of one upstream: its list pages and the events
/// of its watch connections. The server sends column definitions only in the
/// first object of each response, so the decoder keeps them across pages and
/// reconnects.
#[derive(Debug, Default)]
pub struct TableDecoder {
    columns: Option<Arc<[Column]>>,
    synthetic: bool,
}

impl TableDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    fn update_columns(&mut self, definitions: Option<Vec<RawColumn>>) {
        let Some(definitions) = definitions.filter(|definitions| !definitions.is_empty()) else {
            return;
        };
        let columns: Arc<[Column]> = definitions.into_iter().map(Column::from).collect();
        if self.synthetic || self.columns.as_deref() != Some(&columns[..]) {
            self.columns = Some(columns);
            self.synthetic = false;
        }
    }

    fn table_row(&self, row: RawRow) -> Result<Row, DecodeError> {
        let columns = self
            .columns
            .as_deref()
            .filter(|_| !self.synthetic)
            .ok_or(DecodeError::NoColumns)?;
        if row.cells.len() != columns.len() {
            return Err(DecodeError::CellCount {
                expected: columns.len(),
                found: row.cells.len(),
            });
        }
        let mut cells = row.cells;
        for (cell, column) in cells.iter_mut().zip(columns) {
            match (column.kind, &*cell) {
                (ColumnKind::Age, _) => *cell = Cell::Age,
                // Go prints a float64 without a fraction as an integer.
                (ColumnKind::Number, &Cell::Int(value)) => *cell = Cell::Number(value as f64),
                _ => {}
            }
        }
        let object = row.object.ok_or(DecodeError::Missing("object"))?;
        Ok(Row {
            meta: object.metadata.into_meta()?,
            cells: cells.into_boxed_slice(),
        })
    }

    fn raw_row(&mut self, meta: Meta) -> Row {
        if self.columns.is_none() {
            self.columns = Some(metadata_columns());
            self.synthetic = true;
        }
        let cells = self
            .columns
            .iter()
            .flat_map(|columns| columns.iter())
            .map(|column| match column.kind {
                ColumnKind::Age => Cell::Age,
                _ if &*column.format == "name" => Cell::Text(meta.name.clone()),
                _ => Cell::Null,
            })
            .collect();
        Row { meta, cells }
    }
}

impl Decode for TableDecoder {
    type Item = Row;

    fn decode_list(&mut self, body: &[u8]) -> Result<Page, DecodeError> {
        match peek_kind(body)? {
            Kind::Table => {
                let table: TableObject = serde_json::from_slice(body)?;
                self.update_columns(table.column_definitions);
                let rows = table
                    .rows
                    .into_iter()
                    .map(|row| self.table_row(row))
                    .collect::<Result<_, _>>()?;
                Ok(table.metadata.into_page(rows))
            }
            Kind::Other(kind) if kind.ends_with("List") => {
                let list: RawList = serde_json::from_slice(body)?;
                let rows = list
                    .items
                    .into_iter()
                    .map(|item| Ok(self.raw_row(item.metadata.into_meta()?)))
                    .collect::<Result<_, DecodeError>>()?;
                Ok(list.metadata.into_page(rows))
            }
            Kind::Status => Err(DecodeError::UnexpectedKind("Status".into())),
            Kind::Other(kind) => Err(DecodeError::UnexpectedKind(kind.into())),
        }
    }

    fn decode_event(&mut self, line: &[u8]) -> Result<Event, DecodeError> {
        let event: RawEvent<'_> = serde_json::from_slice(line)?;
        let body = event.object.get().as_bytes();
        match peek_kind(body)? {
            Kind::Status => Ok(Event::Error(decode::status(body)?)),
            Kind::Table => {
                let mut table: TableObject = serde_json::from_slice(body)?;
                self.update_columns(table.column_definitions);
                if table.rows.len() != 1 {
                    return Err(DecodeError::RowCount(table.rows.len()));
                }
                let Some(row) = table.rows.pop() else {
                    return Err(DecodeError::RowCount(0));
                };
                match event.kind {
                    EventKind::Bookmark => {
                        let metadata = row.object.unwrap_or_default().metadata;
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
                        self.table_row(row).map(Event::Upsert)
                    }
                    EventKind::Deleted => self.table_row(row).map(Event::Delete),
                    EventKind::Error => Err(DecodeError::UnexpectedKind("Table".into())),
                }
            }
            Kind::Other(kind) => {
                let object: RawObject = serde_json::from_slice(body)?;
                let event = object.metadata.into_event(event.kind, &kind, |meta| meta)?;
                Ok(match event {
                    Event::Upsert(meta) => Event::Upsert(self.raw_row(meta)),
                    Event::Delete(meta) => Event::Delete(self.raw_row(meta)),
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

    /// The metadata columns, Name and Age, while the server has sent raw
    /// objects only.
    fn columns(&self) -> Option<&Arc<[Column]>> {
        self.columns.as_ref()
    }
}

fn metadata_columns() -> Arc<[Column]> {
    Arc::new([
        Column {
            name: "Name".into(),
            kind: ColumnKind::String,
            format: "name".into(),
            priority: 0,
        },
        Column {
            name: "Age".into(),
            kind: ColumnKind::Age,
            format: "".into(),
            priority: 0,
        },
    ])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableObject {
    #[serde(default)]
    metadata: ListMeta,
    #[serde(default)]
    column_definitions: Option<Vec<RawColumn>>,
    #[serde(default, deserialize_with = "nullable")]
    rows: Vec<RawRow>,
}

#[derive(Deserialize)]
struct RawColumn {
    name: Box<str>,
    #[serde(rename = "type")]
    kind: Box<str>,
    #[serde(default)]
    format: Box<str>,
    #[serde(default)]
    priority: i32,
    #[serde(default)]
    description: Box<str>,
}

impl From<RawColumn> for Column {
    fn from(raw: RawColumn) -> Self {
        // Built-in printers type Age as a string described by creationTimestamp's
        // field doc; CRDs type it as a date, under any capitalisation.
        let age = raw.name.eq_ignore_ascii_case("age")
            && (&*raw.kind == "date" || raw.description.starts_with("CreationTimestamp"));
        let kind = match &*raw.kind {
            _ if age => ColumnKind::Age,
            "string" => ColumnKind::String,
            "integer" => ColumnKind::Integer,
            "number" => ColumnKind::Number,
            "boolean" => ColumnKind::Boolean,
            "date" => ColumnKind::Date,
            _ => ColumnKind::Other,
        };
        Column {
            name: raw.name,
            kind,
            format: raw.format,
            priority: raw.priority,
        }
    }
}

#[derive(Deserialize)]
struct RawRow {
    cells: Vec<Cell>,
    #[serde(default)]
    object: Option<RawObject>,
}

impl<'de> Deserialize<'de> for Cell {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct CellVisitor;

        impl<'de> Visitor<'de> for CellVisitor {
            type Value = Cell;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a table cell")
            }

            fn visit_bool<E>(self, v: bool) -> Result<Cell, E> {
                Ok(Cell::Bool(v))
            }

            fn visit_i64<E>(self, v: i64) -> Result<Cell, E> {
                Ok(Cell::Int(v))
            }

            fn visit_u64<E>(self, v: u64) -> Result<Cell, E> {
                Ok(i64::try_from(v).map_or(Cell::Number(v as f64), Cell::Int))
            }

            fn visit_f64<E>(self, v: f64) -> Result<Cell, E> {
                Ok(Cell::Number(v))
            }

            fn visit_str<E>(self, v: &str) -> Result<Cell, E> {
                Ok(Cell::Text(v.into()))
            }

            fn visit_unit<E>(self) -> Result<Cell, E> {
                Ok(Cell::Null)
            }

            fn visit_none<E>(self) -> Result<Cell, E> {
                Ok(Cell::Null)
            }

            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Cell, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Cell::Null)
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Cell, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Cell::Null)
            }
        }

        deserializer.deserialize_any(CellVisitor)
    }
}
