//! A kind's OpenAPI v3 schemas as the JSON Schema (draft-07) that
//! yaml-language-server reads in monaco-yaml, for validation, completion and
//! hover in the YAML editor.
//!
//! The graph of definitions has cycles (`JSONSchemaProps` holds itself), so
//! it cannot be inlined: the kind is the root, and the definitions it
//! reaches come under `definitions`.
//!
//! What OpenAPI v3 says and JSON Schema does not:
//!
//! - A reference is `#/components/schemas/Name`, and becomes
//!   `#/definitions/Name`. OpenAPI 3.0 ignores whatever stands beside a
//!   `$ref`, so a description or a default for the field goes in an `allOf`
//!   with the `$ref` as its only member; the reference takes them beside it
//!   instead, which yaml-language-server keeps for hover and completion
//!   while it drops the constraints of a draft-07 reference's siblings
//!   (`REF_SIBLING_NONCONSTRAINT_KEYS` in yaml-language-server 1.23.0, the
//!   version of monaco-yaml 5.5.1).
//! - `nullable: true` is a type that includes `"null"`, or an `anyOf` with it
//!   where there is no single type.
//! - `x-kubernetes-int-or-string` is an `anyOf` of the two types, where the
//!   schema has none.
//! - A boolean `exclusiveMinimum` or `exclusiveMaximum` is the number of the
//!   bound itself.
//! - `x-kubernetes-preserve-unknown-fields` is what keeps an object that has
//!   properties from rejecting the others.
//!
//! The apply flow uses `validation_strict()`, which refuses a field the
//! schema does not declare, so a typed object does the same here:
//! `additionalProperties: false` unless it preserves unknown fields, as the
//! server's conversion reads it (`shape`), or declares its own. An object with
//! no properties is free-form and takes any field. A member of `allOf`,
//! `anyOf`, `oneOf` or `not`, which a CRD's served document keeps, only
//! constrains fields declared beside it, so it never closes the object.
//!
//! `x-kubernetes-*` keywords are the server's to read and go; a property of
//! that name stays, as `JSONSchemaProps` has some.

use std::collections::BTreeSet;

use kube::core::GroupVersionKind;
use serde_json::{Map, Value, json};

use super::Document;
use super::shape::reference_name;

const DRAFT: &str = "http://json-schema.org/draft-07/schema#";

/// The editor never shows `managedFields`.
const OBJECT_META: &str = "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta";

/// The types whose zero value the server writes as `null` and reads back as
/// unset, which the schema calls a string: a pod's conditions carry
/// `lastProbeTime: null`. See [`Time`] and [`MicroTime`].
///
/// [`Time`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/time.go#L100-L104
/// [`MicroTime`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/micro_time.go#L113-L117
const ZERO_IS_NULL: [&str; 2] = [
    "io.k8s.apimachinery.pkg.apis.meta.v1.Time",
    "io.k8s.apimachinery.pkg.apis.meta.v1.MicroTime",
];

pub(super) fn of(document: &Document, gvk: &GroupVersionKind) -> Option<String> {
    let (name, root) = document.kind(gvk)?;
    let mut converter = Converter {
        document,
        reached: BTreeSet::new(),
        queue: Vec::new(),
    };
    let mut schema = converter.definition(name, root);
    for (property, value) in [
        ("apiVersion", gvk.api_version()),
        ("kind", gvk.kind.clone()),
    ] {
        if let Some(property) = schema
            .get_mut("properties")
            .and_then(|properties| properties.get_mut(property))
            .and_then(Value::as_object_mut)
        {
            property.insert("enum".to_owned(), json!([value]));
        }
    }
    let mut definitions = Map::new();
    while let Some(name) = converter.queue.pop() {
        if let Some(definition) = document.schemas.get(&name).and_then(Value::as_object) {
            let converted = converter.definition(&name, definition);
            definitions.insert(name, converted.into());
        }
    }
    schema.insert("$schema".to_owned(), DRAFT.into());
    schema.insert("definitions".to_owned(), definitions.into());
    Some(Value::Object(schema).to_string())
}

struct Converter<'a> {
    document: &'a Document,
    reached: BTreeSet<String>,
    queue: Vec<String>,
}

impl Converter<'_> {
    /// A definition by its name, which decides what is left out of it, and
    /// so out of what it reaches, and what it takes besides.
    fn definition(&mut self, name: &str, schema: &Map<String, Value>) -> Map<String, Value> {
        let mut amended = schema.clone();
        if name == OBJECT_META {
            if let Some(properties) = amended.get_mut("properties").and_then(Value::as_object_mut) {
                properties.remove("managedFields");
            }
        } else if ZERO_IS_NULL.contains(&name) {
            amended.insert("nullable".to_owned(), Value::Bool(true));
        } else {
            return self.object(schema, false);
        }
        self.object(&amended, false)
    }

    /// A schema written inside another, which `preserves` the unknown fields
    /// of when the one that holds it does.
    fn schema(&mut self, schema: &Value, preserves: bool) -> Value {
        match schema.as_object() {
            Some(object) => self.object(object, preserves).into(),
            None => schema.clone(),
        }
    }

    fn object(&mut self, object: &Map<String, Value>, preserves: bool) -> Map<String, Value> {
        if let Some(name) = reference_name(object) {
            return self.reference(name, object);
        }
        let preserves = preserves
            || object.get("x-kubernetes-preserve-unknown-fields") == Some(&Value::Bool(true));
        let mut converted = Map::new();
        for (keyword, value) in object {
            match keyword.as_str() {
                "properties" => {
                    let properties = value.as_object().map(|properties| {
                        properties
                            .iter()
                            .map(|(name, property)| {
                                (name.clone(), self.schema(property, preserves))
                            })
                            .collect()
                    });
                    converted.insert(
                        keyword.clone(),
                        Value::Object(properties.unwrap_or_default()),
                    );
                }
                "items" | "additionalProperties" => {
                    converted.insert(keyword.clone(), self.schema(value, preserves));
                }
                "not" => {
                    converted.insert(keyword.clone(), self.schema(value, true));
                }
                "allOf" | "anyOf" | "oneOf" => {
                    let members = value.as_array().map(|members| {
                        members
                            .iter()
                            .map(|member| self.schema(member, true))
                            .collect()
                    });
                    converted.insert(keyword.clone(), Value::Array(members.unwrap_or_default()));
                }
                "nullable" => {}
                keyword if keyword.starts_with("x-kubernetes-") => {}
                _ => {
                    converted.insert(keyword.clone(), value.clone());
                }
            }
        }

        if object.get("x-kubernetes-int-or-string") == Some(&Value::Bool(true))
            && !converted.contains_key("anyOf")
        {
            converted.insert(
                "anyOf".to_owned(),
                json!([{ "type": "integer" }, { "type": "string" }]),
            );
        }
        let declares_fields = object
            .get("properties")
            .and_then(Value::as_object)
            .is_some_and(|properties| !properties.is_empty());
        if declares_fields && !preserves && !object.contains_key("additionalProperties") {
            converted.insert("additionalProperties".to_owned(), Value::Bool(false));
        }
        for (exclusive, bound) in [
            ("exclusiveMinimum", "minimum"),
            ("exclusiveMaximum", "maximum"),
        ] {
            match converted.get(exclusive) {
                Some(Value::Bool(true)) => {
                    match converted.remove(bound) {
                        Some(limit) => converted.insert(exclusive.to_owned(), limit),
                        None => converted.remove(exclusive),
                    };
                }
                Some(Value::Bool(false)) => {
                    converted.remove(exclusive);
                }
                _ => {}
            }
        }
        nullable(object, converted)
    }

    /// A reference to a definition, which comes under `definitions` once.
    fn reference(&mut self, name: &str, wrapper: &Map<String, Value>) -> Map<String, Value> {
        if self.document.schemas.contains_key(name) && self.reached.insert(name.to_owned()) {
            self.queue.push(name.to_owned());
        }
        let mut converted = Map::new();
        converted.insert("$ref".to_owned(), format!("#/definitions/{name}").into());
        for annotation in ["description", "default"] {
            if let Some(value) = wrapper.get(annotation) {
                converted.insert(annotation.to_owned(), value.clone());
            }
        }
        nullable(wrapper, converted)
    }
}

/// `converted`, which also takes `null` where `schema` says it is nullable.
fn nullable(schema: &Map<String, Value>, mut converted: Map<String, Value>) -> Map<String, Value> {
    if schema.get("nullable") != Some(&Value::Bool(true)) {
        return converted;
    }
    if let Some(Value::String(single)) = converted.get("type") {
        converted.insert("type".to_owned(), json!([single, "null"]));
        return converted;
    }
    let mut wrapper = Map::new();
    for annotation in ["description", "default"] {
        if let Some(value) = converted.remove(annotation) {
            wrapper.insert(annotation.to_owned(), value);
        }
    }
    wrapper.insert(
        "anyOf".to_owned(),
        json!([Value::Object(converted), { "type": "null" }]),
    );
    wrapper
}
