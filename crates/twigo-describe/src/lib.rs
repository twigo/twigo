//! Describes an object for people (ARCHITECTURE 4.3): the Overview document
//! that the drawer, the Overview tab and MCP's describe-style summaries
//! share.
//!
//! Every object gets the shared sections, metadata first, its conditions
//! and events last. Between them come the sections of its kind's describer,
//! looked up by group and kind, or for any other kind the server's printer
//! columns and its spec and status as trees.

mod data;
mod events;
mod metadata;
mod owned;
mod tree;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use twigo_ipc::{Block, Condition, Field, ObjectEvent, Overview, Section, Tone};

pub use events::{event, newest_first};
pub use owned::{Owned, owned};

/// What an object is described from.
#[derive(Debug, Clone, Copy)]
pub struct Input<'a> {
    pub object: &'a Value,
    /// The server's printer columns for it, Name, Namespace and Age left out.
    pub printed: &'a [Printed],
    /// Newest first.
    pub events: &'a [ObjectEvent],
}

/// A cell the server printed for the object, as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Printed {
    pub column: String,
    pub value: String,
}

type Describer = fn(&Value) -> Vec<Section>;

/// The kinds with sections of their own, by group and kind.
const DESCRIBERS: &[(&str, &str, Describer)] = &[
    ("", "ConfigMap", data::config_map),
    ("", "Secret", data::secret),
];

pub fn describe(input: Input<'_>) -> Overview {
    let object = input.object;
    let mut sections = vec![metadata::section(object)];
    match describer(object) {
        Some(describe) => sections.extend(describe(object)),
        None => sections.extend(generic(object, input.printed)),
    }
    sections.extend(conditions(object));
    sections.push(Section {
        id: "core.events".to_owned(),
        title: "Events".to_owned(),
        blocks: vec![Block::Events {
            events: input.events.to_vec(),
        }],
    });
    Overview { sections }
}

fn describer(object: &Value) -> Option<Describer> {
    let (group, _) = group_version(object);
    let kind = object["kind"].as_str()?;
    DESCRIBERS
        .iter()
        .find(|(g, k, _)| *g == group && *k == kind)
        .map(|(_, _, describe)| *describe)
}

/// The group and version of an object's `apiVersion`, the core group empty.
pub fn group_version(object: &Value) -> (&str, &str) {
    let api_version = object["apiVersion"].as_str().unwrap_or_default();
    api_version.split_once('/').unwrap_or(("", api_version))
}

/// For a kind without a describer: what the server prints for it, then its
/// spec, its other fields and its status, as kubectl's generic describer
/// shows the whole object.
fn generic(object: &Value, printed: &[Printed]) -> Vec<Section> {
    let mut sections = Vec::new();
    if !printed.is_empty() {
        sections.push(Section {
            id: "core.summary".to_owned(),
            title: "Summary".to_owned(),
            blocks: vec![Block::Fields {
                fields: printed
                    .iter()
                    .map(|cell| Field {
                        label: cell.column.clone(),
                        value: twigo_ipc::Value::Text {
                            text: cell.value.clone(),
                        },
                    })
                    .collect(),
            }],
        });
    }
    let fields = object.as_object();
    if let Some(spec) = fields.and_then(|fields| fields.get("spec")) {
        sections.extend(tree::section("core.spec", "Spec", spec, &[]));
    }
    if let Some(fields) = fields {
        let rest: serde_json::Map<String, Value> = fields
            .iter()
            .filter(|(key, _)| {
                !matches!(
                    key.as_str(),
                    "apiVersion" | "kind" | "metadata" | "spec" | "status"
                )
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        sections.extend(tree::section(
            "core.fields",
            "Fields",
            &Value::Object(rest),
            &[],
        ));
    }
    if let Some(status) = fields.and_then(|fields| fields.get("status")) {
        sections.extend(tree::section(
            "core.status",
            "Status",
            status,
            &["conditions"],
        ));
    }
    sections
}

/// Condition types whose True is bad news, from the core kinds: a node's
/// pressures, a ReplicaSet's or Deployment's ReplicaFailure, a Job's Failed.
const TRUE_IS_BAD: &[&str] = &[
    "MemoryPressure",
    "DiskPressure",
    "PIDPressure",
    "NetworkUnavailable",
    "ReplicaFailure",
    "Failed",
    "FailureTarget",
];

fn conditions(object: &Value) -> Option<Section> {
    let conditions: Vec<Condition> = object["status"]["conditions"]
        .as_array()?
        .iter()
        .filter_map(|condition| {
            let kind = condition["type"].as_str()?.to_owned();
            let status = condition["status"].as_str().unwrap_or("Unknown").to_owned();
            let bad_when_true = TRUE_IS_BAD.contains(&kind.as_str());
            let tone = match (status.as_str(), bad_when_true) {
                ("True", false) | ("False", true) => Tone::Success,
                ("True", true) => Tone::Danger,
                ("False", false) => Tone::Warning,
                _ => Tone::Neutral,
            };
            Some(Condition {
                kind,
                status,
                tone,
                reason: text(&condition["reason"]),
                message: text(&condition["message"]),
                last_transition: text(&condition["lastTransitionTime"]),
            })
        })
        .collect();
    (!conditions.is_empty()).then(|| Section {
        id: "core.conditions".to_owned(),
        title: "Conditions".to_owned(),
        blocks: vec![Block::Conditions { conditions }],
    })
}

/// A non-empty string.
pub(crate) fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}
