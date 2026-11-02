//! Meta-lite, the metadata every row keeps, and the decoder of Metadata
//! upstreams (ARCHITECTURE 3.3), which keep nothing else.

use std::fmt;

use jiff::Timestamp;
use serde::Deserialize;
use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, Visitor};

use crate::decode::{
    self, Decode, DecodeError, Event, EventKind, Kind, ListMeta, Page, RawEvent, nullable,
    peek_kind,
};
use crate::table::Row;

pub type Labels = Box<[(Box<str>, Box<str>)]>;

#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub name: Box<str>,
    pub namespace: Option<Box<str>>,
    /// None for objects the server builds without one, such as ComponentStatus
    /// and metrics-server's metrics.
    pub uid: Option<Box<str>>,
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

/// Decodes `PartialObjectMetadata` lists and events into rows without
/// cells, and the full objects of a server that sends no metadata.
#[derive(Debug, Default)]
pub struct MetaDecoder;

impl Decode for MetaDecoder {
    type Item = Row;

    fn decode_list(&mut self, body: &[u8]) -> Result<Page, DecodeError> {
        match peek_kind(body)? {
            Kind::Status => Err(DecodeError::UnexpectedKind("Status".into())),
            Kind::Table => Err(DecodeError::UnexpectedKind("Table".into())),
            Kind::Other(_) => {
                let list: RawList = serde_json::from_slice(body)?;
                let rows = list
                    .items
                    .into_iter()
                    .map(|item| item.metadata.into_meta().map(Row::without_cells))
                    .collect::<Result<_, _>>()?;
                Ok(list.metadata.into_page(rows))
            }
        }
    }

    fn decode_event(&mut self, line: &[u8]) -> Result<Event, DecodeError> {
        let event: RawEvent<'_> = serde_json::from_slice(line)?;
        let body = event.object.get().as_bytes();
        match peek_kind(body)? {
            Kind::Status => Ok(Event::Error(decode::status(body)?)),
            Kind::Table => Err(DecodeError::UnexpectedKind("Table".into())),
            Kind::Other(kind) => {
                let object: RawObject = serde_json::from_slice(body)?;
                object
                    .metadata
                    .into_event(event.kind, &kind, Row::without_cells)
            }
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct RawList {
    #[serde(default)]
    pub metadata: ListMeta,
    #[serde(default, deserialize_with = "nullable")]
    pub items: Vec<RawObject>,
}

#[derive(Default, Deserialize)]
pub(crate) struct RawObject {
    #[serde(default)]
    pub metadata: RawMeta,
}

/// Object metadata as a row keeps it. Fields it does not name, managedFields
/// and annotations' values among them, are skipped without being allocated.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawMeta {
    name: Option<Box<str>>,
    namespace: Option<Box<str>>,
    uid: Option<Box<str>>,
    pub resource_version: Option<Box<str>>,
    #[serde(default, deserialize_with = "labels")]
    labels: Labels,
    #[serde(default, deserialize_with = "nullable")]
    owner_references: Vec<RawOwner>,
    #[serde(default, deserialize_with = "timestamp")]
    creation_timestamp: Option<Timestamp>,
    #[serde(
        default,
        rename = "annotations",
        deserialize_with = "initial_events_end"
    )]
    pub initial_events_end: bool,
}

impl RawMeta {
    pub fn into_meta(self) -> Result<Meta, DecodeError> {
        Ok(Meta {
            name: self.name.ok_or(DecodeError::Missing("metadata.name"))?,
            namespace: self.namespace,
            uid: self.uid,
            resource_version: self.resource_version.unwrap_or_default(),
            labels: self.labels,
            owners: self.owner_references.into_iter().map(Owner::from).collect(),
            created: self.creation_timestamp,
        })
    }

    /// The event of an object of `object_kind`, not a Table, built by `item`
    /// from its metadata.
    pub fn into_event<T>(
        self,
        kind: EventKind,
        object_kind: &str,
        item: impl FnOnce(Meta) -> T,
    ) -> Result<Event<T>, DecodeError> {
        match kind {
            EventKind::Bookmark => Ok(Event::Bookmark {
                resource_version: decode::non_empty(self.resource_version)?,
                initial_events_end: self.initial_events_end,
            }),
            EventKind::Added | EventKind::Modified => self.into_meta().map(item).map(Event::Upsert),
            EventKind::Deleted => self.into_meta().map(item).map(Event::Delete),
            EventKind::Error => Err(DecodeError::UnexpectedKind(object_kind.into())),
        }
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

        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
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
