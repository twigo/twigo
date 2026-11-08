//! Field paths as the server names them, and the `FieldsV1` sets of a
//! manager's entry in managedFields.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde_json::{Map, Value};

use crate::openapi::{ListType, Node};

/// One step of a path.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Element {
    Field(String),
    /// An element of a list map, by its keys sorted by name, each value as
    /// its JSON text.
    Key(Vec<(String, String)>),
    /// An element of a set, as its JSON text.
    Value(String),
}

/// The JSON text of a value, which is what compares equal.
fn text(value: &Value) -> String {
    serde_json::to_string(value).expect("JSON serializes")
}

impl Element {
    /// A `FieldsV1` key: `f:name`, `k:{"name":"web"}`, `v:"finalizer"`;
    /// `None` for the kinds [`DeserializePathElement`] takes that no
    /// structured field ever is, and for what no version knows.
    ///
    /// [`DeserializePathElement`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/fieldpath/serialize-pe.go#L76
    fn parse(key: &str) -> Option<Self> {
        let (kind, rest) = key.split_once(':')?;
        match kind {
            "f" => Some(Self::Field(rest.to_owned())),
            "v" => Some(Self::Value(text(&serde_json::from_str(rest).ok()?))),
            "k" => {
                let fields: Map<String, Value> = serde_json::from_str(rest).ok()?;
                Some(Self::Key(
                    fields
                        .iter()
                        .map(|(name, value)| (name.clone(), text(value)))
                        .collect(),
                ))
            }
            _ => None,
        }
    }

    /// An item of a list of type `list`, as the server identifies it: a
    /// missing key reads as the field's default, and a key neither given
    /// nor defaulted stays out ([`keyedAssociativeListItemToPathElement`]).
    /// `None` for an atomic list, and for an item with no key at all, which
    /// the server refuses.
    ///
    /// [`keyedAssociativeListItemToPathElement`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/helpers.go#L200-L233
    pub(super) fn of_item(item: &Value, list: &ListType, items: Option<Node<'_>>) -> Option<Self> {
        match list {
            ListType::Atomic => None,
            ListType::Set => Some(Self::Value(text(item))),
            ListType::Map { keys } => {
                let mut fields: Vec<(String, String)> = keys
                    .iter()
                    .filter_map(|key| {
                        let value =
                            item.get(key).filter(|value| !value.is_null()).or_else(|| {
                                items
                                    .and_then(|items| items.field(key))
                                    .and_then(|field| field.default())
                            })?;
                        Some((key.clone(), text(value)))
                    })
                    .collect();
                fields.sort();
                (!fields.is_empty()).then_some(Self::Key(fields))
            }
        }
    }

    /// Whether this names `item` of a list.
    pub(super) fn matches(&self, item: &Value) -> bool {
        match self {
            Self::Field(_) => false,
            Self::Value(value) => text(item) == *value,
            Self::Key(fields) => fields
                .iter()
                .all(|(name, value)| item.get(name).is_some_and(|field| text(field) == *value)),
        }
    }

    /// The fields of a key, as JSON.
    pub(super) fn key_fields(&self) -> Map<String, Value> {
        let Self::Key(fields) = self else {
            return Map::new();
        };
        fields
            .iter()
            .map(|(name, value)| {
                (
                    name.clone(),
                    serde_json::from_str(value).expect("a key's text is JSON"),
                )
            })
            .collect()
    }
}

impl fmt::Display for Element {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Field(name) => write!(formatter, ".{name}"),
            Self::Value(value) => write!(formatter, "[={value}]"),
            Self::Key(fields) => {
                let keys: Vec<String> = fields
                    .iter()
                    .map(|(name, value)| format!("{name}={value}"))
                    .collect();
                write!(formatter, "[{}]", keys.join(","))
            }
        }
    }
}

/// A path as the server writes it in a conflict's `field`:
/// `.spec.template.spec.containers[name="app"].image`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct Path(pub(super) Vec<Element>);

impl Path {
    pub(super) fn push(&mut self, element: Element) {
        self.0.push(element);
    }

    pub(super) fn pop(&mut self) {
        self.0.pop();
    }

    pub(super) fn with(&self, element: Element) -> Self {
        let mut path = self.clone();
        path.push(element);
        path
    }

    pub(super) fn elements(&self) -> &[Element] {
        &self.0
    }
}

impl fmt::Display for Path {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0
            .iter()
            .try_for_each(|element| write!(formatter, "{element}"))
    }
}

/// A `FieldsV1` set: the paths a manager owns, relative to where it sits.
/// A member is a path owned itself; a child holds what is owned under it,
/// and a path can be both.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FieldSet {
    pub(super) members: BTreeSet<Element>,
    pub(super) children: BTreeMap<Element, FieldSet>,
}

impl FieldSet {
    /// A set from its JSON, as [`readIterV1`] reads it.
    ///
    /// [`readIterV1`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/fieldpath/serialize.go#L194
    pub fn parse(fields: &Value) -> Self {
        read(fields).0.unwrap_or_default()
    }

    /// Whether the path is owned itself.
    pub(super) fn contains(&self, path: &[Element]) -> bool {
        match path {
            [] => false,
            [last] => self.members.contains(last),
            [first, rest @ ..] => self
                .children
                .get(first)
                .is_some_and(|child| child.contains(rest)),
        }
    }
}

/// A set's children, and whether the set is a member of its parent.
fn read(fields: &Value) -> (Option<FieldSet>, bool) {
    let mut children: Option<FieldSet> = None;
    let mut member = false;
    if let Some(map) = fields.as_object() {
        for (key, value) in map {
            if key == "." {
                member = true;
                continue;
            }
            let Some(element) = Element::parse(key) else {
                continue;
            };
            let (grandchildren, child_member) = read(value);
            if child_member {
                children
                    .get_or_insert_with(FieldSet::default)
                    .members
                    .insert(element.clone());
            }
            if let Some(grandchildren) = grandchildren {
                children
                    .get_or_insert_with(FieldSet::default)
                    .children
                    .insert(element, grandchildren);
            }
        }
    }
    let member = member || children.is_none();
    (children, member)
}
