//! What managedFields say of an object: who owns what, and what Twigo's own
//! entry covers of the live object, as [`ExtractInto`] extracts it.
//!
//! [`ExtractInto`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/util/managedfields/extract.go#L52-L88

use serde_json::{Map, Value, json};

use super::FIELD_MANAGER;
use super::fields::{Element, FieldSet, Path};
use crate::openapi::{ListType, Node};

/// One manager's entry, at the apiVersion it was written with.
#[derive(Debug, Clone)]
pub(super) struct Entry {
    pub api_version: String,
    pub fields: FieldSet,
}

/// The owners of an object's fields: Twigo's Apply entry, which an apply
/// replaces, and every other entry, a subresource's and Twigo's own Update
/// among them.
#[derive(Debug, Clone, Default)]
pub(super) struct Ownership {
    pub ours: Option<Entry>,
    pub others: Vec<Entry>,
}

impl Ownership {
    pub fn of(object: &Value) -> Self {
        let mut ownership = Self::default();
        let entries = object["metadata"]["managedFields"].as_array();
        for entry in entries.into_iter().flatten() {
            let parsed = Entry {
                api_version: entry["apiVersion"].as_str().unwrap_or_default().to_owned(),
                fields: FieldSet::parse(&entry["fieldsV1"]),
            };
            let ours = entry["manager"] == FIELD_MANAGER
                && entry["operation"] == "Apply"
                && entry["subresource"].as_str().unwrap_or_default().is_empty();
            if ours {
                ownership.ours = Some(parsed);
            } else {
                ownership.others.push(parsed);
            }
        }
        ownership
    }

    /// Whether Twigo's Apply entry is the only owner of the path.
    pub fn only_ours(&self, path: &Path) -> bool {
        let elements = path.elements();
        self.ours
            .as_ref()
            .is_some_and(|ours| ours.fields.contains(elements))
            && self
                .others
                .iter()
                .all(|other| !other.fields.contains(elements))
    }

    /// Whether every entry is at `api_version`, so that the paths compare.
    pub fn at_version(&self, api_version: &str) -> bool {
        self.ours
            .iter()
            .chain(&self.others)
            .all(|entry| entry.api_version == api_version)
    }
}

/// What `fields` covers of `value`; `None` when nothing is left of it.
/// Takes [`removeItemsWithSchema`]'s path with one exception: an element
/// owned with none of its fields gives its keys alone, as its other fields
/// are not Twigo's, where the walker extracts it whole.
///
/// [`removeItemsWithSchema`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/remove.go#L36-L46
pub(super) fn extract(value: &Value, fields: &FieldSet, node: Option<Node<'_>>) -> Option<Value> {
    match value {
        Value::Object(map) => {
            let taken = extract_map(map, fields, node);
            (!taken.is_empty()).then_some(Value::Object(taken))
        }
        Value::Array(items) => {
            let list = node.map_or(ListType::Atomic, |node| node.list());
            let of_items = node.and_then(|node| node.items());
            let mut taken = Vec::new();
            for item in items {
                let Some(element) = Element::of_item(item, &list, of_items) else {
                    continue;
                };
                if let Some(child) = fields.children.get(&element) {
                    let Value::Object(map) = item else { continue };
                    let mut picked = extract_map(map, child, of_items);
                    picked.extend(element.key_fields());
                    taken.push(Value::Object(picked));
                } else if fields.members.contains(&element) {
                    taken.push(match &element {
                        Element::Key(_) => Value::Object(element.key_fields()),
                        _ => item.clone(),
                    });
                }
            }
            (!taken.is_empty()).then_some(Value::Array(taken))
        }
        _ => None,
    }
}

fn extract_map(
    map: &Map<String, Value>,
    fields: &FieldSet,
    node: Option<Node<'_>>,
) -> Map<String, Value> {
    let mut taken = Map::new();
    for (name, value) in map {
        let element = Element::Field(name.clone());
        let field = node.and_then(|node| node.field(name));
        if let Some(child) = fields.children.get(&element) {
            if let Some(picked) = extract(value, child, field) {
                taken.insert(name.clone(), picked);
            }
        } else if fields.members.contains(&element) {
            taken.insert(name.clone(), leaf(value, field));
        }
    }
    taken
}

/// A path owned without its children: an atomic value whole, and for a
/// granular map or list that others have since filled only the claim on
/// it, as what is in it is not Twigo's.
fn leaf(value: &Value, node: Option<Node<'_>>) -> Value {
    match value {
        Value::Object(map) if !map.is_empty() && node.is_some_and(|node| !node.atomic_map()) => {
            json!({})
        }
        Value::Array(items)
            if !items.is_empty() && node.is_some_and(|node| node.list() != ListType::Atomic) =>
        {
            json!([])
        }
        _ => value.clone(),
    }
}

/// The paths of `fields` that `value` does not hold.
pub(super) fn missing(value: &Value, fields: &FieldSet, at: &mut Path, found: &mut Vec<Path>) {
    for element in &fields.members {
        if !fields.children.contains_key(element) && child_of(value, element).is_none() {
            found.push(at.with(element.clone()));
        }
    }
    for (element, child) in &fields.children {
        match child_of(value, element) {
            Some(value) => {
                at.push(element.clone());
                missing(value, child, at, found);
                at.pop();
            }
            None => found.push(at.with(element.clone())),
        }
    }
}

fn child_of<'a>(value: &'a Value, element: &Element) -> Option<&'a Value> {
    match element {
        Element::Field(name) => value.get(name),
        _ => value.as_array()?.iter().find(|item| element.matches(item)),
    }
}
