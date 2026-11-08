//! The bus with deletes and Reveals: each friction a plan names, a
//! countdown's cancel that sends nothing, a plan that never runs on another
//! cluster than it was planned on, a read-only context whose write never
//! reaches the server, and a Reveal that shows a value only as it runs.

use std::time::Duration;

use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod, Secret};
use kube::Api;
use kube::api::{DeleteParams, ListParams, PostParams};
use serde_json::json;
use tokio::sync::mpsc;
use twigo_ipc::{
    ErrorKind, Friction, Gvr, Mode, ObjectParts, ObjectQuery, OpenObject, OperationEvent,
    PlanRequest, SetContextMode,
};

use super::{Cluster, WAIT, audit, core, kubectl, plan_delete, reference, run, target};

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_pod_its_replica_set_replaces_counts_down_and_a_cancel_sends_nothing() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("countdown").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let replica_set: ReplicaSet = serde_json::from_value(json!({
        "metadata": { "name": "web" },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": { "app": "web" } },
            "template": {
                "metadata": { "labels": { "app": "web" } },
                "spec": {
                    "nodeName": "kwok-node-0",
                    "containers": [{ "name": "app", "image": "fake" }],
                },
            },
        },
    }))
    .unwrap();
    Api::<ReplicaSet>::namespaced(cluster.admin.clone(), &namespace)
        .create(&PostParams::default(), &replica_set)
        .await
        .unwrap();
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    let listed = ListParams::default().labels("app=web");
    let pod = tokio::time::timeout(WAIT, async {
        loop {
            if let Some(pod) = pods.list(&listed).await.unwrap().items.pop() {
                return pod;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the replica set makes its pod");
    let name = pod.metadata.name.clone().unwrap();
    let uid = pod.metadata.uid.clone().unwrap();
    let pod_ref = || target("pods", Some(&namespace), &name);

    let cancelled = plan_delete(&core, &cluster, pod_ref()).await.unwrap();
    assert_eq!(cancelled.friction, Friction::Countdown { seconds: 5 });
    assert_eq!(cancelled.consequences, ["Its replica set web replaces it."]);
    assert_eq!(
        cancelled.question,
        format!("Delete pod {name} in {namespace} from {}?", cluster.context)
    );
    core.command_cancel("main", cancelled.id);
    tokio::time::sleep(Duration::from_secs(6)).await;
    let refused = run(&core, &cancelled, None).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::NotFound);
    assert_eq!(Cluster::uid(&pods, &name).await, Some(uid.clone()));
    assert!(
        audit(dir.path()).is_empty(),
        "a cancelled countdown sent nothing"
    );

    let early = plan_delete(&core, &cluster, pod_ref()).await.unwrap();
    let refused = run(&core, &early, None).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    assert_eq!(Cluster::uid(&pods, &name).await, Some(uid.clone()));

    let plan = plan_delete(&core, &cluster, pod_ref()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(5)).await;
    let told = run(&core, &plan, None).await.unwrap();
    assert_eq!(
        told.last(),
        Some(&OperationEvent::Done {
            text: format!("Deleted pod {name}"),
            undo_until: None,
        })
    );
    assert_ne!(Cluster::uid(&pods, &name).await, Some(uid));
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn each_friction_holds_its_plan_and_each_kubectl_line_does_the_same() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("friction").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let config_maps = Api::<ConfigMap>::namespaced(cluster.admin.clone(), &namespace);
    let context = &cluster.context;

    cluster.config_map(&namespace, "by-twigo").await;
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "by-twigo"),
    )
    .await
    .unwrap();
    assert_eq!(plan.friction, Friction::Confirm);
    assert_eq!(plan.confirm, "Delete config map");
    assert_eq!(
        plan.kubectl,
        format!("kubectl --context {context} delete configmaps by-twigo -n {namespace}")
    );
    let told = run(&core, &plan, None).await.unwrap();
    assert!(
        matches!(told.last(), Some(OperationEvent::Done { .. })),
        "{told:?}"
    );
    assert_eq!(Cluster::uid(&config_maps, "by-twigo").await, None);

    cluster.config_map(&namespace, "by-kubectl").await;
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "by-kubectl"),
    )
    .await
    .unwrap();
    core.command_cancel("main", plan.id);
    kubectl(&plan, &kubeconfig);
    assert_eq!(Cluster::uid(&config_maps, "by-kubectl").await, None);

    let typed = cluster.namespace("typed").await;
    let wide = || target("namespaces", None, &typed);
    let plan = plan_delete(&core, &cluster, wide()).await.unwrap();
    assert_eq!(
        plan.friction,
        Friction::Typed {
            text: typed.clone()
        }
    );
    assert_eq!(plan.consequences, ["Every object in it goes with it."]);
    let refused = run(&core, &plan, Some(context)).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    let namespaces = Api::<Namespace>::all(cluster.admin.clone());
    assert!(Cluster::uid(&namespaces, &typed).await.is_some());
    let plan = plan_delete(&core, &cluster, wide()).await.unwrap();
    let told = run(&core, &plan, Some(&typed)).await.unwrap();
    assert_eq!(
        told,
        [
            OperationEvent::Running {
                text: format!("Waiting for namespace {typed} to go")
            },
            OperationEvent::Done {
                text: format!("Deleted namespace {typed}"),
                undo_until: None,
            },
        ]
    );
    assert_eq!(Cluster::uid(&namespaces, &typed).await, None);

    let by_kubectl = cluster.namespace("kubectl").await;
    let plan = plan_delete(&core, &cluster, target("namespaces", None, &by_kubectl))
        .await
        .unwrap();
    core.command_cancel("main", plan.id);
    kubectl(&plan, &kubeconfig);
    assert_eq!(Cluster::uid(&namespaces, &by_kubectl).await, None);

    let lines = audit(dir.path());
    let events: Vec<&str> = lines
        .iter()
        .map(|line| line["event"].as_str().unwrap())
        .collect();
    assert_eq!(
        events,
        [
            "confirmed",
            "request",
            "ended",
            "confirmed",
            "request",
            "ended"
        ],
        "{lines:?}"
    );
    assert_eq!(
        lines[1]["target"],
        format!("configmaps/by-twigo in {namespace}")
    );
    assert_eq!(lines[1]["blocked"], serde_json::Value::Null);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn guarded_asks_for_the_context_s_name_and_read_only_sends_nothing() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("modes").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let config_maps = Api::<ConfigMap>::namespaced(cluster.admin.clone(), &namespace);
    let set = |mode| SetContextMode {
        context: cluster.context.clone(),
        mode: Some(mode),
    };

    cluster.config_map(&namespace, "guarded").await;
    core.set_context_mode(set(Mode::Guarded)).await.unwrap();
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "guarded"),
    )
    .await
    .unwrap();
    assert_eq!(
        plan.friction,
        Friction::Typed {
            text: cluster.context.clone()
        }
    );
    assert_eq!(plan.mode, Mode::Guarded);
    run(&core, &plan, Some(&cluster.context)).await.unwrap();
    assert_eq!(Cluster::uid(&config_maps, "guarded").await, None);

    let uid = cluster.config_map(&namespace, "locked").await;
    core.set_context_mode(set(Mode::ReadOnly)).await.unwrap();
    let blocked = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "locked"),
    )
    .await
    .unwrap_err();
    assert_eq!(blocked.kind, ErrorKind::Permissions);
    assert_eq!(blocked.blocked.unwrap().mode, Mode::ReadOnly);
    assert_eq!(Cluster::uid(&config_maps, "locked").await, Some(uid));
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_plan_never_runs_once_its_context_names_another_cluster() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("moved").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let uid = cluster.config_map(&namespace, "kept").await;
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "kept"),
    )
    .await
    .unwrap();

    let mut contexts = core.catalog.subscribe();
    contexts.borrow_and_update();
    let text = std::fs::read_to_string(&kubeconfig).unwrap();
    assert!(text.contains("https://127.0.0.1:"), "{text}");
    std::fs::write(
        &kubeconfig,
        text.replace("https://127.0.0.1:", "https://localhost:"),
    )
    .unwrap();
    tokio::time::timeout(WAIT, contexts.changed())
        .await
        .expect("the catalog reads the new server")
        .unwrap();

    let refused = run(&core, &plan, None).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Conflict);
    let config_maps = Api::<ConfigMap>::namespaced(cluster.admin.clone(), &namespace);
    assert_eq!(Cluster::uid(&config_maps, "kept").await, Some(uid));
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_reveal_asks_in_guarded_and_kubectl_reads_the_same_value() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("reveal").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let secret: Secret = serde_json::from_value(json!({
        "metadata": { "name": "db" },
        "stringData": { "password": "hunter2-live" },
        "data": { "key.der": "MIIBCgKCAQEA/w==" },
    }))
    .unwrap();
    Api::<Secret>::namespaced(cluster.admin.clone(), &namespace)
        .create(&PostParams::default(), &secret)
        .await
        .unwrap();

    let (sender, mut batches) = mpsc::unbounded_channel();
    let object = ObjectQuery {
        space: cluster.context.clone(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "secrets".to_owned(),
        },
        namespaced: true,
        namespace: Some(namespace.clone()),
        name: "db".to_owned(),
    };
    let parts = ObjectParts {
        overview: true,
        manifest: true,
        events: false,
        related: false,
    };
    let id = core
        .object_open("main", OpenObject { object, parts }, move |batch| {
            sender.send(batch).is_ok()
        })
        .await
        .unwrap();
    let shown = tokio::time::timeout(WAIT, async {
        loop {
            let batch = batches.recv().await.unwrap();
            core.object_ack("main", twigo_ipc::Ack { id, seq: batch.seq })
                .unwrap();
            if batch.exists && batch.manifest.is_some() {
                return batch;
            }
        }
    })
    .await
    .expect("the secret is listed");
    let sent = serde_json::to_string(&shown).unwrap();
    assert!(!sent.contains("hunter2"), "{sent}");

    core.set_context_mode(SetContextMode {
        context: cluster.context.clone(),
        mode: Some(Mode::Guarded),
    })
    .await
    .unwrap();
    for (key, expected, binary) in [
        ("password", "hunter2-live", false),
        ("key.der", "MIIBCgKCAQEA/w==", true),
    ] {
        let request = PlanRequest::Reveal {
            object: id,
            key: key.to_owned(),
        };
        let plan = core.command_plan("main", request).await.unwrap();
        assert_eq!(plan.friction, Friction::Confirm);
        assert!(!plan.kubectl.contains(expected), "{}", plan.kubectl);
        let told = run(&core, &plan, None).await.unwrap();
        assert_eq!(
            told,
            [OperationEvent::Revealed {
                value: expected.to_owned(),
                binary
            }]
        );
        assert_eq!(kubectl(&plan, &kubeconfig), expected, "{}", plan.kubectl);
    }

    let closed = core
        .command_plan(
            "main",
            PlanRequest::Reveal {
                object: id,
                key: "password".to_owned(),
            },
        )
        .await
        .unwrap();
    core.object_close("main", id).unwrap();
    let told = run(&core, &closed, None).await.unwrap();
    let [OperationEvent::Failed { error }] = told.as_slice() else {
        panic!("{told:?}");
    };
    assert_eq!(error.kind, ErrorKind::NotFound, "{}", error.message);

    core.state.flush().unwrap();
    for file in ["state.json", "audit.jsonl"] {
        let text = std::fs::read_to_string(dir.path().join(file)).unwrap();
        assert!(!text.contains("hunter2"), "{file}: {text}");
        assert!(!text.contains("MIIBCgKCAQEA"), "{file}: {text}");
    }
    let confirmed: Vec<_> = audit(dir.path())
        .into_iter()
        .filter(|line| line["event"] == "confirmed")
        .map(|line| line["target"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        confirmed,
        [
            format!("secrets/db in {namespace}, key password"),
            format!("secrets/db in {namespace}, key key.der"),
            format!("secrets/db in {namespace}, key password"),
        ]
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_object_replaced_since_the_plan_is_left_standing() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("replaced").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let config_maps = Api::<ConfigMap>::namespaced(cluster.admin.clone(), &namespace);
    cluster.config_map(&namespace, "settings").await;
    let plan = plan_delete(
        &core,
        &cluster,
        target("configmaps", Some(&namespace), "settings"),
    )
    .await
    .unwrap();
    config_maps
        .delete("settings", &DeleteParams::default())
        .await
        .unwrap();
    let replacement = cluster.config_map(&namespace, "settings").await;

    let told = run(&core, &plan, None).await.unwrap();
    let [OperationEvent::Failed { error }] = told.as_slice() else {
        panic!("{told:?}");
    };
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    assert_eq!(
        Cluster::uid(&config_maps, "settings").await,
        Some(replacement)
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_delete_lists_what_goes_with_it_and_several_ask_for_the_context_s_name() {
    let cluster = Cluster::connect().await;
    let first = cluster.namespace("several").await;
    let second = cluster.namespace("several").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let space = || context.clone();

    Api::<Deployment>::namespaced(cluster.admin.clone(), &first)
        .create(
            &PostParams::default(),
            &serde_json::from_value(json!({
                "metadata": { "name": "web" },
                "spec": {
                    "replicas": 2,
                    "selector": { "matchLabels": { "app": "web" } },
                    "template": {
                        "metadata": { "labels": { "app": "web" } },
                        "spec": {
                            "nodeName": "kwok-node-4",
                            "containers": [{ "name": "app", "image": "fake" }],
                        },
                    },
                },
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &first);
    let replica_sets = Api::<ReplicaSet>::namespaced(cluster.admin.clone(), &first);
    let listed = ListParams::default().labels("app=web");
    let made = tokio::time::timeout(WAIT, async {
        loop {
            let pods = pods.list(&listed).await.unwrap().items;
            let sets = replica_sets.list(&listed).await.unwrap().items;
            if pods.len() == 2 && sets.len() == 1 {
                let mut made: Vec<(String, String)> = pods
                    .into_iter()
                    .filter_map(|pod| Some(("Pod".to_owned(), pod.metadata.name?)))
                    .collect();
                made.push((
                    "ReplicaSet".to_owned(),
                    sets[0].metadata.name.clone().unwrap(),
                ));
                made.sort();
                return made;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the deployment makes its replica set and pods");
    let request = PlanRequest::Delete {
        space: space(),
        targets: vec![reference("apps", "v1", "deployments", Some(&first), "web")],
    };
    let plan = core.command_plan("main", request).await.unwrap();
    assert_eq!(plan.friction, Friction::Confirm);
    let [going] = plan.affected.as_slice() else {
        panic!("{:?}", plan.affected);
    };
    assert_eq!(going.title, "With it go");
    let mut listed: Vec<(String, String)> = going
        .objects
        .iter()
        .map(|object| (object.kind.clone(), object.name.clone()))
        .collect();
    listed.sort();
    assert_eq!(listed, made);
    let told = run(&core, &plan, None).await.unwrap();
    assert!(
        matches!(told.last(), Some(OperationEvent::Done { .. })),
        "{told:?}"
    );

    let config_maps =
        |namespace: &str| Api::<ConfigMap>::namespaced(cluster.admin.clone(), namespace);
    let several = |names: &[(&String, &str)]| PlanRequest::Delete {
        space: space(),
        targets: names
            .iter()
            .map(|(namespace, name)| target("configmaps", Some(namespace), name))
            .collect(),
    };
    let three = [(&first, "a"), (&first, "b"), (&second, "c")];
    for (namespace, name) in three {
        cluster.config_map(namespace, name).await;
    }
    let plan = core.command_plan("main", several(&three)).await.unwrap();
    assert_eq!(
        plan.friction,
        Friction::Typed {
            text: context.clone()
        }
    );
    assert_eq!(
        plan.question,
        format!("Delete 3 config maps in 2 namespaces from {context}?")
    );
    assert_eq!(plan.confirm, "Delete 3 config maps");
    assert_eq!(plan.affected[0].title, "Deletes");
    assert_eq!(plan.affected[0].objects.len(), 3);
    let mut namespaces = [&first, &second];
    namespaces.sort();
    let lines: Vec<String> = namespaces
        .iter()
        .map(|namespace| {
            let names = if *namespace == &first { "a b" } else { "c" };
            format!("kubectl --context {context} delete configmaps {names} -n {namespace}")
        })
        .collect();
    assert_eq!(plan.kubectl, lines.join("; "));
    let refused = run(&core, &plan, Some("3")).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    let plan = core.command_plan("main", several(&three)).await.unwrap();
    let told = run(&core, &plan, Some(context)).await.unwrap();
    assert_eq!(
        told.last(),
        Some(&OperationEvent::Done {
            text: "Deleted 3 config maps".to_owned(),
            undo_until: None,
        }),
        "{told:?}"
    );
    for (namespace, name) in three {
        assert_eq!(Cluster::uid(&config_maps(namespace), name).await, None);
    }

    let two = [(&first, "d"), (&second, "e")];
    for (namespace, name) in two {
        cluster.config_map(namespace, name).await;
    }
    let plan = core.command_plan("main", several(&two)).await.unwrap();
    core.command_cancel("main", plan.id);
    kubectl(&plan, &kubeconfig);
    for (namespace, name) in two {
        assert_eq!(Cluster::uid(&config_maps(namespace), name).await, None);
    }

    let two = [(&first, "f"), (&first, "g")];
    for (namespace, name) in two {
        cluster.config_map(namespace, name).await;
    }
    let plan = core.command_plan("main", several(&two)).await.unwrap();
    config_maps(&first)
        .delete("g", &DeleteParams::default())
        .await
        .unwrap();
    let replacement = cluster.config_map(&first, "g").await;
    let told = run(&core, &plan, Some(context)).await.unwrap();
    assert_eq!(
        told.last(),
        Some(&OperationEvent::Done {
            text: "Deleted 1 config map; config map g was replaced since you confirmed, so Twigo left it"
                .to_owned(),
            undo_until: None,
        }),
        "{told:?}"
    );
    assert_eq!(
        Cluster::uid(&config_maps(&first), "g").await,
        Some(replacement)
    );

    let two = [(&first, "h"), (&first, "i")];
    for (namespace, name) in two {
        cluster.config_map(namespace, name).await;
    }
    let plan = core.command_plan("main", several(&two)).await.unwrap();
    for (namespace, name) in two {
        config_maps(namespace)
            .delete(name, &DeleteParams::default())
            .await
            .unwrap();
        cluster.config_map(namespace, name).await;
    }
    let told = run(&core, &plan, Some(context)).await.unwrap();
    let [OperationEvent::Failed { error }] = told.as_slice() else {
        panic!("{told:?}");
    };
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    cluster.delete(&first).await;
    cluster.delete(&second).await;
}
