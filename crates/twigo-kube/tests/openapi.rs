use std::collections::{BTreeSet, HashMap};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http::header::LOCATION;
use http::{Request, Response, StatusCode};
use http_body_util::Full;
use kube::client::Body;
use kube::core::GroupVersionKind;
use serde_json::{Value, json};
use twigo_ipc::{ErrorKind, IpcError};
use twigo_kube::openapi::{Cache, Document, Error, ListType};

const INDEX: &[u8] = include_bytes!("fixtures/openapi/index.json");
const APPS: &[u8] = include_bytes!("fixtures/openapi/apis-apps-v1.json");
const KWOK: &[u8] = include_bytes!("fixtures/openapi/apis-kwok.x-k8s.io-v1alpha1.json");

#[derive(Clone)]
struct Server {
    state: Arc<Mutex<State>>,
}

struct State {
    documents: HashMap<&'static str, Bytes>,
    broken: Option<(StatusCode, Bytes)>,
    redirects: usize,
    asked: Vec<String>,
}

impl Server {
    fn kind() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                documents: HashMap::from([
                    ("/openapi/v3/apis/apps/v1", Bytes::from_static(APPS)),
                    (
                        "/openapi/v3/apis/kwok.x-k8s.io/v1alpha1",
                        Bytes::from_static(KWOK),
                    ),
                ]),
                broken: None,
                redirects: 0,
                asked: Vec::new(),
            })),
        }
    }

    fn break_documents(&self, status: StatusCode, body: &'static [u8]) {
        self.state.lock().unwrap().broken = Some((status, Bytes::from_static(body)));
    }

    fn redirect_documents(&self, times: usize) {
        self.state.lock().unwrap().redirects = times;
    }

    fn asked(&self) -> Vec<String> {
        std::mem::take(&mut self.state.lock().unwrap().asked)
    }

    fn client(&self) -> kube::Client {
        let server = self.clone();
        let service = tower::service_fn(move |request: Request<Body>| {
            let server = server.clone();
            async move { Ok::<_, Infallible>(server.answer(&request)) }
        });
        kube::Client::new(service, "default")
    }

    fn answer(&self, request: &Request<Body>) -> Response<Full<Bytes>> {
        let path = request.uri().path().to_owned();
        let mut state = self.state.lock().unwrap();
        state.asked.push(path.clone());
        let ok = |body: Bytes| {
            Response::builder()
                .status(StatusCode::OK)
                .body(Full::new(body))
                .unwrap()
        };
        if path == "/openapi/v3" {
            return ok(Bytes::from_static(INDEX));
        }
        let Some(document) = state.documents.get(path.as_str()).cloned() else {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Full::default())
                .unwrap();
        };
        if state.redirects > 0 {
            state.redirects -= 1;
            return Response::builder()
                .status(StatusCode::MOVED_PERMANENTLY)
                .header(LOCATION, format!("{path}?hash=0"))
                .body(Full::default())
                .unwrap();
        }
        if let Some((status, body)) = state.broken.clone() {
            return Response::builder()
                .status(status)
                .body(Full::new(body))
                .unwrap();
        }
        ok(document)
    }
}

async fn load(
    server: &Server,
    cache: &Cache,
    group: &str,
    version: &str,
) -> Result<Document, Error> {
    Document::load(&server.client(), cache, group, version).await
}

fn files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| entries.map(|entry| entry.unwrap().path()).collect())
        .unwrap_or_default()
}

fn gvk(group: &str, version: &str, kind: &str) -> GroupVersionKind {
    GroupVersionKind::gvk(group, version, kind)
}

async fn apps() -> Document {
    let dir = tempfile::tempdir().unwrap();
    load(&Server::kind(), &Cache::new(dir.path()), "apps", "v1")
        .await
        .unwrap()
}

async fn kwok() -> Document {
    let dir = tempfile::tempdir().unwrap();
    load(
        &Server::kind(),
        &Cache::new(dir.path()),
        "kwok.x-k8s.io",
        "v1alpha1",
    )
    .await
    .unwrap()
}

fn keyed(keys: &[&str]) -> ListType {
    ListType::Map {
        keys: keys.iter().map(|key| (*key).to_owned()).collect(),
    }
}

#[tokio::test]
async fn a_document_is_fetched_once_and_then_read_from_disk() {
    let server = Server::kind();
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path().join("openapi"));

    load(&server, &cache, "apps", "v1").await.unwrap();
    assert_eq!(server.asked(), ["/openapi/v3", "/openapi/v3/apis/apps/v1"]);

    let again = load(&server, &cache, "apps", "v1").await.unwrap();
    assert_eq!(server.asked(), ["/openapi/v3"]);
    assert!(again.shape(&gvk("apps", "v1", "Deployment")).is_some());

    let restarted = Cache::new(dir.path().join("openapi"));
    load(&server, &restarted, "apps", "v1").await.unwrap();
    assert_eq!(server.asked(), ["/openapi/v3"]);

    let stored = files(&dir.path().join("openapi"));
    assert_eq!(stored.len(), 1);
    assert_eq!(std::fs::read(&stored[0]).unwrap(), APPS);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&stored[0]).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[tokio::test]
async fn a_group_version_the_index_does_not_list_is_not_found() {
    let server = Server::kind();
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path());

    let missing = load(&server, &cache, "apps", "v2").await.unwrap_err();
    assert!(matches!(missing, Error::NotListed(_)), "{missing:?}");
    assert_eq!(IpcError::from(&missing).kind, ErrorKind::NotFound);
    assert_eq!(server.asked(), ["/openapi/v3"]);
    assert!(files(dir.path()).is_empty());
}

#[tokio::test]
async fn a_failed_fetch_keeps_nothing_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path());

    let server = Server::kind();
    server.break_documents(
        StatusCode::INTERNAL_SERVER_ERROR,
        br#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"etcd is unavailable","reason":"InternalError","code":500}"#,
    );
    let refused = load(&server, &cache, "apps", "v1").await.unwrap_err();
    assert_eq!(IpcError::from(&refused).kind, ErrorKind::Unavailable);

    server.break_documents(
        StatusCode::OK,
        br#"{"components":{"schemas":{"another":{}}}}"#,
    );
    let unverified = load(&server, &cache, "apps", "v1").await.unwrap_err();
    assert!(matches!(unverified, Error::Unverified(_)), "{unverified:?}");
    assert!(files(dir.path()).is_empty());
}

#[tokio::test]
async fn a_damaged_file_is_replaced_by_the_document() {
    let server = Server::kind();
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path());
    load(&server, &cache, "apps", "v1").await.unwrap();
    server.asked();
    let stored = files(dir.path());
    std::fs::write(&stored[0], &APPS[..APPS.len() - 1]).unwrap();

    load(&server, &cache, "apps", "v1").await.unwrap();
    assert_eq!(server.asked(), ["/openapi/v3", "/openapi/v3/apis/apps/v1"]);
    assert_eq!(std::fs::read(&stored[0]).unwrap(), APPS);
}

#[tokio::test]
async fn a_document_that_moved_is_asked_for_again_through_the_index() {
    let server = Server::kind();
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path());

    server.redirect_documents(1);
    load(&server, &cache, "apps", "v1").await.unwrap();
    assert_eq!(
        server.asked(),
        [
            "/openapi/v3",
            "/openapi/v3/apis/apps/v1",
            "/openapi/v3",
            "/openapi/v3/apis/apps/v1"
        ]
    );

    let other = tempfile::tempdir().unwrap();
    server.redirect_documents(2);
    let changing = load(&server, &Cache::new(other.path()), "apps", "v1")
        .await
        .unwrap_err();
    assert!(matches!(changing, Error::Changing(_)), "{changing:?}");
    assert!(files(other.path()).is_empty());
}

#[tokio::test]
async fn the_core_group_is_listed_under_api() {
    let server = Server::kind();
    let dir = tempfile::tempdir().unwrap();
    let missing = load(&server, &Cache::new(dir.path()), "", "v1")
        .await
        .unwrap_err();
    assert!(matches!(&missing, Error::Request(_)), "{missing:?}");
    assert_eq!(server.asked(), ["/openapi/v3", "/openapi/v3/api/v1"]);
}

#[tokio::test]
async fn how_the_server_merges_the_fields_of_a_deployment() {
    let document = apps().await;
    let deployment = document.shape(&gvk("apps", "v1", "Deployment")).unwrap();
    let spec = deployment.field("spec").unwrap();
    let pod = spec.field("template").unwrap().field("spec").unwrap();

    let containers = pod.field("containers").unwrap();
    assert_eq!(containers.list(), keyed(&["name"]));
    let container = containers.items().unwrap();

    let ports = container.field("ports").unwrap();
    assert_eq!(ports.list(), keyed(&["containerPort", "protocol"]));
    let port = ports.items().unwrap();
    assert_eq!(
        port.field("protocol").unwrap().default(),
        Some(&json!("TCP"))
    );
    assert_eq!(
        port.field("containerPort").unwrap().default(),
        Some(&json!(0))
    );

    assert_eq!(container.field("args").unwrap().list(), ListType::Atomic);

    let metadata = deployment.field("metadata").unwrap();
    assert_eq!(metadata.field("finalizers").unwrap().list(), ListType::Set);
    assert_eq!(
        metadata.field("ownerReferences").unwrap().list(),
        keyed(&["uid"])
    );
    let labels = metadata.field("labels").unwrap();
    assert!(!labels.atomic_map());
    assert!(labels.field("app").is_some());

    assert!(spec.field("selector").unwrap().atomic_map());
    assert!(!spec.atomic_map());
    assert!(!spec.field("template").unwrap().atomic_map());
}

#[tokio::test]
async fn a_typed_object_has_the_fields_it_declares_and_no_others() {
    let document = apps().await;
    let deployment = document.shape(&gvk("apps", "v1", "Deployment")).unwrap();
    let spec = deployment.field("spec").unwrap();

    assert!(spec.field("replicas").is_some());
    assert!(spec.field("replica").is_none());
    assert!(spec.field("replicas").unwrap().field("x").is_none());
    assert!(spec.field("replicas").unwrap().items().is_none());
    assert!(deployment.field("metadata").unwrap().items().is_none());
    assert!(document.shape(&gvk("apps", "v1", "Nothing")).is_none());
}

#[tokio::test]
async fn how_the_server_merges_the_fields_of_a_custom_resource() {
    let document = kwok().await;
    let stage = document
        .shape(&gvk("kwok.x-k8s.io", "v1alpha1", "Stage"))
        .unwrap();
    let conditions = stage.field("status").unwrap().field("conditions").unwrap();
    assert_eq!(conditions.list(), keyed(&["type"]));
    assert!(conditions.items().unwrap().field("type").is_some());

    let metrics = document
        .shape(&gvk("kwok.x-k8s.io", "v1alpha1", "Metric"))
        .unwrap()
        .field("spec")
        .unwrap()
        .field("metrics")
        .unwrap()
        .items()
        .unwrap();
    assert_eq!(metrics.field("labels").unwrap().list(), keyed(&["name"]));
    assert_eq!(metrics.field("buckets").unwrap().list(), keyed(&["le"]));
}

fn parsed(document: &Document, gvk: &GroupVersionKind) -> Value {
    serde_json::from_str(&document.json_schema(gvk).unwrap()).unwrap()
}

fn references(schema: &Value, found: &mut BTreeSet<String>) {
    match schema {
        Value::Object(object) => {
            for (keyword, value) in object {
                match (keyword.as_str(), value) {
                    ("$ref", Value::String(reference)) => {
                        found.insert(reference.clone());
                    }
                    ("properties", Value::Object(properties)) => {
                        properties
                            .values()
                            .for_each(|property| references(property, found));
                    }
                    ("default" | "enum", _) => {}
                    _ => references(value, found),
                }
            }
        }
        Value::Array(members) => members.iter().for_each(|member| references(member, found)),
        _ => {}
    }
}

#[tokio::test]
async fn a_kind_is_the_root_with_the_definitions_it_reaches() {
    let document = apps().await;
    let schema = parsed(&document, &gvk("apps", "v1", "Deployment"));

    assert_eq!(schema["$schema"], "http://json-schema.org/draft-07/schema#");
    assert_eq!(schema["type"], "object");
    assert_eq!(
        schema["properties"]["apiVersion"]["enum"],
        json!(["apps/v1"])
    );
    assert_eq!(schema["properties"]["kind"]["enum"], json!(["Deployment"]));
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(
        schema["properties"]["spec"]["$ref"],
        "#/definitions/io.k8s.api.apps.v1.DeploymentSpec"
    );
    assert_eq!(schema["properties"]["spec"]["default"], json!({}));
    assert!(
        schema["properties"]["spec"]["description"]
            .as_str()
            .unwrap()
            .contains("desired behavior")
    );
    assert!(schema["properties"]["spec"].get("allOf").is_none());

    let mut reached = BTreeSet::new();
    references(&schema["properties"], &mut reached);
    let definitions = schema["definitions"].as_object().unwrap();
    for definition in definitions.values() {
        references(definition, &mut reached);
    }
    let defined: BTreeSet<String> = definitions
        .keys()
        .map(|name| format!("#/definitions/{name}"))
        .collect();
    assert_eq!(reached, defined);
    assert!(definitions.len() < 166);
    assert!(!definitions.contains_key("io.k8s.api.apps.v1.DaemonSet"));
    assert!(!schema.to_string().contains("#/components"));
    assert!(!schema.to_string().contains("x-kubernetes-"));
}

#[tokio::test]
async fn the_editor_never_shows_managed_fields() {
    let document = apps().await;
    let schema = parsed(&document, &gvk("apps", "v1", "Deployment"));
    let meta = &schema["definitions"]["io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta"];
    assert!(meta["properties"].get("managedFields").is_none());
    assert!(meta["properties"].get("labels").is_some());
    assert!(
        !schema["definitions"]
            .as_object()
            .unwrap()
            .contains_key("io.k8s.apimachinery.pkg.apis.meta.v1.ManagedFieldsEntry")
    );
}

#[tokio::test]
async fn int_or_string_is_the_two_types_json_schema_has() {
    let document = apps().await;
    let schema = parsed(&document, &gvk("apps", "v1", "Deployment"));
    let surge = &schema["definitions"]["io.k8s.api.apps.v1.RollingUpdateDeployment"]["properties"]
        ["maxSurge"];
    assert_eq!(
        surge["$ref"],
        "#/definitions/io.k8s.apimachinery.pkg.util.intstr.IntOrString"
    );
    assert_eq!(
        schema["definitions"]["io.k8s.apimachinery.pkg.util.intstr.IntOrString"]["oneOf"],
        json!([{ "type": "integer" }, { "type": "string" }])
    );

    let document = kwok().await;
    let usage = parsed(
        &document,
        &gvk("kwok.x-k8s.io", "v1alpha1", "ResourceUsage"),
    );
    let value = &usage["properties"]["spec"]["properties"]["usages"]["items"]["properties"]["usage"]
        ["additionalProperties"]["properties"]["value"];
    assert_eq!(
        value["anyOf"],
        json!([{ "type": "integer" }, { "type": "string" }])
    );
    assert!(value.get("x-kubernetes-int-or-string").is_none());
}

fn kinds(document: &[u8], group: &str, version: &str) -> Vec<GroupVersionKind> {
    let document: Value = serde_json::from_slice(document).unwrap();
    document["components"]["schemas"]
        .as_object()
        .unwrap()
        .values()
        .filter_map(|schema| schema["x-kubernetes-group-version-kind"].as_array())
        .flatten()
        .filter(|entry| entry["group"] == group && entry["version"] == version)
        .map(|entry| gvk(group, version, entry["kind"].as_str().unwrap()))
        .collect()
}

#[tokio::test]
async fn every_kind_of_the_two_documents_is_a_draft_07_schema() {
    let apps_kinds = kinds(APPS, "apps", "v1");
    let kwok_kinds = kinds(KWOK, "kwok.x-k8s.io", "v1alpha1");
    assert_eq!((apps_kinds.len(), kwok_kinds.len()), (12, 24));
    for (document, kinds) in [(apps().await, apps_kinds), (kwok().await, kwok_kinds)] {
        for gvk in kinds {
            let schema = parsed(&document, &gvk);
            jsonschema::draft7::new(&schema)
                .unwrap_or_else(|error| panic!("{}: {error}", gvk.kind));
            assert!(
                jsonschema::meta::is_valid(&schema),
                "{} breaks draft-07's meta-schema",
                gvk.kind
            );
        }
    }
}

fn deployment() -> Value {
    json!({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": { "name": "web", "labels": { "app": "web" } },
        "spec": {
            "replicas": 2,
            "selector": { "matchLabels": { "app": "web" } },
            "strategy": { "rollingUpdate": { "maxSurge": "25%", "maxUnavailable": 1 } },
            "template": {
                "metadata": { "labels": { "app": "web" } },
                "spec": {
                    "containers": [{
                        "name": "web",
                        "image": "nginx",
                        "ports": [{ "containerPort": 80 }],
                        "resources": { "limits": { "cpu": 1, "memory": "128Mi" } }
                    }]
                }
            }
        }
    })
}

#[tokio::test]
async fn a_misspelled_field_is_what_the_schema_rejects() {
    let document = apps().await;
    let schema = parsed(&document, &gvk("apps", "v1", "Deployment"));
    let validator = jsonschema::draft7::new(&schema).unwrap();

    assert!(
        validator.is_valid(&deployment()),
        "{:?}",
        validator.iter_errors(&deployment()).collect::<Vec<_>>()
    );

    let mut wrong = deployment();
    wrong["spec"]["replica"] = json!(3);
    assert!(!validator.is_valid(&wrong));

    let mut wrong = deployment();
    wrong["spec"]["template"]["spec"]["containers"][0]["imge"] = json!("nginx");
    assert!(!validator.is_valid(&wrong));

    let mut wrong = deployment();
    wrong["kind"] = json!("Pod");
    assert!(!validator.is_valid(&wrong));

    let mut wrong = deployment();
    wrong["apiVersion"] = json!("apps/v1beta1");
    assert!(!validator.is_valid(&wrong));

    let mut wrong = deployment();
    wrong["spec"]["replicas"] = json!("two");
    assert!(!validator.is_valid(&wrong));
}

#[tokio::test]
async fn a_custom_resource_is_checked_by_its_own_schema() {
    let document = kwok().await;
    let schema = parsed(
        &document,
        &gvk("kwok.x-k8s.io", "v1alpha1", "ResourceUsage"),
    );
    let validator = jsonschema::draft7::new(&schema).unwrap();
    let usage = |value: Value| {
        json!({
            "apiVersion": "kwok.x-k8s.io/v1alpha1",
            "kind": "ResourceUsage",
            "metadata": { "name": "u" },
            "spec": { "usages": [{ "usage": { "cpu": { "value": value } } }] }
        })
    };
    assert!(validator.is_valid(&usage(json!("1Gi"))));
    assert!(validator.is_valid(&usage(json!(2))));
    assert!(!validator.is_valid(&usage(json!("lots"))));
    assert!(!validator.is_valid(&usage(json!(true))));

    let mut misspelled = usage(json!(1));
    misspelled["spec"]["usagess"] = json!([]);
    assert!(!validator.is_valid(&misspelled));
}
