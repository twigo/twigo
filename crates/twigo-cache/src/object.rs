//! The decoder of Object upstreams (ARCHITECTURE 3.3): an open editor's
//! object, kept whole in Rust, managedFields and Secret values included.

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::decode::{self, Decode, DecodeError, Event, Kind, ListMeta, Page, RawEvent, peek_kind};
use crate::meta::{Meta, RawObject};

#[derive(Debug, Clone)]
pub struct Object {
    pub meta: Meta,
    pub json: Box<RawValue>,
}

#[derive(Debug, Default)]
pub struct ObjectDecoder;

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
            Kind::Other(kind) => {
                let list: List<'_> = serde_json::from_slice(body)?;
                // A list's items carry no kind or apiVersion of their own,
                // while a watch's objects do: they get the list's.
                let item_kind = kind.strip_suffix("List").unwrap_or(&kind);
                let objects = list
                    .items
                    .unwrap_or_default()
                    .into_iter()
                    .map(|item| object(item, item_kind, &list.api_version))
                    .collect::<Result<_, _>>()?;
                Ok(list.metadata.into_page(objects))
            }
            Kind::Status => Err(DecodeError::UnexpectedKind("Status".into())),
            Kind::Table => Err(DecodeError::UnexpectedKind("Table".into())),
        }
    }

    fn decode_event(&mut self, line: &[u8]) -> Result<Event<Object>, DecodeError> {
        let event: RawEvent<'_> = serde_json::from_slice(line)?;
        let body = event.object.get().as_bytes();
        match peek_kind(body)? {
            Kind::Status => Ok(Event::Error(decode::status(body)?)),
            Kind::Table => Err(DecodeError::UnexpectedKind("Table".into())),
            Kind::Other(kind) => {
                let parsed: RawObject = serde_json::from_slice(body)?;
                parsed
                    .metadata
                    .into_event(event.kind, &kind, |meta| Object {
                        meta,
                        json: event.object.to_owned(),
                    })
            }
        }
    }
}

fn object(json: &RawValue, kind: &str, api_version: &str) -> Result<Object, DecodeError> {
    let parsed: RawObject = serde_json::from_str(json.get())?;
    let mut whole: serde_json::Map<String, serde_json::Value> = serde_json::from_str(json.get())?;
    whole
        .entry("kind")
        .or_insert_with(|| kind.to_owned().into());
    whole
        .entry("apiVersion")
        .or_insert_with(|| api_version.to_owned().into());
    Ok(Object {
        meta: parsed.metadata.into_meta()?,
        json: serde_json::value::to_raw_value(&whole)?,
    })
}
