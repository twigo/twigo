//! Open objects against a kind or kwok cluster: their batches wait for their
//! acks, they follow an edit and their events, they hold their events'
//! upstream and what their describer needs only while a view shows them,
//! they say why events or a need cannot be listed, and a deleted object
//! keeps no owners; and a list sends its field selector to the server.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-core --test objects_live -- --ignored

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::authentication::v1::TokenRequest;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod, ServiceAccount};
use k8s_openapi::api::rbac::v1::{Role, RoleBinding};
use kube::api::{ApiResource, DeleteParams, DynamicObject, Patch, PatchParams, PostParams};
use kube::config::Kubeconfig;
use kube::{Api, Config};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    Ack, Block, EventList, Gvr, ObjectBatch, ObjectParts, ObjectQuery, OpenObject, Related,
    SetParts, SubscriptionId, Value, ViewState,
};

const WAIT: Duration = Duration::from_secs(30);

/// The test cluster: its kubeconfig, its context and an admin client.
struct Cluster {
    path: PathBuf,
    kubeconfig: Kubeconfig,
    context: String,
    admin: kube::Client,
}

impl Cluster {
    async fn connect() -> Self {
        let path: PathBuf = std::env::var_os("TWIGO_TEST_KUBECONFIG")
            .expect("TWIGO_TEST_KUBECONFIG")
            .into();
        let kubeconfig = Kubeconfig::read_from(&path).unwrap();
        let context = kubeconfig.current_context.clone().unwrap_or_default();
        assert!(
            context.starts_with("kind-") || context.starts_with("kwok-"),
            "refusing context {context:?}: only kind and kwok clusters"
        );
        let config = Config::from_custom_kubeconfig(kubeconfig.clone(), &Default::default())
            .await
            .unwrap();
        let admin = kube::Client::try_from(config).unwrap();
        Cluster {
            path,
            kubeconfig,
            context,
            admin,
        }
    }

    async fn namespace(&self, prefix: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let namespace = format!("core-objects-{prefix}-{nanos}");
        Api::<Namespace>::all(self.admin.clone())
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({ "metadata": { "name": namespace } })).unwrap(),
            )
            .await
            .unwrap();
        namespace
    }

    async fn delete(&self, namespace: &str) {
        Api::<Namespace>::all(self.admin.clone())
            .delete(namespace, &DeleteParams::default())
            .await
            .unwrap();
    }

    /// A pod on a kwok node, its owner references `owners`; its uid.
    async fn pod(&self, namespace: &str, owners: serde_json::Value) -> String {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": "p1", "ownerReferences": owners },
            "spec": { "nodeName": "kwok-node-0", "containers": [{ "name": "app", "image": "fake" }] },
        }))
        .unwrap();
        Api::<Pod>::namespaced(self.admin.clone(), namespace)
            .create(&PostParams::default(), &pod)
            .await
            .unwrap()
            .metadata
            .uid
            .unwrap()
    }

    /// A kubeconfig in `dir` for a service account of `namespace` that may
    /// get, list and watch the core `resources` there and nothing else; and
    /// its context.
    async fn reader(&self, namespace: &str, dir: &Path, resources: &[&str]) -> (PathBuf, String) {
        let accounts = Api::<ServiceAccount>::namespaced(self.admin.clone(), namespace);
        accounts
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({ "metadata": { "name": "reader" } })).unwrap(),
            )
            .await
            .unwrap();
        let role: Role = serde_json::from_value(json!({
            "metadata": { "name": "pods" },
            "rules": [{ "apiGroups": [""], "resources": resources, "verbs": ["get", "list", "watch"] }],
        }))
        .unwrap();
        Api::<Role>::namespaced(self.admin.clone(), namespace)
            .create(&PostParams::default(), &role)
            .await
            .unwrap();
        let binding: RoleBinding = serde_json::from_value(json!({
            "metadata": { "name": "reader-pods" },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "pods" },
            "subjects": [{ "kind": "ServiceAccount", "name": "reader", "namespace": namespace }],
        }))
        .unwrap();
        Api::<RoleBinding>::namespaced(self.admin.clone(), namespace)
            .create(&PostParams::default(), &binding)
            .await
            .unwrap();
        let request: TokenRequest =
            serde_json::from_value(json!({ "spec": { "audiences": [] } })).unwrap();
        let token = accounts
            .create_token_request("reader", &PostParams::default(), &request)
            .await
            .unwrap()
            .status
            .unwrap()
            .token;
        let cluster = self.kubeconfig.clusters[0]
            .cluster
            .clone()
            .expect("the test cluster");
        let context = "kind-pod-reader".to_owned();
        let kubeconfig = json!({
            "apiVersion": "v1",
            "kind": "Config",
            "clusters": [{ "name": "test", "cluster": {
                "server": cluster.server,
                "certificate-authority-data": cluster.certificate_authority_data,
            } }],
            "users": [{ "name": "reader", "user": { "token": token } }],
            "contexts": [{ "name": context, "context": { "cluster": "test", "user": "reader" } }],
            "current-context": context,
        });
        let path = dir.join("reader.kubeconfig");
        std::fs::write(&path, kubeconfig.to_string()).unwrap();
        (path, context)
    }
}

/// A core that reads only `kubeconfig`, with a space for `context`.
fn core(dir: &Path, kubeconfig: &Path, context: &str) -> (Arc<Core>, String) {
    let core = Core::new(dir, &dir.join("cache"));
    let space = core.state.open_space(context).id;
    let (status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    tokio::spawn({
        let core = Arc::clone(&core);
        let kubeconfig = kubeconfig.to_owned();
        async move {
            let _status = status;
            core.run(followed, Some(kubeconfig)).await;
        }
    });
    (core, space)
}

struct Opened {
    core: Arc<Core>,
    id: SubscriptionId,
    batches: mpsc::UnboundedReceiver<ObjectBatch>,
}

impl Opened {
    async fn pod(core: &Arc<Core>, space: String, namespace: &str, parts: ObjectParts) -> Self {
        Self::open(core, space, "pods", namespace, "p1", parts).await
    }

    async fn open(
        core: &Arc<Core>,
        space: String,
        resource: &str,
        namespace: &str,
        name: &str,
        parts: ObjectParts,
    ) -> Self {
        let (sender, batches) = mpsc::unbounded_channel();
        let object = ObjectQuery {
            space,
            gvr: Gvr {
                group: String::new(),
                version: "v1".to_owned(),
                resource: resource.to_owned(),
            },
            namespaced: true,
            namespace: Some(namespace.to_owned()),
            name: name.to_owned(),
        };
        let id = core
            .object_open("main", OpenObject { object, parts }, move |batch| {
                sender.send(batch).is_ok()
            })
            .await
            .unwrap();
        Opened {
            core: Arc::clone(core),
            id,
            batches,
        }
    }

    /// The next batch, acknowledged.
    async fn next(&mut self) -> ObjectBatch {
        let batch = tokio::time::timeout(WAIT, self.batches.recv())
            .await
            .expect("a batch within 30 s")
            .expect("the object is open");
        let ack = Ack {
            id: self.id,
            seq: batch.seq,
        };
        self.core.object_ack("main", ack).unwrap();
        batch
    }

    /// Batches until one passes `wanted`, within 30 s.
    async fn until(&mut self, wanted: impl Fn(&ObjectBatch) -> bool) -> ObjectBatch {
        tokio::time::timeout(WAIT, async {
            loop {
                let batch = self.next().await;
                if wanted(&batch) {
                    return batch;
                }
            }
        })
        .await
        .expect("a wanted batch within 30 s")
    }
}

fn fields(batch: &ObjectBatch, label: &str) -> Option<Value> {
    batch
        .overview
        .as_ref()?
        .sections
        .iter()
        .find_map(|section| {
            section.blocks.iter().find_map(|block| match block {
                Block::Fields { fields } => fields
                    .iter()
                    .find(|field| field.label == label)
                    .map(|field| field.value.clone()),
                _ => None,
            })
        })
}

fn events(batch: &ObjectBatch) -> Option<&EventList> {
    batch
        .overview
        .as_ref()?
        .sections
        .iter()
        .find_map(|section| {
            section.blocks.iter().find_map(|block| match block {
                Block::Events(list) => Some(list),
                _ => None,
            })
        })
}

fn cell(batch: &ObjectBatch, section: &str, row: usize, column: &str) -> Option<String> {
    let section = batch
        .overview
        .as_ref()?
        .sections
        .iter()
        .find(|candidate| candidate.id == section)?;
    section.blocks.iter().find_map(|block| match block {
        Block::Table { columns, rows } => {
            let at = columns.iter().position(|name| name == column)?;
            match rows.get(row)?.get(at)? {
                Value::Text { text } | Value::Code { text } | Value::Toned { text, .. } => {
                    Some(text.clone())
                }
                _ => None,
            }
        }
        _ => None,
    })
}

const OVERVIEW: ObjectParts = ObjectParts {
    overview: true,
    manifest: false,
    events: false,
    related: false,
};

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_open_object_follows_an_edit_and_its_events_while_they_are_shown() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("follow").await;
    let uid = cluster.pod(&namespace, json!([])).await;
    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), &cluster.path, &cluster.context);
    let mut opened = Opened::pod(&core, space, &namespace, OVERVIEW).await;

    let first = tokio::time::timeout(WAIT, opened.batches.recv())
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        opened.batches.try_recv().is_err(),
        "no second batch before the first is acknowledged"
    );
    let id = opened.id;
    core.object_ack("main", Ack { id, seq: first.seq }).unwrap();
    opened
        .until(|batch| {
            fields(batch, "Name")
                == Some(Value::Text {
                    text: "p1".to_owned(),
                })
        })
        .await;
    assert_eq!(
        core.hub.subscribers("events"),
        1,
        "the overview shows events"
    );

    let api: Api<DynamicObject> = Api::namespaced_with(
        cluster.admin.clone(),
        &namespace,
        &ApiResource {
            group: "events.k8s.io".to_owned(),
            version: "v1".to_owned(),
            api_version: "events.k8s.io/v1".to_owned(),
            kind: "Event".to_owned(),
            plural: "events".to_owned(),
        },
    );
    let event: DynamicObject = serde_json::from_value(json!({
        "apiVersion": "events.k8s.io/v1",
        "kind": "Event",
        "metadata": { "name": "probed" },
        "eventTime": "2026-11-02T10:00:00.000000Z",
        "reportingController": "twigo.io/test",
        "reportingInstance": "test",
        "action": "Probe",
        "reason": "Probed",
        "type": "Normal",
        "note": "probed by the test",
        "regarding": { "apiVersion": "v1", "kind": "Pod", "namespace": namespace, "name": "p1", "uid": uid },
    }))
    .unwrap();
    api.create(&PostParams::default(), &event).await.unwrap();
    opened
        .until(|batch| {
            events(batch).is_some_and(|list| list.events.iter().any(|e| e.reason == "Probed"))
        })
        .await;

    let patch = json!({ "metadata": { "labels": { "edited": "yes" } } });
    Api::<Pod>::namespaced(cluster.admin.clone(), &namespace)
        .patch("p1", &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .unwrap();
    opened
        .until(|batch| match fields(batch, "Labels") {
            Some(Value::Labels { labels }) => labels
                .iter()
                .any(|label| label.key == "edited" && label.value == "yes"),
            _ => false,
        })
        .await;

    core.object_set_parts(
        "main",
        SetParts {
            id,
            parts: ObjectParts::default(),
        },
    )
    .unwrap();
    let released = tokio::time::timeout(WAIT, async {
        while core.hub.subscribers("events") > 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(
        released.is_ok(),
        "the events' upstream is let go once hidden"
    );

    core.object_close("main", id).unwrap();
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn events_that_may_not_be_listed_say_why() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("forbidden").await;
    cluster.pod(&namespace, json!([])).await;
    let dir = tempfile::tempdir().unwrap();
    let (kubeconfig, context) = cluster.reader(&namespace, dir.path(), &["pods"]).await;
    let (core, space) = core(dir.path(), &kubeconfig, &context);
    let mut opened = Opened::pod(&core, space, &namespace, OVERVIEW).await;
    let batch = opened
        .until(|batch| events(batch).is_some_and(|list| list.unavailable.is_some()))
        .await;
    let reason = events(&batch).and_then(|list| list.unavailable.clone());
    assert!(
        reason.as_deref().is_some_and(|why| why.contains("events")),
        "{reason:?}"
    );
    assert!(batch.exists, "the pod itself may be read");
    core.object_close("main", opened.id).unwrap();
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_deleted_object_keeps_no_owners() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("deleted").await;
    let owner: ConfigMap =
        serde_json::from_value(json!({ "metadata": { "name": "owner" } })).unwrap();
    let owner = Api::<ConfigMap>::namespaced(cluster.admin.clone(), &namespace)
        .create(&PostParams::default(), &owner)
        .await
        .unwrap();
    let owners = json!([{
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "name": "owner",
        "uid": owner.metadata.uid,
    }]);
    cluster.pod(&namespace, owners).await;
    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), &cluster.path, &cluster.context);
    let parts = ObjectParts {
        related: true,
        ..OVERVIEW
    };
    let mut opened = Opened::pod(&core, space, &namespace, parts).await;
    opened
        .until(|batch| {
            batch
                .related
                .as_ref()
                .is_some_and(|related| related.owners.len() == 1)
        })
        .await;
    Api::<Pod>::namespaced(cluster.admin.clone(), &namespace)
        .delete("p1", &DeleteParams::default().grace_period(0))
        .await
        .unwrap();
    let gone = opened
        .until(|batch| !batch.exists && batch.status == ViewState::Ready)
        .await;
    assert_eq!(gone.related, Some(Related::default()));
    core.object_close("main", opened.id).unwrap();
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_describer_follows_the_objects_it_needs_while_the_overview_is_shown() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("needs").await;
    let service: DynamicObject = serde_json::from_value(json!({
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": { "name": "web" },
        "spec": { "ports": [{ "name": "http", "port": 80, "targetPort": 8080 }] },
    }))
    .unwrap();
    let services: Api<DynamicObject> = Api::namespaced_with(
        cluster.admin.clone(),
        &namespace,
        &ApiResource::erase::<k8s_openapi::api::core::v1::Service>(&()),
    );
    services
        .create(&PostParams::default(), &service)
        .await
        .unwrap();
    let slices: Api<DynamicObject> = Api::namespaced_with(
        cluster.admin.clone(),
        &namespace,
        &ApiResource {
            group: "discovery.k8s.io".to_owned(),
            version: "v1".to_owned(),
            api_version: "discovery.k8s.io/v1".to_owned(),
            kind: "EndpointSlice".to_owned(),
            plural: "endpointslices".to_owned(),
        },
    );
    let slice = |addresses: &[&str]| {
        json!({
            "apiVersion": "discovery.k8s.io/v1",
            "kind": "EndpointSlice",
            "metadata": { "name": "web-1", "labels": { "kubernetes.io/service-name": "web" } },
            "addressType": "IPv4",
            "ports": [{ "name": "http", "port": 8080, "protocol": "TCP" }],
            "endpoints": addresses
                .iter()
                .map(|address| json!({ "addresses": [address], "conditions": { "ready": true } }))
                .collect::<Vec<_>>(),
        })
    };
    slices
        .create(
            &PostParams::default(),
            &serde_json::from_value(slice(&["10.1.2.3"])).unwrap(),
        )
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), &cluster.path, &cluster.context);
    let mut opened = Opened::open(&core, space, "services", &namespace, "web", OVERVIEW).await;
    opened
        .until(|batch| {
            cell(batch, "core.ports", 0, "Endpoints").as_deref() == Some("10.1.2.3:8080")
        })
        .await;
    assert_eq!(core.hub.subscribers("endpointslices"), 1);

    let edited = slice(&["10.1.2.3", "10.1.2.4"]);
    slices
        .patch(
            "web-1",
            &PatchParams::apply("twigo-test").force(),
            &Patch::Apply(&edited),
        )
        .await
        .unwrap();
    opened
        .until(|batch| {
            cell(batch, "core.ports", 0, "Endpoints").as_deref()
                == Some("10.1.2.3:8080, 10.1.2.4:8080")
        })
        .await;

    core.object_set_parts(
        "main",
        SetParts {
            id: opened.id,
            parts: ObjectParts::default(),
        },
    )
    .unwrap();
    let released = tokio::time::timeout(WAIT, async {
        while core.hub.subscribers("endpointslices") > 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(released.is_ok(), "the slices are let go once hidden");
    core.object_set_parts(
        "main",
        SetParts {
            id: opened.id,
            parts: OVERVIEW,
        },
    )
    .unwrap();
    opened
        .until(|batch| {
            cell(batch, "core.ports", 0, "Endpoints").as_deref()
                == Some("10.1.2.3:8080, 10.1.2.4:8080")
        })
        .await;
    core.object_close("main", opened.id).unwrap();
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_list_with_a_field_selector_keeps_what_the_server_selects() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("fields").await;
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    for (name, node) in [("p1", "kwok-node-0"), ("p2", "kwok-node-1")] {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": name },
            "spec": { "nodeName": node, "containers": [{ "name": "app", "image": "fake" }] },
        }))
        .unwrap();
        pods.create(&PostParams::default(), &pod).await.unwrap();
    }
    let dir = tempfile::tempdir().unwrap();
    let (core, space) = core(dir.path(), &cluster.path, &cluster.context);
    let query = twigo_ipc::ListQuery {
        space,
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
        },
        namespaced: true,
        namespaces: Vec::new(),
        label_selector: None,
        field_selector: Some("spec.nodeName=kwok-node-0".to_owned()),
        owners: None,
        text: None,
        columns: None,
        sort: None,
        count_by: None,
        group_by: None,
        values: None,
    };
    let (sender, mut batches) = mpsc::unbounded_channel();
    let id = core
        .list_subscribe("main", query, move |batch| sender.send(batch).is_ok())
        .await
        .unwrap();
    core.list_set_window(
        "main",
        twigo_ipc::SetWindow {
            id,
            start: 0,
            end: 40,
        },
    )
    .unwrap();
    let ids = tokio::time::timeout(WAIT, async {
        loop {
            let batch = batches.recv().await.expect("the list is open");
            core.list_ack("main", Ack { id, seq: batch.seq }).unwrap();
            if batch.status == ViewState::Ready
                && let Some(window) = batch.window
            {
                return window.ids;
            }
        }
    })
    .await
    .expect("the list is ready within 30 s");
    let ids: Vec<String> = ids.into_iter().map(|id| id.0).collect();
    let mine: Vec<&String> = ids
        .iter()
        .filter(|id| id.contains(&format!("/{namespace}/")))
        .collect();
    assert_eq!(mine, [&format!("{}/{namespace}/p1", cluster.context)]);
    core.list_unsubscribe("main", id).unwrap();
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_need_that_may_not_be_read_says_why() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("refused").await;
    let service: DynamicObject = serde_json::from_value(json!({
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": { "name": "web" },
        "spec": { "ports": [{ "name": "http", "port": 80 }] },
    }))
    .unwrap();
    Api::<DynamicObject>::namespaced_with(
        cluster.admin.clone(),
        &namespace,
        &ApiResource::erase::<k8s_openapi::api::core::v1::Service>(&()),
    )
    .create(&PostParams::default(), &service)
    .await
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (kubeconfig, context) = cluster
        .reader(&namespace, dir.path(), &["services", "events"])
        .await;
    let (core, space) = core(dir.path(), &kubeconfig, &context);
    let mut opened = Opened::open(&core, space, "services", &namespace, "web", OVERVIEW).await;
    let batch = opened
        .until(|batch| {
            cell(batch, "core.ports", 0, "Endpoints")
                .is_some_and(|text| text.starts_with("You may not"))
        })
        .await;
    let refused = cell(&batch, "core.ports", 0, "Endpoints").unwrap();
    assert!(refused.contains("endpointslices"), "{refused}");
    core.object_close("main", opened.id).unwrap();
    cluster.delete(&namespace).await;
}
