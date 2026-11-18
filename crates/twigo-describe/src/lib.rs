//! Describes an object for people (ARCHITECTURE 4.3): the Overview document
//! that the drawer, the Overview tab and MCP's describe-style summaries
//! share.
//!
//! Its state comes first, as the owner chose on 2026-11-03: what is wrong
//! with it when anything is, then what a triage of its kind reads, down to
//! how it is configured and what it is. The order, and which sections open
//! of themselves, is data of the kind's [`layout`]; a kind without one
//! shows its first section, its conditions, its other sections, then
//! events and metadata. The describer is looked up by group and kind; any
//! other kind gets the server's printer columns and its spec and status as
//! trees. A describer may need other objects, such as a
//! Deployment its ReplicaSets: it names them, and twigo-core lists and
//! follows them while the Overview is shown.

mod batch;
mod containers;
mod data;
mod events;
mod header;
mod layout;
mod metadata;
mod network;
mod node;
mod owned;
mod pod;
mod show;
mod storage;
mod template;
mod tree;
mod volumes;
mod workloads;

use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use twigo_ipc::Printed;
use twigo_ipc::{
    Block, Condition, EventList, Field, Finding, Header, Overview, Section, Span, Tone,
    Value as Shown, Vital,
};

use layout::Layout;
use show::{Summary, named, section};

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

/// What a kind's describer adds to the shared sections and the header.
#[derive(Default)]
pub(crate) struct Described {
    /// For the Diagnostics section, which comes first.
    pub findings: Vec<Finding>,
    pub sections: Vec<Section>,
    /// What the header says of the object's vitals in words, which a finding's
    /// title replaces.
    pub sentence: Vec<Span>,
    pub vitals: Vec<Vital>,
    /// The condition types whose cause its findings say in their own words,
    /// which the layout does not take as stated by any finding.
    pub explained: Vec<&'static str>,
    pub node: Option<String>,
    /// Rows for the Metadata section, after the object's age.
    pub metadata: Vec<Field>,
    /// Its labels are in a section of the describer's, not in Metadata.
    pub labels_apart: bool,
}

struct Describer {
    group: &'static str,
    kind: &'static str,
    needs: fn(&Value) -> Vec<Need>,
    describe: fn(&Input<'_>) -> Described,
    layout: &'static Layout,
}

fn nothing(_: &Value) -> Vec<Need> {
    Vec::new()
}

/// The kinds with sections of their own, by group and kind.
const DESCRIBERS: &[Describer] = &[
    Describer {
        group: "",
        kind: "Pod",
        needs: pod::needs,
        describe: pod::describe,
        layout: &layout::POD,
    },
    Describer {
        group: "apps",
        kind: "Deployment",
        needs: workloads::deployment_needs,
        describe: workloads::deployment,
        layout: &layout::WORKLOAD,
    },
    Describer {
        group: "apps",
        kind: "StatefulSet",
        needs: nothing,
        describe: workloads::stateful_set,
        layout: &layout::WORKLOAD,
    },
    Describer {
        group: "apps",
        kind: "DaemonSet",
        needs: nothing,
        describe: workloads::daemon_set,
        layout: &layout::WORKLOAD,
    },
    Describer {
        group: "batch",
        kind: "Job",
        needs: nothing,
        describe: batch::job,
        layout: &layout::JOB,
    },
    Describer {
        group: "batch",
        kind: "CronJob",
        needs: nothing,
        describe: batch::cron_job,
        layout: &layout::OTHER,
    },
    Describer {
        group: "",
        kind: "Service",
        needs: network::service_needs,
        describe: network::service,
        layout: &layout::OTHER,
    },
    Describer {
        group: "networking.k8s.io",
        kind: "Ingress",
        needs: network::ingress_needs,
        describe: network::ingress,
        layout: &layout::OTHER,
    },
    Describer {
        group: "",
        kind: "Node",
        needs: node::needs,
        describe: node::describe,
        layout: &layout::NODE,
    },
    Describer {
        group: "",
        kind: "PersistentVolumeClaim",
        needs: storage::needs,
        describe: storage::describe,
        layout: &layout::OTHER,
    },
    Describer {
        group: "",
        kind: "ConfigMap",
        needs: nothing,
        describe: data::config_map,
        layout: &layout::OTHER,
    },
    Describer {
        group: "",
        kind: "Secret",
        needs: nothing,
        describe: data::secret,
        layout: &layout::OTHER,
    },
];

/// The objects the describer of `object`'s kind reads besides it.
pub fn needs(object: &Value) -> Vec<Need> {
    describer(object).map_or_else(Vec::new, |describer| (describer.needs)(object))
}

pub fn describe(input: Input<'_>) -> Overview {
    let object = input.object;
    let found = describer(object);
    let layout = found.map_or(&layout::OTHER, |found| found.layout);
    let described = match found {
        Some(describer) => (describer.describe)(&input),
        None => Described {
            sections: generic(object, input.printed),
            ..Described::default()
        },
    };
    let Described {
        findings,
        sections: mut own,
        sentence,
        vitals,
        explained,
        node,
        metadata,
        labels_apart,
    } = described;
    let mut sections = Vec::new();
    if !findings.is_empty() {
        sections.push(Section {
            tone: findings.iter().fold(None, |tone, finding| {
                layout::worse(tone, layout::wrong(finding.tone))
            }),
            ..section(
                "core.diagnostics",
                "Diagnostics",
                vec![Block::Diagnostics {
                    findings: findings.clone(),
                }],
            )
        });
    }
    let first = own.first().map(|first| first.id.clone());
    if layout.order.is_empty()
        && own.iter().all(|section| section.tone.is_none())
        && let (Some(section), Some(finding)) = (own.first_mut(), findings.first())
    {
        section.tone = findings.iter().fold(None, |tone, finding| {
            layout::worse(tone, layout::wrong(finding.tone))
        });
        section.summary = named(finding);
    }
    let mut own = own.into_iter();
    if layout.order.is_empty() {
        sections.extend(own.next());
    }
    sections.extend(conditions(object, layout, !findings.is_empty(), &explained));
    sections.extend(own);
    sections.push(events::section(input.events));
    sections.push(metadata::section(object, metadata, labels_apart));
    layout.arrange(&mut sections);
    layout.settle(&mut sections, first.as_deref());
    Overview {
        header: Header {
            owner: header::owner(object, input.facts),
            node,
            created: text(&object["metadata"]["creationTimestamp"]),
            generated: None,
            printed: input.printed.to_vec(),
            sentence: header::sentence(&findings, sentence),
            vitals,
        },
        sections,
    }
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
        sections.push(section(
            "core.summary",
            "Summary",
            vec![Block::Fields {
                fields: printed
                    .iter()
                    .map(|cell| Field {
                        default: false,
                        label: cell.column.clone(),
                        value: Shown::Text {
                            text: cell.value.clone(),
                        },
                    })
                    .collect(),
            }],
        ));
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

fn conditions(
    object: &Value,
    layout: &Layout,
    findings: bool,
    explained: &[&str],
) -> Option<Section> {
    let finished = !layout.follows.is_empty()
        && matches!(
            object["status"]["phase"].as_str(),
            Some("Succeeded" | "Failed")
        );
    let state = |kind: &str| STATES.contains(&kind) || (finished && layout.follows.contains(&kind));
    let conditions: Vec<Condition> = object["status"]["conditions"]
        .as_array()?
        .iter()
        .filter_map(|condition| {
            let kind = condition["type"].as_str()?.to_owned();
            let status = condition["status"].as_str().unwrap_or("Unknown").to_owned();
            let bad_when_true = match layout.good_when_true {
                Some(good) => !good(&kind),
                None => TRUE_IS_BAD.contains(&kind.as_str()),
            };
            let tone = match (status.as_str(), bad_when_true) {
                _ if state(&kind) => Tone::Neutral,
                ("True", false) | ("False", true) => Tone::Success,
                ("True", true) => Tone::Danger,
                ("Unknown", _) => layout.unknown,
                _ => Tone::Warning,
            };
            Some(Condition {
                explained: layout::wrong(tone).is_some()
                    && (explained.contains(&kind.as_str())
                        || (findings && layout.explains.contains(&kind.as_str()))),
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
    if conditions.is_empty() {
        return None;
    }
    let health: Vec<&Condition> = conditions
        .iter()
        .filter(|condition| condition.tone != Tone::Neutral)
        .collect();
    let ok = health
        .iter()
        .filter(|condition| condition.tone == Tone::Success)
        .count();
    let unexplained: Vec<&Condition> = conditions
        .iter()
        .filter(|condition| layout.unexplained(condition))
        .collect();
    let mut summary = Summary::default();
    if let [first, more @ ..] = unexplained.as_slice() {
        summary = summary.part(match more.len() {
            0 => format!("{} is {}", first.kind, first.status),
            others => format!("{} is {} and {others} more", first.kind, first.status),
        });
    }
    Some(Section {
        summary: if health.is_empty() {
            Vec::new()
        } else {
            summary.part(format!("{ok} of {} ok", health.len())).done()
        },
        ..section(
            "core.conditions",
            "Conditions",
            vec![Block::Conditions { conditions }],
        )
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
