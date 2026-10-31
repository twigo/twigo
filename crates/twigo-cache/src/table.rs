use std::borrow::Cow;
use std::fmt;
use std::sync::Arc;

use jiff::Timestamp;
use serde::Deserialize;
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::value::RawValue;

pub mod request;

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

pub type Labels = Box<[(Box<str>, Box<str>)]>;

#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub name: Box<str>,
    pub namespace: Option<Box<str>>,
    pub uid: Box<str>,
    pub resource_version: Box<str>,
    pub labels: Labels,
    pub owners: Box<[Owner]>,
    pub created: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Owner {
    pub kind: Box<str>,
    pub name: Box<str>,
    pub uid: Box<str>,
    pub controller: bool,
}

#[derive(Debug, PartialEq)]
pub struct Page {
    pub rows: Vec<Row>,
    pub resource_version: Box<str>,
    pub continue_token: Option<Box<str>>,
}

#[derive(Debug, PartialEq)]
pub enum Event {
    Upsert(Row),
    Delete(Row),
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

    /// The current columns. They are the metadata columns, Name and Age, while
    /// the server has sent raw objects only.
    pub fn columns(&self) -> Option<&Arc<[Column]>> {
        self.columns.as_ref()
    }

    pub fn decode_list(&mut self, body: &[u8]) -> Result<Page, DecodeError> {
        match peek_kind(body)? {
            Kind::Table => {
                let table: TableObject = serde_json::from_slice(body)?;
                self.update_columns(table.column_definitions);
                let rows = table
                    .rows
                    .into_iter()
                    .map(|row| self.table_row(row))
                    .collect::<Result<_, _>>()?;
                Ok(Page {
                    rows,
                    resource_version: table.metadata.resource_version.unwrap_or_default(),
                    continue_token: table
                        .metadata
                        .continue_token
                        .filter(|token| !token.is_empty()),
                })
            }
            Kind::Other(kind) if kind.ends_with("List") => {
                let list: RawList = serde_json::from_slice(body)?;
                let rows = list
                    .items
                    .into_iter()
                    .map(|item| self.raw_row(item.metadata))
                    .collect::<Result<_, _>>()?;
                Ok(Page {
                    rows,
                    resource_version: list.metadata.resource_version.unwrap_or_default(),
                    continue_token: list
                        .metadata
                        .continue_token
                        .filter(|token| !token.is_empty()),
                })
            }
            Kind::Status => Err(DecodeError::UnexpectedKind("Status".into())),
            Kind::Other(kind) => Err(DecodeError::UnexpectedKind(kind.into())),
        }
    }

    pub fn decode_event(&mut self, line: &[u8]) -> Result<Event, DecodeError> {
        let event: RawEvent<'_> = serde_json::from_slice(line)?;
        let body = event.object.get().as_bytes();
        match peek_kind(body)? {
            Kind::Status => {
                let status: StatusObject = serde_json::from_slice(body)?;
                Ok(Event::Error(Status {
                    code: status.code,
                    reason: status.reason,
                    message: status.message,
                }))
            }
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
                    EventKind::Bookmark => Ok(Event::Bookmark {
                        resource_version: table.metadata.resource_version.unwrap_or_default(),
                        initial_events_end: row
                            .object
                            .is_some_and(|object| object.metadata.initial_events_end),
                    }),
                    EventKind::Added | EventKind::Modified => {
                        self.table_row(row).map(Event::Upsert)
                    }
                    EventKind::Deleted => self.table_row(row).map(Event::Delete),
                    EventKind::Error => Err(DecodeError::UnexpectedKind("Table".into())),
                }
            }
            Kind::Other(kind) => {
                let object: RawObject = serde_json::from_slice(body)?;
                match event.kind {
                    EventKind::Bookmark => Ok(Event::Bookmark {
                        resource_version: object.metadata.resource_version.unwrap_or_default(),
                        initial_events_end: object.metadata.initial_events_end,
                    }),
                    EventKind::Added | EventKind::Modified => {
                        self.raw_row(object.metadata).map(Event::Upsert)
                    }
                    EventKind::Deleted => self.raw_row(object.metadata).map(Event::Delete),
                    EventKind::Error => Err(DecodeError::UnexpectedKind(kind.into())),
                }
            }
        }
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
        let columns = self.columns.as_deref().ok_or(DecodeError::NoColumns)?;
        if row.cells.len() != columns.len() {
            return Err(DecodeError::CellCount {
                expected: columns.len(),
                found: row.cells.len(),
            });
        }
        let mut cells = row.cells;
        for (cell, column) in cells.iter_mut().zip(columns) {
            if column.kind == ColumnKind::Age {
                *cell = Cell::Age;
            }
        }
        let object = row.object.ok_or(DecodeError::Missing("object"))?;
        Ok(Row {
            meta: object.metadata.into_meta()?,
            cells: cells.into_boxed_slice(),
        })
    }

    fn raw_row(&mut self, metadata: RawMeta) -> Result<Row, DecodeError> {
        let meta = metadata.into_meta()?;
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
        Ok(Row { meta, cells })
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

enum Kind<'a> {
    Table,
    Status,
    Other(Cow<'a, str>),
}

fn peek_kind(body: &[u8]) -> Result<Kind<'_>, DecodeError> {
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
struct RawEvent<'a> {
    #[serde(rename = "type")]
    kind: EventKind,
    #[serde(borrow)]
    object: &'a RawValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum EventKind {
    Added,
    Modified,
    Deleted,
    Bookmark,
    Error,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableObject {
    #[serde(default)]
    metadata: ListMeta,
    #[serde(default)]
    column_definitions: Option<Vec<RawColumn>>,
    #[serde(default)]
    rows: Vec<RawRow>,
}

#[derive(Deserialize)]
struct RawList {
    #[serde(default)]
    metadata: ListMeta,
    #[serde(default)]
    items: Vec<RawObject>,
}

#[derive(Deserialize)]
struct RawObject {
    #[serde(default)]
    metadata: RawMeta,
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

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListMeta {
    resource_version: Option<Box<str>>,
    #[serde(rename = "continue")]
    continue_token: Option<Box<str>>,
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
        // Built-in printers describe Age with creationTimestamp's field doc; a
        // CRD's Age column is a printer column on its JSONPath.
        let age = &*raw.name == "Age"
            && (raw.description.starts_with("CreationTimestamp")
                || raw.description.ends_with(".metadata.creationTimestamp"));
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

/// Object metadata as a row keeps it. Fields it does not name, managedFields
/// and annotations' values among them, are skipped without being allocated.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMeta {
    name: Option<Box<str>>,
    namespace: Option<Box<str>>,
    uid: Option<Box<str>>,
    resource_version: Option<Box<str>>,
    #[serde(default, deserialize_with = "labels")]
    labels: Labels,
    #[serde(default)]
    owner_references: Vec<RawOwner>,
    #[serde(default, deserialize_with = "timestamp")]
    creation_timestamp: Option<Timestamp>,
    #[serde(
        default,
        rename = "annotations",
        deserialize_with = "initial_events_end"
    )]
    initial_events_end: bool,
}

impl RawMeta {
    fn into_meta(self) -> Result<Meta, DecodeError> {
        Ok(Meta {
            name: self.name.ok_or(DecodeError::Missing("metadata.name"))?,
            namespace: self.namespace,
            uid: self.uid.ok_or(DecodeError::Missing("metadata.uid"))?,
            resource_version: self.resource_version.unwrap_or_default(),
            labels: self.labels,
            owners: self.owner_references.into_iter().map(Owner::from).collect(),
            created: self.creation_timestamp,
        })
    }
}

#[derive(Deserialize)]
struct RawOwner {
    kind: Box<str>,
    name: Box<str>,
    uid: Box<str>,
    #[serde(default)]
    controller: Option<bool>,
}

impl From<RawOwner> for Owner {
    fn from(raw: RawOwner) -> Self {
        Owner {
            kind: raw.kind,
            name: raw.name,
            uid: raw.uid,
            controller: raw.controller.unwrap_or(false),
        }
    }
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

fn labels<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Labels, D::Error> {
    struct LabelsVisitor;

    impl<'de> Visitor<'de> for LabelsVisitor {
        type Value = Labels;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a label map")
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(Box::default())
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut labels = Vec::with_capacity(map.size_hint().unwrap_or(0));
            while let Some(label) = map.next_entry::<Box<str>, Box<str>>()? {
                labels.push(label);
            }
            Ok(labels.into_boxed_slice())
        }
    }

    deserializer.deserialize_any(LabelsVisitor)
}

fn timestamp<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Timestamp>, D::Error> {
    struct TimestampVisitor;

    impl<'de> Visitor<'de> for TimestampVisitor {
        type Value = Option<Timestamp>;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("an RFC 3339 timestamp")
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            v.parse().map(Some).map_err(E::custom)
        }
    }

    deserializer.deserialize_any(TimestampVisitor)
}

const INITIAL_EVENTS_END: &str = "k8s.io/initial-events-end";

fn initial_events_end<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    struct AnnotationsVisitor;

    impl<'de> Visitor<'de> for AnnotationsVisitor {
        type Value = bool;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("an annotation map")
        }

        fn visit_unit<E>(self) -> Result<bool, E> {
            Ok(false)
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
            let mut found = false;
            while let Some(matches) = map.next_key_seed(StrIs(INITIAL_EVENTS_END))? {
                if matches {
                    found = map.next_value_seed(StrIs("true"))?;
                } else {
                    map.next_value::<IgnoredAny>()?;
                }
            }
            Ok(found)
        }
    }

    deserializer.deserialize_any(AnnotationsVisitor)
}

/// Compares a string with an expected value without allocating it.
struct StrIs(&'static str);

impl<'de> DeserializeSeed<'de> for StrIs {
    type Value = bool;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<bool, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for StrIs {
    type Value = bool;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a string")
    }

    fn visit_str<E>(self, v: &str) -> Result<bool, E> {
        Ok(v == self.0)
    }
}
