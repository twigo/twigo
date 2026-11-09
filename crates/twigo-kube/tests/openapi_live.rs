use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use http::Request;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{
    Api, ApiResource, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams,
};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::core::GroupVersionKind;
use kube::{Client, Config};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use twigo_kube::client::{Clients, Gate, Options};
use twigo_kube::openapi::{Cache, Document, Error};

static SERVER_COUNTERS: Mutex<()> = Mutex::const_new(());

async fn client() -> Client {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: these tests create custom resources, so they run only against kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    Clients::new(&config, Gate::unrestricted(), Options::default())
        .unwrap()
        .api
}

#[derive(Debug, Clone, Copy)]
struct Requests {
    documents: u64,
    indexes: u64,
}

async fn requests(client: &Client) -> Requests {
    let request = Request::get("/metrics").body(Vec::new()).unwrap();
    let metrics = client.request_text(request).await.unwrap();
    let counted = |subresource: &str| -> u64 {
        metrics
            .lines()
            .filter(|line| line.starts_with("apiserver_request_total{"))
            .filter(|line| line.contains(&format!("subresource=\"{subresource}\"")))
            .filter(|line| line.contains("verb=\"GET\""))
            .map(|line| line.rsplit(' ').next().unwrap().parse::<u64>().unwrap())
            .sum()
    };
    Requests {
        documents: counted("openapi/v3/"),
        indexes: counted("openapi/v3"),
    }
}

async fn listed(client: &Client, path: &str) -> Option<String> {
    let request = Request::get("/openapi/v3").body(Vec::new()).unwrap();
    let index: Value = client.request(request).await.unwrap();
    index["paths"][path]["serverRelativeURL"]
        .as_str()
        .map(str::to_owned)
}

fn unique(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!("{prefix}-{nanos}")
}

fn widgets(group: &str, properties: Value) -> CustomResourceDefinition {
    serde_json::from_value(json!({
        "apiVersion": "apiextensions.k8s.io/v1",
        "kind": "CustomResourceDefinition",
        "metadata": { "name": format!("widgets.{group}") },
        "spec": {
            "group": group,
            "scope": "Namespaced",
            "names": { "plural": "widgets", "singular": "widget", "kind": "Widget", "listKind": "WidgetList" },
            "versions": [{
                "name": "v1",
                "served": true,
                "storage": true,
                "schema": { "openAPIV3Schema": {
                    "type": "object",
                    "properties": {
                        "spec": { "type": "object", "properties": properties },
                    },
                } },
            }],
        },
    }))
    .unwrap()
}

async fn established(client: &Client, name: &str) {
    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let crd = crds.get(name).await.unwrap();
        let ready = crd
            .status
            .and_then(|status| status.conditions)
            .unwrap_or_default()
            .iter()
            .any(|condition| condition.type_ == "Established" && condition.status == "True");
        if ready {
            return;
        }
        assert!(Instant::now() < deadline, "{name} was never established");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn load_when_listed(client: &Client, cache: &Cache, group: &str) -> Document {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match Document::load(client, cache, group, "v1").await {
            Ok(document) => return document,
            Err(Error::NotListed(_)) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(error) => panic!("{group}: {error}"),
        }
    }
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_second_request_for_a_document_does_not_reach_the_server() {
    let _counters = SERVER_COUNTERS.lock().await;
    let client = client().await;
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path());

    let before = requests(&client).await;
    Document::load(&client, &cache, "apps", "v1").await.unwrap();
    let first = requests(&client).await;
    assert_eq!(first.documents - before.documents, 1);
    assert!(first.indexes > before.indexes);

    let document = Document::load(&client, &cache, "apps", "v1").await.unwrap();
    let second = requests(&client).await;
    assert_eq!(second.documents - first.documents, 0);
    assert!(second.indexes > first.indexes);
    assert!(
        document
            .shape(&GroupVersionKind::gvk("apps", "v1", "Deployment"))
            .is_some()
    );
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_crd_that_changes_gets_a_new_hash_and_its_new_schema_is_answered() {
    let _counters = SERVER_COUNTERS.lock().await;
    let client = client().await;
    let group = format!("{}.example.com", unique("openapi"));
    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    let name = format!("widgets.{group}");
    crds.create(
        &PostParams::default(),
        &widgets(&group, json!({ "size": { "type": "integer" } })),
    )
    .await
    .unwrap();
    established(&client, &name).await;

    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path());
    let path = format!("apis/{group}/v1");
    let widget = GroupVersionKind::gvk(&group, "v1", "Widget");

    let first = load_when_listed(&client, &cache, &group).await;
    let spec = first.shape(&widget).unwrap().field("spec").unwrap();
    assert!(spec.field("size").is_some());
    assert!(spec.field("replicas").is_none());
    let hash = listed(&client, &path).await.unwrap();

    let before = requests(&client).await;
    let again = Document::load(&client, &cache, &group, "v1").await.unwrap();
    assert_eq!(requests(&client).await.documents - before.documents, 0);
    assert!(again.shape(&widget).is_some());

    crds.patch(
        &name,
        &PatchParams::default(),
        &Patch::Merge(json!({ "spec": { "versions": [{
            "name": "v1",
            "served": true,
            "storage": true,
            "schema": { "openAPIV3Schema": {
                "type": "object",
                "properties": { "spec": { "type": "object", "properties": {
                    "replicas": { "type": "integer" },
                } } },
            } },
        }] } })),
    )
    .await
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while listed(&client, &path).await.unwrap() == hash {
        assert!(Instant::now() < deadline, "the group kept its hash");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let before = requests(&client).await;
    let changed = Document::load(&client, &cache, &group, "v1").await.unwrap();
    assert_eq!(requests(&client).await.documents - before.documents, 1);
    let spec = changed.shape(&widget).unwrap().field("spec").unwrap();
    assert!(spec.field("replicas").is_some());
    assert!(spec.field("size").is_none());
    let schema: Value = serde_json::from_str(&changed.json_schema(&widget).unwrap()).unwrap();
    assert!(
        schema["properties"]["spec"]["properties"]
            .get("replicas")
            .is_some()
    );
    assert!(
        schema["properties"]["spec"]["properties"]
            .get("size")
            .is_none()
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);

    crds.delete(&name, &DeleteParams::default()).await.unwrap();
}

fn strip_managed_fields(mut object: Value) -> Value {
    if let Some(metadata) = object["metadata"].as_object_mut() {
        metadata.remove("managedFields");
    }
    object
}

async fn objects(client: &Client, gvk: &GroupVersionKind, plural: &str) -> Vec<Value> {
    let resource = ApiResource::from_gvk_with_plural(gvk, plural);
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &resource);
    api.list(&ListParams::default())
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|object| {
            let mut object = strip_managed_fields(serde_json::to_value(object).unwrap());
            object["apiVersion"] = gvk.api_version().into();
            object["kind"] = gvk.kind.clone().into();
            object
        })
        .collect()
}

fn name_of(object: &Value) -> String {
    format!(
        "{}/{}",
        object["metadata"]["namespace"].as_str().unwrap_or(""),
        object["metadata"]["name"].as_str().unwrap()
    )
}

fn misspelled(object: &Value, pointer: &str) -> Value {
    let mut twin = object.clone();
    let (parent, key) = pointer.rsplit_once('/').unwrap();
    let parent = twin.pointer_mut(parent).unwrap().as_object_mut().unwrap();
    let value = parent
        .remove(key)
        .unwrap_or_else(|| panic!("{pointer} is missing"));
    parent.insert(format!("{key}x"), value);
    twin
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn real_objects_validate_against_their_schemas_and_misspelled_twins_do_not() {
    let _counters = SERVER_COUNTERS.lock().await;
    let client = client().await;
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path());

    let group = format!("{}.example.com", unique("objects"));
    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    let name = format!("widgets.{group}");
    crds.create(
        &PostParams::default(),
        &widgets(
            &group,
            json!({
                "size": { "type": "integer", "minimum": 1, "exclusiveMinimum": true },
                "ports": {
                    "type": "array",
                    "x-kubernetes-list-type": "map",
                    "x-kubernetes-list-map-keys": ["port"],
                    "items": {
                        "type": "object",
                        "required": ["port"],
                        "properties": {
                            "port": { "type": "integer" },
                            "name": { "type": "string" },
                        },
                    },
                },
                "mode": { "type": "string", "nullable": true },
                "timeout": { "x-kubernetes-int-or-string": true },
                "extra": { "type": "object", "x-kubernetes-preserve-unknown-fields": true },
                "labels": { "type": "object", "additionalProperties": { "type": "string" } },
            }),
        ),
    )
    .await
    .unwrap();
    established(&client, &name).await;
    load_when_listed(&client, &cache, &group).await;
    let widget = GroupVersionKind::gvk(&group, "v1", "Widget");
    let created: DynamicObject = serde_json::from_value(json!({
        "apiVersion": widget.api_version(),
        "kind": "Widget",
        "metadata": { "name": "w", "namespace": "default" },
        "spec": {
            "size": 2,
            "ports": [{ "port": 80, "name": "http" }],
            "mode": null,
            "timeout": "30s",
            "extra": { "anything": [1, { "else": "x" }] },
            "labels": { "app": "w" },
        },
    }))
    .unwrap();
    let api: Api<DynamicObject> = Api::namespaced_with(
        client.clone(),
        "default",
        &ApiResource::from_gvk_with_plural(&widget, "widgets"),
    );
    api.create(&PostParams::default(), &created).await.unwrap();

    let kinds = [
        (
            GroupVersionKind::gvk("apps", "v1", "Deployment"),
            "deployments",
            "/spec/replicas",
        ),
        (
            GroupVersionKind::gvk("", "v1", "Pod"),
            "pods",
            "/spec/containers",
        ),
        (
            GroupVersionKind::gvk("", "v1", "Service"),
            "services",
            "/spec/ports",
        ),
        (
            GroupVersionKind::gvk("", "v1", "ConfigMap"),
            "configmaps",
            "/metadata/name",
        ),
        (widget.clone(), "widgets", "/spec/size"),
    ];
    for (gvk, plural, misspelling) in kinds {
        let document = Document::load(&client, &cache, &gvk.group, &gvk.version)
            .await
            .unwrap();
        let schema: Value = serde_json::from_str(&document.json_schema(&gvk).unwrap()).unwrap();
        let validator = jsonschema::draft7::new(&schema).unwrap();
        let found = objects(&client, &gvk, plural).await;
        assert!(!found.is_empty(), "the cluster has no {}", gvk.kind);
        for object in &found {
            let errors: Vec<String> = validator
                .iter_errors(object)
                .map(|error| format!("{} {}", error.instance_path(), error))
                .collect();
            assert!(
                errors.is_empty(),
                "{} {}: {errors:#?}",
                gvk.kind,
                name_of(object)
            );
            let twin = misspelled(object, misspelling);
            assert!(
                !validator.is_valid(&twin),
                "{} {} with {misspelling} misspelled is valid",
                gvk.kind,
                name_of(object)
            );
            let twin = misspelled(object, "/metadata/name");
            assert!(
                !validator.is_valid(&twin),
                "{} {}",
                gvk.kind,
                name_of(object)
            );
        }
        println!("{}: {} objects", gvk.kind, found.len());
    }

    api.delete("w", &DeleteParams::default()).await.unwrap();
    crds.delete(&name, &DeleteParams::default()).await.unwrap();
}
