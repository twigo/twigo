//! The actions besides delete and Reveal: scale, restart, cordon, drain,
//! trigger and suspend, each seen in its object afterwards, the undo of
//! those that have one, a read-only context that sends none of them, and
//! what a person without rights is told before they try.

use std::time::Duration;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Node, PersistentVolumeClaim, Pod, ServiceAccount};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::RoleBinding;
use kube::Api;
use kube::api::{ListParams, Patch, PatchParams, PostParams};
use kube::config::{AuthInfo, Kubeconfig, NamedAuthInfo};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use twigo_ipc::{
    Access, AccessQuery, ErrorKind, Execute, Friction, Mode, OperationEvent, Plan, PlanRequest,
    SetContextMode,
};

use twigo_core::Core;

use super::{Cluster, WAIT, core, core_over, eventually, kubectl, plan, reference, run};

async fn create<K>(api: &Api<K>, value: Value) -> K
where
    K: kube::Resource + Clone + serde::Serialize + serde::de::DeserializeOwned + std::fmt::Debug,
{
    api.create(
        &PostParams::default(),
        &serde_json::from_value(value).unwrap(),
    )
    .await
    .unwrap()
}

async fn merge<K>(api: &Api<K>, name: &str, patch: Value) -> K
where
    K: kube::Resource + Clone + serde::de::DeserializeOwned + std::fmt::Debug,
{
    api.patch(name, &PatchParams::default(), &Patch::Merge(patch))
        .await
        .unwrap()
}

fn deployment(name: &str, replicas: u32, node: &str) -> Value {
    json!({
        "metadata": { "name": name },
        "spec": {
            "replicas": replicas,
            "selector": { "matchLabels": { "app": name } },
            "template": {
                "metadata": { "labels": { "app": name } },
                "spec": {
                    "nodeName": node,
                    "containers": [{ "name": "app", "image": "fake" }],
                },
            },
        },
    })
}

fn cronjob(name: &str, suspend: bool) -> Value {
    json!({
        "metadata": { "name": name },
        "spec": {
            "schedule": "0 0 1 1 *",
            "suspend": suspend,
            "jobTemplate": {
                "metadata": { "labels": { "app": name }, "annotations": { "team": "data" } },
                "spec": { "template": { "spec": {
                    "nodeName": "kwok-node-2",
                    "restartPolicy": "Never",
                    "containers": [{ "name": "app", "image": "fake" }],
                } } },
            },
        },
    })
}

async fn pods_of(pods: &Api<Pod>, app: &str, count: usize) -> Vec<String> {
    let listed = ListParams::default().labels(&format!("app={app}"));
    let names = tokio::time::timeout(WAIT, async {
        loop {
            let names: Vec<String> = pods
                .list(&listed)
                .await
                .unwrap()
                .items
                .into_iter()
                .filter(|pod| pod.metadata.deletion_timestamp.is_none())
                .filter_map(|pod| pod.metadata.name)
                .collect();
            if names.len() == count {
                return names;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
    names
        .await
        .unwrap_or_else(|_| panic!("{count} pods of {app} within 60 s"))
}

async fn uids(pods: &Api<Pod>, app: &str) -> std::collections::BTreeMap<String, String> {
    pods.list(&ListParams::default().labels(&format!("app={app}")))
        .await
        .unwrap()
        .items
        .into_iter()
        .filter(|pod| pod.metadata.deletion_timestamp.is_none())
        .filter_map(|pod| Some((pod.metadata.name?, pod.metadata.uid?)))
        .collect()
}

const RESUMED: &str = "Its schedule starts jobs again, and the latest run it missed while suspended starts at once, unless its starting deadline has passed.";

fn done(told: &[OperationEvent]) -> (&str, Option<i64>) {
    match told.last() {
        Some(OperationEvent::Done { text, undo_until }) => (text, *undo_until),
        other => panic!("{other:?}"),
    }
}

fn failed(told: &[OperationEvent]) -> &twigo_ipc::IpcError {
    match told.last() {
        Some(OperationEvent::Failed { error }) => error,
        other => panic!("{other:?}"),
    }
}

fn names(plan: &Plan, title: &str) -> Vec<String> {
    named(plan, title, |_| true)
}

fn names_in(plan: &Plan, title: &str, namespace: &str) -> Vec<String> {
    named(plan, title, |object| {
        object.namespace.as_deref() == Some(namespace)
    })
}

fn named(plan: &Plan, title: &str, keep: impl Fn(&twigo_ipc::ObjectRef) -> bool) -> Vec<String> {
    plan.affected
        .iter()
        .find(|affected| affected.title == title)
        .map(|affected| {
            affected
                .objects
                .iter()
                .filter(|object| keep(object))
                .map(|object| object.name.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn undo(cluster: &Cluster) -> PlanRequest {
    PlanRequest::Undo {
        space: cluster.context.clone(),
    }
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn scale_runs_at_once_and_its_undo_puts_it_back_unless_someone_else_changed_it() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("scale").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let (context, space) = (&cluster.context, cluster.context.clone());
    let deployments = Api::<Deployment>::namespaced(cluster.admin.clone(), &namespace);
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    create(&deployments, deployment("web", 1, "kwok-node-0")).await;
    let web = || reference("apps", "v1", "deployments", Some(&namespace), "web");
    let scale = |replicas| PlanRequest::Scale {
        space: space.clone(),
        target: web(),
        replicas,
    };
    let replicas = || async { deployments.get("web").await.unwrap().spec.replicas };

    let up = plan(&core, scale(3)).await.unwrap();
    assert_eq!(up.friction, Friction::AtOnce);
    assert_eq!(
        up.kubectl,
        format!(
            "kubectl --context {context} scale deployments.apps web --current-replicas 1 --replicas 3 -n {namespace}"
        )
    );
    let told = run(&core, &up, None).await.unwrap();
    let (text, undo_until) = done(&told);
    assert_eq!(text, "Scaled deployment web to 3");
    assert!(undo_until.is_some());
    assert_eq!(replicas().await, Some(3));

    pods_of(&pods, "web", 3).await;
    let back = plan(&core, undo(&cluster)).await.unwrap();
    assert_eq!(back.friction, Friction::AtOnce);
    assert_eq!(
        back.kubectl,
        format!(
            "kubectl --context {context} scale deployments.apps web --current-replicas 3 --replicas 1 -n {namespace}"
        )
    );
    let told = run(&core, &back, None).await.unwrap();
    assert_eq!(done(&told), ("Scaled deployment web back to 1", None));
    assert_eq!(replicas().await, Some(1));
    let nothing = plan(&core, undo(&cluster)).await.unwrap_err();
    assert_eq!(nothing.kind, ErrorKind::NotFound);

    run(&core, &plan(&core, scale(2)).await.unwrap(), None)
        .await
        .unwrap();
    merge(&deployments, "web", json!({ "spec": { "replicas": 4 } })).await;
    let refused = plan(&core, undo(&cluster)).await.unwrap();
    let told = run(&core, &refused, None).await.unwrap();
    let error = failed(&told);
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    assert_eq!(
        error.message,
        "Deployment web changed since you scaled it, so Twigo left it"
    );
    assert_eq!(replicas().await, Some(4));

    let moved = plan(&core, scale(5)).await.unwrap();
    merge(&deployments, "web", json!({ "spec": { "replicas": 3 } })).await;
    let told = run(&core, &moved, None).await.unwrap();
    let error = failed(&told);
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    assert_eq!(
        error.message,
        "Deployment web has 3 replicas now, not the 4 Twigo asked about, so it scaled nothing"
    );
    let there = plan(&core, scale(4)).await.unwrap();
    merge(&deployments, "web", json!({ "spec": { "replicas": 4 } })).await;
    let told = run(&core, &there, None).await.unwrap();
    assert_eq!(done(&told), ("Deployment web has 4 replicas already", None));
    assert_eq!(replicas().await, Some(4));

    let running = pods_of(&pods, "web", 4).await;
    let down = plan(&core, scale(0)).await.unwrap();
    assert_eq!(down.friction, Friction::Confirm);
    let mut going = names(&down, "Its pods go");
    going.sort();
    let mut expected = running;
    expected.sort();
    assert_eq!(going, expected);
    core.command_cancel("main", down.id);
    kubectl(&down, &kubeconfig);
    assert_eq!(replicas().await, Some(0));

    run(&core, &plan(&core, scale(2)).await.unwrap(), None)
        .await
        .unwrap();
    let running = pods_of(&pods, "web", 2).await;
    let back = plan(&core, undo(&cluster)).await.unwrap();
    assert_eq!(back.friction, Friction::Confirm);
    let mut going = names(&back, "Its pods go");
    going.sort();
    let mut expected = running;
    expected.sort();
    assert_eq!(going, expected);
    core.command_cancel("main", back.id);
    kubectl(&back, &kubeconfig);
    assert_eq!(replicas().await, Some(0));
    let same = plan(&core, scale(0)).await.unwrap_err();
    assert_eq!(same.kind, ErrorKind::InvalidInput);

    core.set_context_mode(SetContextMode {
        context: context.clone(),
        mode: Some(Mode::Guarded),
    })
    .await
    .unwrap();
    let guarded = plan(&core, scale(1)).await.unwrap();
    assert_eq!(
        guarded.friction,
        Friction::Typed {
            text: context.clone()
        }
    );
    run(&core, &guarded, Some(context)).await.unwrap();
    let back = plan(&core, undo(&cluster)).await.unwrap();
    assert_eq!(
        back.friction,
        Friction::Typed {
            text: context.clone()
        }
    );
    run(&core, &back, Some(context)).await.unwrap();
    assert_eq!(replicas().await, Some(0));

    core.set_context_mode(SetContextMode {
        context: context.clone(),
        mode: None,
    })
    .await
    .unwrap();
    create(&deployments, deployment("again", 1, "kwok-node-0")).await;
    pods_of(&pods, "again", 1).await;
    let sets = Api::<ReplicaSet>::namespaced(cluster.admin.clone(), &namespace);
    let set = sets
        .list(&ListParams::default().labels("app=again"))
        .await
        .unwrap()
        .items
        .remove(0)
        .metadata
        .name
        .unwrap();
    let owned = plan(
        &core,
        PlanRequest::Scale {
            space: space.clone(),
            target: reference("apps", "v1", "replicasets", Some(&namespace), &set),
            replicas: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        owned.consequences,
        [
            "Its pods go.",
            "Its deployment again controls its replicas and may set them back."
        ]
    );
    core.command_cancel("main", owned.id);

    let again = PlanRequest::Scale {
        space: space.clone(),
        target: reference("apps", "v1", "deployments", Some(&namespace), "again"),
        replicas: 2,
    };
    let planned = plan(&core, again).await.unwrap();
    deployments
        .delete("again", &kube::api::DeleteParams::default())
        .await
        .unwrap();
    eventually("the deployment goes", || async {
        deployments.get_opt("again").await.unwrap().is_none()
    })
    .await;
    create(&deployments, deployment("again", 1, "kwok-node-0")).await;
    let told = run(&core, &planned, None).await.unwrap();
    let error = failed(&told);
    assert_eq!(error.kind, ErrorKind::Conflict, "{}", error.message);
    assert_eq!(
        error.message,
        "Deployment again was replaced since Twigo asked, so it scaled nothing"
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn cordon_and_uncordon_run_at_once_and_their_undo_holds_to_the_field() {
    let cluster = Cluster::connect().await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let nodes = Api::<Node>::all(cluster.admin.clone());
    let name = "kwok-node-5";
    uncordon(&nodes, name).await;
    let cordon = |unschedulable| PlanRequest::Cordon {
        space: context.clone(),
        node: name.to_owned(),
        unschedulable,
    };
    let unschedulable = || async {
        nodes
            .get(name)
            .await
            .unwrap()
            .spec
            .unwrap()
            .unschedulable
            .unwrap_or(false)
    };

    let plan_cordon = plan(&core, cordon(true)).await.unwrap();
    assert_eq!(plan_cordon.friction, Friction::AtOnce);
    assert_eq!(
        plan_cordon.kubectl,
        format!("kubectl --context {context} cordon {name}")
    );
    let told = run(&core, &plan_cordon, None).await.unwrap();
    assert_eq!(done(&told).0, format!("Cordoned node {name}"));
    assert!(unschedulable().await);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let back = plan(&core, undo(&cluster)).await.unwrap();
    assert_eq!(
        back.kubectl,
        format!("kubectl --context {context} uncordon {name}")
    );
    run(&core, &back, None).await.unwrap();
    assert!(!unschedulable().await);

    let by_kubectl = plan(&core, cordon(true)).await.unwrap();
    core.command_cancel("main", by_kubectl.id);
    kubectl(&by_kubectl, &kubeconfig);
    assert!(unschedulable().await);
    let again = plan(&core, cordon(true)).await.unwrap_err();
    assert_eq!(again.kind, ErrorKind::InvalidInput);

    let late = plan(&core, cordon(false)).await.unwrap();
    merge(&nodes, name, json!({ "spec": { "unschedulable": null } })).await;
    let told = run(&core, &late, None).await.unwrap();
    let expected = format!("Node {name} is not cordoned");
    assert_eq!(done(&told), (expected.as_str(), None));
    assert!(!unschedulable().await);
    merge(&nodes, name, json!({ "spec": { "unschedulable": true } })).await;

    let uncordon = plan(&core, cordon(false)).await.unwrap();
    run(&core, &uncordon, None).await.unwrap();
    assert!(!unschedulable().await);
    merge(&nodes, name, json!({ "spec": { "unschedulable": true } })).await;
    let refused = plan(&core, undo(&cluster)).await.unwrap();
    let told = run(&core, &refused, None).await.unwrap();
    assert_eq!(failed(&told).kind, ErrorKind::Conflict);
    merge(&nodes, name, json!({ "spec": { "unschedulable": null } })).await;

    let uncordon = plan(&core, cordon(false)).await.unwrap_err();
    assert_eq!(uncordon.kind, ErrorKind::InvalidInput);

    let ghost = "twigo-ghost";
    let gone = || async {
        if nodes.get_opt(ghost).await.unwrap().is_some() {
            nodes
                .delete(ghost, &kube::api::DeleteParams::default())
                .await
                .unwrap();
        }
        eventually("the node goes", || async {
            nodes.get_opt(ghost).await.unwrap().is_none()
        })
        .await;
    };
    gone().await;
    create(&nodes, json!({ "metadata": { "name": ghost } })).await;
    let planned = plan(
        &core,
        PlanRequest::Cordon {
            space: context.clone(),
            node: ghost.to_owned(),
            unschedulable: true,
        },
    )
    .await
    .unwrap();
    gone().await;
    create(&nodes, json!({ "metadata": { "name": ghost } })).await;
    let told = run(&core, &planned, None).await.unwrap();
    assert_eq!(
        failed(&told).message,
        format!("Node {ghost} was replaced since Twigo asked, so it changed nothing")
    );
    assert!(!cordoned(&nodes, ghost).await);
    let planned = plan(
        &core,
        PlanRequest::Drain {
            space: context.clone(),
            node: ghost.to_owned(),
        },
    )
    .await
    .unwrap();
    gone().await;
    create(&nodes, json!({ "metadata": { "name": ghost } })).await;
    let told = run(&core, &planned, None).await.unwrap();
    assert_eq!(
        failed(&told).message,
        format!("Node {ghost} was replaced since Twigo asked, so it drained nothing")
    );
    assert!(!cordoned(&nodes, ghost).await);
    gone().await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_restart_stamps_the_template_and_lists_the_pods_it_replaces() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("restart").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let deployments = Api::<Deployment>::namespaced(cluster.admin.clone(), &namespace);
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    create(&deployments, deployment("web", 2, "kwok-node-1")).await;
    let running = pods_of(&pods, "web", 2).await;
    let restart = || PlanRequest::Restart {
        space: context.clone(),
        target: reference("apps", "v1", "deployments", Some(&namespace), "web"),
    };
    let stamp = || async {
        deployments
            .get("web")
            .await
            .unwrap()
            .spec
            .template
            .metadata
            .unwrap()
            .annotations
            .unwrap_or_default()
            .get("kubectl.kubernetes.io/restartedAt")
            .cloned()
    };

    let planned = plan(&core, restart()).await.unwrap();
    assert_eq!(planned.friction, Friction::Confirm);
    assert_eq!(
        planned.kubectl,
        format!("kubectl --context {context} rollout restart deployments.apps/web -n {namespace}")
    );
    let mut replaced = names(&planned, "Replaces");
    replaced.sort();
    let mut expected = running;
    expected.sort();
    assert_eq!(replaced, expected);
    let told = run(&core, &planned, None).await.unwrap();
    assert_eq!(done(&told), ("Restarted deployment web", None));
    let first = stamp().await.expect("the template is stamped");

    tokio::time::sleep(Duration::from_millis(1100)).await;
    let by_kubectl = plan(&core, restart()).await.unwrap();
    core.command_cancel("main", by_kubectl.id);
    kubectl(&by_kubectl, &kubeconfig);
    let second = stamp().await.expect("kubectl stamps it");
    assert_ne!(first, second);

    let sets = Api::<StatefulSet>::namespaced(cluster.admin.clone(), &namespace);
    let set = |name: &str, strategy: Value| {
        json!({
            "metadata": { "name": name },
            "spec": {
                "replicas": 3,
                "serviceName": name,
                "ordinals": { "start": 2 },
                "selector": { "matchLabels": { "app": name } },
                "updateStrategy": strategy,
                "template": {
                    "metadata": { "labels": { "app": name } },
                    "spec": {
                        "nodeName": "kwok-node-1",
                        "containers": [{ "name": "app", "image": "fake" }],
                    },
                },
            },
        })
    };
    create(&sets, set("kept", json!({ "type": "OnDelete" }))).await;
    let partitioned = json!({ "type": "RollingUpdate", "rollingUpdate": { "partition": 1 } });
    create(&sets, set("part", partitioned)).await;
    pods_of(&pods, "kept", 3).await;
    pods_of(&pods, "part", 3).await;
    let restart_set = |name: &str| PlanRequest::Restart {
        space: context.clone(),
        target: reference("apps", "v1", "statefulsets", Some(&namespace), name),
    };
    let (kept, part) = (uids(&pods, "kept").await, uids(&pods, "part").await);

    let planned = plan(&core, restart_set("kept")).await.unwrap();
    assert!(planned.affected.is_empty(), "{:?}", planned.affected);
    assert_eq!(
        planned.consequences,
        [
            "Its pods keep running: its update strategy is OnDelete, so each takes the new template only once it is deleted."
        ]
    );
    run(&core, &planned, None).await.unwrap();
    let planned = plan(&core, restart_set("part")).await.unwrap();
    let mut replaced = names(&planned, "Replaces");
    replaced.sort();
    assert_eq!(replaced, ["part-3", "part-4"]);
    assert_eq!(
        planned.consequences,
        [
            "Its pods from ordinal 3 up are replaced in turn; those below its partition keep running."
        ]
    );
    run(&core, &planned, None).await.unwrap();
    let rolled = || async {
        let status = sets.get("part").await.unwrap().status.unwrap();
        (status.updated_replicas, status.ready_replicas)
    };
    eventually("the pods past the partition are replaced", || async {
        let now = uids(&pods, "part").await;
        let replaced = ["part-3", "part-4"].iter().all(|name| {
            now.get(*name)
                .is_some_and(|uid| part.get(*name) != Some(uid))
        });
        replaced && rolled().await == (Some(2), Some(3))
    })
    .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(rolled().await, (Some(2), Some(3)));
    assert_eq!(uids(&pods, "part").await.get("part-2"), part.get("part-2"));
    assert_eq!(uids(&pods, "kept").await, kept);

    create(&deployments, deployment("renewed", 1, "kwok-node-1")).await;
    let renewed = plan(
        &core,
        PlanRequest::Restart {
            space: context.clone(),
            target: reference("apps", "v1", "deployments", Some(&namespace), "renewed"),
        },
    )
    .await
    .unwrap();
    deployments
        .delete("renewed", &kube::api::DeleteParams::default())
        .await
        .unwrap();
    eventually("the deployment goes", || async {
        deployments.get_opt("renewed").await.unwrap().is_none()
    })
    .await;
    create(&deployments, deployment("renewed", 1, "kwok-node-1")).await;
    let told = run(&core, &renewed, None).await.unwrap();
    assert_eq!(
        failed(&told).message,
        "Deployment renewed was replaced since Twigo asked, so it restarted nothing"
    );

    merge(&deployments, "web", json!({ "spec": { "paused": true } })).await;
    let paused = plan(&core, restart()).await.unwrap_err();
    assert_eq!(paused.kind, ErrorKind::InvalidInput);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_trigger_makes_a_job_of_the_cron_job_s_template_as_kubectl_does() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("trigger").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let cronjobs = Api::<CronJob>::namespaced(cluster.admin.clone(), &namespace);
    let jobs = Api::<Job>::namespaced(cluster.admin.clone(), &namespace);
    let uid = create(&cronjobs, cronjob("backup", true))
        .await
        .metadata
        .uid
        .unwrap();
    let trigger = || PlanRequest::Trigger {
        space: context.clone(),
        namespace: namespace.clone(),
        name: "backup".to_owned(),
    };
    let job_of = |plan: &Plan| {
        plan.consequences[0]
            .strip_prefix("Job ")
            .and_then(|rest| rest.split_once(' '))
            .map(|(name, _)| name.to_owned())
            .expect("the plan names its job")
    };
    let made = |job: Job| {
        let metadata = job.metadata;
        let annotations = metadata.annotations.unwrap_or_default();
        assert_eq!(
            annotations
                .get("cronjob.kubernetes.io/instantiate")
                .map(String::as_str),
            Some("manual")
        );
        assert_eq!(annotations.get("team").map(String::as_str), Some("data"));
        let owner = &metadata.owner_references.unwrap()[0];
        assert_eq!(
            (owner.kind.as_str(), owner.uid.as_str()),
            ("CronJob", uid.as_str())
        );
        assert_eq!(owner.controller, Some(true));
    };

    let planned = plan(&core, trigger()).await.unwrap();
    assert_eq!(planned.friction, Friction::Confirm);
    let job = job_of(&planned);
    assert!(job.starts_with("backup-manual-"), "{job}");
    assert_eq!(
        planned.kubectl,
        format!(
            "kubectl --context {context} create job {job} --from cronjob/backup -n {namespace}"
        )
    );
    let told = run(&core, &planned, None).await.unwrap();
    assert_eq!(done(&told), (format!("Created job {job}").as_str(), None));
    made(jobs.get(&job).await.unwrap());

    let by_kubectl = plan(&core, trigger()).await.unwrap();
    core.command_cancel("main", by_kubectl.id);
    kubectl(&by_kubectl, &kubeconfig);
    made(jobs.get(&job_of(&by_kubectl)).await.unwrap());
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn suspend_and_resume_run_at_once_and_their_undo_holds_to_the_generation() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("suspend").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let cronjobs = Api::<CronJob>::namespaced(cluster.admin.clone(), &namespace);
    let jobs = Api::<Job>::namespaced(cluster.admin.clone(), &namespace);
    create(&cronjobs, cronjob("nightly", false)).await;
    create(
        &jobs,
        json!({
            "metadata": { "name": "held" },
            "spec": {
                "suspend": true,
                "template": { "spec": {
                    "nodeName": "kwok-node-2",
                    "restartPolicy": "Never",
                    "containers": [{ "name": "app", "image": "fake" }],
                } },
            },
        }),
    )
    .await;
    let suspend = |resource: &str, name: &str, suspend| PlanRequest::Suspend {
        space: context.clone(),
        target: reference("batch", "v1", resource, Some(&namespace), name),
        suspend,
    };
    let cronjob_suspended =
        || async { cronjobs.get("nightly").await.unwrap().spec.suspend == Some(true) };
    let job_suspended =
        || async { jobs.get("held").await.unwrap().spec.unwrap().suspend == Some(true) };

    let planned = plan(&core, suspend("cronjobs", "nightly", true))
        .await
        .unwrap();
    assert_eq!(planned.friction, Friction::AtOnce);
    assert_eq!(
        planned.kubectl,
        format!(
            r#"kubectl --context {context} patch cronjobs.batch nightly --type merge -p '{{"spec":{{"suspend":true}}}}' -n {namespace}"#
        )
    );
    let told = run(&core, &planned, None).await.unwrap();
    assert_eq!(done(&told).0, "Suspended cron job nightly");
    assert!(cronjob_suspended().await);
    let back = plan(&core, undo(&cluster)).await.unwrap();
    run(&core, &back, None).await.unwrap();
    assert!(!cronjob_suspended().await);

    run(
        &core,
        &plan(&core, suspend("cronjobs", "nightly", true))
            .await
            .unwrap(),
        None,
    )
    .await
    .unwrap();
    merge(
        &cronjobs,
        "nightly",
        json!({ "spec": { "schedule": "0 1 1 1 *" } }),
    )
    .await;
    let refused = plan(&core, undo(&cluster)).await.unwrap();
    assert_eq!(refused.consequences, [RESUMED]);
    let told = run(&core, &refused, None).await.unwrap();
    assert_eq!(failed(&told).kind, ErrorKind::Conflict);
    assert!(cronjob_suspended().await);
    let resume = plan(&core, suspend("cronjobs", "nightly", false))
        .await
        .unwrap();
    assert_eq!(resume.friction, Friction::AtOnce);
    assert_eq!(resume.consequences, [RESUMED]);
    core.command_cancel("main", resume.id);

    create(&cronjobs, cronjob("again", false)).await;
    run(
        &core,
        &plan(&core, suspend("cronjobs", "again", true))
            .await
            .unwrap(),
        None,
    )
    .await
    .unwrap();
    cronjobs
        .delete("again", &kube::api::DeleteParams::default())
        .await
        .unwrap();
    create(&cronjobs, cronjob("again", false)).await;
    merge(&cronjobs, "again", json!({ "spec": { "suspend": true } })).await;
    let refused = plan(&core, undo(&cluster)).await.unwrap();
    let told = run(&core, &refused, None).await.unwrap();
    assert_eq!(
        failed(&told).message,
        "Cron job again was replaced since you suspended it, so Twigo left it"
    );

    let mut waiting = json!({
        "metadata": { "name": "waiting" },
        "spec": { "template": { "spec": {
            "nodeSelector": { "twigo.io/no-such-node": "anywhere" },
            "restartPolicy": "Never",
            "containers": [{ "name": "app", "image": "fake" }],
        } } },
    });
    waiting["spec"]["parallelism"] = json!(1);
    create(&jobs, waiting).await;
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    let pending = tokio::time::timeout(WAIT, async {
        loop {
            let listed = pods
                .list(&ListParams::default().labels("batch.kubernetes.io/job-name=waiting"))
                .await
                .unwrap()
                .items;
            let active = jobs
                .get("waiting")
                .await
                .unwrap()
                .status
                .and_then(|status| status.active);
            if let (Some(pod), Some(1)) = (listed.first(), active) {
                return pod.metadata.name.clone().unwrap();
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the job's pod waits for a node");
    let stopping = plan(&core, suspend("jobs", "waiting", true)).await.unwrap();
    assert_eq!(stopping.friction, Friction::Confirm);
    assert_eq!(names(&stopping, "Its pods stop"), [pending]);
    run(&core, &stopping, None).await.unwrap();
    let resumed = plan(&core, suspend("jobs", "waiting", false))
        .await
        .unwrap();
    assert_eq!(resumed.friction, Friction::AtOnce);
    run(&core, &resumed, None).await.unwrap();
    eventually("the resumed job runs a pod", || async {
        jobs.get("waiting")
            .await
            .unwrap()
            .status
            .and_then(|status| status.active)
            == Some(1)
    })
    .await;
    let back = plan(&core, undo(&cluster)).await.unwrap();
    assert_eq!(back.friction, Friction::Confirm);
    core.command_cancel("main", back.id);

    let resume = plan(&core, suspend("jobs", "held", false)).await.unwrap();
    let told = run(&core, &resume, None).await.unwrap();
    assert_eq!(done(&told).0, "Resumed job held");
    assert!(!job_suspended().await);
    let again = plan(&core, suspend("jobs", "held", false))
        .await
        .unwrap_err();
    assert_eq!(again.kind, ErrorKind::InvalidInput);
    let by_kubectl = plan(&core, suspend("jobs", "held", true)).await.unwrap();
    core.command_cancel("main", by_kubectl.id);
    kubectl(&by_kubectl, &kubeconfig);
    assert!(job_suspended().await);

    create(&cronjobs, cronjob("late", false)).await;
    let late = plan(&core, suspend("cronjobs", "late", true))
        .await
        .unwrap();
    merge(&cronjobs, "late", json!({ "spec": { "suspend": true } })).await;
    let told = run(&core, &late, None).await.unwrap();
    assert_eq!(done(&told), ("Cron job late is suspended already", None));

    create(&cronjobs, cronjob("renewed", false)).await;
    let planned = plan(&core, suspend("cronjobs", "renewed", true))
        .await
        .unwrap();
    cronjobs
        .delete("renewed", &kube::api::DeleteParams::default())
        .await
        .unwrap();
    eventually("the cron job goes", || async {
        cronjobs.get_opt("renewed").await.unwrap().is_none()
    })
    .await;
    create(&cronjobs, cronjob("renewed", false)).await;
    let told = run(&core, &planned, None).await.unwrap();
    assert_eq!(
        failed(&told).message,
        "Cron job renewed was replaced since Twigo asked, so it changed nothing"
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_job_s_suspend_lists_the_pods_it_owns_and_says_what_it_cannot_read() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("owned").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let jobs = Api::<Job>::namespaced(cluster.admin.clone(), &namespace);
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    let deployments = Api::<Deployment>::namespaced(cluster.admin.clone(), &namespace);
    create(&deployments, deployment("manual", 1, "kwok-node-2")).await;
    pods_of(&pods, "manual", 1).await;
    create(
        &jobs,
        json!({
            "metadata": { "name": "chosen" },
            "spec": {
                "manualSelector": true,
                "selector": { "matchLabels": { "app": "manual" } },
                "template": {
                    "metadata": { "labels": { "app": "manual" } },
                    "spec": {
                        "nodeSelector": { "twigo.io/no-such-node": "anywhere" },
                        "restartPolicy": "Never",
                        "containers": [{ "name": "app", "image": "fake" }],
                    },
                },
            },
        }),
    )
    .await;
    let chosen = jobs.get("chosen").await.unwrap().metadata.uid.unwrap();
    let own = tokio::time::timeout(WAIT, async {
        loop {
            let owned: Vec<String> = pods
                .list(&ListParams::default())
                .await
                .unwrap()
                .items
                .into_iter()
                .filter(|pod| {
                    pod.metadata
                        .owner_references
                        .iter()
                        .flatten()
                        .any(|owner| owner.uid == chosen)
                })
                .filter_map(|pod| pod.metadata.name)
                .collect();
            let active = jobs
                .get("chosen")
                .await
                .unwrap()
                .status
                .and_then(|status| status.active);
            if owned.len() == 1 && active == Some(1) {
                return owned;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the job runs a pod");
    let suspend = |name: &str| PlanRequest::Suspend {
        space: context.clone(),
        target: reference("batch", "v1", "jobs", Some(&namespace), name),
        suspend: true,
    };
    let stopping = plan(&core, suspend("chosen")).await.unwrap();
    assert_eq!(stopping.friction, Friction::Confirm);
    assert_eq!(names(&stopping, "Its pods stop"), own);
    core.command_cancel("main", stopping.id);

    create(
        &Api::<k8s_openapi::api::rbac::v1::Role>::namespaced(cluster.admin.clone(), &namespace),
        json!({
            "metadata": { "name": "suspender" },
            "rules": [{ "apiGroups": ["batch"], "resources": ["jobs"], "verbs": ["get", "patch"] }],
        }),
    )
    .await;
    let role = json!({ "kind": "Role", "name": "suspender" });
    let (_dir, suspender, space) = as_account(&cluster, &namespace, "suspender", role).await;
    let blind = plan(
        &suspender,
        PlanRequest::Suspend {
            space,
            target: reference("batch", "v1", "jobs", Some(&namespace), "chosen"),
            suspend: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(blind.friction, Friction::Confirm);
    assert!(blind.affected.is_empty(), "{:?}", blind.affected);
    let unread = format!("Twigo cannot read the pods in {namespace}, so it cannot say which run.");
    assert!(
        blind.consequences.contains(&unread),
        "{:?}",
        blind.consequences
    );
    suspender.command_cancel("main", blind.id);

    create(
        &jobs,
        json!({
            "metadata": { "name": "finished" },
            "spec": { "template": { "spec": {
                "nodeName": "kwok-node-2",
                "restartPolicy": "Never",
                "containers": [{ "name": "app", "image": "fake" }],
            } } },
        }),
    )
    .await;
    eventually("the job completes", || async {
        jobs.get("finished")
            .await
            .unwrap()
            .status
            .and_then(|status| status.conditions)
            .unwrap_or_default()
            .iter()
            .any(|condition| condition.type_ == "Complete" && condition.status == "True")
    })
    .await;
    let ended = plan(&core, suspend("finished")).await.unwrap_err();
    assert_eq!(ended.kind, ErrorKind::InvalidInput);
    assert_eq!(
        ended.message,
        "Job finished has completed, so there is nothing to suspend"
    );
    cluster.delete(&namespace).await;
}

async fn cordoned(nodes: &Api<Node>, name: &str) -> bool {
    nodes
        .get(name)
        .await
        .unwrap()
        .spec
        .unwrap()
        .unschedulable
        .unwrap_or(false)
}

async fn uncordon(nodes: &Api<Node>, name: &str) {
    merge(nodes, name, json!({ "spec": { "unschedulable": null } })).await;
}

fn budget(app: &str, min: u32) -> Value {
    json!({
        "metadata": { "name": app },
        "spec": { "minAvailable": min, "selector": { "matchLabels": { "app": app } } },
    })
}

async fn observed(budgets: &Api<PodDisruptionBudget>, name: &str, expected: i32) {
    eventually(&format!("the budget {name} sees its pods"), || async {
        budgets
            .get(name)
            .await
            .unwrap()
            .status
            .is_some_and(|status| {
                status.expected_pods == Some(expected) && status.current_healthy == Some(expected)
            })
    })
    .await;
}

const HELD: &str = "A disruption budget holds pod";

async fn running_until<Then, Done>(
    core: &Core,
    plan: &Plan,
    typed: Option<&str>,
    when: &str,
    then: Then,
) -> Vec<OperationEvent>
where
    Then: FnOnce() -> Done,
    Done: std::future::Future<Output = ()>,
{
    let (sender, mut events) = mpsc::unbounded_channel();
    core.command_execute(
        "main",
        Execute {
            plan: plan.id,
            typed: typed.map(str::to_owned),
        },
        move |event| sender.send(event).is_ok(),
    )
    .await
    .unwrap();
    let mut then = Some(then);
    let mut told = Vec::new();
    tokio::time::timeout(WAIT, async {
        while let Some(event) = events.recv().await {
            let last = !matches!(event, OperationEvent::Running { .. });
            if let OperationEvent::Running { text } = &event
                && text.starts_with(when)
                && let Some(then) = then.take()
            {
                then().await;
            }
            told.push(event);
            if last {
                return;
            }
        }
    })
    .await
    .expect("the run ends within 60 s");
    told
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_drain_waits_on_a_budget_then_finishes_and_leaves_daemon_set_pods() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("drain").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let node = "kwok-node-6";
    let nodes = Api::<Node>::all(cluster.admin.clone());
    uncordon(&nodes, node).await;
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    let budgets = Api::<PodDisruptionBudget>::namespaced(cluster.admin.clone(), &namespace);
    let label =
        |value: Option<&str>| json!({ "metadata": { "labels": { "twigo.io/drain-test": value } } });
    let elsewhere = "kwok-node-3";
    merge(&nodes, node, label(Some(&namespace))).await;
    let mut web = deployment("web", 2, node);
    let template = &mut web["spec"]["template"]["spec"];
    template.as_object_mut().unwrap().remove("nodeName");
    template["nodeSelector"] = json!({ "twigo.io/drain-test": namespace });
    template["tolerations"] = json!([{ "key": "kwok.x-k8s.io/node", "operator": "Exists" }]);
    create(
        &Api::<Deployment>::namespaced(cluster.admin.clone(), &namespace),
        web,
    )
    .await;
    create(&budgets, budget("web", 1)).await;
    create(
        &Api::<DaemonSet>::namespaced(cluster.admin.clone(), &namespace),
        json!({
            "metadata": { "name": "agent" },
            "spec": {
                "selector": { "matchLabels": { "app": "agent" } },
                "template": {
                    "metadata": { "labels": { "app": "agent" } },
                    "spec": {
                        "nodeSelector": { "kubernetes.io/hostname": node },
                        "tolerations": [{ "key": "kwok.x-k8s.io/node", "operator": "Exists" }],
                        "containers": [{ "name": "app", "image": "fake" }],
                    },
                },
            },
        }),
    )
    .await;
    let web = pods_of(&pods, "web", 2).await;
    let agent = pods_of(&pods, "agent", 1).await;
    observed(&budgets, "web", 2).await;

    let planned = plan(
        &core,
        PlanRequest::Drain {
            space: context.clone(),
            node: node.to_owned(),
        },
    )
    .await
    .unwrap();
    assert_eq!(planned.friction, Friction::Confirm);
    assert_eq!(
        planned.kubectl,
        format!("kubectl --context {context} drain {node} --ignore-daemonsets")
    );
    let evicts = names_in(&planned, "Evicts", &namespace);
    for pod in &web {
        assert!(evicts.contains(pod), "{pod} in {evicts:?}");
    }
    assert!(!evicts.contains(&agent[0]), "{evicts:?}");
    let staying = names_in(
        &planned,
        "Stay, as their daemon sets run them on every node",
        &namespace,
    );
    assert!(staying.contains(&agent[0]), "{staying:?}");

    let mut held = false;
    let told = running_until(&core, &planned, None, HELD, || {
        held = true;
        async {
            merge(&nodes, elsewhere, label(Some(&namespace))).await;
        }
    })
    .await;
    assert!(held, "a budget held a pod back: {told:?}");
    assert_eq!(done(&told), (format!("Drained node {node}").as_str(), None));
    assert!(cordoned(&nodes, node).await);
    let left = pods.list(&ListParams::default()).await.unwrap().items;
    for pod in &web {
        assert!(
            left.iter()
                .all(|left| left.metadata.name.as_ref() != Some(pod)),
            "{pod} went"
        );
    }
    assert!(
        left.iter()
            .any(|left| left.metadata.name.as_ref() == Some(&agent[0])),
        "its daemon set's pod stays"
    );
    cluster.delete(&namespace).await;
    uncordon(&nodes, node).await;
    merge(&nodes, node, label(None)).await;
    merge(&nodes, elsewhere, label(None)).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_stopped_drain_leaves_the_node_cordoned_and_says_so() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("stuck").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let node = "kwok-node-7";
    let nodes = Api::<Node>::all(cluster.admin.clone());
    uncordon(&nodes, node).await;
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    let budgets = Api::<PodDisruptionBudget>::namespaced(cluster.admin.clone(), &namespace);
    create(
        &Api::<Deployment>::namespaced(cluster.admin.clone(), &namespace),
        deployment("stuck", 1, node),
    )
    .await;
    create(&budgets, budget("stuck", 1)).await;
    let deployments = Api::<Deployment>::namespaced(cluster.admin.clone(), &namespace);
    create(&deployments, deployment("loose", 1, node)).await;
    create(&deployments, deployment("both", 1, node)).await;
    for name in ["both-a", "both-b"] {
        let mut twice = budget("both", 0);
        twice["metadata"]["name"] = json!(name);
        create(&budgets, twice).await;
    }
    let stuck = pods_of(&pods, "stuck", 1).await;
    let loose = pods_of(&pods, "loose", 1).await;
    let both = pods_of(&pods, "both", 1).await;
    observed(&budgets, "stuck", 1).await;

    let planned = plan(
        &core,
        PlanRequest::Drain {
            space: cluster.context.clone(),
            node: node.to_owned(),
        },
    )
    .await
    .unwrap();
    let told = running_until(&core, &planned, None, HELD, || async {
        core.command_cancel("main", planned.id);
    })
    .await;
    let Some(OperationEvent::Stopped { text }) = told.last() else {
        panic!("{told:?}");
    };
    assert!(
        text.starts_with(&format!(
            "Stopped draining node {node}, which stays cordoned; it evicted 1 of 3 pods; evicting pod {namespace}/{} failed:",
            both[0]
        )),
        "{text}"
    );
    assert!(cordoned(&nodes, node).await);
    assert_eq!(pods_of(&pods, "stuck", 1).await, stuck);
    eventually("the evicted pod goes", || async {
        pods.get_opt(&loose[0]).await.unwrap().is_none()
    })
    .await;
    cluster.delete(&namespace).await;
    uncordon(&nodes, node).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_drain_that_meets_pods_kubectl_refuses_asks_for_the_node_s_name_and_takes_them() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("forced").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let nodes = Api::<Node>::all(cluster.admin.clone());
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    let (forced, plain) = ("kwok-node-8", "kwok-node-9");
    uncordon(&nodes, forced).await;
    uncordon(&nodes, plain).await;
    create(
        &pods,
        json!({
            "metadata": { "name": "lonely", "labels": { "app": "lonely" } },
            "spec": { "nodeName": forced, "containers": [{ "name": "app", "image": "fake" }] },
        }),
    )
    .await;
    let mut scratch = deployment("scratch", 1, forced);
    scratch["spec"]["template"]["spec"]["volumes"] = json!([{ "name": "tmp", "emptyDir": {} }]);
    let deployments = Api::<Deployment>::namespaced(cluster.admin.clone(), &namespace);
    create(&deployments, scratch).await;
    create(&deployments, deployment("plain", 1, plain)).await;
    pods_of(&pods, "lonely", 1).await;
    let scratched = pods_of(&pods, "scratch", 1).await;
    pods_of(&pods, "plain", 1).await;
    let drain = |node: &str| PlanRequest::Drain {
        space: context.clone(),
        node: node.to_owned(),
    };

    let planned = plan(&core, drain(forced)).await.unwrap();
    assert_eq!(
        planned.friction,
        Friction::Typed {
            text: forced.to_owned()
        }
    );
    assert_eq!(planned.confirm, "Drain node with force");
    assert_eq!(
        planned.kubectl,
        format!(
            "kubectl --context {context} drain {forced} --ignore-daemonsets --delete-emptydir-data --force"
        )
    );
    assert_eq!(
        names_in(
            &planned,
            "Gone for good, with no controller to replace them",
            &namespace,
        ),
        ["lonely"]
    );
    assert_eq!(
        names_in(&planned, "Their emptyDir data goes with them", &namespace),
        scratched
    );
    let refused = run(&core, &planned, Some(context)).await.unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    let planned = plan(&core, drain(forced)).await.unwrap();
    create(
        &pods,
        json!({
            "metadata": { "name": "late", "labels": { "app": "late" } },
            "spec": { "nodeName": forced, "containers": [{ "name": "app", "image": "fake" }] },
        }),
    )
    .await;
    pods_of(&pods, "late", 1).await;
    let told = run(&core, &planned, Some(forced)).await.unwrap();
    assert_eq!(
        failed(&told).message,
        format!(
            "Node {forced} stays cordoned: 1 pod came that the plan did not take: {namespace}/late"
        )
    );
    assert!(pods.get_opt("lonely").await.unwrap().is_some());
    assert!(pods.get_opt("late").await.unwrap().is_some());
    let planned = plan(&core, drain(forced)).await.unwrap();
    let told = run(&core, &planned, Some(forced)).await.unwrap();
    assert_eq!(done(&told).0, format!("Drained node {forced}"));
    assert!(pods.get_opt("lonely").await.unwrap().is_none());

    uncordon(&nodes, forced).await;
    let budgets = Api::<PodDisruptionBudget>::namespaced(cluster.admin.clone(), &namespace);
    create(&deployments, deployment("both", 1, forced)).await;
    create(&deployments, deployment("free", 1, forced)).await;
    for name in ["both-a", "both-b"] {
        let mut twice = budget("both", 0);
        twice["metadata"]["name"] = json!(name);
        create(&budgets, twice).await;
    }
    let both = pods_of(&pods, "both", 1).await;
    let free = pods_of(&pods, "free", 1).await;
    let planned = plan(&core, drain(forced)).await.unwrap();
    let told = run(&core, &planned, Some(forced)).await.unwrap();
    let error = failed(&told);
    assert!(
        error.message.starts_with(&format!(
            "Node {forced} stays cordoned: evicting pod {namespace}/{} failed:",
            both[0]
        )),
        "{}",
        error.message
    );
    assert!(
        pods.get_opt(&free[0]).await.unwrap().is_none(),
        "the others went"
    );
    assert!(pods.get_opt(&both[0]).await.unwrap().is_some());
    assert!(cordoned(&nodes, forced).await);

    let by_kubectl = plan(&core, drain(plain)).await.unwrap();
    assert_eq!(by_kubectl.friction, Friction::Confirm);
    core.command_cancel("main", by_kubectl.id);
    kubectl(&by_kubectl, &kubeconfig);
    assert!(cordoned(&nodes, plain).await);

    uncordon(&nodes, plain).await;
    create(
        &Api::<StatefulSet>::namespaced(cluster.admin.clone(), &namespace),
        json!({
            "metadata": { "name": "pinned" },
            "spec": {
                "replicas": 1,
                "serviceName": "pinned",
                "selector": { "matchLabels": { "app": "pinned" } },
                "template": {
                    "metadata": { "labels": { "app": "pinned" } },
                    "spec": {
                        "nodeName": plain,
                        "containers": [{ "name": "app", "image": "fake" }],
                    },
                },
            },
        }),
    )
    .await;
    create(&budgets, budget("pinned", 1)).await;
    pods_of(&pods, "pinned", 1).await;
    observed(&budgets, "pinned", 1).await;
    let first = pods.get("pinned-0").await.unwrap().metadata.uid;
    let planned = plan(&core, drain(plain)).await.unwrap();
    let told = running_until(&core, &planned, None, HELD, || async {
        pods.delete(
            "pinned-0",
            &kube::api::DeleteParams {
                grace_period_seconds: Some(0),
                ..kube::api::DeleteParams::default()
            },
        )
        .await
        .unwrap();
    })
    .await;
    assert_eq!(done(&told).0, format!("Drained node {plain}"));
    let again = pods.get("pinned-0").await.unwrap();
    assert_ne!(again.metadata.uid, first);
    assert!(
        again.metadata.deletion_timestamp.is_none(),
        "the new pod stays"
    );
    cluster.delete(&namespace).await;
    uncordon(&nodes, forced).await;
    uncordon(&nodes, plain).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_read_only_context_sends_none_of_the_actions() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("locked").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let deployments = Api::<Deployment>::namespaced(cluster.admin.clone(), &namespace);
    let cronjobs = Api::<CronJob>::namespaced(cluster.admin.clone(), &namespace);
    let jobs = Api::<Job>::namespaced(cluster.admin.clone(), &namespace);
    let nodes = Api::<Node>::all(cluster.admin.clone());
    let deployment_version = create(&deployments, deployment("web", 1, "kwok-node-3"))
        .await
        .metadata
        .generation;
    let cronjob_version = create(&cronjobs, cronjob("backup", false))
        .await
        .metadata
        .resource_version;
    core.set_context_mode(SetContextMode {
        context: context.clone(),
        mode: Some(Mode::ReadOnly),
    })
    .await
    .unwrap();

    let web = || reference("apps", "v1", "deployments", Some(&namespace), "web");
    let backup = || reference("batch", "v1", "cronjobs", Some(&namespace), "backup");
    let space = || context.clone();
    let requests = [
        PlanRequest::Scale {
            space: space(),
            target: web(),
            replicas: 3,
        },
        PlanRequest::Restart {
            space: space(),
            target: web(),
        },
        PlanRequest::Cordon {
            space: space(),
            node: "kwok-node-3".to_owned(),
            unschedulable: true,
        },
        PlanRequest::Drain {
            space: space(),
            node: "kwok-node-3".to_owned(),
        },
        PlanRequest::Trigger {
            space: space(),
            namespace: namespace.clone(),
            name: "backup".to_owned(),
        },
        PlanRequest::Suspend {
            space: space(),
            target: backup(),
            suspend: true,
        },
        PlanRequest::Delete {
            space: space(),
            targets: vec![
                web(),
                reference("apps", "v1", "deployments", Some(&namespace), "other"),
            ],
        },
    ];
    for request in requests {
        let blocked = plan(&core, request.clone()).await.unwrap_err();
        assert_eq!(blocked.kind, ErrorKind::Permissions, "{request:?}");
        assert_eq!(blocked.blocked.unwrap().mode, Mode::ReadOnly, "{request:?}");
    }
    assert_eq!(
        deployments.get("web").await.unwrap().metadata.generation,
        deployment_version
    );
    assert_eq!(
        cronjobs
            .get("backup")
            .await
            .unwrap()
            .metadata
            .resource_version,
        cronjob_version
    );
    assert!(
        jobs.list(&ListParams::default())
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert!(!cordoned(&nodes, "kwok-node-3").await);
    cluster.delete(&namespace).await;
}

async fn as_account(
    cluster: &Cluster,
    namespace: &str,
    name: &str,
    role: Value,
) -> (tempfile::TempDir, std::sync::Arc<Core>, String) {
    let accounts = Api::<ServiceAccount>::namespaced(cluster.admin.clone(), namespace);
    create(&accounts, json!({ "metadata": { "name": name } })).await;
    let mut role_ref = role;
    role_ref["apiGroup"] = json!("rbac.authorization.k8s.io");
    create(
        &Api::<RoleBinding>::namespaced(cluster.admin.clone(), namespace),
        json!({
            "metadata": { "name": name },
            "roleRef": role_ref,
            "subjects": [{ "kind": "ServiceAccount", "name": name, "namespace": namespace }],
        }),
    )
    .await;
    let token = accounts
        .create_token_request(
            name,
            &PostParams::default(),
            &serde_json::from_value(json!({ "spec": { "expirationSeconds": 600 } })).unwrap(),
        )
        .await
        .unwrap()
        .status
        .and_then(|status| status.token)
        .expect("a token for the ServiceAccount");
    let mut kubeconfig = Kubeconfig::read_from(&cluster.path).unwrap();
    let context = format!("{}-{name}", cluster.context);
    let mut named = kubeconfig
        .contexts
        .iter()
        .find(|named| named.name == cluster.context)
        .unwrap()
        .clone();
    named.name = context.clone();
    if let Some(entry) = named.context.as_mut() {
        entry.user = Some(name.to_owned());
    }
    kubeconfig.contexts = vec![named];
    kubeconfig.auth_infos = vec![NamedAuthInfo {
        name: name.to_owned(),
        auth_info: Some(AuthInfo {
            token: Some(token.into()),
            ..AuthInfo::default()
        }),
        ..NamedAuthInfo::default()
    }];
    kubeconfig.current_context = Some(context.clone());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    std::fs::write(&path, serde_json::to_string(&kubeconfig).unwrap()).unwrap();
    let core = core_over(dir.path(), &path, &context).await;
    (dir, core, context)
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_person_without_rights_is_told_so_before_they_try() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("viewer").await;
    let role = json!({ "kind": "ClusterRole", "name": "view" });
    let (_dir, viewing, viewer) = as_account(&cluster, &namespace, "viewer", role).await;

    let access = |verb: &str, group: &str, resource: &str, subresource: Option<&str>| Access {
        verb: verb.to_owned(),
        group: group.to_owned(),
        resource: resource.to_owned(),
        subresource: subresource.map(str::to_owned),
        name: None,
    };
    let checks = vec![
        access("list", "", "pods", None),
        access("delete", "", "pods", None),
        access("patch", "apps", "deployments", Some("scale")),
        access("create", "batch", "jobs", None),
        access("patch", "", "nodes", None),
        access("create", "", "pods", Some("eviction")),
    ];
    let answers = viewing
        .access_review(AccessQuery {
            space: viewer.clone(),
            namespace: Some(namespace.clone()),
            checks: checks.clone(),
        })
        .await
        .unwrap();
    assert_eq!(answers, [true, false, false, false, false, false]);

    let admin_dir = tempfile::tempdir().unwrap();
    let (admin, _) = core(admin_dir.path(), &cluster).await;
    let answers = admin
        .access_review(AccessQuery {
            space: cluster.context.clone(),
            namespace: Some(namespace.clone()),
            checks,
        })
        .await
        .unwrap();
    assert_eq!(answers, [true; 6]);

    create(
        &Api::<k8s_openapi::api::rbac::v1::Role>::namespaced(cluster.admin.clone(), &namespace),
        json!({
            "metadata": { "name": "picker" },
            "rules": [
                {
                    "apiGroups": ["apps"],
                    "resources": ["deployments/scale"],
                    "verbs": ["patch"],
                    "resourceNames": ["web"],
                },
                { "apiGroups": [""], "resources": ["namespaces"], "verbs": ["delete"] },
            ],
        }),
    )
    .await;
    let role = json!({ "kind": "Role", "name": "picker" });
    let (_dir, picking, picker) = as_account(&cluster, &namespace, "picker", role).await;
    let named =
        |verb: &str, group: &str, resource: &str, subresource: Option<&str>, name: &str| Access {
            name: Some(name.to_owned()),
            ..access(verb, group, resource, subresource)
        };
    let answers = picking
        .access_review(AccessQuery {
            space: picker.clone(),
            namespace: Some(namespace.clone()),
            checks: vec![
                access("patch", "apps", "deployments", Some("scale")),
                named("patch", "apps", "deployments", Some("scale"), "web"),
                named("patch", "apps", "deployments", Some("scale"), "db"),
            ],
        })
        .await
        .unwrap();
    assert_eq!(answers, [false, true, false]);
    let answers = picking
        .access_review(AccessQuery {
            space: picker,
            namespace: None,
            checks: vec![
                access("delete", "", "namespaces", None),
                named("delete", "", "namespaces", None, &namespace),
                named("delete", "", "namespaces", None, "default"),
            ],
        })
        .await
        .unwrap();
    assert_eq!(answers, [false, true, false]);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_stateful_set_that_deletes_its_claims_on_scale_down_asks_and_lists_them() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("claims").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let context = &cluster.context;
    let sets = Api::<StatefulSet>::namespaced(cluster.admin.clone(), &namespace);
    let claims = Api::<PersistentVolumeClaim>::namespaced(cluster.admin.clone(), &namespace);
    let pods = Api::<Pod>::namespaced(cluster.admin.clone(), &namespace);
    let set = |name: &str, when_scaled: &str| {
        json!({
            "metadata": { "name": name },
            "spec": {
                "replicas": 2,
                "serviceName": name,
                "selector": { "matchLabels": { "app": name } },
                "persistentVolumeClaimRetentionPolicy": { "whenScaled": when_scaled },
                "template": {
                    "metadata": { "labels": { "app": name } },
                    "spec": {
                        "nodeName": "kwok-node-0",
                        "containers": [{ "name": "app", "image": "fake" }],
                    },
                },
                "volumeClaimTemplates": [{
                    "metadata": { "name": "data" },
                    "spec": {
                        "accessModes": ["ReadWriteOnce"],
                        "resources": { "requests": { "storage": "1Mi" } },
                    },
                }],
            },
        })
    };
    create(&sets, set("db", "Delete")).await;
    create(&sets, set("kept", "Retain")).await;
    let mut late = set("late", "Delete");
    late["spec"]["ordinals"] = json!({ "start": 5 });
    create(&sets, late).await;
    pods_of(&pods, "db", 2).await;
    pods_of(&pods, "kept", 2).await;
    pods_of(&pods, "late", 2).await;
    let scale = |name: &str, replicas| PlanRequest::Scale {
        space: context.clone(),
        target: reference("apps", "v1", "statefulsets", Some(&namespace), name),
        replicas,
    };

    let shrink = plan(&core, scale("db", 1)).await.unwrap();
    assert_eq!(shrink.friction, Friction::Confirm);
    assert_eq!(names(&shrink, "Their claims go"), ["data-db-1"]);
    run(&core, &shrink, None).await.unwrap();
    eventually("the scaled-away pod's claim goes", || async {
        claims.get_opt("data-db-1").await.unwrap().is_none()
    })
    .await;
    assert!(claims.get_opt("data-db-0").await.unwrap().is_some());

    let kept = plan(&core, scale("kept", 1)).await.unwrap();
    assert_eq!(kept.friction, Friction::AtOnce);
    assert!(kept.affected.is_empty(), "{:?}", kept.affected);

    let late = plan(&core, scale("late", 1)).await.unwrap();
    assert_eq!(names(&late, "Their claims go"), ["data-late-6"]);
    core.command_cancel("main", late.id);

    let grow = plan(&core, scale("db", 2)).await.unwrap();
    assert_eq!(grow.friction, Friction::AtOnce);
    run(&core, &grow, None).await.unwrap();
    eventually("the new pod's claim is made", || async {
        claims.get_opt("data-db-1").await.unwrap().is_some()
    })
    .await;
    let back = plan(&core, undo(&cluster)).await.unwrap();
    assert_eq!(back.friction, Friction::Confirm);
    assert!(back.destructive);
    assert_eq!(names(&back, "Their claims go"), ["data-db-1"]);
    core.command_cancel("main", back.id);

    create(
        &Api::<k8s_openapi::api::rbac::v1::Role>::namespaced(cluster.admin.clone(), &namespace),
        json!({
            "metadata": { "name": "scaler" },
            "rules": [{
                "apiGroups": ["apps"],
                "resources": ["statefulsets", "statefulsets/scale"],
                "verbs": ["get", "patch"],
            }],
        }),
    )
    .await;
    let role = json!({ "kind": "Role", "name": "scaler" });
    let (_dir, scaler, context) = as_account(&cluster, &namespace, "scaler", role).await;
    let blind = plan(
        &scaler,
        PlanRequest::Scale {
            space: context,
            target: reference("apps", "v1", "statefulsets", Some(&namespace), "db"),
            replicas: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(blind.friction, Friction::Confirm);
    assert!(
        blind.consequences.contains(
            &"Twigo cannot read claim data-db-1, so it cannot say whether it is there.".to_owned()
        ),
        "{:?}",
        blind.consequences
    );
    cluster.delete(&namespace).await;
}
