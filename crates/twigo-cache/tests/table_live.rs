use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::{AsyncBufRead, AsyncBufReadExt};
use k8s_openapi::api::core::v1::{Namespace, Pod};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{
    ApiResource, DeleteParams, DynamicObject, GroupVersionKind, Patch, PatchParams, PostParams,
};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use serde_json::json;
use twigo_cache::table::request::{self, WatchFrom};
use twigo_cache::table::{Cell, ColumnKind, Event, Row, TableDecoder};
use twigo_kube::client::{Clients, Options};

const POD_COLUMNS: [&str; 9] = [
    "Name",
    "Ready",
    "Status",
    "Restarts",
    "Age",
    "IP",
    "Node",
    "Nominated Node",
    "Readiness Gates",
];

async fn client() -> Client {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: these tests create CRDs and namespaces, so they run only against kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    Clients::new(&config, Options::default()).unwrap().api
}

async fn minor_version(client: &Client) -> u32 {
    let info = client.apiserver_version().await.unwrap();
    info.minor.trim_end_matches('+').parse().unwrap()
}

async fn namespace(client: &Client, prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let name = format!("{prefix}-{nanos}");
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap();
    Api::<Namespace>::all(client.clone())
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
    name
}

async fn delete_namespace(client: &Client, name: &str) {
    Api::<Namespace>::all(client.clone())
        .delete(name, &DeleteParams::default())
        .await
        .unwrap();
}

async fn create_pod(pods: &Api<Pod>, name: &str) {
    let pod: Pod = serde_json::from_value(json!({
        "metadata": { "name": name, "labels": { "app": "probe" } },
        "spec": {
            "nodeName": "kwok-node-0",
            "containers": [{ "name": "app", "image": "fake" }]
        }
    }))
    .unwrap();
    pods.create(&PostParams::default(), &pod).await.unwrap();
}

async fn label(api: &Api<Pod>, name: &str, value: &str) {
    let patch = json!({ "metadata": { "labels": { "touched": value } } });
    api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .unwrap();
}

struct Lines(Pin<Box<dyn AsyncBufRead + Send>>);

impl Lines {
    async fn open(client: &Client, request: http::Request<Vec<u8>>) -> Self {
        Lines(Box::pin(client.request_stream(request).await.unwrap()))
    }

    async fn next(&mut self) -> Option<Vec<u8>> {
        let mut line = Vec::new();
        let read =
            tokio::time::timeout(Duration::from_secs(60), self.0.read_until(b'\n', &mut line))
                .await
                .expect("a watch event within a minute")
                .unwrap();
        (read > 0).then_some(line)
    }
}

fn has_columns(line: &[u8]) -> bool {
    let line = std::str::from_utf8(line).unwrap();
    line.contains("\"columnDefinitions\":[{")
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn pods_list_and_watch() {
    let client = client().await;
    let ns = namespace(&client, "pods").await;
    let pods = Api::<Pod>::namespaced(client.clone(), &ns);
    create_pod(&pods, "p1").await;
    create_pod(&pods, "p2").await;
    let path = format!("/api/v1/namespaces/{ns}/pods");

    let body = client
        .request_text(request::list(&path, 500, None))
        .await
        .unwrap();
    assert!(body.contains("\"managedFields\""));
    let mut decoder = TableDecoder::new();
    let page = decoder.decode_list(body.as_bytes()).unwrap();
    let columns = decoder.columns().unwrap().clone();
    let names: Vec<&str> = columns.iter().map(|column| &*column.name).collect();
    assert_eq!(names, POD_COLUMNS);
    assert_eq!(columns[4].kind, ColumnKind::Age);
    let priorities: Vec<i32> = columns.iter().map(|column| column.priority).collect();
    assert_eq!(priorities, [0, 0, 0, 0, 0, 1, 1, 1, 1]);
    assert_eq!(page.rows.len(), 2);
    assert!(
        page.rows
            .iter()
            .all(|row| row.cells[4] == Cell::Age && row.meta.created.is_some())
    );

    let mut watch = Lines::open(
        &client,
        request::watch(
            &path,
            WatchFrom::ResourceVersion(&page.resource_version),
            60,
        ),
    )
    .await;
    label(&pods, "p1", "once").await;
    create_pod(&pods, "p3").await;
    pods.delete("p2", &DeleteParams::default().grace_period(0))
        .await
        .unwrap();

    let mut first = true;
    let mut last_version = page.resource_version.clone();
    let mut seen = Vec::new();
    while let Some(line) = watch.next().await {
        assert_eq!(
            has_columns(&line),
            first,
            "column definitions only in the first event"
        );
        first = false;
        match decoder.decode_event(&line).unwrap() {
            Event::Upsert(row) => {
                last_version = row.meta.resource_version.clone();
                seen.push(("upsert", row.meta.name));
            }
            Event::Delete(row) => {
                let deleted_p2 = &*row.meta.name == "p2";
                last_version = row.meta.resource_version.clone();
                seen.push(("delete", row.meta.name));
                if deleted_p2 {
                    break;
                }
            }
            Event::Bookmark { .. } => {}
            Event::Error(status) => panic!("watch failed: {status:?}"),
        }
    }
    assert!(seen.contains(&("upsert", "p1".into())));
    assert!(seen.contains(&("upsert", "p3".into())));
    assert!(Arc::ptr_eq(&columns, decoder.columns().unwrap()));

    let mut again = Lines::open(
        &client,
        request::watch(&path, WatchFrom::ResourceVersion(&last_version), 60),
    )
    .await;
    label(&pods, "p1", "twice").await;
    let line = again.next().await.unwrap();
    assert!(
        has_columns(&line),
        "a new connection sends the columns again"
    );
    let row = upsert(decoder.decode_event(&line).unwrap());
    assert_eq!(row.cells.len(), POD_COLUMNS.len());
    assert!(Arc::ptr_eq(&columns, decoder.columns().unwrap()));

    delete_namespace(&client, &ns).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn streaming_lists_depend_on_the_release() {
    let client = client().await;
    let minor = minor_version(&client).await;
    let ns = namespace(&client, "stream").await;
    let pods = Api::<Pod>::namespaced(client.clone(), &ns);
    create_pod(&pods, "p1").await;
    let path = format!("/api/v1/namespaces/{ns}/pods");

    let request = request::watch(&path, WatchFrom::InitialEvents, 60);
    if minor == 33 {
        let Err(kube::Error::Api(status)) = client.request_stream(request).await else {
            panic!("1.33 ships WatchList off and must reject a streaming list");
        };
        assert_eq!(status.code, 422);
        assert!(
            status.message.contains("sendInitialEvents"),
            "{}",
            status.message
        );
        delete_namespace(&client, &ns).await;
        return;
    }

    let mut watch = Lines::open(&client, request).await;
    let mut decoder = TableDecoder::new();
    let first = watch.next().await.unwrap();
    let row = upsert(decoder.decode_event(&first).unwrap());
    assert_eq!(&*row.meta.name, "p1");
    assert!(has_columns(&first));
    let names: Vec<&str> = decoder
        .columns()
        .unwrap()
        .iter()
        .map(|column| &*column.name)
        .collect();
    assert_eq!(names, POD_COLUMNS);
    loop {
        let line = watch.next().await.expect("the initial-events-end bookmark");
        if let Event::Bookmark {
            initial_events_end, ..
        } = decoder.decode_event(&line).unwrap()
            && initial_events_end
        {
            break;
        }
    }

    delete_namespace(&client, &ns).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn crd_printer_columns() {
    let client = client().await;
    let crds = Api::<CustomResourceDefinition>::all(client.clone());
    let crd: CustomResourceDefinition = serde_json::from_value(json!({
        "metadata": { "name": "widgets.test.twigo.io" },
        "spec": {
            "group": "test.twigo.io",
            "scope": "Namespaced",
            "names": { "plural": "widgets", "singular": "widget", "kind": "Widget" },
            "versions": [{
                "name": "v1",
                "served": true,
                "storage": true,
                "schema": { "openAPIV3Schema": {
                    "type": "object",
                    "properties": { "spec": {
                        "type": "object",
                        "properties": {
                            "size": { "type": "string" },
                            "replicas": { "type": "integer" },
                            "ratio": { "type": "number" },
                            "enabled": { "type": "boolean" },
                            "since": { "type": "string", "format": "date-time" }
                        }
                    }}
                }},
                "additionalPrinterColumns": [
                    { "name": "Size", "type": "string", "jsonPath": ".spec.size" },
                    { "name": "Replicas", "type": "integer", "jsonPath": ".spec.replicas" },
                    { "name": "Ratio", "type": "number", "jsonPath": ".spec.ratio", "priority": 1 },
                    { "name": "Enabled", "type": "boolean", "jsonPath": ".spec.enabled" },
                    { "name": "Since", "type": "date", "jsonPath": ".spec.since" },
                    { "name": "Age", "type": "date", "jsonPath": ".metadata.creationTimestamp" }
                ]
            }]
        }
    }))
    .unwrap();
    crds.patch(
        "widgets.test.twigo.io",
        &PatchParams::apply("twigo-tests").force(),
        &Patch::Apply(&crd),
    )
    .await
    .unwrap();
    let established = kube::runtime::wait::await_condition(
        crds.clone(),
        "widgets.test.twigo.io",
        kube::runtime::conditions::is_crd_established(),
    );
    tokio::time::timeout(Duration::from_secs(60), established)
        .await
        .expect("the CRD is established within a minute")
        .unwrap();

    let ns = namespace(&client, "widgets").await;
    let ten_days_ago =
        jiff::Timestamp::from_second(jiff::Timestamp::now().as_second() - 10 * 86_400)
            .unwrap()
            .to_string();
    let resource = ApiResource::from_gvk(&GroupVersionKind::gvk("test.twigo.io", "v1", "Widget"));
    let widgets = Api::<DynamicObject>::namespaced_with(client.clone(), &ns, &resource);
    for (name, spec) in [
        (
            "full",
            json!({ "size": "large", "replicas": 3, "ratio": 0.5, "enabled": true, "since": ten_days_ago }),
        ),
        ("empty", json!({})),
    ] {
        let widget: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "test.twigo.io/v1",
            "kind": "Widget",
            "metadata": { "name": name },
            "spec": spec
        }))
        .unwrap();
        widgets
            .create(&PostParams::default(), &widget)
            .await
            .unwrap();
    }

    let path = format!("/apis/test.twigo.io/v1/namespaces/{ns}/widgets");
    let body = client
        .request_text(request::list(&path, 500, None))
        .await
        .unwrap();
    let mut decoder = TableDecoder::new();
    let page = decoder.decode_list(body.as_bytes()).unwrap();
    let kinds: Vec<ColumnKind> = decoder
        .columns()
        .unwrap()
        .iter()
        .map(|column| column.kind)
        .collect();
    assert_eq!(
        kinds,
        [
            ColumnKind::String,
            ColumnKind::String,
            ColumnKind::Integer,
            ColumnKind::Number,
            ColumnKind::Boolean,
            ColumnKind::Date,
            ColumnKind::Age,
        ]
    );
    assert_eq!(decoder.columns().unwrap()[3].priority, 1);
    let full = page
        .rows
        .iter()
        .find(|row| &*row.meta.name == "full")
        .unwrap();
    assert_eq!(full.cells[2], Cell::Int(3));
    assert_eq!(full.cells[3], Cell::Number(0.5));
    assert_eq!(full.cells[4], Cell::Bool(true));
    assert_eq!(full.cells[5], Cell::Text("10d".into()));
    assert_eq!(full.cells[6], Cell::Age);
    let empty = page
        .rows
        .iter()
        .find(|row| &*row.meta.name == "empty")
        .unwrap();
    assert!(empty.cells[1..6].iter().all(|cell| *cell == Cell::Null));

    delete_namespace(&client, &ns).await;
}

fn upsert(event: Event) -> Row {
    match event {
        Event::Upsert(row) => row,
        other => panic!("expected an upsert, got {other:?}"),
    }
}
