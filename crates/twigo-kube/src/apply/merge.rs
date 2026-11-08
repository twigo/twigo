//! What is done with a configuration and an object: joining what Twigo owns
//! with what changed, taking paths out, and the merge patches that remove
//! what an apply cannot, or carry an edit an apply cannot express at all.

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::fields::{Element, Path};
use crate::openapi::{ListType, Node};

/// Lays `change` over `into`, as the server would merge the two.
pub(super) fn merge(into: &mut Value, change: Value, node: Option<Node<'_>>) {
    match (into, change) {
        (Value::Object(into), Value::Object(change)) if node.is_some_and(|n| !n.atomic_map()) => {
            for (name, value) in change {
                let field = node.and_then(|node| node.field(&name));
                match into.get_mut(&name) {
                    Some(existing) => merge(existing, value, field),
                    None => {
                        into.insert(name, value);
                    }
                }
            }
        }
        (Value::Array(into), Value::Array(change)) if node.is_some() => {
            let list = node.map_or(ListType::Atomic, |node| node.list());
            let items = node.and_then(|node| node.items());
            if list == ListType::Atomic {
                *into = change;
                return;
            }
            for item in change {
                let found = Element::of_item(&item, &list, items).and_then(|element| {
                    into.iter().position(|old| {
                        Element::of_item(old, &list, items) == Some(element.clone())
                    })
                });
                match found {
                    Some(index) => merge(&mut into[index], item, items),
                    None => into.push(item),
                }
            }
        }
        (into, change) => *into = change,
    }
}

fn is_empty_container(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// Takes `path` out of `value`, and says whether it was there. With `prune`,
/// a map or list the removal emptied and an element it left with only its
/// keys go too, so a claim on them does not stay behind.
pub(super) fn remove(value: &mut Value, path: &[Element], prune: bool) -> bool {
    let Some((first, rest)) = path.split_first() else {
        return false;
    };
    match first {
        Element::Field(name) => {
            let Value::Object(map) = value else {
                return false;
            };
            if rest.is_empty() {
                return map.remove(name).is_some();
            }
            let Some(child) = map.get_mut(name) else {
                return false;
            };
            let removed = remove(child, rest, prune);
            if removed && prune && is_empty_container(child) {
                map.remove(name);
            }
            removed
        }
        element => {
            let Value::Array(items) = value else {
                return false;
            };
            let Some(index) = items.iter().position(|item| element.matches(item)) else {
                return false;
            };
            if rest.is_empty() {
                items.remove(index);
                return true;
            }
            let removed = remove(&mut items[index], rest, prune);
            if removed && prune && !beyond_keys(&items[index], element) {
                items.remove(index);
            }
            removed
        }
    }
}

/// Takes the `dropped` paths out, each as the server named it in a conflict.
/// With `keys_only_goes`, an element left with nothing but its keys goes
/// too, since a change that is gone claims nothing.
pub(super) fn retain(
    value: &mut Value,
    node: Option<Node<'_>>,
    dropped: &HashSet<String>,
    keys_only_goes: bool,
    at: &mut Path,
) {
    match value {
        Value::Object(map) => {
            let names: Vec<String> = map.keys().cloned().collect();
            for name in names {
                at.push(Element::Field(name.clone()));
                if dropped.contains(&at.to_string()) {
                    map.remove(&name);
                } else if let Some(child) = map.get_mut(&name) {
                    let was_empty = is_empty_container(child);
                    let field = node.and_then(|node| node.field(&name));
                    retain(child, field, dropped, keys_only_goes, at);
                    if !was_empty && is_empty_container(child) {
                        map.remove(&name);
                    }
                }
                at.pop();
            }
        }
        Value::Array(items) => {
            let list = node.map_or(ListType::Atomic, |node| node.list());
            let of_items = node.and_then(|node| node.items());
            if list == ListType::Atomic {
                return;
            }
            items.retain_mut(|item| {
                let Some(element) = Element::of_item(item, &list, of_items) else {
                    return true;
                };
                at.push(element.clone());
                let mut keep = !dropped.contains(&at.to_string());
                if keep {
                    let had_more = beyond_keys(item, &element);
                    retain(item, of_items, dropped, keys_only_goes, at);
                    keep = !(keys_only_goes && had_more && !beyond_keys(item, &element));
                }
                at.pop();
                keep
            });
        }
        _ => {}
    }
}

/// Whether an item holds more than its keys; for a set's item, whose whole
/// is its key, always.
fn beyond_keys(item: &Value, element: &Element) -> bool {
    match (item, element) {
        (Value::Object(map), Element::Key(keys)) => map
            .keys()
            .any(|name| !keys.iter().any(|(key, _)| key == name)),
        _ => true,
    }
}

/// The value at a path of an object.
pub(super) fn value_at<'a>(value: &'a Value, path: &[Element]) -> Option<&'a Value> {
    let Some((first, rest)) = path.split_first() else {
        return Some(value);
    };
    let child = match first {
        Element::Field(name) => value.get(name)?,
        element => value
            .as_array()?
            .iter()
            .find(|item| element.matches(item))?,
    };
    value_at(child, rest)
}

/// Whether `object` still holds `path`.
pub fn still_has(object: &Value, path: &Path) -> bool {
    value_at(object, path.elements()).is_some()
}

/// `object` with the paths taken out.
pub fn without(object: &Value, paths: &[Path]) -> Value {
    let mut result = object.clone();
    for path in paths {
        remove(&mut result, path.elements(), false);
    }
    result
}

/// The JSON merge patch that removes `removals` from `object`: `null` at
/// the path, and for a path inside a list, which a merge patch cannot
/// address, the outermost list on its path whole, minus what goes. `None`
/// when `object` holds none of it.
pub fn merge_patch(object: &Value, removals: &[Path]) -> Option<Value> {
    let mut patch = Value::Object(Map::new());
    let mut lists: Vec<&[Element]> = Vec::new();
    let mut sent = false;
    for removal in removals {
        let elements = removal.elements();
        let Some(index) = elements
            .iter()
            .position(|element| !matches!(element, Element::Field(_)))
        else {
            if value_at(object, elements).is_some() {
                put(&mut patch, elements, Value::Null);
                sent = true;
            }
            continue;
        };
        let prefix = &elements[..index];
        if lists.contains(&prefix) {
            continue;
        }
        lists.push(prefix);
        let Some(mut list) = value_at(object, prefix).cloned() else {
            continue;
        };
        let mut changed = false;
        for other in removals {
            if other.elements().starts_with(prefix) {
                changed |= remove(&mut list, &other.elements()[index..], false);
            }
        }
        if changed {
            put(&mut patch, prefix, list);
            sent = true;
        }
    }
    sent.then_some(patch)
}

/// One JSON merge patch that carries `changed`, `removals` and the
/// `rewritten` lists together, as `kubectl edit` sends an edit: laid over
/// `object`, so that what it does not change stays as the server has it, and
/// made into a patch, in which a list that differs goes whole.
pub(super) fn combined(
    object: &Value,
    changed: Value,
    removals: &[Path],
    rewritten: &[(Path, Vec<Value>)],
    node: Option<Node<'_>>,
) -> Map<String, Value> {
    let mut after = object.clone();
    merge(&mut after, changed, node);
    for removal in removals {
        remove(&mut after, removal.elements(), false);
    }
    for (path, list) in rewritten {
        place(&mut after, path.elements(), Value::Array(list.clone()));
    }
    let (Value::Object(from), Value::Object(to)) = (object, &after) else {
        return Map::new();
    };
    difference(from, to)
}

/// The JSON merge patch that turns `from` into `to`.
fn difference(from: &Map<String, Value>, to: &Map<String, Value>) -> Map<String, Value> {
    let mut patch = Map::new();
    for name in from.keys().filter(|name| !to.contains_key(*name)) {
        patch.insert(name.clone(), Value::Null);
    }
    for (name, value) in to {
        match (from.get(name), value) {
            (Some(old), value) if old == value => {}
            (Some(Value::Object(old)), Value::Object(new)) => {
                patch.insert(name.clone(), Value::Object(difference(old, new)));
            }
            _ => {
                patch.insert(name.clone(), value.clone());
            }
        }
    }
    patch
}

/// Puts `new` at `path`, making what is missing on the way.
fn place(value: &mut Value, path: &[Element], new: Value) {
    let Some((first, rest)) = path.split_first() else {
        *value = new;
        return;
    };
    match first {
        Element::Field(name) => {
            let Value::Object(map) = value else {
                return;
            };
            let child = map
                .entry(name.clone())
                .or_insert_with(|| Value::Object(Map::new()));
            place(child, rest, new);
        }
        element => {
            let Value::Array(items) = value else {
                return;
            };
            match items.iter().position(|item| element.matches(item)) {
                Some(index) => place(&mut items[index], rest, new),
                None => {
                    let mut item = Value::Object(element.key_fields());
                    place(&mut item, rest, new);
                    items.push(item);
                }
            }
        }
    }
}

/// Sets a path of fields in `patch`, making the maps on the way.
fn put(patch: &mut Value, path: &[Element], value: Value) {
    let Some((first, rest)) = path.split_first() else {
        return;
    };
    let Element::Field(name) = first else {
        return;
    };
    let map = patch.as_object_mut().expect("a patch is a map");
    if rest.is_empty() {
        map.insert(name.clone(), value);
    } else {
        let child = map
            .entry(name.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        put(child, rest, value);
    }
}
