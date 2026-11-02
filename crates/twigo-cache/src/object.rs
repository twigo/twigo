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
        struct List<'a> {
            #[serde(default)]
            metadata: ListMeta,
            #[serde(borrow, default)]
            items: Option<Vec<&'a RawValue>>,
        }
        match peek_kind(body)? {
            Kind::Other(_) => {
                let list: List<'_> = serde_json::from_slice(body)?;
                let objects = list
                    .items
                    .unwrap_or_default()
                    .into_iter()
                    .map(object)
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

fn object(json: &RawValue) -> Result<Object, DecodeError> {
    let parsed: RawObject = serde_json::from_str(json.get())?;
    Ok(Object {
        meta: parsed.metadata.into_meta()?,
        json: json.to_owned(),
    })
}
