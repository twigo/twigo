use std::collections::HashMap;

use kube::core::GroupVersionKind;
use serde_json::{Value, json};

use super::fields::{Element, FieldSet, Path};
use super::owned::{self, Ownership};
use super::{
    Built, Edit, ForeignVersion, build, changes, for_create, manifest, merge_patch, still_has,
    without,
};
use crate::openapi::{Document, Node};

fn apps() -> Document {
    let whole: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/openapi/apis-apps-v1.json"
    ))
    .unwrap();
    Document {
        schemas: whole["components"]["schemas"].as_object().unwrap().clone(),
    }
}

fn synthetic(properties: Value) -> Document {
    let mut schemas = serde_json::Map::new();
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

fn deployment_root(document: &Document) -> Node<'_> {
    document
        .shape(&GroupVersionKind::gvk("apps", "v1", "Deployment"))
        .unwrap()
}

fn synthetic_root(document: &Document) -> Node<'_> {
    document
        .shape(&GroupVersionKind::gvk("example.com", "v1", "Kind"))
        .unwrap()
}

fn deployment() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/apply/deployment.json")).unwrap()
}

fn configmap() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/apply/configmap.json")).unwrap()
}

fn view(object: &Value) -> Value {
    let mut object = object.clone();
    object["metadata"]
        .as_object_mut()
        .unwrap()
        .remove("managedFields");
    object
}

fn paths(paths: &[Path]) -> Vec<String> {
    paths.iter().map(ToString::to_string).collect()
}

fn built(live: &Value, base: &Value, edited: &Value, root: Node<'_>, dropped: &[String]) -> Built {
    build(Edit {
        live,
        base,
        edited,
        root,
        status_subresource: true,
        lock: "42",
        dropped,
    })
    .unwrap()
}

#[test]
fn fields_v1_reads_members_children_and_every_kind_of_element() {
    let set = FieldSet::parse(&json!({
        "f:a": {},
        "f:b": { ".": {}, "f:c": {} },
        "f:list": {
            "k:{\"name\":\"x\",\"port\":80}": { ".": {}, "f:value": {} },
        },
        "f:set": { "v:\"one\"": {}, "v:2": {} },
        "i:0": {},
        "z:unknown": {},
    }));
    let field = |name: &str| Element::Field(name.to_owned());
    let key = Element::Key(vec![
        ("name".to_owned(), "\"x\"".to_owned()),
        ("port".to_owned(), "80".to_owned()),
    ]);
    let cases: Vec<(Vec<Element>, bool)> = vec![
        (vec![field("a")], true),
        (vec![field("b")], true),
        (vec![field("b"), field("c")], true),
        (vec![field("c")], false),
        (vec![field("list"), key.clone()], true),
        (vec![field("list"), key.clone(), field("value")], true),
        (vec![field("list")], false),
        (
            vec![field("set"), Element::Value("\"one\"".to_owned())],
            true,
        ),
        (vec![field("set"), Element::Value("2".to_owned())], true),
        (vec![field("set"), Element::Value("3".to_owned())], false),
    ];
    for (path, member) in cases {
        assert_eq!(set.contains(&path), member, "{path:?}");
    }
    assert_eq!(set.members.len(), 2, "f:a and f:b are members of the root");
    assert_eq!(set.children.len(), 3);
}

#[test]
fn a_path_reads_as_the_server_names_it_in_a_conflict() {
    let path = Path(vec![
        Element::Field("spec".to_owned()),
        Element::Field("containers".to_owned()),
        Element::Key(vec![("name".to_owned(), "\"app\"".to_owned())]),
        Element::Field("ports".to_owned()),
        Element::Key(vec![
            ("containerPort".to_owned(), "80".to_owned()),
            ("protocol".to_owned(), "\"TCP\"".to_owned()),
        ]),
    ]);
    assert_eq!(
        path.to_string(),
        ".spec.containers[name=\"app\"].ports[containerPort=80,protocol=\"TCP\"]"
    );
    let set = Path(vec![Element::Value("\"x\"".to_owned())]);
    assert_eq!(set.to_string(), "[=\"x\"]");
}

#[test]
fn owned_is_what_twigo_applied_with_a_list_map_s_keys_read_from_the_live_object() {
    let live = deployment();
    let document = apps();
    let ownership = Ownership::of(&live);
    let ours = ownership.ours.as_ref().unwrap();
    assert_eq!(ownership.others.len(), 2);
    let extracted = owned::extract(&live, &ours.fields, Some(deployment_root(&document))).unwrap();
    assert_eq!(
        extracted,
        json!({
            "metadata": { "annotations": { "owner": "twigo" } },
            "spec": {
                "replicas": 5,
                "template": { "spec": { "containers": [{
                    "name": "app",
                    "ports": [{ "containerPort": 8080, "protocol": "TCP" }],
                }] } },
            },
        })
    );
}

#[test]
fn owned_leaves_a_claim_on_what_others_filled_and_takes_atomic_values_whole() {
    let document = synthetic(json!({
        "labels": { "type": "object", "additionalProperties": { "type": "string" } },
        "selector": {
            "type": "object",
            "x-kubernetes-map-type": "atomic",
            "additionalProperties": { "type": "string" },
        },
        "args": { "type": "array", "items": { "type": "string" } },
        "finalizers": {
            "type": "array",
            "x-kubernetes-list-type": "set",
            "items": { "type": "string" },
        },
    }));
    let live = json!({
        "labels": { "theirs": "1" },
        "selector": { "app": "web", "tier": "a" },
        "args": ["a", "b"],
        "finalizers": ["x", "y"],
    });
    let fields = FieldSet::parse(&json!({
        "f:labels": {},
        "f:selector": {},
        "f:args": {},
        "f:finalizers": { "v:\"y\"": {} },
    }));
    assert_eq!(
        owned::extract(&live, &fields, Some(synthetic_root(&document))).unwrap(),
        json!({
            "labels": {},
            "selector": { "app": "web", "tier": "a" },
            "args": ["a", "b"],
            "finalizers": ["y"],
        })
    );
}

#[test]
fn owned_keeps_only_an_element_s_keys_when_none_of_its_fields_are_twigo_s() {
    let document = apps();
    let root = deployment_root(&document);
    let live = json!({
        "spec": { "template": { "spec": { "containers": [
            { "name": "app", "image": "x" },
            { "name": "other", "image": "y" },
        ] } } },
    });
    let fields = FieldSet::parse(&json!({
        "f:spec": { "f:template": { "f:spec": { "f:containers": {
            "k:{\"name\":\"app\"}": {},
        } } } },
    }));
    assert_eq!(
        owned::extract(&live, &fields, Some(root)).unwrap(),
        json!({ "spec": { "template": { "spec": { "containers": [{ "name": "app" }] } } } })
    );
}

fn diff(root: Node<'_>, before: Value, after: Value) -> (Value, Vec<String>) {
    let mut removals = Vec::new();
    let changed = changes::of_map(
        before.as_object().unwrap(),
        after.as_object().unwrap(),
        Some(root),
        &[],
        &mut Path::default(),
        &mut removals,
    );
    (Value::Object(changed), paths(&removals))
}

#[test]
fn changes_walk_each_place_as_the_server_merges_it() {
    let document = apps();
    let root = deployment_root(&document);
    let app = |extra: Value| {
        let mut container = json!({ "name": "app", "image": "fake:1" });
        container
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        container
    };
    let spec = |containers: Value| json!({ "spec": { "template": { "spec": { "containers": containers } } } });
    let cases: Vec<(&str, Value, Value, Value, Vec<&str>)> = vec![
        (
            "a scalar that differs is taken",
            json!({ "spec": { "replicas": 1 } }),
            json!({ "spec": { "replicas": 2 } }),
            json!({ "spec": { "replicas": 2 } }),
            vec![],
        ),
        (
            "equal is no change",
            json!({ "spec": { "replicas": 1 } }),
            json!({ "spec": { "replicas": 1 } }),
            json!({}),
            vec![],
        ),
        (
            "a granular map recurses and a key that appears is taken whole",
            json!({ "metadata": { "annotations": { "a": "1" } } }),
            json!({ "metadata": { "annotations": { "a": "1", "b": "2" } } }),
            json!({ "metadata": { "annotations": { "b": "2" } } }),
            vec![],
        ),
        (
            "an atomic map is taken whole",
            json!({ "spec": { "selector": { "matchLabels": { "app": "web" } } } }),
            json!({ "spec": { "selector": { "matchLabels": { "app": "web", "t": "1" } } } }),
            json!({ "spec": { "selector": { "matchLabels": { "app": "web", "t": "1" } } } }),
            vec![],
        ),
        (
            "an atomic list is taken whole",
            spec(json!([app(json!({ "args": ["a"] }))])),
            spec(json!([app(json!({ "args": ["a", "b"] }))])),
            spec(json!([{ "name": "app", "args": ["a", "b"] }])),
            vec![],
        ),
        (
            "a list map pairs by key and carries its keys",
            spec(json!([app(json!({}))])),
            spec(json!([app(json!({ "image": "fake:2" }))])),
            spec(json!([{ "name": "app", "image": "fake:2" }])),
            vec![],
        ),
        (
            "a new element goes whole",
            spec(json!([app(json!({}))])),
            spec(json!([app(json!({})), { "name": "side", "image": "s:1" }])),
            spec(json!([{ "name": "side", "image": "s:1" }])),
            vec![],
        ),
        (
            "an element gone is a removal by its keys",
            spec(json!([app(json!({})), { "name": "side", "image": "s:1" }])),
            spec(json!([app(json!({}))])),
            json!({}),
            vec![".spec.template.spec.containers[name=\"side\"]"],
        ),
        (
            "a port added without protocol pairs by the default key with the one that has it",
            spec(json!([app(
                json!({ "ports": [{ "containerPort": 80, "protocol": "TCP" }] })
            )])),
            spec(json!([app(
                json!({ "ports": [{ "containerPort": 80, "name": "http" }] })
            )])),
            spec(json!([{ "name": "app", "ports": [{ "containerPort": 80, "name": "http" }] }])),
            vec![],
        ),
        (
            "a key given with its default is no change",
            spec(json!([app(json!({ "ports": [{ "containerPort": 80 }] }))])),
            spec(json!([app(
                json!({ "ports": [{ "containerPort": 80, "protocol": "TCP" }] })
            )])),
            json!({}),
            vec![],
        ),
        (
            "a field in an element gone is a removal under its keys",
            spec(json!([app(json!({ "workingDir": "/x" }))])),
            spec(json!([app(json!({}))])),
            json!({}),
            vec![".spec.template.spec.containers[name=\"app\"].workingDir"],
        ),
        (
            "a set takes what was added and removes by value",
            json!({ "metadata": { "finalizers": ["a", "b"] } }),
            json!({ "metadata": { "finalizers": ["a", "c"] } }),
            json!({ "metadata": { "finalizers": ["c"] } }),
            vec![".metadata.finalizers[=\"b\"]"],
        ),
        (
            "a field the schema does not know is taken as a change",
            json!({ "spec": { "replicas": 1 } }),
            json!({ "spec": { "replicas": 1, "bogus": true } }),
            json!({ "spec": { "bogus": true } }),
            vec![],
        ),
        (
            "an explicit null is a removal",
            json!({ "spec": { "minReadySeconds": 3 } }),
            json!({ "spec": { "minReadySeconds": null } }),
            json!({}),
            vec![".spec.minReadySeconds"],
        ),
    ];
    for (name, before, after, want, want_removals) in cases {
        let (got, removals) = diff(root, before, after);
        assert_eq!(got, want, "{name}");
        assert_eq!(removals, want_removals, "{name}");
    }
}

#[test]
fn a_set_list_compares_by_value_on_a_schema_of_its_own() {
    let document = synthetic(json!({
        "tags": {
            "type": "array",
            "x-kubernetes-list-type": "set",
            "items": { "type": "string" },
        },
    }));
    let (got, removals) = diff(
        synthetic_root(&document),
        json!({ "tags": ["a", "b"] }),
        json!({ "tags": ["b", "c"] }),
    );
    assert_eq!(got, json!({ "tags": ["c"] }));
    assert_eq!(removals, vec![".tags[=\"a\"]"]);
}

#[test]
fn a_second_edit_keeps_what_twigo_owns() {
    let live = deployment();
    let document = apps();
    let base = view(&live);
    let mut edited = base.clone();
    edited["metadata"]["annotations"]["owner"] = json!("me");
    let result = built(&live, &base, &edited, deployment_root(&document), &[]);
    let config = result.config.unwrap();
    assert_eq!(config["spec"]["replicas"], 5, "{config}");
    assert_eq!(config["metadata"]["annotations"]["owner"], "me");
    assert_eq!(config["metadata"]["resourceVersion"], "42");
    assert_eq!(config["metadata"]["name"], "web");
    assert_eq!(config["apiVersion"], "apps/v1");
    assert!(result.removals.is_empty());
}

#[test]
fn an_edit_equal_to_its_base_sends_nothing() {
    let live = deployment();
    let document = apps();
    let base = view(&live);
    let result = built(&live, &base, &base, deployment_root(&document), &[]);
    assert!(result.unchanged());
    assert_eq!(result.config, None);
    assert!(result.ignored.is_empty());
}

#[test]
fn what_no_configuration_may_carry_is_reported_not_sent() {
    let live = deployment();
    let document = apps();
    let base = view(&live);
    let mut edited = base.clone();
    edited["status"]["replicas"] = json!(99);
    edited["metadata"]["uid"] = json!("changed");
    edited["metadata"]["annotations"]["new"] = json!("1");
    let result = built(&live, &base, &edited, deployment_root(&document), &[]);
    assert_eq!(result.ignored, vec![".status", ".metadata.uid"]);
    let config = result.config.unwrap();
    assert_eq!(config.get("status"), None);
    assert_eq!(config["metadata"].get("uid"), None);
}

#[test]
fn a_status_with_no_subresource_is_an_ordinary_field() {
    let live = deployment();
    let document = apps();
    let base = view(&live);
    let mut edited = base.clone();
    edited["status"]["replicas"] = json!(99);
    let result = build(Edit {
        live: &live,
        base: &base,
        edited: &edited,
        root: deployment_root(&document),
        status_subresource: false,
        lock: "42",
        dropped: &[],
    })
    .unwrap();
    assert!(result.ignored.is_empty());
    assert_eq!(result.config.unwrap()["status"], json!({ "replicas": 99 }));
}

#[test]
fn a_removal_goes_by_the_apply_only_when_twigo_is_its_only_owner() {
    let live = configmap();
    let document = synthetic(json!({
        "data": { "type": "object", "additionalProperties": { "type": "string" } },
    }));
    let base = view(&live);
    let cases = [
        ("only", vec![], true),
        ("shared", vec![".data.shared"], false),
        ("theirs", vec![".data.theirs"], false),
    ];
    for (key, patch, gives_up) in cases {
        let mut edited = base.clone();
        edited["data"].as_object_mut().unwrap().remove(key);
        let result = built(&live, &base, &edited, synthetic_root(&document), &[]);
        assert_eq!(paths(&result.removals), patch, "{key}");
        assert_eq!(result.config.is_some(), gives_up, "{key}");
        if gives_up {
            assert_eq!(
                result.config.unwrap()["data"],
                json!({ "shared": "2" }),
                "{key}"
            );
        }
    }
}

#[test]
fn a_removed_subtree_goes_by_the_patch_when_any_leaf_is_not_twigo_s_alone() {
    let live = configmap();
    let document = synthetic(json!({
        "data": { "type": "object", "additionalProperties": { "type": "string" } },
    }));
    let base = view(&live);
    let mut edited = base.clone();
    edited.as_object_mut().unwrap().remove("data");
    let result = built(&live, &base, &edited, synthetic_root(&document), &[]);
    assert_eq!(paths(&result.removals), vec![".data"]);
}

#[test]
fn a_field_nobody_owns_needs_the_patch() {
    let mut live = configmap();
    live["metadata"]["managedFields"] = json!([]);
    let document = synthetic(json!({
        "data": { "type": "object", "additionalProperties": { "type": "string" } },
    }));
    let base = view(&live);
    let mut edited = base.clone();
    edited["data"].as_object_mut().unwrap().remove("only");
    let result = built(&live, &base, &edited, synthetic_root(&document), &[]);
    assert_eq!(paths(&result.removals), vec![".data.only"]);
    assert_eq!(result.config, None);
}

#[test]
fn a_change_with_only_a_merge_patch_removal_sends_no_apply() {
    let live = configmap();
    let document = synthetic(json!({
        "data": { "type": "object", "additionalProperties": { "type": "string" } },
    }));
    let base = view(&live);
    let mut edited = base.clone();
    edited["data"].as_object_mut().unwrap().remove("theirs");
    let result = built(&live, &base, &edited, synthetic_root(&document), &[]);
    assert!(!result.unchanged());
    assert_eq!(result.config, None);
}

#[test]
fn a_dropped_path_leaves_the_configuration_and_a_lone_key_claims_nothing() {
    let live = deployment();
    let document = apps();
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["template"]["spec"]["containers"][0]["image"] = json!("fake:2");
    let dropped = vec![".spec.template.spec.containers[name=\"app\"].image".to_owned()];
    let result = built(&live, &base, &edited, deployment_root(&document), &dropped);
    assert!(result.unchanged(), "{result:?}");
}

#[test]
fn a_removal_already_gone_on_the_server_is_no_removal() {
    let live = deployment();
    let document = apps();
    let mut base = view(&live);
    base["metadata"]["annotations"]["gone"] = json!("x");
    let mut edited = view(&live);
    edited["metadata"]["annotations"]
        .as_object_mut()
        .unwrap()
        .remove("gone");
    let result = built(&live, &base, &edited, deployment_root(&document), &[]);
    assert!(result.unchanged());
}

#[test]
fn an_entry_at_another_version_is_refused_when_its_paths_are_lost_and_carried_when_not() {
    let document = apps();
    let mut live = deployment();
    let base = view(&live);
    let mut edited = base.clone();
    edited["metadata"]["annotations"]["new"] = json!("1");
    let twigo = live["metadata"]["managedFields"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["manager"] == "twigo")
        .unwrap();
    twigo["apiVersion"] = json!("apps/v1beta2");
    let carried = built(&live, &base, &edited, deployment_root(&document), &[]);
    assert_eq!(carried.config.unwrap()["spec"]["replicas"], 5);

    twigo_entry(&mut live)["fieldsV1"]["f:spec"]["f:renamed"] = json!({});
    let refused = build(Edit {
        live: &live,
        base: &base,
        edited: &edited,
        root: deployment_root(&document),
        status_subresource: true,
        lock: "42",
        dropped: &[],
    });
    assert_eq!(
        refused,
        Err(ForeignVersion {
            version: "apps/v1beta2".to_owned(),
            paths: vec![".spec.renamed".to_owned()],
        })
    );
}

fn twigo_entry(live: &mut Value) -> &mut Value {
    live["metadata"]["managedFields"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["manager"] == "twigo")
        .unwrap()
}

#[test]
fn a_foreign_entry_sends_every_removal_by_the_merge_patch() {
    let mut live = configmap();
    twigo_entry(&mut live)["apiVersion"] = json!("v1beta1");
    let document = synthetic(json!({
        "data": { "type": "object", "additionalProperties": { "type": "string" } },
    }));
    let base = view(&live);
    let mut edited = base.clone();
    edited["data"].as_object_mut().unwrap().remove("only");
    let result = built(&live, &base, &edited, synthetic_root(&document), &[]);
    assert_eq!(paths(&result.removals), vec![".data.only"]);
    assert_eq!(result.config, None);
}

#[test]
fn the_merge_patch_sends_null_at_a_path_and_the_outermost_list_whole_for_one_in_a_list() {
    let object = json!({
        "metadata": { "labels": { "a": "1", "b": "2" } },
        "spec": {
            "containers": [
                { "name": "a", "image": "x", "ports": [{ "containerPort": 1 }, { "containerPort": 2 }] },
                { "name": "b", "image": "y" },
            ],
        },
    });
    let path = |elements: Vec<Element>| Path(elements);
    let field = |name: &str| Element::Field(name.to_owned());
    let container = |name: &str| Element::Key(vec![("name".to_owned(), format!("\"{name}\""))]);
    let cases: Vec<(&str, Vec<Path>, Option<Value>)> = vec![
        (
            "a map field goes by null",
            vec![path(vec![field("metadata"), field("labels"), field("a")])],
            Some(json!({ "metadata": { "labels": { "a": null } } })),
        ),
        (
            "an element goes by its list",
            vec![path(vec![
                field("spec"),
                field("containers"),
                container("b"),
            ])],
            Some(json!({ "spec": { "containers": [
                { "name": "a", "image": "x", "ports": [{ "containerPort": 1 }, { "containerPort": 2 }] },
            ] } })),
        ),
        (
            "a field in an element sends the outermost list whole, minus it",
            vec![path(vec![
                field("spec"),
                field("containers"),
                container("a"),
                field("image"),
            ])],
            Some(json!({ "spec": { "containers": [
                { "name": "a", "ports": [{ "containerPort": 1 }, { "containerPort": 2 }] },
                { "name": "b", "image": "y" },
            ] } })),
        ),
        (
            "a nested list element goes by the outermost list",
            vec![path(vec![
                field("spec"),
                field("containers"),
                container("a"),
                field("ports"),
                Element::Key(vec![("containerPort".to_owned(), "2".to_owned())]),
            ])],
            Some(json!({ "spec": { "containers": [
                { "name": "a", "image": "x", "ports": [{ "containerPort": 1 }] },
                { "name": "b", "image": "y" },
            ] } })),
        ),
        (
            "what is not there sends nothing",
            vec![path(vec![field("metadata"), field("labels"), field("z")])],
            None,
        ),
    ];
    for (name, removals, want) in cases {
        assert_eq!(merge_patch(&object, &removals), want, "{name}");
    }
}

#[test]
fn the_result_drops_a_removal_and_still_has_says_what_is_left() {
    let object = json!({ "a": { "b": 1, "c": 2 } });
    let path = Path(vec![
        Element::Field("a".to_owned()),
        Element::Field("b".to_owned()),
    ]);
    assert!(still_has(&object, &path));
    assert_eq!(
        without(&object, std::slice::from_ref(&path)),
        json!({ "a": { "c": 2 } })
    );
    assert!(!still_has(
        &without(&object, std::slice::from_ref(&path)),
        &path
    ));
}

#[test]
fn a_manifest_is_its_whole_object_without_the_server_s_fields() {
    let (config, ignored) = manifest(
        &json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "c", "namespace": "n", "uid": "x" },
            "data": { "a": "1" },
            "status": { "ignored": true },
        }),
        true,
    );
    assert_eq!(ignored, vec![".status", ".metadata.uid"]);
    assert_eq!(
        config,
        json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "c", "namespace": "n" },
            "data": { "a": "1" },
        })
    );
}

#[test]
fn a_recreate_loses_what_the_server_made_and_what_the_job_controller_generates() {
    let uid = "e89c896f-9c3d-4d2a-8cc1-b1e12b496eed";
    let job = json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": "j",
            "namespace": "n",
            "uid": uid,
            "resourceVersion": "1",
            "creationTimestamp": "2026-11-08T12:14:53Z",
            "labels": {
                "batch.kubernetes.io/controller-uid": uid,
                "batch.kubernetes.io/job-name": "j",
                "controller-uid": uid,
                "job-name": "j",
                "team": "a",
            },
        },
        "spec": {
            "selector": { "matchLabels": { "batch.kubernetes.io/controller-uid": uid } },
            "manualSelector": false,
            "template": {
                "metadata": { "labels": {
                    "batch.kubernetes.io/controller-uid": uid,
                    "batch.kubernetes.io/job-name": "j",
                    "controller-uid": uid,
                    "job-name": "j",
                    "tier": "b",
                } },
                "spec": { "containers": [{ "name": "a", "image": "x" }] },
            },
        },
        "status": { "active": 1 },
    });
    let body = for_create(&job, true);
    assert_eq!(body.get("status"), None);
    assert_eq!(body["metadata"].get("uid"), None);
    assert_eq!(body["metadata"].get("resourceVersion"), None);
    assert_eq!(body["spec"].get("selector"), None);
    assert_eq!(body["metadata"]["labels"], json!({ "team": "a" }));
    assert_eq!(
        body["spec"]["template"]["metadata"]["labels"],
        json!({ "tier": "b" })
    );

    let mut manual = job.clone();
    manual["spec"]["manualSelector"] = json!(true);
    let body = for_create(&manual, true);
    assert_eq!(
        body["spec"]["selector"],
        json!({ "matchLabels": { "batch.kubernetes.io/controller-uid": uid } })
    );
    assert_eq!(
        body["metadata"]["labels"]["controller-uid"],
        json!(uid),
        "a manual selector's labels are the person's"
    );

    let pod = for_create(
        &json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "p", "resourceVersion": "1", "labels": { "job-name": "kept" } },
            "status": { "phase": "Running" },
        }),
        false,
    );
    assert_eq!(
        pod,
        json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "p", "labels": { "job-name": "kept" } },
        })
    );
}

#[test]
fn ownership_counts_a_subresource_s_entry_and_twigo_s_update_as_another_manager() {
    let live = json!({
        "metadata": { "managedFields": [
            { "manager": "twigo", "operation": "Update", "apiVersion": "v1", "fieldsV1": { "f:a": {} } },
            { "manager": "twigo", "operation": "Apply", "subresource": "status", "apiVersion": "v1", "fieldsV1": { "f:b": {} } },
            { "manager": "twigo", "operation": "Apply", "apiVersion": "v1", "fieldsV1": { "f:c": {} } },
        ] },
    });
    let ownership = Ownership::of(&live);
    assert_eq!(ownership.others.len(), 2);
    let path = |name: &str| Path(vec![Element::Field(name.to_owned())]);
    let want: HashMap<&str, bool> = HashMap::from([("a", false), ("b", false), ("c", true)]);
    for (name, only) in want {
        assert_eq!(ownership.only_ours(&path(name)), only, "{name}");
    }
}
