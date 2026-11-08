//! How the server merges each field of a kind, read from its OpenAPI
//! document, for the apply configurations of ARCHITECTURE 6.5.
//!
//! The server merges by a schema it converts with [`ToSchemaFromOpenAPI`]
//! from the schemas of the document it serves, for the kinds it ships
//! ([`getOpenAPIModels`]) and for a CRD's, which [`buildOpenAPIModelsForApply`]
//! builds with the `BuildOpenAPIV3` that builds the served document, whose
//! options differ only in `IncludeSelectableFields` ([`buildV3Spec`]). A
//! [`Node`] answers what that conversion makes of a place in it, so the apply
//! configuration Twigo builds is merged as the server will merge it.
//! The document has cycles (`JSONSchemaProps`), so a node borrows the
//! document and goes where it is asked to rather than owning a tree.
//!
//! What the conversion decides, by the code at kube-openapi
//! `d427ff9ee9ad`, the commit Kubernetes 1.37.0 pins, and
//! structured-merge-diff 6.4.2:
//!
//! - A list is atomic unless `x-kubernetes-list-type` says `set` or `map`,
//!   and `map` takes its keys from `x-kubernetes-list-map-keys`. Without a
//!   list type the older markers decide: `x-kubernetes-patch-strategy` of
//!   `merge` or `merge,retainKeys` makes it associative, a map keyed by
//!   `x-kubernetes-patch-merge-key`, or a set without one, and anything else
//!   is atomic ([`getListElementRelationship`]). A list type that is
//!   present, even one the conversion does not know, shuts the markers out.
//! - A map is granular unless `x-kubernetes-map-type` says `atomic`, and a
//!   reference's own marker replaces its target's ([`getMapElementRelationship`],
//!   [`makeOpenAPIRef`], [`Resolve`]).
//! - An object with properties keeps to them: a field it does not declare is
//!   an error, unless the schema or a schema it was written inside says
//!   `x-kubernetes-preserve-unknown-fields`, or declares `additionalProperties`,
//!   which then types the unknown fields ([`parseObject`]). An object with
//!   neither is free-form.
//! - A node with no type information, such as a preserved object that has no
//!   properties, a free-form one, or `x-kubernetes-int-or-string`'s `oneOf`,
//!   is deduced from the value it gets. A deduced map is granular and each of
//!   its values is deduced again, and a deduced list is atomic, with elements
//!   that are untyped and atomic whole: maps atomic, lists atomic
//!   ([`deducedDef`], [`untypedDef`]). A list with no `items` has those
//!   elements too ([`parseList`]).
//! - A key of a list map that is missing from an element is read as its
//!   default from the element's schema, and an element that has no key
//!   field at all and no default for one is an error
//!   ([`keyedAssociativeListItemToPathElement`]): [`Node::default`].
//!
//! [`ToSchemaFromOpenAPI`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/schemaconv/openapi.go#L28-L75
//! [`getOpenAPIModels`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/server/genericapiserver.go#L1041-L1071
//! [`buildOpenAPIModelsForApply`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiextensions-apiserver/pkg/apiserver/customresource_handler.go#L1482-L1517
//! [`buildV3Spec`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiextensions-apiserver/pkg/controller/openapiv3/controller.go#L237-L249
//! [`getListElementRelationship`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/schemaconv/smd.go#L269-L316
//! [`getMapElementRelationship`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/schemaconv/smd.go#L318-L334
//! [`makeOpenAPIRef`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/schemaconv/openapi.go#L127-L172
//! [`Resolve`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/schema/elements.go#L312-L362
//! [`parseObject`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/schemaconv/openapi.go#L174-L226
//! [`parseList`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/schemaconv/openapi.go#L228-L263
//! [`deducedDef`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/schemaconv/smd.go#L99-L118
//! [`untypedDef`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/schemaconv/smd.go#L78-L97
//! [`keyedAssociativeListItemToPathElement`]: https://github.com/kubernetes-sigs/structured-merge-diff/blob/v6.4.2/typed/helpers.go#L187-L233

use serde_json::{Map, Value};

use super::Document;

/// How the server merges the elements of a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListType {
    /// The list is one value: an apply replaces it whole.
    Atomic,
    /// The elements are scalars, each its own.
    Set,
    /// The elements are objects, each identified by the values of these
    /// fields, or by their defaults.
    Map { keys: Vec<String> },
}

/// A place in a kind's schema: the root, a field, an element or a value of
/// a map. It borrows the document.
#[derive(Debug, Clone, Copy)]
pub struct Node<'a> {
    document: &'a Document,
    kind: Kind<'a>,
}

#[derive(Debug, Clone, Copy)]
enum Kind<'a> {
    Schema(Typed<'a>),
    Deduced,
    Untyped,
}

#[derive(Debug, Clone, Copy)]
struct Typed<'a> {
    schema: &'a Map<String, Value>,
    /// The `x-kubernetes-map-type` of the reference that led here, which
    /// replaces the schema's own.
    map_type: Option<&'a str>,
    preserves: bool,
    default: Option<&'a Value>,
}

impl<'a> Node<'a> {
    pub(super) fn definition(document: &'a Document, schema: &'a Map<String, Value>) -> Self {
        Self {
            document,
            kind: Kind::Schema(Typed {
                schema,
                map_type: None,
                preserves: preserves(schema),
                default: None,
            }),
        }
    }

    /// The field of this name, or the type of the values of a map that
    /// declares `additionalProperties`. `None` where the server refuses the
    /// field: a name the object does not declare, or anything under a
    /// scalar.
    pub fn field(&self, name: &str) -> Option<Node<'a>> {
        let Kind::Schema(typed) = self.kind else {
            return Some(self.kind_of(self.kind));
        };
        if !typed.holds("object") {
            return None;
        }
        let properties = typed.schema.get("properties").and_then(Value::as_object);
        if let Some(property) = properties.and_then(|properties| properties.get(name)) {
            return self.reference(typed, property, property.get("default"));
        }
        match typed.schema.get("additionalProperties") {
            None if typed.preserves || properties.is_none_or(Map::is_empty) => {
                Some(self.kind_of(Kind::Deduced))
            }
            Some(Value::Bool(true)) => Some(self.kind_of(Kind::Deduced)),
            Some(values @ Value::Object(_)) => self.reference(typed, values, None),
            _ => None,
        }
    }

    /// The type of a list's elements, `None` where the node is no list.
    pub fn items(&self) -> Option<Node<'a>> {
        let Kind::Schema(typed) = self.kind else {
            return Some(self.kind_of(Kind::Untyped));
        };
        if !typed.holds("array") {
            return None;
        }
        match typed.schema.get("items") {
            Some(items @ Value::Object(_)) => self.reference(typed, items, None),
            _ => Some(self.kind_of(Kind::Untyped)),
        }
    }

    /// How the server merges the elements of this list; atomic for a node
    /// that is no list, as for a list the schema says nothing of.
    pub fn list(&self) -> ListType {
        let Kind::Schema(typed) = self.kind else {
            return ListType::Atomic;
        };
        if !typed.holds("array") {
            return ListType::Atomic;
        }
        let extension = |name: &str| typed.schema.get(name).and_then(Value::as_str);
        let keys = |name: &str| -> Vec<String> {
            typed
                .schema
                .get(name)
                .and_then(Value::as_array)
                .map(|keys| {
                    keys.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };
        let keyed = |keys: Vec<String>| {
            if keys.is_empty() {
                ListType::Atomic
            } else {
                ListType::Map { keys }
            }
        };
        if let Some(list_type) = typed.schema.get("x-kubernetes-list-type") {
            return match list_type.as_str() {
                Some("set") => ListType::Set,
                Some("map") => keyed(keys("x-kubernetes-list-map-keys")),
                _ => ListType::Atomic,
            };
        }
        match extension("x-kubernetes-patch-strategy") {
            Some("merge" | "merge,retainKeys") => {
                match typed.schema.get("x-kubernetes-patch-merge-key") {
                    None => ListType::Set,
                    Some(key) => key
                        .as_str()
                        .map_or(ListType::Atomic, |key| keyed(vec![key.to_owned()])),
                }
            }
            _ => ListType::Atomic,
        }
    }

    /// Whether the server takes this map as one value, so that a field
    /// applied under it replaces what is there instead of joining it.
    pub fn atomic_map(&self) -> bool {
        match self.kind {
            Kind::Deduced => false,
            Kind::Untyped => true,
            Kind::Schema(typed) => {
                typed.holds("object")
                    && typed.map_type.or_else(|| {
                        typed
                            .schema
                            .get("x-kubernetes-map-type")
                            .and_then(Value::as_str)
                    }) == Some("atomic")
            }
        }
    }

    /// Whether `name` is a field this object declares, as against a key of a
    /// map, whose schema is that of all its values.
    pub fn declares(&self, name: &str) -> bool {
        let Kind::Schema(typed) = self.kind else {
            return false;
        };
        typed
            .schema
            .get("properties")
            .and_then(Value::as_object)
            .is_some_and(|properties| properties.contains_key(name))
    }

    /// Whether this field may hold a null as a value, which the server keeps.
    pub fn nullable(&self) -> bool {
        match self.kind {
            Kind::Schema(typed) => typed.schema.get("nullable") == Some(&Value::Bool(true)),
            Kind::Deduced | Kind::Untyped => false,
        }
    }

    /// Whether the schema types this place, as against a value the server
    /// deduces from what it gets, or leaves untyped.
    pub fn typed(&self) -> bool {
        matches!(self.kind, Kind::Schema(_))
    }

    /// The `default` of the field this node was reached by, which a key of a
    /// list map may rely on when an element leaves it out.
    pub fn default(&self) -> Option<&'a Value> {
        match self.kind {
            Kind::Schema(typed) => typed.default,
            Kind::Deduced | Kind::Untyped => None,
        }
    }

    fn kind_of(&self, kind: Kind<'a>) -> Node<'a> {
        Node {
            document: self.document,
            kind,
        }
    }

    /// The node of a schema written inside `parent`, as `makeOpenAPIRef` types
    /// it: a reference goes to its definition, which starts over with its
    /// own `x-kubernetes-preserve-unknown-fields`, and anything else is
    /// typed inline, inside what `parent` preserves.
    fn reference(
        &self,
        parent: Typed<'a>,
        schema: &'a Value,
        default: Option<&'a Value>,
    ) -> Option<Node<'a>> {
        let schema = schema.as_object()?;
        if let Some(name) = reference_name(schema) {
            let target = self.document.schemas.get(name)?.as_object()?;
            return Some(self.kind_of(Kind::Schema(Typed {
                schema: target,
                map_type: schema.get("x-kubernetes-map-type").and_then(Value::as_str),
                preserves: preserves(target),
                default,
            })));
        }
        Some(self.kind_of(Kind::Schema(Typed {
            schema,
            map_type: None,
            preserves: parent.preserves || preserves(schema),
            default,
        })))
    }
}

impl Typed<'_> {
    /// Whether the schema declares this JSON type or none.
    fn holds(&self, json_type: &str) -> bool {
        match self.schema.get("type").and_then(Value::as_str) {
            Some(declared) => declared == json_type,
            None => true,
        }
    }
}

fn preserves(schema: &Map<String, Value>) -> bool {
    schema.get("x-kubernetes-preserve-unknown-fields") == Some(&Value::Bool(true))
}

/// The definition a schema refers to, directly or as the only member of an
/// `allOf`, which is how OpenAPI 3.0 puts a description or a default next to
/// a reference.
pub(super) fn reference_name(schema: &Map<String, Value>) -> Option<&str> {
    let reference = schema.get("$ref").and_then(Value::as_str).or_else(|| {
        match schema.get("allOf").and_then(Value::as_array)?.as_slice() {
            [only] => only.get("$ref").and_then(Value::as_str),
            _ => None,
        }
    })?;
    reference.rsplit('/').next().filter(|name| !name.is_empty())
}
