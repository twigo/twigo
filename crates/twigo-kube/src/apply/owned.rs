//! What managedFields say of an object: who owns what, and what Twigo's own
//! entry covers of the live object, as [`ExtractInto`] extracts it.
//!
//! [`ExtractInto`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/util/managedfields/extract.go#L52-L88

use std::collections::HashMap;

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

    /// Whether another manager holds the path, as a member or by anything
    /// under it: the path then stays after an apply that leaves it out.
    pub fn others_hold(&self, path: &Path) -> bool {
        self.others
            .iter()
            .any(|other| other.fields.holds(path.elements()))
    }

    /// Whether another manager's hold keeps what Twigo stops naming on the
    /// server: its member, or anything under it when the path is a field the
    /// schema declares.
    pub fn others_keep(&self, path: &Path, declared: bool) -> bool {
        if declared {
            return self.others_hold(path);
        }
        self.others
            .iter()
            .any(|other| other.fields.contains(path.elements()))
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
/// Takes [`removeItemsWithSchema`]'s path with two exceptions: an element
/// owned with none of its fields gives its keys alone, as its other fields
/// are not Twigo's, where the walker extracts it whole; and an element of a
/// key the live object duplicates is left out, as naming that key replaces
/// every element of it and an apply refuses it twice ([`visitListItems`]).
/// Nothing is lost by leaving it out: whoever wrote the duplicate holds the
/// key, and that write took it from every other manager ([`Updater::update`]).
///
/// [`removeItemsWithSchema`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/remove.go#L36-L46
/// [`visitListItems`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/merge.go#L285-L316
/// [`Updater::update`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/merge/update.go#L131-L151
pub(super) fn extract(value: &Value, fields: &FieldSet, node: Option<Node<'_>>) -> Option<Value> {
    match value {
        Value::Object(map) => {
            let taken = extract_map(map, fields, node);
            (!taken.is_empty()).then_some(Value::Object(taken))
        }
        Value::Array(items) => {
            let list = node.map_or(ListType::Atomic, |node| node.list());
            let of_items = node.and_then(|node| node.items());
            let elements: Vec<Option<Element>> = items
                .iter()
                .map(|item| Element::of_item(item, &list, of_items))
                .collect();
            let mut counted: HashMap<&Element, usize> = HashMap::new();
            for element in elements.iter().flatten() {
                *counted.entry(element).or_default() += 1;
            }
            let mut taken = Vec::new();
            for (item, element) in items.iter().zip(&elements) {
                let Some(element) = element.as_ref().filter(|element| counted[*element] == 1)
                else {
                    continue;
                };
                let child = fields.children.get(element);
                if child.is_none() && !fields.members.contains(element) {
                    continue;
                }
                if is_whole(item, of_items) {
                    taken.push(item.clone());
                    continue;
                }
                let Some(child) = child else {
                    taken.push(Value::Object(element.key_fields()));
                    continue;
                };
                let Value::Object(map) = item else { continue };
                let mut picked = extract_map(map, child, of_items);
                picked.extend(element.key_fields());
                taken.push(Value::Object(picked));
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
        let child = fields.children.get(&element);
        if child.is_none() && !fields.members.contains(&element) {
            continue;
        }
        if is_whole(value, field) {
            taken.insert(name.clone(), value.clone());
            continue;
        }
        let picked = match child {
            Some(child) => extract(value, child, field),
            None => Some(claim(value)),
        };
        if let Some(picked) = picked {
            taken.insert(name.clone(), picked);
        }
    }
    taken
}

/// Whether the schema takes this value as one, so that it is extracted
/// whole, whatever the set names under it, as [`removeItemsWithSchema`]
/// does: a field that was granular when Twigo applied it and is atomic now
/// names its old parts. A value the schema does not know counts too.
///
/// [`removeItemsWithSchema`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/remove.go#L70-L75
fn is_whole(value: &Value, node: Option<Node<'_>>) -> bool {
    match value {
        Value::Object(_) => node.is_none_or(|node| node.atomic_map()),
        Value::Array(_) => node.is_none_or(|node| node.list() == ListType::Atomic),
        _ => true,
    }
}

/// A granular map or list owned without its children: only the claim on it,
/// as what others have since filled in it is not Twigo's.
fn claim(value: &Value) -> Value {
    if value.is_object() {
        json!({})
    } else {
        json!([])
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
