//! The metadata section every object gets.

use serde_json::Value;
use twigo_ipc::{Block, Field, Label, ObjectRef, Section, Value as Shown};

use crate::{group_version, text};

/// Holds the whole object again, a Secret's values in clear among them, so
/// no view shows it (ARCHITECTURE 3.6).
const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

pub(crate) fn section(object: &Value) -> Section {
    let metadata = &object["metadata"];
    let namespace = text(&metadata["namespace"]);
    let mut fields = Vec::new();
    let mut add = |label: &str, value: Shown| {
        fields.push(Field {
            label: label.to_owned(),
            value,
        });
    };
    add(
        "Name",
        Shown::Text {
            text: text(&metadata["name"]).unwrap_or_default(),
        },
    );
    if let Some(namespace) = &namespace {
        add(
            "Namespace",
            Shown::Link {
                target: ObjectRef {
                    group: String::new(),
                    version: "v1".to_owned(),
                    kind: "Namespace".to_owned(),
                    namespace: None,
                    name: namespace.clone(),
                },
                text: namespace.clone(),
            },
        );
    }
    if let Some(at) = text(&metadata["creationTimestamp"]) {
        add("Created", Shown::Time { at });
    }
    if let Some(at) = text(&metadata["deletionTimestamp"]) {
        add("Deleting since", Shown::Time { at });
        if let Some(seconds) = metadata["deletionGracePeriodSeconds"].as_u64() {
            add(
                "Grace period",
                Shown::Text {
                    text: format!("{seconds} s"),
                },
            );
        }
    }
    let (controllers, others) = owners(metadata, namespace.as_deref());
    if !controllers.is_empty() {
        add("Controlled by", list(controllers));
    }
    if !others.is_empty() {
        add("Owners", list(others));
    }
    let labels = labels(&metadata["labels"], &[]);
    if !labels.is_empty() {
        add("Labels", Shown::Labels { labels });
    }
    let annotations = labels_of(&metadata["annotations"]);
    if !annotations.is_empty() {
        add(
            "Annotations",
            Shown::Labels {
                labels: annotations,
            },
        );
    }
    if let Some(finalizers) = metadata["finalizers"].as_array().filter(|f| !f.is_empty()) {
        add(
            "Finalizers",
            list(
                finalizers
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|text| Shown::Text {
                        text: text.to_owned(),
                    })
                    .collect(),
            ),
        );
    }
    let managers = managers(metadata);
    if !managers.is_empty() {
        add("Managed by", list(managers));
    }
    if let Some(uid) = text(&metadata["uid"]) {
        add("UID", Shown::Text { text: uid });
    }
    Section {
        id: "core.metadata".to_owned(),
        title: "Metadata".to_owned(),
        blocks: vec![Block::Fields { fields }],
    }
}

fn list(items: Vec<Shown>) -> Shown {
    match <[Shown; 1]>::try_from(items) {
        Ok([item]) => item,
        Err(items) => Shown::List { items },
    }
}

fn labels_of(annotations: &Value) -> Vec<Label> {
    labels(annotations, &[LAST_APPLIED])
}

/// Sorted by key, `skip` left out.
fn labels(map: &Value, skip: &[&str]) -> Vec<Label> {
    let mut labels: Vec<Label> = map
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| !skip.contains(&key.as_str()))
        .map(|(key, value)| Label {
            key: key.clone(),
            value: value.as_str().unwrap_or_default().to_owned(),
        })
        .collect();
    labels.sort_by(|a, b| a.key.cmp(&b.key));
    labels
}

/// Links to the owners that control the object, and to the others.
fn owners(metadata: &Value, namespace: Option<&str>) -> (Vec<Shown>, Vec<Shown>) {
    let mut controllers = Vec::new();
    let mut others = Vec::new();
    for owner in metadata["ownerReferences"].as_array().into_iter().flatten() {
        let (Some(kind), Some(name)) = (text(&owner["kind"]), text(&owner["name"])) else {
            continue;
        };
        let (group, version) = group_version(owner);
        let link = Shown::Link {
            target: ObjectRef {
                group: group.to_owned(),
                version: version.to_owned(),
                kind: kind.clone(),
                namespace: namespace.map(str::to_owned),
                name: name.clone(),
            },
            text: format!("{kind}/{name}"),
        };
        if owner["controller"].as_bool() == Some(true) {
            controllers.push(link);
        } else {
            others.push(link);
        }
    }
    (controllers, others)
}

/// The field managers, each once, in the order the server lists them.
fn managers(metadata: &Value) -> Vec<Shown> {
    let mut names: Vec<String> = Vec::new();
    for entry in metadata["managedFields"].as_array().into_iter().flatten() {
        if let Some(manager) = text(&entry["manager"])
            && !names.contains(&manager)
        {
            names.push(manager);
        }
    }
    names.into_iter().map(|text| Shown::Text { text }).collect()
}
