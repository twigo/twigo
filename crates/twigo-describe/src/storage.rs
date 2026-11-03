//! PersistentVolumeClaims: what kubectl describe prints of them (kubectl
//! v1.37.1, `describePersistentVolumeClaim`), the pods that use them read
//! as kubectl's `getPodsForPVC` finds them.

use serde_json::Value;
use twigo_ipc::{Block, Finding, Section, Span, Tone, Value as Shown};

use crate::show::{Fields, POD, PV, link, list, plain, toned};
use crate::workloads::fact;
use crate::{Described, Found, Input, Need, text};

/// What the volume controller says while a claim of a WaitForFirstConsumer
/// class waits, rightly, for its pod (kubernetes v1.37.1
/// `pkg/controller/volume/events`); any other reason leaves it unbound.
const WAITING: &[&str] = &["WaitForFirstConsumer", "WaitForPodScheduled"];

fn pods_need(claim: &Value) -> Need {
    Need {
        group: String::new(),
        version: "v1".to_owned(),
        resource: "pods".to_owned(),
        namespaced: true,
        namespace: text(&claim["metadata"]["namespace"]),
        field_selector: None,
    }
}

pub(crate) fn needs(claim: &Value) -> Vec<Need> {
    vec![pods_need(claim)]
}

pub(crate) fn describe(input: &Input<'_>) -> Described {
    let claim = input.object;
    let spec = &claim["spec"];
    let status = &claim["status"];
    let namespace = text(&claim["metadata"]["namespace"]);
    let phase = status["phase"].as_str().unwrap_or_default();
    let mut fields = Fields::default();
    fields.add(
        "Status",
        if phase == "Bound" {
            plain(phase)
        } else {
            toned(phase, Tone::Warning)
        },
    );
    fields.maybe(
        "Volume",
        text(&spec["volumeName"]).map(|volume| link(PV, None, &volume, volume.clone())),
    );
    fields.maybe(
        "Storage class",
        text(&spec["storageClassName"]).map(|class| {
            link(
                ("storage.k8s.io", "v1", "StorageClass"),
                None,
                &class,
                class.clone(),
            )
        }),
    );
    fields.text("Requested", &spec["resources"]["requests"]["storage"]);
    if text(&spec["volumeName"]).is_some() {
        fields.text("Capacity", &status["capacity"]["storage"]);
        fields.maybe("Access modes", modes(&status["accessModes"]).map(plain));
    } else {
        fields.maybe("Access modes", modes(&spec["accessModes"]).map(plain));
    }
    fields.text("Volume mode", &spec["volumeMode"]);
    fields.maybe(
        "Volume attributes class",
        text(&spec["volumeAttributesClassName"]).map(|class| {
            link(
                ("storage.k8s.io", "v1", "VolumeAttributesClass"),
                None,
                &class,
                class.clone(),
            )
        }),
    );
    for (label, key) in [
        ("Data source", "dataSource"),
        ("Data source ref", "dataSourceRef"),
    ] {
        let source = &spec[key];
        if let (Some(kind), Some(name)) = (text(&source["kind"]), text(&source["name"])) {
            let group = text(&source["apiGroup"]).unwrap_or_default();
            let version = if group.is_empty() { "v1" } else { "" };
            fields.add(
                label,
                link(
                    (&group, version, &kind),
                    namespace.as_deref(),
                    &name,
                    format!("{kind} {name}"),
                ),
            );
        }
    }
    match fact(input.facts, &pods_need(claim)) {
        Some(Found::Listed { objects }) => {
            let used: Vec<Shown> = users(claim, objects)
                .into_iter()
                .map(|pod| {
                    let name = pod["metadata"]["name"].as_str().unwrap_or_default();
                    link(POD, namespace.as_deref(), name, name)
                })
                .collect();
            fields.add("Used by", list(used).unwrap_or_else(|| plain("no pod")));
        }
        Some(Found::Unavailable { message }) => {
            fields.add("Used by", plain(message.clone()));
        }
        None => {}
    }
    let mut findings = Vec::new();
    let newest = input.events.events.first();
    let waits = newest.is_some_and(|event| WAITING.contains(&event.reason.as_str()));
    if phase == "Pending" && !waits {
        findings.push(Finding {
            tone: Tone::Warning,
            title: "The claim is not bound".to_owned(),
            detail: vec![Span::Text {
                text: newest.map_or_else(
                    || "No volume backs it, and nothing says why.".to_owned(),
                    |event| format!("{}.", event.reason),
                ),
            }],
            message: newest.map(|event| event.message.trim().to_owned()),
        });
    }
    if phase == "Lost" {
        findings.push(Finding {
            tone: Tone::Danger,
            title: "The claim lost its volume".to_owned(),
            detail: vec![Span::Text {
                text: "The volume it was bound to no longer exists.".to_owned(),
            }],
            message: None,
        });
    }
    Described {
        findings,
        sections: vec![Section {
            id: "core.claim".to_owned(),
            title: "Claim".to_owned(),
            blocks: vec![Block::Fields { fields: fields.0 }],
        }],
    }
}

fn modes(modes: &Value) -> Option<String> {
    let modes: Vec<&str> = modes.as_array()?.iter().filter_map(Value::as_str).collect();
    (!modes.is_empty()).then(|| modes.join(","))
}

/// The pods that mount the claim, then the pod that owns it, as an
/// ephemeral volume's claim is owned, once each.
fn users<'a>(claim: &Value, pods: &'a [Value]) -> Vec<&'a Value> {
    let name = &claim["metadata"]["name"];
    let mut users: Vec<&Value> = pods
        .iter()
        .filter(|pod| {
            pod["spec"]["volumes"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|volume| volume["persistentVolumeClaim"]["claimName"] == *name)
        })
        .collect();
    for owner in claim["metadata"]["ownerReferences"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if owner["kind"] != "Pod" {
            continue;
        }
        if let Some(pod) = pods
            .iter()
            .find(|pod| pod["metadata"]["uid"] == owner["uid"])
            && !users.iter().any(|user| std::ptr::eq(*user, pod))
        {
            users.push(pod);
        }
    }
    users
}
