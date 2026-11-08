//! The apply configuration of an edit (ARCHITECTURE 6.5), pure so that its
//! semantics are tested without a cluster: what Twigo owns of the live
//! object, plus what the person changed, minus what they removed.
//!
//! Applying the whole object would make Twigo a co-owner of every field, so
//! the configuration holds only:
//!
//! - what the `twigo` entry of `metadata.managedFields` (operation `Apply`,
//!   no subresource) covers of the live object, extracted as [`ExtractInto`]
//!   does, since a field a later apply leaves out is removed
//!   ([`Updater::prune`]);
//! - what differs between what the object was opened as and the edit, each
//!   place taken as the server merges it, read from the kind's [`Node`].
//!
//! The server keeps one Apply entry per manager, whatever its version
//! ([`BuildManagerIdentifier`]), and prunes that entry at the version it was
//! written with, converting the object to it. So an entry at another version
//! than the one opened has paths that may not name the same fields: where
//! one of them does not reach the live object Twigo refuses to go on
//! ([`ForeignVersion`]), as leaving it out would lose what Twigo owns, and
//! otherwise the same-named paths are carried and every removal goes by the
//! merge patch, since ownership at other versions does not compare.
//!
//! A field left out goes only when Twigo's Apply entry is its only owner.
//! One that another manager owns too, or that nobody does, stays after an
//! apply, so it needs a JSON merge patch ([`merge_patch`]). Which fields are
//! those is worked out per path: another manager that holds the path, as a
//! member or by anything under it, a list element by its key or a deduced
//! map included, keeps it, and so does a leaf under a removed subtree that
//! is not Twigo's alone. [`Updater::prune`] removes the whole of a struct or
//! a list element whose member Twigo was the only one to hold, along with
//! what nobody owns in it (defaults): the classification counts such a leaf
//! as staying, and the dry-run's answer settles it, since what it no longer
//! holds needs no patch.
//!
//! A map or a list element a removal empties stays in the configuration
//! while the edit holds it, as the server deletes the whole of what an apply
//! stops naming, what nobody owns in it included, unless another manager
//! holds it (`merge::release`).
//!
//! Some edits no apply can express without owning what it does not change:
//! a list's elements put in another order, one inserted before the end (the
//! server places a new element before the next one the configuration shares
//! with the object, but an edit moving elements names more of the list than
//! the person changed), an element of a key held twice, changed or removed,
//! or a change an apply cannot validate with the old field still there
//! (`strategy: Recreate` over another manager's `rollingUpdate`). They
//! go by one JSON merge patch that carries the changes and the removals
//! together ([`Combined`]), as `kubectl edit` does.
//!
//! [`ExtractInto`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/util/managedfields/extract.go#L52-L88
//! [`Updater::prune`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/merge/update.go#L256-L280
//! [`BuildManagerIdentifier`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/util/managedfields/internal/managedfields.go#L133-L159

mod changes;
mod fields;
mod merge;
mod owned;
#[cfg(test)]
mod tests;

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::openapi::{ListType, Node};
use changes::Found;
use fields::Element;
use owned::Ownership;

pub use fields::{FieldSet, Path};
pub use merge::{merge_patch, still_has, without};

/// The field manager Twigo applies as.
pub const FIELD_MANAGER: &str = "twigo";

/// The field manager of the one merge patch that carries an edit no apply
/// can express, as `kubectl edit` names its own.
pub const EDIT_FIELD_MANAGER: &str = "twigo-edit";

/// What the server sets on an object, which no apply configuration may
/// carry.
const SERVER_METADATA: [&str; 8] = [
    "uid",
    "resourceVersion",
    "generation",
    "creationTimestamp",
    "deletionTimestamp",
    "deletionGracePeriodSeconds",
    "selfLink",
    "managedFields",
];

/// An edit of an object as it was opened.
pub struct Edit<'a> {
    /// The object as the server has it now, with managedFields.
    pub live: &'a Value,
    /// The object as the webview received it.
    pub base: &'a Value,
    /// The object as the person left it.
    pub edited: &'a Value,
    /// The kind's root in the schema of the version opened.
    pub root: Node<'a>,
    /// Whether the resource has a `status` subresource.
    pub status_subresource: bool,
    /// The `resourceVersion` to hold the apply to.
    pub lock: &'a str,
    /// The conflicting paths the person gave up.
    pub dropped: &'a [String],
}

/// The one JSON merge patch of an edit, carrying its changes and its
/// removals together.
#[derive(Debug, Clone, PartialEq)]
pub enum Combined {
    /// No such patch is needed.
    None,
    /// Tried when the apply's dry-run or that of its patch answers `422`,
    /// and there are removals that go by patch: `removals` are all that go
    /// by it, those the apply alone would have taken included.
    Fallback { patch: Value, removals: Vec<Path> },
    /// Only this can express the edit; no apply is sent.
    Only(Value),
}

/// What Twigo will send for an edit.
#[derive(Debug, Clone, PartialEq)]
pub struct Built {
    /// The apply configuration; `None` when an apply would neither set nor
    /// give up anything.
    pub config: Option<Value>,
    /// The paths the merge patch has to remove.
    pub removals: Vec<Path>,
    /// What the edit said that no configuration may carry, by path.
    pub ignored: Vec<String>,
    pub combined: Combined,
}

impl Built {
    /// Whether the edit sends nothing at all.
    pub fn unchanged(&self) -> bool {
        self.config.is_none() && self.removals.is_empty() && self.combined == Combined::None
    }
}

/// Paths of Twigo's entry, written at another version, that the object at
/// the version opened does not hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignVersion {
    pub version: String,
    pub paths: Vec<String>,
}

/// Why an edit cannot be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Foreign(ForeignVersion),
    /// Lists the edit sends whole that the server holds otherwise than the
    /// edit was opened with: sending them would revert the other writer, and
    /// nothing can merge them.
    ListsMoved(Vec<String>),
}

/// Builds what an edit sends. A null where the schema types the field leaves
/// first, so nothing downstream reads one as a value: a null a person left
/// there means no value, and the server's own (`creationTimestamp: null` in
/// a template) is not a field of the object ([`normalized`]). What Twigo
/// owns comes from the live object as it stands, nulls included.
pub fn build(edit: Edit<'_>) -> Result<Built, Refusal> {
    let Edit {
        live,
        base,
        edited,
        root,
        status_subresource,
        lock,
        dropped,
    } = edit;
    let raw_live = live;
    let (live, base, edited) = (
        &normalized(live, Some(root)),
        &normalized(base, Some(root)),
        &normalized(edited, Some(root)),
    );
    let ignored = ignored(Some(base), edited, status_subresource);

    let mut found = Found::default();
    let changed = changes::of_map(
        &editable(base, status_subresource),
        &editable(edited, status_subresource),
        Some(root),
        &[],
        &mut Path::default(),
        &mut found,
    );
    let mut changed = Value::Object(changed);
    let dropped: HashSet<String> = dropped.iter().cloned().collect();
    merge::retain(
        &mut changed,
        Some(root),
        &dropped,
        true,
        &mut Path::default(),
    );
    let Found {
        mut removals,
        rewritten,
    } = found;
    removals.retain(|removal| still_has(live, removal));
    let moved: Vec<String> = rewritten
        .iter()
        .filter(|(path, _)| {
            merge::value_at(live, path.elements()) != merge::value_at(base, path.elements())
        })
        .map(|(path, _)| path.to_string())
        .collect();
    if !moved.is_empty() {
        return Err(Refusal::ListsMoved(moved));
    }
    let object = Value::Object(editable(live, status_subresource));

    if !rewritten.is_empty() {
        let patch = merge::combined(&object, changed, &removals, &rewritten, Some(root));
        let combined = if patch.is_empty() {
            Combined::None
        } else {
            Combined::Only(Value::Object(patch))
        };
        return Ok(Built {
            config: None,
            removals,
            ignored,
            combined,
        });
    }

    let ownership = Ownership::of(live);
    let api_version = live["apiVersion"].as_str().unwrap_or_default();
    let mut config = match &ownership.ours {
        Some(ours) => {
            if ours.api_version != api_version {
                let mut found = Vec::new();
                owned::missing(raw_live, &ours.fields, &mut Path::default(), &mut found);
                if !found.is_empty() {
                    return Err(Refusal::Foreign(ForeignVersion {
                        version: ours.api_version.clone(),
                        paths: found.iter().map(ToString::to_string).collect(),
                    }));
                }
            }
            owned::extract(raw_live, &ours.fields, Some(root)).unwrap_or_else(|| json!({}))
        }
        None => json!({}),
    };
    let has_changes = !changed.as_object().is_some_and(Map::is_empty);
    merge::merge(&mut config, changed.clone(), Some(root));
    for removal in &removals {
        merge::release(
            &mut config,
            removal.elements(),
            Some(root),
            &mut Path::default(),
            &ownership,
        );
    }
    merge::retain(
        &mut config,
        Some(root),
        &dropped,
        false,
        &mut Path::default(),
    );
    merge::in_live_order(&mut config, live, Some(root));

    let comparable = ownership.at_version(api_version);
    let (by_patch, by_apply): (Vec<Path>, Vec<Path>) = removals.into_iter().partition(|removal| {
        !comparable || stays_after_apply(live, removal, Some(root), &ownership)
    });
    let combined = if by_patch.is_empty() {
        Combined::None
    } else {
        let every: Vec<Path> = by_patch.iter().chain(&by_apply).cloned().collect();
        Combined::Fallback {
            patch: Value::Object(merge::combined(&object, changed, &every, &[], Some(root))),
            removals: every,
        }
    };

    let config = (has_changes || !by_apply.is_empty()).then(|| {
        finish(
            config,
            api_version,
            edited["kind"].as_str().unwrap_or_default(),
            &edited["metadata"],
            Some(Held {
                resource_version: lock,
                uid: live["metadata"].get("uid"),
            }),
        )
    });
    Ok(Built {
        config,
        removals: by_patch,
        ignored,
        combined,
    })
}

/// The configuration of a manifest with no object behind it: all of it, but
/// what no configuration may carry, reported by path, and the conflicting
/// paths the person gave up, which `root` finds. `None` when giving those
/// up leaves it nothing to set.
pub fn manifest(
    edited: &Value,
    status_subresource: bool,
    root: Option<Node<'_>>,
    dropped: &[String],
) -> (Option<Value>, Vec<String>) {
    let edited = &normalized(edited, root);
    let ignored = ignored(None, edited, status_subresource);
    let mut fields = Value::Object(editable(edited, status_subresource));
    if !dropped.is_empty() {
        let dropped: HashSet<String> = dropped.iter().cloned().collect();
        merge::retain(&mut fields, root, &dropped, true, &mut Path::default());
        let sets_something = fields.as_object().is_some_and(|fields| {
            fields.iter().any(|(name, value)| {
                name != "metadata" || value.as_object().is_none_or(|map| !map.is_empty())
            })
        });
        if !sets_something {
            return (None, ignored);
        }
    }
    let config = finish(
        fields,
        edited["apiVersion"].as_str().unwrap_or_default(),
        edited["kind"].as_str().unwrap_or_default(),
        &edited["metadata"],
        None,
    );
    (Some(config), ignored)
}

/// `object` without the nulls of fields the schema types, whose absence is
/// what the person meant. Where the schema does not type a place, a deduced
/// or untyped node, a field it does not know, or in an atomic value, and on
/// a field it says is `nullable`, a null is a value, which the server keeps.
fn normalized(object: &Value, root: Option<Node<'_>>) -> Value {
    fn strip(value: &mut Value, node: Node<'_>) {
        if !node.typed() {
            return;
        }
        match value {
            Value::Object(map) if !node.atomic_map() => {
                map.retain(|name, value| {
                    !value.is_null()
                        || !node
                            .field(name)
                            .is_some_and(|field| field.typed() && !field.nullable())
                });
                for (name, value) in map.iter_mut() {
                    if let Some(field) = node.field(name) {
                        strip(value, field);
                    }
                }
            }
            Value::Array(items) if node.list() != ListType::Atomic => {
                if let Some(of_items) = node.items() {
                    items.iter_mut().for_each(|item| strip(item, of_items));
                }
            }
            _ => {}
        }
    }
    let mut object = object.clone();
    if let Some(root) = root {
        strip(&mut object, root);
    }
    object
}

/// `object` without a null map value at any depth, for a comparison, and for
/// a Pod or a Job, whose fields the schema all types.
fn without_nulls(object: &Value) -> Value {
    fn strip(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.retain(|_, value| !value.is_null());
                map.values_mut().for_each(strip);
            }
            Value::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let mut object = object.clone();
    strip(&mut object);
    object
}

/// What says whether an object changed, for a resource with a `status`
/// subresource: its `resourceVersion` and `generation` move on every status
/// write, which changes nothing a person edits.
pub fn comparable(object: &Value) -> Value {
    let mut object = without_nulls(object);
    if let Some(root) = object.as_object_mut() {
        root.remove("status");
        if let Some(metadata) = root.get_mut("metadata").and_then(Value::as_object_mut) {
            for field in ["resourceVersion", "generation", "managedFields"] {
                metadata.remove(field);
            }
        }
    }
    object
}

/// [`comparable`] and who owns what, to tell whether an object changed since
/// a preview read it: a co-owner that arrived since would make a removal
/// silently not happen. Each entry's `time` and the entries of a subresource
/// are left out, as a status writer moves only those.
pub fn comparable_with_owners(object: &Value) -> Value {
    let mut view = comparable(object);
    let entries: Vec<Value> = object["metadata"]["managedFields"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["subresource"].as_str().unwrap_or_default().is_empty())
        .map(|entry| {
            let mut entry = entry.clone();
            if let Some(entry) = entry.as_object_mut() {
                entry.remove("time");
            }
            entry
        })
        .collect();
    view["metadata"]["managedFields"] = Value::Array(entries);
    view
}

/// `edited` without its server fields, for a create: `status`, the server's
/// metadata and, for a Job the server selected for, the labels and the
/// selector it generates ([`generateSelector`]), which do not survive a new
/// uid.
///
/// [`generateSelector`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/batch/job/strategy.go#L209-L255
pub fn for_create(edited: &Value, job: bool) -> Value {
    let mut object = without_nulls(edited);
    let Some(root) = object.as_object_mut() else {
        return object;
    };
    root.remove("status");
    if let Some(metadata) = root.get_mut("metadata").and_then(Value::as_object_mut) {
        for field in SERVER_METADATA {
            metadata.remove(field);
        }
    }
    if job && object["spec"]["manualSelector"] != true {
        let generated = [
            "controller-uid",
            "job-name",
            "batch.kubernetes.io/controller-uid",
            "batch.kubernetes.io/job-name",
        ];
        let strip = |metadata: &mut Value| {
            if let Some(labels) = metadata["labels"].as_object_mut() {
                for label in generated {
                    labels.remove(label);
                }
            }
        };
        strip(&mut object["metadata"]);
        strip(&mut object["spec"]["template"]["metadata"]);
        if let Some(spec) = object["spec"].as_object_mut() {
            spec.remove("selector");
        }
    }
    object
}

/// The fields of an object a configuration may hold: everything but the
/// identity, `status` where a subresource owns it, and the server's metadata.
fn editable(object: &Value, status_subresource: bool) -> Map<String, Value> {
    let mut fields = object.as_object().cloned().unwrap_or_default();
    fields.remove("apiVersion");
    fields.remove("kind");
    if status_subresource {
        fields.remove("status");
    }
    if let Some(metadata) = fields.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.remove("name");
        metadata.remove("namespace");
        for field in SERVER_METADATA {
            metadata.remove(field);
        }
    }
    fields
        .entry("metadata")
        .or_insert_with(|| Value::Object(Map::new()));
    fields
}

/// What the edit says differently from the object in the fields no
/// configuration may carry; for a manifest, all it says of them.
fn ignored(base: Option<&Value>, edited: &Value, status_subresource: bool) -> Vec<String> {
    let differs = |of: &dyn Fn(&Value) -> Option<&Value>| match base {
        Some(base) => of(base) != of(edited),
        None => of(edited).is_some(),
    };
    let mut ignored = Vec::new();
    if status_subresource && differs(&|object| object.get("status")) {
        ignored.push(".status".to_owned());
    }
    for field in SERVER_METADATA {
        if differs(&|object| object["metadata"].get(field)) {
            ignored.push(format!(".metadata.{field}"));
        }
    }
    ignored
}

/// What holds a configuration of an edit to the object it was made from: the
/// `resourceVersion`, and the uid, as an apply to a name nothing has creates
/// it whatever `resourceVersion` it holds to, and with a uid is refused with
/// a `409` (kind 1.37, 2026-11-08).
struct Held<'a> {
    resource_version: &'a str,
    uid: Option<&'a Value>,
}

/// A configuration with its identity and, for an edit, what holds it.
fn finish(
    mut config: Value,
    api_version: &str,
    kind: &str,
    metadata: &Value,
    held: Option<Held<'_>>,
) -> Value {
    if !config.is_object() {
        config = json!({});
    }
    let root = config.as_object_mut().expect("a configuration is a map");
    root.insert("apiVersion".to_owned(), json!(api_version));
    root.insert("kind".to_owned(), json!(kind));
    let meta = root
        .entry("metadata")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("metadata is a map");
    meta.insert("name".to_owned(), metadata["name"].clone());
    if let Some(namespace) = metadata.get("namespace") {
        meta.insert("namespace".to_owned(), namespace.clone());
    }
    if let Some(Held {
        resource_version,
        uid,
    }) = held
    {
        meta.insert("resourceVersion".to_owned(), json!(resource_version));
        if let Some(uid) = uid {
            meta.insert("uid".to_owned(), uid.clone());
        }
    }
    config
}

/// Whether any leaf under the removed `path` stays after an apply that
/// leaves it out, by who owns it.
fn stays_after_apply(
    live: &Value,
    path: &Path,
    root: Option<Node<'_>>,
    ownership: &Ownership,
) -> bool {
    if ownership.others_hold(path) {
        return true;
    }
    let Some(value) = merge::value_at(live, path.elements()) else {
        return false;
    };
    let mut node = root;
    for element in path.elements() {
        node = match element {
            Element::Field(name) => node.and_then(|node| node.field(name)),
            _ => node.and_then(|node| node.items()),
        };
    }
    let mut at = path.clone();
    leaf_stays(value, node, &mut at, ownership)
}

fn leaf_stays(value: &Value, node: Option<Node<'_>>, at: &mut Path, ownership: &Ownership) -> bool {
    match value {
        Value::Object(map) if !map.is_empty() && node.is_some_and(|node| !node.atomic_map()) => {
            map.iter().any(|(name, child)| {
                at.push(Element::Field(name.clone()));
                let field = node.and_then(|node| node.field(name));
                let stays = leaf_stays(child, field, at, ownership);
                at.pop();
                stays
            })
        }
        Value::Array(items)
            if !items.is_empty() && node.is_some_and(|node| node.list() != ListType::Atomic) =>
        {
            let list = node.map_or(ListType::Atomic, |node| node.list());
            let of_items = node.and_then(|node| node.items());
            items.iter().any(|item| {
                let Some(element) = Element::of_item(item, &list, of_items) else {
                    return true;
                };
                at.push(element.clone());
                let stays = element_stays(item, &list, of_items, at, ownership);
                at.pop();
                stays
            })
        }
        _ => !ownership.only_ours(at),
    }
}

/// An element's fields, its keys aside, which go with it; an element with
/// nothing but keys is its own leaf.
fn element_stays(
    item: &Value,
    list: &ListType,
    of_items: Option<Node<'_>>,
    at: &mut Path,
    ownership: &Ownership,
) -> bool {
    let (Value::Object(map), ListType::Map { keys }) = (item, list) else {
        return !ownership.only_ours(at);
    };
    let mut fields = map
        .iter()
        .filter(|(name, _)| !keys.contains(name))
        .peekable();
    if fields.peek().is_none() {
        return !ownership.only_ours(at);
    }
    fields.any(|(name, child)| {
        at.push(Element::Field(name.clone()));
        let field = of_items.and_then(|node| node.field(name));
        let stays = leaf_stays(child, field, at, ownership);
        at.pop();
        stays
    })
}
