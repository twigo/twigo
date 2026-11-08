use std::collections::HashMap;

use kube::core::GroupVersionKind;
use serde_json::{Value, json};

use super::fields::{Element, FieldSet, Path};
use super::owned::{self, Ownership};
use super::{
    Built, Combined, Edit, ForeignVersion, Refusal, build, changes, comparable,
    comparable_with_owners, for_create, manifest, merge_patch, normalized, still_has, without,
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
    let mut found = changes::Found::default();
    let changed = changes::of_map(
        normalized(&before, Some(root)).as_object().unwrap(),
        normalized(&after, Some(root)).as_object().unwrap(),
        Some(root),
        &[],
        &mut Path::default(),
        &mut found,
    );
    (Value::Object(changed), paths(&found.removals))
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
    assert_eq!(
        config["metadata"]["uid"], live["metadata"]["uid"],
        "the edit's uid is not sent"
    );
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
        Err(Refusal::Foreign(ForeignVersion {
            version: "apps/v1beta2".to_owned(),
            paths: vec![".spec.renamed".to_owned()],
        }))
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
        None,
        &[],
    );
    assert_eq!(ignored, vec![".status", ".metadata.uid"]);
    assert_eq!(
        config.unwrap(),
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

fn manager(name: &str, operation: &str, fields: Value) -> Value {
    json!({
        "manager": name,
        "operation": operation,
        "fieldsV1": fields,
    })
}

fn owned_by(mut object: Value, managers: Vec<Value>) -> Value {
    let api_version = object["apiVersion"].clone();
    let managers = managers
        .into_iter()
        .map(|mut entry| {
            entry["apiVersion"] = api_version.clone();
            entry
        })
        .collect();
    object["metadata"]["managedFields"] = Value::Array(managers);
    object
}

fn items_document() -> Document {
    synthetic(json!({
        "metadata": { "type": "object", "properties": {
            "name": { "type": "string" },
            "namespace": { "type": "string" },
            "annotations": { "type": "object", "additionalProperties": { "type": "string" } },
        } },
        "refs": {
            "type": "array",
            "x-kubernetes-list-type": "map",
            "x-kubernetes-list-map-keys": ["name"],
            "items": {
                "type": "object",
                "required": ["name"],
                "x-kubernetes-map-type": "atomic",
                "properties": {
                    "name": { "type": "string" },
                    "ns": { "type": "string" },
                    "kind": { "type": "string" },
                },
            },
        },
        "tags": {
            "type": "array",
            "x-kubernetes-list-type": "set",
            "items": { "type": "string" },
        },
        "items": {
            "type": "array",
            "x-kubernetes-list-type": "map",
            "x-kubernetes-list-map-keys": ["name"],
            "items": {
                "type": "object",
                "required": ["name"],
                "properties": {
                    "name": { "type": "string" },
                    "value": { "type": "string" },
                    "other": { "type": "string" },
                },
            },
        },
        "ports": {
            "type": "array",
            "x-kubernetes-list-type": "map",
            "x-kubernetes-list-map-keys": ["port", "protocol"],
            "items": {
                "type": "object",
                "required": ["port"],
                "properties": {
                    "port": { "type": "integer" },
                    "protocol": { "type": "string", "default": "TCP" },
                    "name": { "type": "string" },
                },
            },
        },
        "free": { "type": "object", "x-kubernetes-preserve-unknown-fields": true },
        "conf": {
            "type": "object",
            "x-kubernetes-map-type": "atomic",
            "additionalProperties": { "type": "string" },
        },
        "lst": {
            "type": "array",
            "x-kubernetes-list-type": "atomic",
            "items": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "value": { "type": "string" },
                },
            },
        },
    }))
}

fn widget(spec: Value) -> Value {
    let mut object = json!({
        "apiVersion": "example.com/v1",
        "kind": "Kind",
        "metadata": { "name": "one", "namespace": "n", "resourceVersion": "9" },
    });
    object
        .as_object_mut()
        .unwrap()
        .extend(spec.as_object().unwrap().clone());
    object
}

fn item(name: &str) -> String {
    format!("k:{{\"name\":\"{name}\"}}")
}

fn deployment_with(metadata: Value, managers: Vec<Value>) -> Value {
    let mut object = json!({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": { "name": "web", "namespace": "n" },
        "spec": { "replicas": 1 },
    });
    object["metadata"]
        .as_object_mut()
        .unwrap()
        .extend(metadata.as_object().unwrap().clone());
    owned_by(object, managers)
}

#[test]
fn deleting_an_object_s_only_metadata_map_removes_that_map_by_its_own_path() {
    let document = apps();
    let live = deployment_with(
        json!({ "labels": { "a": "1" } }),
        vec![manager(
            "other",
            "Update",
            json!({ "f:metadata": { "f:labels": { "f:a": {} } } }),
        )],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["metadata"].as_object_mut().unwrap().remove("labels");
    let result = built(&live, &base, &edited, deployment_root(&document), &[]);
    assert_eq!(paths(&result.removals), vec![".metadata.labels"]);
    assert_eq!(
        merge_patch(&live, &result.removals).unwrap(),
        json!({ "metadata": { "labels": null } })
    );
}

#[test]
fn a_null_reaches_nothing_downstream_as_a_change_or_a_key() {
    let document = items_document();
    let root = synthetic_root(&document);
    let live = owned_by(
        widget(json!({
            "ports": [{ "port": 80, "protocol": "TCP", "name": "a" }],
            "free": { "stamp": null },
        })),
        vec![],
    );
    let base = view(&live);

    let mut edited = base.clone();
    edited["metadata"]["annotations"] = json!({ "note": null });
    edited["free"]["added"] = json!({ "kept": 1, "gone": null });
    let result = built(&live, &base, &edited, root, &[]);
    let config = result.config.unwrap();
    assert_eq!(config["metadata"]["annotations"], json!({}), "{config}");
    assert_eq!(
        config["free"],
        json!({ "added": { "kept": 1, "gone": null } }),
        "under a deduced node a null is a value: {config}"
    );
    assert_eq!(result.removals, vec![]);

    let mut edited = base.clone();
    edited["ports"][0]["protocol"] = Value::Null;
    edited["ports"][0]["name"] = json!("b");
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(
        result.config.unwrap()["ports"],
        json!([{ "port": 80, "name": "b" }]),
        "a key left null is read as its default and carried by neither side"
    );
    assert_eq!(result.removals, vec![]);

    let result = built(&live, &base, &base, root, &[]);
    assert!(result.unchanged(), "{result:?}");
}

#[test]
fn a_duplicate_of_a_key_is_left_as_it_is_when_another_element_is_edited() {
    let document = items_document();
    let live = owned_by(
        widget(json!({ "items": [
            { "name": "A", "value": "1" },
            { "name": "A", "value": "2" },
            { "name": "B", "value": "x" },
        ] })),
        vec![],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["items"][2]["value"] = json!("y");
    let result = built(&live, &base, &edited, synthetic_root(&document), &[]);
    assert_eq!(
        result.config.unwrap()["items"],
        json!([{ "name": "B", "value": "y" }])
    );
    assert_eq!(result.removals, vec![]);
}

#[test]
fn owned_never_emits_a_key_the_live_object_duplicates() {
    let document = items_document();
    let live = widget(json!({ "items": [
        { "name": "A", "value": "1" },
        { "name": "A", "value": "2" },
        { "name": "B", "value": "x" },
    ] }));
    let fields = FieldSet::parse(&json!({ "f:items": {
        item("A"): { ".": {}, "f:name": {}, "f:value": {} },
        item("B"): { ".": {}, "f:name": {}, "f:value": {} },
    } }));
    assert_eq!(
        owned::extract(&live, &fields, Some(synthetic_root(&document))).unwrap()["items"],
        json!([{ "name": "B", "value": "x" }])
    );
}

#[test]
fn a_field_that_became_atomic_is_extracted_whole_whatever_the_set_names() {
    let document = items_document();
    let live = widget(json!({
        "conf": { "a": "1", "b": "2" },
        "lst": [{ "name": "l1", "value": "v" }, { "name": "l2" }],
    }));
    let fields = FieldSet::parse(&json!({
        "f:conf": { "f:a": {} },
        "f:lst": { item("l1"): { ".": {}, "f:name": {}, "f:value": {} } },
    }));
    assert_eq!(
        owned::extract(&live, &fields, Some(synthetic_root(&document))).unwrap(),
        json!({
            "conf": { "a": "1", "b": "2" },
            "lst": [{ "name": "l1", "value": "v" }, { "name": "l2" }],
        })
    );
}

#[test]
fn a_co_owner_of_a_list_element_or_a_deduced_map_keeps_a_removal_for_the_patch() {
    let document = items_document();
    let root = synthetic_root(&document);
    let element = |also: Value| {
        let mut fields = json!({ ".": {}, "f:name": {} });
        fields
            .as_object_mut()
            .unwrap()
            .extend(also.as_object().unwrap().clone());
        json!({ "f:items": { item("x"): fields } })
    };
    let live = owned_by(
        widget(json!({ "items": [{ "name": "x", "value": "2" }] })),
        vec![
            manager("gitops", "Apply", element(json!({}))),
            manager("twigo", "Apply", element(json!({ "f:value": {} }))),
        ],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["items"] = json!([]);
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(paths(&result.removals), vec![".items[name=\"x\"]"]);

    let live = owned_by(
        widget(json!({ "free": { "m": { "k": "1" } } })),
        vec![
            manager("gitops", "Apply", json!({ "f:free": { "f:m": {} } })),
            manager(
                "twigo",
                "Apply",
                json!({ "f:free": { "f:m": { "f:k": {} } } }),
            ),
        ],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["free"].as_object_mut().unwrap().remove("m");
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(paths(&result.removals), vec![".free.m"]);

    let live = owned_by(
        widget(json!({ "items": [{ "name": "x", "value": "2" }] })),
        vec![manager("twigo", "Apply", element(json!({ "f:value": {} })))],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited.as_object_mut().unwrap().remove("items");
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(result.removals, vec![], "Twigo alone holds it");
    assert!(result.config.is_some());
}

#[test]
fn a_removal_keeps_the_element_it_empties_named_unless_another_manager_holds_it_as_a_member() {
    let document = apps();
    let root = deployment_root(&document);
    let element = |fields: Value| json!({ "f:spec": { "f:template": { "f:spec": { "f:containers": { item("app"): fields } } } } });
    let twigo = manager(
        "twigo",
        "Apply",
        element(json!({ ".": {}, "f:name": {}, "f:workingDir": {} })),
    );
    let bare = Some(json!({ "name": "app" }));
    for (case, others, expected) in [
        ("Twigo alone holds it", vec![], bare.clone()),
        (
            "another holds it as a member",
            vec![manager(
                "gitops",
                "Apply",
                element(json!({ ".": {}, "f:name": {}, "f:image": {} })),
            )],
            None,
        ),
        (
            "another holds only a field under it, and the server deletes it all the same",
            vec![manager("helm", "Update", element(json!({ "f:image": {} })))],
            bare.clone(),
        ),
    ] {
        let mut managers = others;
        managers.push(twigo.clone());
        let mut live = deployment_with(json!({}), managers);
        live["spec"] = json!({ "template": { "spec": { "containers": [
            { "name": "app", "image": "x", "workingDir": "/x" },
        ] } } });
        let base = view(&live);
        let mut edited = base.clone();
        edited["spec"]["template"]["spec"]["containers"][0]
            .as_object_mut()
            .unwrap()
            .remove("workingDir");
        let result = built(&live, &base, &edited, root, &[]);
        let config = result.config.expect(case);
        match &expected {
            Some(element) => assert_eq!(
                config["spec"]["template"]["spec"]["containers"],
                json!([element]),
                "{case}: {config}"
            ),
            None => assert_eq!(config.get("spec"), None, "{case}: {config}"),
        }
    }
    let mut live = deployment_with(json!({}), vec![twigo.clone()]);
    live["spec"] = json!({ "template": { "spec": { "containers": [
        { "name": "app", "image": "x", "workingDir": "/x" },
    ] } } });
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["template"]["spec"]["containers"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "name": "only-keys" }));
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(
        result.config.unwrap()["spec"]["template"]["spec"]["containers"][1],
        json!({ "name": "only-keys" }),
        "an element the person added with only its keys stays"
    );
}

#[test]
fn a_removal_keeps_the_map_it_empties_in_the_configuration_unless_another_manager_keeps_it() {
    let document = apps();
    let root = deployment_root(&document);
    let volume = |fields: Value| json!({ "f:spec": { "f:template": { "f:spec": { "f:volumes": { item("cache"): fields } } } } });
    let twigo = manager(
        "twigo",
        "Apply",
        volume(json!({ ".": {}, "f:name": {}, "f:emptyDir": { "f:medium": {} } })),
    );
    let live_with = |managers: Vec<Value>, empty_dir: Value| {
        let mut live = deployment_with(json!({}), managers);
        live["spec"] = json!({ "template": { "spec": { "volumes": [
            { "name": "cache", "emptyDir": empty_dir },
        ] } } });
        live
    };
    let edited_of = |live: &Value, empty_dir: Value| {
        let mut edited = view(live);
        edited["spec"]["template"]["spec"]["volumes"][0]["emptyDir"] = empty_dir;
        edited
    };

    for (case, other) in [
        (
            "a member",
            manager("gitops", "Apply", volume(json!({ "f:emptyDir": {} }))),
        ),
        (
            "a declared field held by anything under it",
            manager(
                "helm",
                "Update",
                volume(json!({ "f:emptyDir": { "f:sizeLimit": {} } })),
            ),
        ),
    ] {
        let live = live_with(
            vec![other, twigo.clone()],
            json!({ "medium": "Memory", "sizeLimit": "1Gi" }),
        );
        let edited = edited_of(&live, json!({ "sizeLimit": "1Gi" }));
        let result = built(&live, &view(&live), &edited, root, &[]);
        assert_eq!(
            result.config.unwrap()["spec"]["template"]["spec"]["volumes"],
            json!([{ "name": "cache" }]),
            "{case}: the map goes, and the volume stays named"
        );
    }

    let document = items_document();
    let root = synthetic_root(&document);
    let free = |fields: Value| json!({ "f:free": fields });
    let twigo = manager("twigo", "Apply", free(json!({ "f:m": { "f:k": {} } })));
    for (case, other, expected) in [
        ("nobody else holds it", None, Some(json!({}))),
        (
            "a deduced map's key held as a member",
            Some(free(json!({ "f:m": {} }))),
            None,
        ),
        (
            "a deduced map's key held only under it",
            Some(free(json!({ "f:m": { "f:z": {} } }))),
            Some(json!({})),
        ),
    ] {
        let mut managers = vec![twigo.clone()];
        managers.extend(other.map(|fields| manager("gitops", "Apply", fields)));
        let live = owned_by(
            widget(json!({ "free": { "m": { "k": "1", "z": "2" } } })),
            managers,
        );
        let base = view(&live);
        let mut edited = base.clone();
        edited["free"]["m"].as_object_mut().unwrap().remove("k");
        let config = built(&live, &base, &edited, root, &[]).config.unwrap();
        assert_eq!(
            config["free"].get("m").cloned(),
            expected,
            "{case}: {config}"
        );
    }

    let twigo = manager(
        "twigo",
        "Apply",
        json!({ "f:items": { item("x"): { ".": {}, "f:name": {}, "f:value": {} } } }),
    );
    let live = owned_by(
        widget(json!({ "items": [{ "name": "x", "value": "1" }, { "name": "y", "value": "2" }] })),
        vec![
            twigo,
            manager(
                "gitops",
                "Apply",
                json!({ "f:items": { item("y"): { ".": {}, "f:name": {}, "f:value": {} } } }),
            ),
        ],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["items"].as_array_mut().unwrap().remove(0);
    let config = built(&live, &base, &edited, root, &[]).config.unwrap();
    assert_eq!(config.get("items"), None, "{config}");
}

fn emptying_document() -> Document {
    synthetic(json!({
        "metadata": { "type": "object", "properties": {
            "name": { "type": "string" },
            "annotations": { "type": "object", "additionalProperties": { "type": "string" } },
        } },
        "spec": { "type": "object", "properties": {
            "note": { "type": "string" },
            "other": { "type": "string" },
            "rules": {
                "type": "array",
                "x-kubernetes-list-type": "map",
                "x-kubernetes-list-map-keys": ["k"],
                "items": { "type": "object", "required": ["k"], "properties": {
                    "k": { "type": "string" },
                    "v": { "type": "string" },
                } },
            },
            "tags": {
                "type": "array",
                "x-kubernetes-list-type": "set",
                "items": { "type": "string" },
            },
            "sub": { "type": "object", "properties": {
                "x": { "type": "string" },
                "y": { "type": "string" },
            } },
            "labels": { "type": "object", "additionalProperties": { "type": "string" } },
            "free": { "type": "object", "x-kubernetes-preserve-unknown-fields": true },
            "conf": {
                "type": "object",
                "x-kubernetes-map-type": "atomic",
                "additionalProperties": { "type": "string" },
            },
            "lst": {
                "type": "array",
                "x-kubernetes-list-type": "atomic",
                "items": { "type": "string" },
            },
            "items": {
                "type": "array",
                "x-kubernetes-list-type": "map",
                "x-kubernetes-list-map-keys": ["name"],
                "items": { "type": "object", "required": ["name"], "properties": {
                    "name": { "type": "string" },
                    "sub": { "type": "object", "properties": { "x": { "type": "string" } } },
                    "nested": {
                        "type": "array",
                        "x-kubernetes-list-type": "map",
                        "x-kubernetes-list-map-keys": ["id"],
                        "items": { "type": "object", "required": ["id"], "properties": {
                            "id": { "type": "string" },
                        } },
                    },
                } },
            },
        } },
    }))
}

#[test]
fn an_edit_that_leaves_a_map_or_a_list_empty_goes_by_the_one_merge_patch() {
    let document = emptying_document();
    let root = synthetic_root(&document);
    for (case, spec, edited, patch) in [
        (
            "a list map, Twigo's only field under spec, beside an unowned field",
            json!({ "rules": [{ "k": "a", "v": "1" }], "other": "theirs" }),
            json!({ "rules": [], "other": "theirs" }),
            json!({ "rules": [] }),
        ),
        (
            "a set",
            json!({ "tags": ["a", "b"] }),
            json!({ "tags": [] }),
            json!({ "tags": [] }),
        ),
        (
            "a typed map",
            json!({ "sub": { "x": "1" } }),
            json!({ "sub": {} }),
            json!({ "sub": { "x": null } }),
        ),
        (
            "an additionalProperties map",
            json!({ "labels": { "a": "1", "b": "2" } }),
            json!({ "labels": {} }),
            json!({ "labels": { "a": null, "b": null } }),
        ),
        (
            "a preserved map",
            json!({ "free": { "a": { "b": 1 } } }),
            json!({ "free": {} }),
            json!({ "free": { "a": null } }),
        ),
        (
            "a map nested in a preserved one",
            json!({ "free": { "a": { "b": 1 }, "z": 1 } }),
            json!({ "free": { "a": {}, "z": 1 } }),
            json!({ "free": { "a": { "b": null } } }),
        ),
        (
            "a map in a list element, which goes with its list",
            json!({ "items": [{ "name": "x", "sub": { "x": "1" } }] }),
            json!({ "items": [{ "name": "x", "sub": {} }] }),
            json!({ "items": [{ "name": "x", "sub": {} }] }),
        ),
        (
            "a list in a list element",
            json!({ "items": [{ "name": "x", "nested": [{ "id": "n" }] }] }),
            json!({ "items": [{ "name": "x", "nested": [] }] }),
            json!({ "items": [{ "name": "x", "nested": [] }] }),
        ),
    ] {
        let fields = |spec: &Value| {
            let names: serde_json::Map<String, Value> = spec
                .as_object()
                .unwrap()
                .keys()
                .filter(|name| *name != "other")
                .map(|name| (format!("f:{name}"), json!({})))
                .collect();
            json!({ "f:spec": names })
        };
        let live = owned_by(
            widget(json!({ "spec": spec })),
            vec![manager("twigo", "Apply", fields(&spec))],
        );
        let base = view(&live);
        let mut changed = base.clone();
        changed["spec"] = edited;
        let result = built(&live, &base, &changed, root, &[]);
        assert_eq!(result.config, None, "{case}");
        assert_eq!(only_patch(&result), &json!({ "spec": patch }), "{case}");
    }

    let document = apps();
    let root = deployment_root(&document);
    let mut live = deployment_with(json!({}), vec![]);
    live["spec"] = json!({ "template": { "spec": { "volumes": [
        { "name": "cache", "emptyDir": { "medium": "Memory" } },
    ] } } });
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["template"]["spec"]["volumes"][0]["emptyDir"] = json!({});
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(
        only_patch(&result),
        &json!({ "spec": { "template": { "spec": { "volumes": [
            { "name": "cache", "emptyDir": {} },
        ] } } } }),
        "a built-in's map, the volume kept"
    );
}

#[test]
fn what_an_apply_can_say_empty_stays_an_apply() {
    let document = emptying_document();
    let root = synthetic_root(&document);
    for (case, before, after, sent) in [
        (
            "an atomic map",
            json!({ "conf": { "a": "1" } }),
            json!({ "conf": {} }),
            json!({ "conf": {} }),
        ),
        (
            "an atomic list",
            json!({ "lst": ["1"] }),
            json!({ "lst": [] }),
            json!({ "lst": [] }),
        ),
        (
            "a deduced list, which is atomic",
            json!({ "free": { "l": [1, 2] } }),
            json!({ "free": { "l": [] } }),
            json!({ "free": { "l": [] } }),
        ),
        (
            "a map the edit adds empty",
            json!({ "note": "n" }),
            json!({ "note": "n", "sub": {} }),
            json!({ "sub": {} }),
        ),
    ] {
        let live = owned_by(widget(json!({ "spec": before })), vec![]);
        let base = view(&live);
        let mut edited = base.clone();
        edited["spec"] = after;
        let result = built(&live, &base, &edited, root, &[]);
        assert_eq!(result.combined, Combined::None, "{case}");
        assert_eq!(result.config.unwrap()["spec"], sent, "{case}");
    }

    let live = owned_by(
        widget(json!({ "spec": { "sub": {}, "note": "n" } })),
        vec![],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["note"] = json!("m");
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(
        result.combined,
        Combined::None,
        "a map that was empty already is no edit of it"
    );
}

#[test]
fn a_list_that_loses_twigo_s_last_element_while_the_edit_keeps_one_nobody_owns_goes_by_the_patch() {
    let document = emptying_document();
    let root = synthetic_root(&document);
    let rule = |name: &str| format!("k:{{\"k\":\"{name}\"}}");
    let twigo = manager(
        "twigo",
        "Apply",
        json!({ "f:spec": { "f:rules": { rule("a"): { ".": {}, "f:k": {} } } } }),
    );
    let live = owned_by(
        widget(json!({ "spec": { "rules": [{ "k": "a" }, { "k": "b" }] } })),
        vec![twigo.clone()],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["rules"].as_array_mut().unwrap().remove(0);
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(
        only_patch(&result),
        &json!({ "spec": { "rules": [{ "k": "b" }] } })
    );

    let live = owned_by(
        widget(json!({ "spec": { "tags": ["a", "b"] } })),
        vec![manager(
            "twigo",
            "Apply",
            json!({ "f:spec": { "f:tags": { "v:\"a\"": {} } } }),
        )],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["tags"] = json!(["b"]);
    assert_eq!(
        only_patch(&built(&live, &base, &edited, root, &[])),
        &json!({ "spec": { "tags": ["b"] } })
    );

    let live = owned_by(
        widget(json!({ "spec": { "rules": [{ "k": "a" }, { "k": "b" }] } })),
        vec![
            twigo,
            manager(
                "helm",
                "Update",
                json!({ "f:spec": { "f:rules": { rule("b"): { ".": {}, "f:k": {} } } } }),
            ),
        ],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["rules"].as_array_mut().unwrap().remove(0);
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(result.combined, Combined::None, "another manager keeps it");
    assert_eq!(result.config.unwrap().get("spec"), None);
}

#[test]
fn a_null_on_a_nullable_field_is_a_value_and_elsewhere_it_is_no_value() {
    let document = synthetic(json!({
        "nullable": { "type": "string", "nullable": true },
        "typed": { "type": "string" },
    }));
    let root = synthetic_root(&document);
    let object = json!({ "metadata": {}, "nullable": null, "typed": null });
    assert_eq!(
        normalized(&object, Some(root)),
        json!({ "metadata": {}, "nullable": null })
    );

    let live = owned_by(widget(json!({ "nullable": "set", "typed": "t" })), vec![]);
    let base = view(&live);
    let mut edited = base.clone();
    edited["nullable"] = Value::Null;
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(result.removals, vec![], "a null is no removal here");
    assert_eq!(result.config.unwrap()["nullable"], Value::Null);
}

#[test]
fn a_configuration_of_an_edit_holds_to_the_uid_it_was_built_from() {
    let document = apps();
    let root = deployment_root(&document);
    let live = deployment();
    let uid = live["metadata"]["uid"].clone();
    assert!(uid.is_string(), "the fixture holds one");
    let base = view(&live);
    let mut edited = base.clone();
    edited["metadata"]["annotations"] = json!({ "mine": "1" });
    let config = built(&live, &base, &edited, root, &[]).config.unwrap();
    assert_eq!(config["metadata"]["uid"], uid);
    assert_eq!(config["metadata"]["resourceVersion"], "42");

    let (config, _) = manifest(&edited, true, Some(root), &[]);
    assert_eq!(
        config.unwrap()["metadata"].get("uid"),
        None,
        "a manifest may create its object"
    );
}

fn only_patch(result: &Built) -> &Value {
    match &result.combined {
        Combined::Only(patch) => patch,
        other => panic!("expected the merge patch alone, got {other:?}"),
    }
}

fn env_widget(items: Value) -> Value {
    owned_by(widget(json!({ "items": items })), vec![])
}

#[test]
fn an_element_of_a_duplicated_key_changed_or_removed_goes_by_the_merge_patch_alone() {
    let document = items_document();
    let root = synthetic_root(&document);
    let live = env_widget(json!([
        { "name": "A", "value": "1" },
        { "name": "A", "value": "2" },
        { "name": "B", "value": "x" },
    ]));
    let base = view(&live);

    let mut changed = base.clone();
    changed["items"][1]["value"] = json!("3");
    let result = built(&live, &base, &changed, root, &[]);
    assert_eq!(result.config, None);
    assert_eq!(
        only_patch(&result),
        &json!({ "items": [
            { "name": "A", "value": "1" },
            { "name": "A", "value": "3" },
            { "name": "B", "value": "x" },
        ] })
    );

    let mut removed = base.clone();
    removed["items"].as_array_mut().unwrap().remove(0);
    let result = built(&live, &base, &removed, root, &[]);
    assert_eq!(
        only_patch(&result),
        &json!({ "items": [
            { "name": "A", "value": "2" },
            { "name": "B", "value": "x" },
        ] })
    );
    assert_eq!(
        result.removals,
        vec![],
        "a duplicate has no path of its own"
    );
    assert!(!result.unchanged());
}

#[test]
fn a_reordered_list_map_goes_by_the_merge_patch_alone_and_an_append_does_not() {
    let document = items_document();
    let root = synthetic_root(&document);
    let live = env_widget(json!([
        { "name": "A", "value": "1" },
        { "name": "B", "value": "$(A)" },
    ]));
    let base = view(&live);

    let mut reordered = base.clone();
    reordered["items"].as_array_mut().unwrap().reverse();
    reordered["items"][0]["value"] = json!("$(A)2");
    let result = built(&live, &base, &reordered, root, &[]);
    assert_eq!(result.config, None);
    assert_eq!(
        only_patch(&result),
        &json!({ "items": [
            { "name": "B", "value": "$(A)2" },
            { "name": "A", "value": "1" },
        ] })
    );

    let mut appended = base.clone();
    appended["items"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "name": "C", "value": "3" }));
    let result = built(&live, &base, &appended, root, &[]);
    assert_eq!(result.combined, Combined::None);
    assert!(result.config.is_some());

    let mut removed = base.clone();
    removed["items"].as_array_mut().unwrap().remove(0);
    let result = built(&live, &base, &removed, root, &[]);
    assert_eq!(
        result.combined,
        Combined::Fallback {
            patch: json!({ "items": [{ "name": "B", "value": "$(A)" }] }),
            removals: vec![Path(vec![
                Element::Field("items".to_owned()),
                Element::Key(vec![("name".to_owned(), "\"A\"".to_owned())]),
            ])],
        },
        "losing an element is no reorder"
    );
}

#[test]
fn a_list_map_reordered_inside_an_element_goes_whole_with_the_rest_of_the_edit() {
    let document = apps();
    let root = deployment_root(&document);
    let mut live = deployment_with(json!({ "labels": { "a": "1" } }), vec![]);
    live["spec"] = json!({ "replicas": 1, "template": { "spec": { "containers": [
        { "name": "app", "image": "x", "env": [{ "name": "A", "value": "1" }, { "name": "B", "value": "2" }] },
        { "name": "side", "image": "y" },
    ] } } });
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["replicas"] = json!(2);
    edited["spec"]["template"]["spec"]["containers"][0]["env"]
        .as_array_mut()
        .unwrap()
        .reverse();
    edited["metadata"]["labels"]
        .as_object_mut()
        .unwrap()
        .remove("a");
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(result.config, None);
    assert_eq!(
        only_patch(&result),
        &json!({
            "metadata": { "labels": { "a": null } },
            "spec": { "replicas": 2, "template": { "spec": { "containers": [
                { "name": "app", "image": "x", "env": [{ "name": "B", "value": "2" }, { "name": "A", "value": "1" }] },
                { "name": "side", "image": "y" },
            ] } } },
        })
    );
    assert_eq!(paths(&result.removals), vec![".metadata.labels.a"]);
}

#[test]
fn the_combined_patch_carries_changes_and_removals_over_the_live_object() {
    let document = apps();
    let root = deployment_root(&document);
    let mut live = deployment_with(
        json!({}),
        vec![manager(
            "other",
            "Update",
            json!({ "f:spec": { "f:strategy": { "f:rollingUpdate": {} } } }),
        )],
    );
    live["spec"] = json!({
        "replicas": 1,
        "paused": true,
        "strategy": { "type": "RollingUpdate", "rollingUpdate": { "maxSurge": "25%" } },
    });
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["strategy"] = json!({ "type": "Recreate" });

    live["spec"]["paused"] = json!(false);
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(
        paths(&result.removals),
        vec![".spec.strategy.rollingUpdate"]
    );
    assert!(result.config.is_some());
    let Combined::Fallback { patch, removals } = result.combined else {
        panic!("expected the fallback, got {:?}", result.combined);
    };
    assert_eq!(
        patch,
        json!({ "spec": { "strategy": { "type": "Recreate", "rollingUpdate": null } } }),
        "a change on the server since it was opened is not undone"
    );
    assert_eq!(paths(&removals), vec![".spec.strategy.rollingUpdate"]);
}

#[test]
fn comparing_objects_drops_what_a_status_write_moves_and_only_that() {
    let object = json!({
        "metadata": {
            "name": "web",
            "resourceVersion": "1",
            "generation": 2,
            "managedFields": [],
            "annotations": { "a": "1" },
        },
        "spec": { "template": { "metadata": { "creationTimestamp": null } } },
        "status": { "replicas": 1 },
    });
    let mut moved = object.clone();
    moved["metadata"]["resourceVersion"] = json!("7");
    moved["status"]["replicas"] = json!(2);
    moved["spec"]["template"]["metadata"]
        .as_object_mut()
        .unwrap()
        .remove("creationTimestamp");
    assert_eq!(comparable(&object), comparable(&moved));

    let mut changed_spec = object.clone();
    changed_spec["spec"]["replicas"] = json!(3);
    assert_ne!(comparable(&object), comparable(&changed_spec));
    let mut changed_metadata = object.clone();
    changed_metadata["metadata"]["annotations"]["a"] = json!("2");
    assert_ne!(comparable(&object), comparable(&changed_metadata));
}

#[test]
fn a_manifest_loses_the_paths_given_up_and_nothing_is_left_of_it_when_they_were_all_it_set() {
    let document = items_document();
    let root = synthetic_root(&document);
    let edited = widget(json!({
        "items": [{ "name": "a", "value": "1", "other": "2" }],
        "free": { "x": 1 },
    }));
    let dropped = vec![".items[name=\"a\"].value".to_owned()];
    let (config, _) = manifest(&edited, false, Some(root), &dropped);
    let config = config.unwrap();
    assert_eq!(
        config["items"],
        json!([{ "name": "a", "other": "2" }]),
        "{config}"
    );
    assert_eq!(config["free"], json!({ "x": 1 }));

    let lone = widget(json!({ "free": { "x": 1 } }));
    let dropped = vec![".free.x".to_owned()];
    let (config, _) = manifest(&lone, false, Some(root), &dropped);
    assert_eq!(config, None);
}

#[test]
fn a_configuration_holds_its_elements_in_live_order_and_new_ones_after_them() {
    let document = apps();
    let root = deployment_root(&document);
    let containers = |object: &Value| {
        object["spec"]["template"]["spec"]["containers"]
            .as_array()
            .unwrap()
            .clone()
    };
    let names = |items: &[Value]| -> Vec<String> {
        items
            .iter()
            .map(|item| item["name"].as_str().unwrap().to_owned())
            .collect()
    };
    let mut live = deployment_with(
        json!({}),
        vec![manager(
            "twigo",
            "Apply",
            json!({ "f:spec": { "f:template": { "f:spec": { "f:containers": {
                item("sidecar"): { ".": {}, "f:name": {}, "f:image": {} },
                item("app"): { ".": {}, "f:name": {}, "f:env": {
                    item("DERIVED"): { ".": {}, "f:name": {}, "f:value": {} },
                } },
            } } } } }),
        )],
    );
    live["spec"] = json!({ "template": { "spec": { "containers": [
        {
            "name": "app",
            "image": "a",
            "env": [{ "name": "BASE", "value": "x" }, { "name": "DERIVED", "value": "$(BASE)/z" }],
        },
        { "name": "sidecar", "image": "s" },
    ] } } });
    let base = view(&live);
    let mut edited = base.clone();
    edited["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = json!("x2");
    edited["spec"]["template"]["spec"]["containers"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "name": "extra", "image": "e" }));
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(result.combined, Combined::None);
    let config = result.config.unwrap();
    let got = containers(&config);
    assert_eq!(names(&got), ["app", "sidecar", "extra"], "{config}");
    assert_eq!(
        names(got[0]["env"].as_array().unwrap()),
        ["BASE", "DERIVED"],
        "{config}"
    );
}

#[test]
fn an_element_placed_before_the_end_goes_by_the_merge_patch_and_an_append_does_not() {
    let document = items_document();
    let root = synthetic_root(&document);
    let env = |pairs: &[(&str, &str)]| {
        Value::Array(
            pairs
                .iter()
                .map(|(name, value)| json!({ "name": name, "value": value }))
                .collect(),
        )
    };
    let with_edit = |before: Value, after: Value| {
        let live = env_widget(before);
        let base = view(&live);
        let mut edited = base.clone();
        edited["items"] = after;
        built(&live, &base, &edited, root, &[])
    };
    let inserted = with_edit(
        env(&[("A", "1"), ("B", "$(C)/b")]),
        env(&[("A", "1"), ("C", "c"), ("B", "$(C)/b")]),
    );
    assert_eq!(inserted.config, None);
    assert_eq!(
        only_patch(&inserted),
        &json!({ "items": [
            { "name": "A", "value": "1" },
            { "name": "C", "value": "c" },
            { "name": "B", "value": "$(C)/b" },
        ] })
    );
    let renamed = with_edit(
        env(&[("A", "1"), ("B", "2"), ("C", "3")]),
        env(&[("A", "1"), ("X", "2"), ("C", "3")]),
    );
    assert!(matches!(renamed.combined, Combined::Only(_)), "{renamed:?}");
    let first = with_edit(env(&[("A", "1")]), env(&[("Z", "0"), ("A", "1")]));
    assert!(matches!(first.combined, Combined::Only(_)), "{first:?}");

    let appended = with_edit(env(&[("A", "1")]), env(&[("A", "1"), ("B", "2")]));
    assert_eq!(appended.combined, Combined::None);
    assert!(appended.config.is_some());
    let renamed_last = with_edit(
        env(&[("A", "1"), ("B", "2")]),
        env(&[("A", "1"), ("X", "2")]),
    );
    assert!(
        !matches!(renamed_last.combined, Combined::Only(_)),
        "{renamed_last:?}"
    );
}

#[test]
fn a_changed_element_of_a_list_with_atomic_items_is_taken_whole() {
    let document = items_document();
    let root = synthetic_root(&document);
    let live = owned_by(
        widget(json!({ "refs": [
            { "name": "r", "ns": "n1", "kind": "K" },
            { "name": "s", "ns": "n2", "kind": "L" },
        ] })),
        vec![],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["refs"][0]["ns"] = json!("n9");
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(
        result.config.unwrap()["refs"],
        json!([{ "name": "r", "ns": "n9", "kind": "K" }])
    );
    assert_eq!(result.removals, vec![]);

    let mut edited = base.clone();
    edited["refs"][0].as_object_mut().unwrap().remove("ns");
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(
        result.config.unwrap()["refs"],
        json!([{ "name": "r", "kind": "K" }]),
        "what goes from an atomic element is no removal of its own"
    );
    assert_eq!(result.removals, vec![]);

    let result = built(&live, &base, &base, root, &[]);
    assert!(result.unchanged(), "{result:?}");
}

#[test]
fn a_new_duplicate_of_a_key_goes_by_the_merge_patch_and_keeps_the_element_it_copies() {
    let document = items_document();
    let root = synthetic_root(&document);
    let live = env_widget(json!([{ "name": "A", "value": "1" }]));
    let base = view(&live);
    let mut edited = base.clone();
    edited["items"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "name": "A", "value": "2" }));
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(result.config, None);
    assert_eq!(
        only_patch(&result),
        &json!({ "items": [
            { "name": "A", "value": "1" },
            { "name": "A", "value": "2" },
        ] })
    );
}

#[test]
fn a_reordered_set_goes_by_the_merge_patch_and_so_does_a_value_placed_before_the_end() {
    let document = items_document();
    let root = synthetic_root(&document);
    let live = owned_by(widget(json!({ "tags": ["a", "b"] })), vec![]);
    let base = view(&live);
    let edit_to = |tags: Value| {
        let mut edited = base.clone();
        edited["tags"] = tags;
        built(&live, &base, &edited, root, &[])
    };
    for tags in [json!(["b", "a"]), json!(["a", "c", "b"])] {
        let result = edit_to(tags.clone());
        assert_eq!(result.config, None, "{tags}");
        assert_eq!(only_patch(&result), &json!({ "tags": tags }));
    }
    let appended = edit_to(json!(["a", "b", "c"]));
    assert_eq!(appended.combined, Combined::None);
    assert_eq!(appended.config.unwrap()["tags"], json!(["c"]));
}

#[test]
fn a_null_goes_only_where_the_schema_types_the_field() {
    let document = items_document();
    let root = synthetic_root(&document);
    let object = widget(json!({
        "metadata": { "name": "one", "annotations": { "a": null, "b": "1" } },
        "ports": [{ "port": 80, "protocol": null, "name": null }],
        "free": { "hosts": [{ "host": "a", "tls": null }], "gone": null },
        "conf": { "a": null },
        "lst": [{ "name": "x", "value": null }],
        "refs": [{ "name": "r", "ns": null }],
        "bogus": null,
    }));
    assert_eq!(
        normalized(&object, Some(root)),
        widget(json!({
            "metadata": { "name": "one", "annotations": { "b": "1" } },
            "ports": [{ "port": 80 }],
            "free": { "hosts": [{ "host": "a", "tls": null }], "gone": null },
            "conf": { "a": null },
            "lst": [{ "name": "x", "value": null }],
            "refs": [{ "name": "r", "ns": null }],
            "bogus": null,
        }))
    );
    assert_eq!(normalized(&object, None), object);
}

#[test]
fn what_twigo_owns_keeps_a_null_of_the_live_object_on_an_unrelated_edit() {
    let document = items_document();
    let root = synthetic_root(&document);
    let live = owned_by(
        widget(json!({
            "free": { "hosts": [{ "host": "a", "tls": null }] },
            "tags": ["x"],
        })),
        vec![manager(
            "twigo",
            "Apply",
            json!({ "f:free": { "f:hosts": {} } }),
        )],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["tags"].as_array_mut().unwrap().push(json!("y"));
    let config = built(&live, &base, &edited, root, &[]).config.unwrap();
    assert_eq!(
        config["free"],
        json!({ "hosts": [{ "host": "a", "tls": null }] })
    );

    let live = owned_by(
        widget(json!({
            "items": [{ "name": "a", "value": null }],
            "tags": ["x"],
        })),
        vec![manager(
            "twigo",
            "Apply",
            json!({ "f:items": { item("a"): { ".": {}, "f:name": {}, "f:value": {} } } }),
        )],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["tags"].as_array_mut().unwrap().push(json!("y"));
    let config = built(&live, &base, &edited, root, &[]).config.unwrap();
    assert_eq!(
        config["items"],
        json!([{ "name": "a", "value": null }]),
        "extraction reads the raw live object"
    );
}

#[test]
fn a_list_sent_whole_that_the_server_holds_otherwise_is_refused_and_so_is_one_whose_element_went() {
    let document = apps();
    let root = deployment_root(&document);
    let object = |containers: Value| {
        let mut object = deployment_with(json!({}), vec![]);
        object["spec"] = json!({ "template": { "spec": { "containers": containers } } });
        object
    };
    let opened = object(json!([{ "name": "app", "image": "x", "env": [
        { "name": "A", "value": "1" }, { "name": "B", "value": "2" },
    ] }]));
    let base = view(&opened);
    let mut edited = base.clone();
    edited["spec"]["template"]["spec"]["containers"][0]["env"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let build_over = |live: &Value| {
        build(Edit {
            live,
            base: &base,
            edited: &edited,
            root,
            status_subresource: true,
            lock: "42",
            dropped: &[],
        })
    };
    let path = ".spec.template.spec.containers[name=\"app\"].env".to_owned();

    let other_wrote = object(json!([{ "name": "app", "image": "x", "env": [
        { "name": "A", "value": "from-other" }, { "name": "B", "value": "2" },
        { "name": "X", "value": "other" },
    ] }]));
    assert_eq!(
        build_over(&other_wrote),
        Err(Refusal::ListsMoved(vec![path.clone()]))
    );

    let element_gone = object(json!([{ "name": "other", "image": "x" }]));
    assert_eq!(
        build_over(&element_gone),
        Err(Refusal::ListsMoved(vec![path]))
    );

    let same = object(json!([{ "name": "app", "image": "y", "env": [
        { "name": "A", "value": "1" }, { "name": "B", "value": "2" },
    ] }]));
    assert!(
        matches!(build_over(&same).unwrap().combined, Combined::Only(_)),
        "what the server moved elsewhere does not matter"
    );
}

#[test]
fn comparing_with_owners_counts_a_new_manager_and_not_what_a_status_writer_moves() {
    let object = json!({
        "metadata": {
            "name": "web",
            "resourceVersion": "1",
            "managedFields": [
                { "manager": "a", "operation": "Update", "time": "1", "fieldsV1": { "f:spec": {} } },
                { "manager": "ctl", "operation": "Update", "subresource": "status", "time": "1", "fieldsV1": { "f:status": {} } },
            ],
        },
        "status": { "replicas": 1 },
    });
    let mut status_moved = object.clone();
    status_moved["metadata"]["resourceVersion"] = json!("2");
    status_moved["status"]["replicas"] = json!(2);
    status_moved["metadata"]["managedFields"][0]["time"] = json!("9");
    status_moved["metadata"]["managedFields"][1]["time"] = json!("9");
    status_moved["metadata"]["managedFields"][1]["fieldsV1"] =
        json!({ "f:status": { "f:replicas": {} } });
    assert_eq!(
        comparable_with_owners(&object),
        comparable_with_owners(&status_moved)
    );

    let mut co_owner = object.clone();
    co_owner["metadata"]["managedFields"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "manager": "third", "operation": "Apply", "time": "1", "fieldsV1": { "f:spec": {} } }));
    assert_eq!(comparable(&object), comparable(&co_owner));
    assert_ne!(
        comparable_with_owners(&object),
        comparable_with_owners(&co_owner)
    );
}

#[test]
fn the_fallback_lists_every_removal_it_carries_those_the_apply_would_take_too() {
    let document = items_document();
    let root = synthetic_root(&document);
    let live = owned_by(
        widget(
            json!({ "metadata": { "annotations": { "mine": "1", "theirs": "2", "kept": "3" } } }),
        ),
        vec![
            manager(
                "twigo",
                "Apply",
                json!({ "f:metadata": { "f:annotations": { "f:mine": {} } } }),
            ),
            manager(
                "gitops",
                "Apply",
                json!({ "f:metadata": { "f:annotations": { "f:theirs": {} } } }),
            ),
        ],
    );
    let base = view(&live);
    let mut edited = base.clone();
    edited["metadata"]["annotations"] = json!({ "kept": "3" });
    let result = built(&live, &base, &edited, root, &[]);
    assert_eq!(paths(&result.removals), [".metadata.annotations.theirs"]);
    let Combined::Fallback { removals, .. } = &result.combined else {
        panic!("expected the fallback, got {:?}", result.combined);
    };
    assert_eq!(
        paths(removals),
        [".metadata.annotations.theirs", ".metadata.annotations.mine"]
    );
}
