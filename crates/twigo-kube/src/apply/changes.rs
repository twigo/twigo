//! What a person changed: the fields of an edit that differ from what the
//! object was opened as, walked with the [`Node`] of each place so that each
//! is taken as the server merges it, and what is gone from the edit.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::fields::{Element, Path};
use crate::openapi::{ListType, Node};

/// What the walk found besides the fields that changed.
#[derive(Debug, Default)]
pub(super) struct Found {
    /// What was in the object and is gone from the edit.
    pub removals: Vec<Path>,
    /// Lists an apply cannot express, each as the edit left it: one whose
    /// elements changed order, or whose duplicated key is touched.
    pub rewritten: Vec<(Path, Vec<Value>)>,
    /// Whether the edit leaves empty a map or a list the object held filled,
    /// which no apply can say: an empty list claims nothing ([`doList`]), and
    /// a map a prune emptied is left null ([`removingWalker`]). An atomic one
    /// is a value like any other.
    ///
    /// [`doList`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/tofieldset.go#L132-L147
    /// [`removingWalker`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/remove.go#L171-L173
    pub emptied: bool,
    /// Arrays and objects that go out as the edit left them, numbers the
    /// webview rounded included; a bare scalar is what the person typed.
    pub whole: Vec<Path>,
}

impl Found {
    fn sent_whole(&mut self, at: &Path, value: &Value) {
        if value.is_array() || value.is_object() {
            self.whole.push(at.clone());
        }
    }
}

/// The changes between two maps; a key in `skip` is a list map's key, which
/// identifies the element and is never a change.
pub(super) fn of_map(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    node: Option<Node<'_>>,
    skip: &[String],
    at: &mut Path,
    found: &mut Found,
) -> Map<String, Value> {
    let mut changes = Map::new();
    for (name, edited) in after {
        if skip.contains(name) {
            continue;
        }
        at.push(Element::Field(name.clone()));
        match before.get(name) {
            None => {
                found.sent_whole(at, edited);
                changes.insert(name.clone(), edited.clone());
            }
            Some(value) => {
                let field = node.and_then(|node| node.field(name));
                if let Some(change) = of_value(value, edited, field, at, found) {
                    changes.insert(name.clone(), change);
                }
            }
        }
        at.pop();
    }
    for name in before.keys() {
        if !skip.contains(name) && !after.contains_key(name) {
            found.removals.push(at.with(Element::Field(name.clone())));
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
    found: &mut Found,
) -> Option<Value> {
    if before == after {
        return None;
    }
    match (before, after, node) {
        (Value::Object(before), Value::Object(after), Some(node)) if !node.atomic_map() => {
            found.emptied |= after.is_empty();
            let changes = of_map(before, after, Some(node), &[], at, found);
            (!changes.is_empty()).then_some(Value::Object(changes))
        }
        (Value::Array(before), Value::Array(after), Some(node)) => {
            let list = node.list();
            found.emptied |= after.is_empty() && list != ListType::Atomic;
            match list {
                ListType::Atomic => {
                    found.whole.push(at.clone());
                    Some(Value::Array(after.clone()))
                }
                ListType::Set => of_set(before, after, at, found),
                ListType::Map { keys } => of_list_map(before, after, &keys, node, at, found),
            }
        }
        _ => {
            found.sent_whole(at, after);
            Some(after.clone())
        }
    }
}

/// Whether what stayed changed order, or something new stands before what
/// stayed: an apply could say so only by naming, and so owning, more of the
/// list than the person changed.
fn moved<T: PartialEq>(was: &[T], now: &[T]) -> bool {
    let stayed_was = was.iter().filter(|item| now.contains(item));
    let stayed_now = now.iter().filter(|item| was.contains(item));
    let last_stayed = now.iter().rposition(|item| was.contains(item));
    !stayed_was.eq(stayed_now)
        || last_stayed.is_some_and(|last| now[..last].iter().any(|item| !was.contains(item)))
}

/// What a set gained; what it lost is removed by value. A set whose values
/// moved is left to a merge patch, as a list map is.
fn of_set(before: &[Value], after: &[Value], at: &Path, found: &mut Found) -> Option<Value> {
    if moved(before, after) {
        found.rewritten.push((at.clone(), after.to_vec()));
        return None;
    }
    let element =
        |item: &Value| Element::of_item(item, &ListType::Set, None).expect("sets name their items");
    for item in before {
        if !after.contains(item) {
            found.removals.push(at.with(element(item)));
        }
    }
    let added: Vec<Value> = after
        .iter()
        .filter(|item| !before.contains(item))
        .cloned()
        .collect();
    for item in &added {
        found.sent_whole(at, item);
    }
    (!added.is_empty()).then_some(Value::Array(added))
}

/// An element by its key and which of the elements of that key it is, as the
/// server allows the same key twice in what it stores (`env`, `ports`).
type Occurrence = (Element, usize);

fn occurrences(
    list: &[Value],
    keys: &ListType,
    items: Option<Node<'_>>,
) -> Vec<Option<Occurrence>> {
    let mut counted: HashMap<Element, usize> = HashMap::new();
    list.iter()
        .map(|item| {
            let element = Element::of_item(item, keys, items)?;
            let count = counted.entry(element.clone()).or_default();
            *count += 1;
            Some((element, *count - 1))
        })
        .collect()
}

/// A list map's changes, its elements paired by key and occurrence: a pair
/// carries its keys and its changes, a new element goes whole, and one gone
/// is removed by its keys. An element whose items are atomic is taken whole,
/// keys included, as the server takes an atomic map ([`doMap`]). An apply
/// cannot address one of two elements with a key, and an edit that moves
/// elements names more of the list than the person changed, so a list whose
/// elements moved or whose duplicated key is touched, by the edit too, is
/// left to a merge patch; a duplicate nobody touched sends nothing, as an
/// apply that names its key replaces every element of it ([`visitListItems`]).
///
/// [`doMap`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/merge.go#L415
///
/// [`visitListItems`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/merge.go#L168-L283
fn of_list_map(
    before: &[Value],
    after: &[Value],
    keys: &[String],
    node: Node<'_>,
    at: &mut Path,
    found: &mut Found,
) -> Option<Value> {
    let list = ListType::Map {
        keys: keys.to_vec(),
    };
    let items = node.items();
    let was = occurrences(before, &list, items);
    let now = occurrences(after, &list, items);
    let old: HashMap<&Occurrence, &Value> = was
        .iter()
        .zip(before)
        .filter_map(|(occurrence, item)| Some((occurrence.as_ref()?, item)))
        .collect();
    let new: HashMap<&Occurrence, &Value> = now
        .iter()
        .zip(after)
        .filter_map(|(occurrence, item)| Some((occurrence.as_ref()?, item)))
        .collect();
    let duplicated: HashSet<&Element> = was
        .iter()
        .chain(&now)
        .flatten()
        .filter(|(_, count)| *count > 0)
        .map(|(element, _)| element)
        .collect();

    let named = |list: &[Option<Occurrence>]| list.iter().flatten().cloned().collect::<Vec<_>>();
    let duplicate_touched = was
        .iter()
        .chain(&now)
        .flatten()
        .filter(|occurrence| duplicated.contains(&occurrence.0))
        .any(|occurrence| old.get(occurrence) != new.get(occurrence));
    if moved(&named(&was), &named(&now)) || duplicate_touched {
        found.rewritten.push((at.clone(), after.to_vec()));
        return None;
    }

    let mut changes = Vec::new();
    for (item, occurrence) in after.iter().zip(&now) {
        let Some(occurrence) = occurrence else {
            found.sent_whole(at, item);
            changes.push(item.clone());
            continue;
        };
        if duplicated.contains(&occurrence.0) {
            continue;
        }
        match (old.get(occurrence), item) {
            (Some(old_item), item) if items.is_some_and(|items| items.atomic_map()) => {
                if *old_item != item {
                    found.sent_whole(&at.with(occurrence.0.clone()), item);
                    changes.push(item.clone());
                }
            }
            (Some(Value::Object(old_item)), Value::Object(new_item)) => {
                at.push(occurrence.0.clone());
                let changed = of_map(old_item, new_item, items, keys, at, found);
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
            _ => {
                found.sent_whole(&at.with(occurrence.0.clone()), item);
                changes.push(item.clone());
            }
        }
    }
    for occurrence in was.iter().flatten() {
        if !new.contains_key(occurrence) {
            found.removals.push(at.with(occurrence.0.clone()));
        }
    }
    (!changes.is_empty()).then_some(Value::Array(changes))
}
