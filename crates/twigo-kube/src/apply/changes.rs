//! What a person changed: the fields of an edit that differ from what the
//! object was opened as, walked with the [`Node`] of each place so that each
//! is taken as the server merges it, and what is gone from the edit.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::fields::{Element, Path};
use crate::openapi::{ListType, Node};

/// The changes between two maps; a key in `skip` is a list map's key, which
/// identifies the element and is never a change. An explicit null reads as
/// absent, as a YAML key left empty.
pub(super) fn of_map(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    node: Option<Node<'_>>,
    skip: &[String],
    at: &mut Path,
    removals: &mut Vec<Path>,
) -> Map<String, Value> {
    let mut changes = Map::new();
    for (name, edited) in after {
        if skip.contains(name) || edited.is_null() {
            continue;
        }
        at.push(Element::Field(name.clone()));
        match before.get(name).filter(|value| !value.is_null()) {
            None => {
                changes.insert(name.clone(), edited.clone());
            }
            Some(value) => {
                let field = node.and_then(|node| node.field(name));
                if let Some(change) = of_value(value, edited, field, at, removals) {
                    changes.insert(name.clone(), change);
                }
            }
        }
        at.pop();
    }
    for (name, value) in before {
        if !skip.contains(name) && !value.is_null() && after.get(name).is_none_or(Value::is_null) {
            removals.push(at.with(Element::Field(name.clone())));
        }
    }
    changes
}

/// The change at one place, or `None` when there is none. A place the
/// schema does not know is taken as it stands.
fn of_value(
    before: &Value,
    after: &Value,
    node: Option<Node<'_>>,
    at: &mut Path,
    removals: &mut Vec<Path>,
) -> Option<Value> {
    if before == after {
        return None;
    }
    match (before, after, node) {
        (Value::Object(before), Value::Object(after), Some(node)) if !node.atomic_map() => {
            let changes = of_map(before, after, Some(node), &[], at, removals);
            (!changes.is_empty()).then_some(Value::Object(changes))
        }
        (Value::Array(before), Value::Array(after), Some(node)) => match node.list() {
            ListType::Atomic => Some(Value::Array(after.clone())),
            ListType::Set => of_set(before, after, at, removals),
            ListType::Map { keys } => of_list_map(before, after, &keys, node, at, removals),
        },
        _ => Some(after.clone()),
    }
}

/// What a set gained; what it lost is removed by value.
fn of_set(before: &[Value], after: &[Value], at: &Path, removals: &mut Vec<Path>) -> Option<Value> {
    let element =
        |item: &Value| Element::of_item(item, &ListType::Set, None).expect("sets name their items");
    for item in before {
        if !after.contains(item) {
            removals.push(at.with(element(item)));
        }
    }
    let added: Vec<Value> = after
        .iter()
        .filter(|item| !before.contains(item))
        .cloned()
        .collect();
    (!added.is_empty()).then_some(Value::Array(added))
}

/// A list map's changes: an element paired by its keys carries them and its
/// changes, a new one goes whole, and one gone is removed by its keys.
fn of_list_map(
    before: &[Value],
    after: &[Value],
    keys: &[String],
    node: Node<'_>,
    at: &mut Path,
    removals: &mut Vec<Path>,
) -> Option<Value> {
    let list = ListType::Map {
        keys: keys.to_vec(),
    };
    let items = node.items();
    let element = |item: &Value| Element::of_item(item, &list, items);
    let mut old: HashMap<Element, &Value> = HashMap::new();
    for item in before {
        if let Some(found) = element(item) {
            old.entry(found).or_insert(item);
        }
    }
    let mut seen = Vec::new();
    let mut changes = Vec::new();
    for item in after {
        let Some(found) = element(item) else {
            changes.push(item.clone());
            continue;
        };
        seen.push(found.clone());
        match (old.get(&found), item) {
            (Some(Value::Object(old_item)), Value::Object(new_item)) => {
                at.push(found);
                let changed = of_map(old_item, new_item, items, keys, at, removals);
                at.pop();
                if !changed.is_empty() {
                    let mut carried: Map<String, Value> = keys
                        .iter()
                        .filter_map(|key| Some((key.clone(), new_item.get(key)?.clone())))
                        .collect();
                    carried.extend(changed);
                    changes.push(Value::Object(carried));
                }
            }
            _ => changes.push(item.clone()),
        }
    }
    for item in before {
        if let Some(found) = element(item)
            && !seen.contains(&found)
        {
            removals.push(at.with(found));
        }
    }
    (!changes.is_empty()).then_some(Value::Array(changes))
}
