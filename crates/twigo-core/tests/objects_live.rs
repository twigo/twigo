//! An open object against a kind or kwok cluster: its batches wait for
//! their acks, it follows an edit and its events, and it holds its events'
//! upstream only while a view shows them.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-core --test objects_live -- --ignored

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::api::{ApiResource, DeleteParams, DynamicObject, Patch, PatchParams, PostParams};
use kube::config::Kubeconfig;
use kube::{Api, Config};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    Ack, Block, Gvr, ObjectBatch, ObjectParts, ObjectQuery, OpenObject, SetParts, SubscriptionId,
    Value,
};

const WAIT: Duration = Duration::from_secs(30);

struct Opened {
    core: Arc<Core>,
    id: SubscriptionId,
    batches: mpsc::UnboundedReceiver<ObjectBatch>,
}

impl Opened {
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

    /// Batches until one passes `wanted`.
    async fn until(&mut self, wanted: impl Fn(&ObjectBatch) -> bool) -> ObjectBatch {
        loop {
            let batch = self.next().await;
            if wanted(&batch) {
                return batch;
            }
        }
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

fn has_event(batch: &ObjectBatch, reason: &str) -> bool {
    batch.overview.as_ref().is_some_and(|overview| {
        overview.sections.iter().any(|section| {
            section.blocks.iter().any(|block| match block {
                Block::Events(list) => list.events.iter().any(|event| event.reason == reason),
                _ => false,
            })
        })
    })
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_open_object_follows_an_edit_and_its_events_while_they_are_shown() {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG").expect("TWIGO_TEST_KUBECONFIG");
    let kubeconfig = Kubeconfig::read_from(&path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: only kind and kwok clusters"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &Default::default())
        .await
        .unwrap();
    let admin = kube::Client::try_from(config).unwrap();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let namespace = format!("core-objects-{nanos}");
    Api::<Namespace>::all(admin.clone())
        .create(
            &PostParams::default(),
            &serde_json::from_value(json!({ "metadata": { "name": namespace } })).unwrap(),
        )
        .await
        .unwrap();
    let pods = Api::<Pod>::namespaced(admin.clone(), &namespace);
    let pod: Pod = serde_json::from_value(json!({
        "metadata": { "name": "p1" },
        "spec": { "nodeName": "kwok-node-0", "containers": [{ "name": "app", "image": "fake" }] },
    }))
    .unwrap();
    let uid = pods
        .create(&PostParams::default(), &pod)
        .await
        .unwrap()
        .metadata
        .uid
        .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(dir.path(), &dir.path().join("cache"));
    let space = core.state.open_space(&context).id;
    let (_status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(std::ffi::OsString, std::ffi::OsString)>(),
    ))));
    tokio::spawn({
        let core = Arc::clone(&core);
        let path = path.clone().into();
        async move { core.run(followed, Some(path)).await }
    });
    let (sender, batches) = mpsc::unbounded_channel();
    let query = ObjectQuery {
        space,
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
        },
        namespaced: true,
        namespace: Some(namespace.clone()),
        name: "p1".to_owned(),
    };
    let overview = ObjectParts {
        overview: true,
        ..ObjectParts::default()
    };
    let id = core
        .object_open(
            "main",
            OpenObject {
                object: query,
                parts: overview,
            },
            move |batch| sender.send(batch).is_ok(),
        )
        .await
        .unwrap();
    let mut opened = Opened {
        core: Arc::clone(&core),
        id,
        batches,
    };

    let first = tokio::time::timeout(WAIT, opened.batches.recv())
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        opened.batches.try_recv().is_err(),
        "no second batch before the first is acknowledged"
    );
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

    let events: Api<DynamicObject> = Api::namespaced_with(
        admin.clone(),
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
    events.create(&PostParams::default(), &event).await.unwrap();
    opened.until(|batch| has_event(batch, "Probed")).await;

    let patch = json!({ "metadata": { "labels": { "edited": "yes" } } });
    pods.patch("p1", &PatchParams::default(), &Patch::Merge(&patch))
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
    Api::<Namespace>::all(admin)
        .delete(&namespace, &DeleteParams::default())
        .await
        .unwrap();
}
