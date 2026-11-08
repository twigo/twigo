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
//! those is worked out per path, for every leaf under a removed subtree.
//! [`Updater::prune`] removes the whole of a struct or a list element whose
//! member Twigo was the only one to hold, along with what nobody owns in it
//! (defaults): the classification counts such a leaf as staying, and the
//! dry-run's answer settles it, since what it no longer holds needs no patch.
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
use fields::Element;
use owned::Ownership;

pub use fields::{FieldSet, Path};
pub use merge::{merge_patch, still_has, without};

/// The field manager Twigo applies as.
pub const FIELD_MANAGER: &str = "twigo";

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
}

impl Built {
    /// Whether the edit sends nothing at all.
    pub fn unchanged(&self) -> bool {
        self.config.is_none() && self.removals.is_empty()
    }
}

/// Paths of Twigo's entry, written at another version, that the object at
/// the version opened does not hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignVersion {
    pub version: String,
    pub paths: Vec<String>,
}

/// Builds what an edit sends.
pub fn build(edit: Edit<'_>) -> Result<Built, ForeignVersion> {
    let Edit {
        live,
        base,
        edited,
        root,
        status_subresource,
        lock,
        dropped,
    } = edit;
    let ignored = ignored(Some(base), edited, status_subresource);
    let ownership = Ownership::of(live);
    let api_version = live["apiVersion"].as_str().unwrap_or_default();
    let mut config = match &ownership.ours {
        Some(ours) => {
            if ours.api_version != api_version {
                let mut found = Vec::new();
                owned::missing(live, &ours.fields, &mut Path::default(), &mut found);
                if !found.is_empty() {
                    return Err(ForeignVersion {
                        version: ours.api_version.clone(),
                        paths: found.iter().map(ToString::to_string).collect(),
                    });
                }
            }
            owned::extract(live, &ours.fields, Some(root)).unwrap_or_else(|| json!({}))
        }
        None => json!({}),
    };

    let mut removals = Vec::new();
    let changed = changes::of_map(
        &editable(base, status_subresource),
        &editable(edited, status_subresource),
        Some(root),
        &[],
        &mut Path::default(),
        &mut removals,
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
    let has_changes = !changed.as_object().is_some_and(Map::is_empty);
    merge::merge(&mut config, changed, Some(root));

    removals.retain(|removal| still_has(live, removal));
    for removal in &removals {
        merge::remove(&mut config, removal.elements(), true);
    }
    merge::retain(
        &mut config,
        Some(root),
        &dropped,
        false,
        &mut Path::default(),
    );

    let comparable = ownership.at_version(api_version);
    let (by_patch, by_apply): (Vec<Path>, Vec<Path>) = removals.into_iter().partition(|removal| {
        !comparable || stays_after_apply(live, removal, Some(root), &ownership)
    });

    let config = (has_changes || !by_apply.is_empty()).then(|| {
        finish(
            config,
            api_version,
            edited["kind"].as_str().unwrap_or_default(),
            &edited["metadata"],
            Some(lock),
        )
    });
    Ok(Built {
        config,
        removals: by_patch,
        ignored,
    })
}

/// The configuration of a manifest with no object behind it: all of it, but
/// what no configuration may carry, reported by path.
pub fn manifest(edited: &Value, status_subresource: bool) -> (Value, Vec<String>) {
    let ignored = ignored(None, edited, status_subresource);
    let config = Value::Object(editable(edited, status_subresource));
    let config = finish(
        config,
        edited["apiVersion"].as_str().unwrap_or_default(),
        edited["kind"].as_str().unwrap_or_default(),
        &edited["metadata"],
        None,
    );
    (config, ignored)
}

/// `edited` without its server fields, for a create: `status`, the server's
/// metadata and, for a Job the server selected for, the labels and the
/// selector it generates ([`generateSelector`]), which do not survive a new
/// uid.
///
/// [`generateSelector`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/batch/job/strategy.go#L209-L255
pub fn for_create(edited: &Value, job: bool) -> Value {
    let mut object = edited.clone();
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
    if fields
        .get("metadata")
        .and_then(Value::as_object)
        .is_some_and(Map::is_empty)
    {
        fields.remove("metadata");
    }
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

/// A configuration with its identity and, for an edit, its lock.
fn finish(
    mut config: Value,
    api_version: &str,
    kind: &str,
    metadata: &Value,
    lock: Option<&str>,
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
    if let Some(lock) = lock {
        meta.insert("resourceVersion".to_owned(), json!(lock));
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
