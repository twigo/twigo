use kube::core::GroupVersionKind;
use serde_json::{Value, json};

use super::{Document, ListType, Node};

fn gvk() -> GroupVersionKind {
    GroupVersionKind::gvk("example.com", "v1", "Kind")
}

fn document(properties: Value, definitions: Value) -> Document {
    let mut schemas = definitions.as_object().cloned().unwrap_or_default();
    schemas.insert(
        "example.Kind".to_owned(),
        json!({
            "type": "object",
            "x-kubernetes-group-version-kind": [
                { "group": "example.com", "version": "v1", "kind": "Kind" }
            ],
            "properties": properties,
        }),
    );
    Document { schemas }
}

fn root(document: &Document) -> Node<'_> {
    document.shape(&gvk()).unwrap()
}

fn json_schema(document: &Document) -> Value {
    serde_json::from_str(&document.json_schema(&gvk()).unwrap()).unwrap()
}

fn keyed(key: &str) -> ListType {
    ListType::Map {
        keys: vec![key.to_owned()],
    }
}

fn list(extensions: Value) -> Value {
    let mut list = json!({ "type": "array", "items": { "$ref": "#/components/schemas/Item" } });
    list.as_object_mut()
        .unwrap()
        .extend(extensions.as_object().unwrap().clone());
    list
}

#[test]
fn a_list_without_a_list_type_follows_the_older_patch_markers() {
    let document = document(
        json!({
            "merged": list(json!({
                "x-kubernetes-patch-strategy": "merge",
                "x-kubernetes-patch-merge-key": "name",
            })),
            "retained": list(json!({
                "x-kubernetes-patch-strategy": "merge,retainKeys",
                "x-kubernetes-patch-merge-key": "name",
            })),
            "keyless": list(json!({ "x-kubernetes-patch-strategy": "merge" })),
            "replaced": list(json!({ "x-kubernetes-patch-strategy": "retainKeys" })),
            "unknown": list(json!({ "x-kubernetes-patch-strategy": "replace" })),
            "none": list(json!({})),
            "atomic": list(json!({
                "x-kubernetes-list-type": "atomic",
                "x-kubernetes-patch-strategy": "merge",
                "x-kubernetes-patch-merge-key": "name",
            })),
            "unknown type": list(json!({
                "x-kubernetes-list-type": "ordered",
                "x-kubernetes-patch-strategy": "merge",
                "x-kubernetes-patch-merge-key": "name",
            })),
            "no keys": list(json!({ "x-kubernetes-list-type": "map" })),
            "set": list(json!({ "x-kubernetes-list-type": "set" })),
            "map": list(json!({
                "x-kubernetes-list-type": "map",
                "x-kubernetes-list-map-keys": ["a", "b"],
            })),
        }),
        json!({}),
    );
    let root = root(&document);
    let type_of = |name: &str| root.field(name).unwrap().list();
    assert_eq!(type_of("merged"), keyed("name"));
    assert_eq!(type_of("retained"), keyed("name"));
    assert_eq!(type_of("keyless"), ListType::Set);
    assert_eq!(type_of("replaced"), ListType::Atomic);
    assert_eq!(type_of("unknown"), ListType::Atomic);
    assert_eq!(type_of("none"), ListType::Atomic);
    assert_eq!(type_of("atomic"), ListType::Atomic);
    assert_eq!(type_of("unknown type"), ListType::Atomic);
    assert_eq!(type_of("no keys"), ListType::Atomic);
    assert_eq!(type_of("set"), ListType::Set);
    assert_eq!(
        type_of("map"),
        ListType::Map {
            keys: vec!["a".to_owned(), "b".to_owned()]
        }
    );
}

#[test]
fn a_node_with_no_type_information_is_deduced_from_what_it_gets() {
    let document = document(
        json!({
            "preserved": { "type": "object", "x-kubernetes-preserve-unknown-fields": true },
            "free": { "type": "object" },
            "anything": {},
            "number": { "format": "int-or-string", "oneOf": [{ "type": "integer" }, { "type": "string" }] },
            "text": { "type": "string" },
        }),
        json!({}),
    );
    let root = root(&document);

    for name in ["preserved", "free", "anything", "number"] {
        let node = root.field(name).unwrap();
        let value = node.field("a").unwrap();
        assert!(!value.atomic_map(), "{name}");
        assert_eq!(value.list(), ListType::Atomic, "{name}");
        let deeper = value.field("b").unwrap().field("c").unwrap();
        assert!(!deeper.atomic_map(), "{name}");
        assert_eq!(deeper.list(), ListType::Atomic, "{name}");

        let element = value.items().unwrap();
        assert!(element.atomic_map(), "{name}");
        assert_eq!(element.list(), ListType::Atomic, "{name}");
        assert!(element.field("x").unwrap().atomic_map(), "{name}");
        assert_eq!(element.items().unwrap().list(), ListType::Atomic, "{name}");
    }

    let anything = root.field("anything").unwrap();
    assert!(anything.items().unwrap().atomic_map());
    assert_eq!(anything.list(), ListType::Atomic);
    assert!(root.field("text").unwrap().field("a").is_none());
    assert!(root.field("text").unwrap().items().is_none());
}

#[test]
fn an_object_with_properties_refuses_the_others_unless_it_preserves_them() {
    let document = document(
        json!({
            "typed": {
                "type": "object",
                "properties": { "a": { "type": "string", "default": "x" } },
            },
            "preserved": {
                "type": "object",
                "x-kubernetes-preserve-unknown-fields": true,
                "properties": { "a": { "type": "string" } },
            },
            "inside": {
                "type": "object",
                "x-kubernetes-preserve-unknown-fields": true,
                "properties": {
                    "inline": { "type": "object", "properties": { "a": { "type": "string" } } },
                    "named": { "allOf": [{ "$ref": "#/components/schemas/Typed" }] },
                },
            },
            "values": { "type": "object", "additionalProperties": { "type": "string" } },
            "closed": {
                "type": "object",
                "properties": { "a": { "type": "string" } },
                "additionalProperties": false,
            },
            "open": {
                "type": "object",
                "properties": { "a": { "type": "string" } },
                "additionalProperties": true,
            },
        }),
        json!({
            "Typed": { "type": "object", "properties": { "a": { "type": "string" } } },
        }),
    );
    let root = root(&document);

    let typed = root.field("typed").unwrap();
    assert_eq!(typed.field("a").unwrap().default(), Some(&json!("x")));
    assert!(typed.field("b").is_none());

    assert!(root.field("preserved").unwrap().field("b").is_some());
    assert!(root.field("preserved").unwrap().field("a").is_some());

    let inside = root.field("inside").unwrap();
    assert!(inside.field("inline").unwrap().field("b").is_some());
    assert!(inside.field("named").unwrap().field("b").is_none());

    let values = root.field("values").unwrap();
    assert!(values.field("anything").is_some());
    assert!(values.field("anything").unwrap().field("x").is_none());

    assert!(root.field("closed").unwrap().field("b").is_none());
    assert!(root.field("open").unwrap().field("b").is_some());
}

#[test]
fn a_reference_takes_the_map_type_written_beside_it_over_its_targets() {
    let document = document(
        json!({
            "inherited": { "allOf": [{ "$ref": "#/components/schemas/Atomic" }] },
            "overridden": {
                "allOf": [{ "$ref": "#/components/schemas/Atomic" }],
                "x-kubernetes-map-type": "granular",
            },
            "forced": {
                "allOf": [{ "$ref": "#/components/schemas/Granular" }],
                "x-kubernetes-map-type": "atomic",
            },
            "direct": { "$ref": "#/components/schemas/Atomic" },
            "inline": {
                "type": "object",
                "x-kubernetes-map-type": "atomic",
                "additionalProperties": { "type": "string" },
            },
            "granular": { "type": "object", "x-kubernetes-map-type": "granular" },
            "plain": { "type": "object", "additionalProperties": { "type": "string" } },
            "number": { "type": "integer", "x-kubernetes-map-type": "atomic" },
        }),
        json!({
            "Atomic": { "type": "object", "x-kubernetes-map-type": "atomic" },
            "Granular": { "type": "object" },
        }),
    );
    let root = root(&document);
    let atomic = |name: &str| root.field(name).unwrap().atomic_map();
    assert!(atomic("inherited"));
    assert!(!atomic("overridden"));
    assert!(atomic("forced"));
    assert!(atomic("direct"));
    assert!(atomic("inline"));
    assert!(!atomic("granular"));
    assert!(!atomic("plain"));
    assert!(!atomic("number"));
}

#[test]
fn a_reference_that_leads_nowhere_has_no_node() {
    let document = document(
        json!({ "lost": { "allOf": [{ "$ref": "#/components/schemas/Gone" }] } }),
        json!({}),
    );
    assert!(root(&document).field("lost").is_none());
}

#[test]
fn a_nullable_schema_takes_null_as_a_type() {
    let document = document(
        json!({
            "text": { "type": "string", "nullable": true },
            "never": { "type": "string", "nullable": false },
            "choice": { "type": "string", "enum": ["a", "b"], "nullable": true },
            "object": {
                "allOf": [{ "$ref": "#/components/schemas/Object" }],
                "nullable": true,
                "description": "An object.",
                "default": {},
            },
            "number": {
                "x-kubernetes-int-or-string": true,
                "nullable": true,
                "description": "Either.",
            },
        }),
        json!({ "Object": { "type": "object" } }),
    );
    let properties = &json_schema(&document)["properties"];
    assert_eq!(properties["text"]["type"], json!(["string", "null"]));
    assert!(properties["text"].get("nullable").is_none());
    assert_eq!(properties["never"]["type"], "string");
    assert_eq!(properties["choice"]["enum"], json!(["a", "b"]));
    assert_eq!(properties["choice"]["type"], json!(["string", "null"]));
    assert_eq!(
        properties["object"],
        json!({
            "anyOf": [{ "$ref": "#/definitions/Object" }, { "type": "null" }],
            "description": "An object.",
            "default": {},
        })
    );
    assert_eq!(
        properties["number"],
        json!({
            "anyOf": [
                { "anyOf": [{ "type": "integer" }, { "type": "string" }] },
                { "type": "null" }
            ],
            "description": "Either.",
        })
    );
}

#[test]
fn int_or_string_keeps_the_types_it_lists_and_gets_them_otherwise() {
    let document = document(
        json!({
            "bare": { "x-kubernetes-int-or-string": true },
            "listed": {
                "x-kubernetes-int-or-string": true,
                "anyOf": [{ "type": "integer" }, { "type": "string", "pattern": "^[0-9]+%$" }],
            },
        }),
        json!({}),
    );
    let properties = &json_schema(&document)["properties"];
    assert_eq!(
        properties["bare"],
        json!({ "anyOf": [{ "type": "integer" }, { "type": "string" }] })
    );
    assert_eq!(
        properties["listed"],
        json!({ "anyOf": [{ "type": "integer" }, { "type": "string", "pattern": "^[0-9]+%$" }] })
    );
}

#[test]
fn a_boolean_exclusive_bound_is_the_bound_itself() {
    let document = document(
        json!({
            "above": { "type": "integer", "minimum": 1, "exclusiveMinimum": true },
            "below": { "type": "integer", "maximum": 9, "exclusiveMaximum": true },
            "within": { "type": "integer", "minimum": 1, "exclusiveMinimum": false },
            "unbounded": { "type": "integer", "exclusiveMaximum": true },
            "numeric": { "type": "integer", "exclusiveMinimum": 2 },
        }),
        json!({}),
    );
    let properties = &json_schema(&document)["properties"];
    assert_eq!(
        properties["above"],
        json!({ "type": "integer", "exclusiveMinimum": 1 })
    );
    assert_eq!(
        properties["below"],
        json!({ "type": "integer", "exclusiveMaximum": 9 })
    );
    assert_eq!(
        properties["within"],
        json!({ "type": "integer", "minimum": 1 })
    );
    assert_eq!(properties["unbounded"], json!({ "type": "integer" }));
    assert_eq!(
        properties["numeric"],
        json!({ "type": "integer", "exclusiveMinimum": 2 })
    );
}

#[test]
fn a_typed_object_refuses_unknown_fields_unless_it_preserves_or_declares_them() {
    let document = document(
        json!({
            "typed": { "type": "object", "properties": { "a": { "type": "string" } } },
            "preserved": {
                "type": "object",
                "x-kubernetes-preserve-unknown-fields": true,
                "properties": {
                    "inline": { "type": "object", "properties": { "a": { "type": "string" } } },
                    "named": { "allOf": [{ "$ref": "#/components/schemas/Typed" }] },
                },
            },
            "values": {
                "type": "object",
                "properties": { "a": { "type": "string" } },
                "additionalProperties": { "type": "string" },
            },
            "free": { "type": "object" },
            "empty": { "type": "object", "properties": {} },
        }),
        json!({
            "Typed": { "type": "object", "properties": { "a": { "type": "string" } } },
        }),
    );
    let schema = json_schema(&document);
    let properties = &schema["properties"];
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(properties["typed"]["additionalProperties"], false);
    assert!(
        properties["preserved"]
            .get("additionalProperties")
            .is_none()
    );
    assert!(
        properties["preserved"]["properties"]["inline"]
            .get("additionalProperties")
            .is_none()
    );
    assert_eq!(
        schema["definitions"]["Typed"]["additionalProperties"],
        false
    );
    assert_eq!(
        properties["values"]["additionalProperties"],
        json!({ "type": "string" })
    );
    assert!(properties["free"].get("additionalProperties").is_none());
    assert!(properties["empty"].get("additionalProperties").is_none());
}

#[test]
fn a_property_named_like_an_extension_stays_and_the_extension_goes() {
    let document = document(
        json!({
            "keywords": {
                "type": "object",
                "x-kubernetes-map-type": "atomic",
                "properties": {
                    "x-kubernetes-preserve-unknown-fields": { "type": "boolean" },
                    "x-kubernetes-list-type": { "type": "string" },
                },
            },
        }),
        json!({}),
    );
    let keywords = &json_schema(&document)["properties"]["keywords"];
    assert!(keywords.get("x-kubernetes-map-type").is_none());
    assert_eq!(
        keywords["properties"]["x-kubernetes-preserve-unknown-fields"],
        json!({ "type": "boolean" })
    );
    assert_eq!(
        keywords["properties"]["x-kubernetes-list-type"],
        json!({ "type": "string" })
    );
    assert_eq!(keywords["additionalProperties"], false);
}

#[test]
fn a_definition_that_holds_itself_is_defined_once() {
    let document = document(
        json!({
            "tree": { "allOf": [{ "$ref": "#/components/schemas/Tree" }] },
            "again": { "allOf": [{ "$ref": "#/components/schemas/example.Kind" }] },
        }),
        json!({
            "Tree": {
                "type": "object",
                "properties": {
                    "children": {
                        "type": "array",
                        "items": { "$ref": "#/components/schemas/Tree" },
                    },
                },
            },
        }),
    );
    let schema = json_schema(&document);
    let mut names: Vec<_> = schema["definitions"].as_object().unwrap().keys().collect();
    names.sort();
    assert_eq!(names, ["Tree", "example.Kind"]);
    assert_eq!(
        schema["definitions"]["Tree"]["properties"]["children"]["items"]["$ref"],
        "#/definitions/Tree"
    );
    assert!(
        schema["definitions"]["example.Kind"]["properties"]
            .get("again")
            .is_some()
    );
}

#[test]
fn a_kind_the_document_does_not_declare_has_no_schema_and_no_shape() {
    let document = document(json!({}), json!({}));
    let other = GroupVersionKind::gvk("example.com", "v2", "Kind");
    assert!(document.json_schema(&other).is_none());
    assert!(document.shape(&other).is_none());
}

#[test]
fn the_types_whose_zero_value_is_null_take_null() {
    let document = document(
        json!({
            "created": { "allOf": [{ "$ref": "#/components/schemas/io.k8s.apimachinery.pkg.apis.meta.v1.Time" }] },
            "seen": { "allOf": [{ "$ref": "#/components/schemas/io.k8s.apimachinery.pkg.apis.meta.v1.MicroTime" }] },
            "text": { "type": "string", "format": "date-time" },
        }),
        json!({
            "io.k8s.apimachinery.pkg.apis.meta.v1.Time": { "type": "string", "format": "date-time" },
            "io.k8s.apimachinery.pkg.apis.meta.v1.MicroTime": { "type": "string", "format": "date-time" },
        }),
    );
    let schema = json_schema(&document);
    for name in ["Time", "MicroTime"] {
        assert_eq!(
            schema["definitions"][format!("io.k8s.apimachinery.pkg.apis.meta.v1.{name}")],
            json!({ "type": ["string", "null"], "format": "date-time" })
        );
    }
    assert_eq!(schema["properties"]["text"]["type"], "string");
}

#[test]
fn a_value_validation_constrains_fields_and_never_closes_the_object() {
    let member = json!({ "properties": { "a": { "minLength": 1 } } });
    let document = document(
        json!({
            "spec": {
                "type": "object",
                "properties": { "a": { "type": "string" }, "b": { "type": "string" } },
                "allOf": [member],
                "anyOf": [member],
                "oneOf": [member],
                "not": member,
            },
        }),
        json!({}),
    );
    let schema = json_schema(&document);
    let spec = &schema["properties"]["spec"];
    assert_eq!(spec["additionalProperties"], false);
    for validation in [
        &spec["allOf"][0],
        &spec["anyOf"][0],
        &spec["oneOf"][0],
        &spec["not"],
    ] {
        assert_eq!(validation["properties"]["a"]["minLength"], 1);
        assert_eq!(validation.get("additionalProperties"), None);
    }
}
