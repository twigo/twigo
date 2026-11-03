//! Describes an object for people (ARCHITECTURE 4.3): the Overview document
//! that the drawer, the Overview tab and MCP's describe-style summaries
//! share.
//!
//! Its state comes first, as the owner chose on 2026-11-03: what is wrong
//! with it when anything is, the first section of its kind's describer,
//! its conditions, the describer's other sections, then metadata and
//! events last. The describer is looked up by group and kind; any other
//! kind gets the server's printer columns and its spec and status as
//! trees. A describer may need other objects, such as a
//! Deployment its ReplicaSets: it names them, and twigo-core lists and
//! follows them while the Overview is shown.

mod batch;
mod containers;
mod data;
mod events;
mod metadata;
mod network;
mod node;
mod owned;
mod pod;
mod quantity;
mod show;
mod storage;
mod template;
mod tree;
mod volumes;
mod workloads;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use twigo_ipc::{
    Block, Condition, EventList, Field, Finding, Overview, Section, Tone, Value as Shown,
};

pub use events::{event, newest_first};
pub use owned::{Owned, owned};
pub use pod::{next_start, status_tone};

/// What an object is described from.
#[derive(Debug, Clone, Copy)]
pub struct Input<'a> {
    pub object: &'a Value,
    /// The server's printer columns for it, Name, Namespace and Age left out.
    pub printed: &'a [Printed],
    pub events: &'a EventList,
    /// The objects its describer [`needs`], each once it is listed.
    pub facts: &'a [Fact],
}

/// A cell the server printed for the object, as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Printed {
    pub column: String,
    pub value: String,
}

/// Objects of one resource a describer reads besides its own.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Need {
    /// Empty for the core group.
    pub group: String,
    pub version: String,
    pub resource: String,
    pub namespaced: bool,
    /// None for every namespace, or a cluster-scoped resource.
    pub namespace: Option<String>,
    pub field_selector: Option<String>,
}

/// What a [`Need`] found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fact {
    pub need: Need,
    pub found: Found,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Found {
    Listed {
        objects: Vec<Value>,
    },
    /// Why they cannot be listed, as when the person may not list them.
    Unavailable {
        message: String,
    },
}

/// What a kind's describer adds to the shared sections.
pub(crate) struct Described {
    /// For the Diagnostics section, which comes first.
    pub findings: Vec<Finding>,
    pub sections: Vec<Section>,
}

struct Describer {
    group: &'static str,
    kind: &'static str,
    needs: fn(&Value) -> Vec<Need>,
    describe: fn(&Input<'_>) -> Described,
}

fn nothing(_: &Value) -> Vec<Need> {
    Vec::new()
}

/// The kinds with sections of their own, by group and kind.
const DESCRIBERS: &[Describer] = &[
    Describer {
        group: "",
        kind: "Pod",
        needs: nothing,
        describe: pod::describe,
    },
    Describer {
        group: "apps",
        kind: "Deployment",
        needs: workloads::deployment_needs,
        describe: workloads::deployment,
    },
    Describer {
        group: "apps",
        kind: "StatefulSet",
        needs: nothing,
        describe: workloads::stateful_set,
    },
    Describer {
        group: "apps",
        kind: "DaemonSet",
        needs: nothing,
        describe: workloads::daemon_set,
    },
    Describer {
        group: "batch",
        kind: "Job",
        needs: nothing,
        describe: batch::job,
    },
    Describer {
        group: "batch",
        kind: "CronJob",
        needs: nothing,
        describe: batch::cron_job,
    },
    Describer {
        group: "",
        kind: "Service",
        needs: network::service_needs,
        describe: network::service,
    },
    Describer {
        group: "networking.k8s.io",
        kind: "Ingress",
        needs: network::ingress_needs,
        describe: network::ingress,
    },
    Describer {
        group: "",
        kind: "Node",
        needs: node::needs,
        describe: node::describe,
    },
    Describer {
        group: "",
        kind: "PersistentVolumeClaim",
        needs: storage::needs,
        describe: storage::describe,
    },
    Describer {
        group: "",
        kind: "ConfigMap",
        needs: nothing,
        describe: data::config_map,
    },
    Describer {
        group: "",
        kind: "Secret",
        needs: nothing,
        describe: data::secret,
    },
];

/// The objects the describer of `object`'s kind reads besides it.
pub fn needs(object: &Value) -> Vec<Need> {
    describer(object).map_or_else(Vec::new, |describer| (describer.needs)(object))
}

pub fn describe(input: Input<'_>) -> Overview {
    let object = input.object;
    let described = match describer(object) {
        Some(describer) => (describer.describe)(&input),
        None => Described {
            findings: Vec::new(),
            sections: generic(object, input.printed),
        },
    };
    let mut sections = Vec::new();
    if !described.findings.is_empty() {
        sections.push(Section {
            id: "core.diagnostics".to_owned(),
            title: "Diagnostics".to_owned(),
            blocks: vec![Block::Diagnostics {
                findings: described.findings,
            }],
        });
    }
    let mut own = described.sections.into_iter();
    sections.extend(own.next());
    sections.extend(conditions(object));
    sections.extend(own);
    sections.push(metadata::section(object));
    sections.push(Section {
        id: "core.events".to_owned(),
        title: "Events".to_owned(),
        blocks: vec![Block::Events(input.events.clone())],
    });
    Overview { sections }
}

fn describer(object: &Value) -> Option<&'static Describer> {
    let (group, _) = group_version(object);
    let kind = object["kind"].as_str()?;
    DESCRIBERS
        .iter()
        .find(|describer| describer.group == group && describer.kind == kind)
}

/// The text the server printed in a column.
pub(crate) fn printed<'a>(printed: &'a [Printed], column: &str) -> Option<&'a str> {
    printed
        .iter()
        .find(|cell| cell.column == column)
        .map(|cell| cell.value.as_str())
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
                        value: Shown::Text {
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

/// Condition types whose True is bad news, from the core kinds (k8s.io/api
/// v0.37.1): a node's pressures, a ReplicaSet's or Deployment's
/// ReplicaFailure, a Job's Failed, a claim's resize and modify errors, a
/// pod about to be disrupted, a namespace that cannot be deleted.
const TRUE_IS_BAD: &[&str] = &[
    "MemoryPressure",
    "DiskPressure",
    "PIDPressure",
    "NetworkUnavailable",
    "ReplicaFailure",
    "Failed",
    "FailureTarget",
    "ControllerResizeError",
    "NodeResizeError",
    "ModifyVolumeError",
    "DisruptionTarget",
    "NamespaceDeletionDiscoveryFailure",
    "NamespaceDeletionContentFailure",
    "NamespaceDeletionGroupVersionParsingFailure",
];

/// Condition types that tell a state rather than health, so neither status
/// is wrong: a claim in use or resizing, a pod or node in a planned change,
/// a suspended Job, a namespace still emptying.
const STATES: &[&str] = &[
    "Unused",
    "Resizing",
    "FileSystemResizePending",
    "ModifyingVolume",
    "PodResizePending",
    "PodResizeInProgress",
    "AllContainersRestarting",
    "GracefulNodeShutdownInProgress",
    "DrainInProgress",
    "Drained",
    "MaintenancePlanned",
    "MaintenanceInProgress",
    "Suspended",
    "NamespaceContentRemaining",
    "NamespaceFinalizersRemaining",
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
                _ if STATES.contains(&kind.as_str()) => Tone::Neutral,
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
                last_heartbeat: text(&condition["lastHeartbeatTime"]),
            })
        })
        .collect();
    (!conditions.is_empty()).then(|| Section {
        id: "core.conditions".to_owned(),
        title: "Conditions".to_owned(),
        blocks: vec![Block::Conditions { conditions }],
    })
}

/// What a component said, without the line ends it wrote around it, as a
/// termination message read from a log ends.
pub(crate) fn message(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A non-empty string.
pub(crate) fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}
