//! ConfigMaps and Secrets: their keys with sizes, never a Secret's values
//! (ARCHITECTURE 3.6).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use twigo_ipc::{Block, DataEntry, Field, Section, Value as Shown};

use crate::{Described, Input, text};

pub(crate) fn config_map(input: &Input<'_>) -> Described {
    let object = input.object;
    let mut entries: Vec<DataEntry> = object["data"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| DataEntry {
            key: key.clone(),
            bytes: value.as_str().map_or(0, str::len) as u64,
            binary: false,
        })
        .collect();
    entries.extend(
        object["binaryData"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(key, value)| DataEntry {
                key: key.clone(),
                bytes: decoded(value).map_or(0, |bytes| bytes.len() as u64),
                binary: true,
            }),
    );
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    let mut blocks = immutable(object);
    blocks.push(Block::Data {
        entries,
        readable: true,
    });
    Described {
        findings: Vec::new(),
        sections: vec![Section {
            id: "core.data".to_owned(),
            title: "Data".to_owned(),
            blocks,
        }],
    }
}

pub(crate) fn secret(input: &Input<'_>) -> Described {
    let object = input.object;
    let mut fields = Vec::new();
    if let Some(kind) = text(&object["type"]) {
        fields.push(Field {
            label: "Type".to_owned(),
            value: Shown::Text { text: kind },
        });
    }
    let mut blocks = vec![Block::Fields { fields }];
    blocks.extend(immutable(object));
    let mut entries: Vec<DataEntry> = object["data"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| {
            let bytes = decoded(value).unwrap_or_default();
            DataEntry {
                key: key.clone(),
                bytes: bytes.len() as u64,
                binary: std::str::from_utf8(&bytes).is_err(),
            }
        })
        .collect();
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    blocks.push(Block::Data {
        entries,
        readable: false,
    });
    Described {
        findings: Vec::new(),
        sections: vec![Section {
            id: "core.data".to_owned(),
            title: "Data".to_owned(),
            blocks,
        }],
    }
}

fn immutable(object: &Value) -> Vec<Block> {
    match object["immutable"].as_bool() {
        Some(true) => vec![Block::Fields {
            fields: vec![Field {
                label: "Immutable".to_owned(),
                value: Shown::Text {
                    text: "true".to_owned(),
                },
            }],
        }],
        _ => Vec::new(),
    }
}

fn decoded(value: &Value) -> Option<Vec<u8>> {
    STANDARD.decode(value.as_str()?).ok()
}
