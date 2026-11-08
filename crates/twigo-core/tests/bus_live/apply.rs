//! An apply of an edit on kind: what each answer of the preview is for, and
//! what is on the server after it, field by field.

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::Api;
use kube::api::PostParams;
use serde_json::{Value, json};
use twigo_core::Core;
use twigo_ipc::{
    ApplyConflict, ApplyPreviewed, ApplyRequest, ApplyStrategy, ErrorKind, Mode, OpenedEdit, Plan,
    PlanRequest, PreviewId, ResourceRef, SetContextMode,
};

use super::{Cluster, core, eventually, kubectl, reference, run};

fn deployments(namespace: &str) -> String {
    format!("/apis/apps/v1/namespaces/{namespace}/deployments")
}

fn deployment(name: &str) -> Value {
    json!({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": { "name": name, "annotations": { "theirs": "1" } },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": { "app": name } },
            "template": {
                "metadata": { "labels": { "app": name } },
                "spec": {
                    "nodeName": "kwok-node-0",
                    "containers": [{
                        "name": "app",
                        "image": "fake:1",
                        "workingDir": "/work",
                        "ports": [{ "name": "http", "containerPort": 80 }],
                    }],
                },
            },
        },
    })
}

async fn post(admin: &kube::Client, path: &str, body: &Value) -> Value {
    let uri = format!("{path}?fieldManager=other");
    admin
        .request(
            http::Request::post(uri)
                .header("content-type", "application/json")
                .body(serde_json::to_vec(body).unwrap())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn read(admin: &kube::Client, path: &str) -> Value {
    admin
        .request(http::Request::get(path).body(Vec::new()).unwrap())
        .await
        .unwrap()
}

async fn merge_patch(admin: &kube::Client, path: &str, body: &Value, manager: &str) -> Value {
    admin
        .request(
            http::Request::patch(format!("{path}?fieldManager={manager}"))
                .header("content-type", "application/merge-patch+json")
                .body(serde_json::to_vec(body).unwrap())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn server_apply(admin: &kube::Client, path: &str, body: &Value, manager: &str) -> Value {
    admin
        .request(
            http::Request::patch(format!("{path}?fieldManager={manager}&force=true"))
                .header("content-type", "application/apply-patch+yaml")
                .body(serde_json::to_vec(body).unwrap())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn settled(admin: &kube::Client, path: &str) -> Value {
    let mut last = read(admin, path).await;
    let mut steady = 0;
    tokio::time::timeout(super::WAIT, async {
        while steady < 4 {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let now = read(admin, path).await;
            steady = if rv(&now) == rv(&last) { steady + 1 } else { 0 };
            last = now;
        }
    })
    .await
    .expect("the object settles within 60 s");
    last
}

fn view(object: &Value) -> Value {
    let mut object = object.clone();
    object["metadata"]
        .as_object_mut()
        .unwrap()
        .remove("managedFields");
    object
}

fn rv(object: &Value) -> String {
    object["metadata"]["resourceVersion"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn edit(
    cluster: &Cluster,
    target: ResourceRef,
    live: &Value,
    edited: Value,
    force: bool,
    drop: Vec<String>,
) -> ApplyRequest {
    ApplyRequest {
        space: cluster.context.clone(),
        opened: Some(OpenedEdit {
            target,
            base: view(live),
            lock: rv(live),
        }),
        edited,
        force,
        drop,
    }
}

async fn preview(core: &Core, request: ApplyRequest) -> ApplyPreviewed {
    core.apply_preview("main", request).await.unwrap()
}

fn ready(answer: ApplyPreviewed) -> (PreviewId, Value, Vec<String>, Vec<String>) {
    match answer {
        ApplyPreviewed::Ready {
            id,
            result,
            removals,
            warnings,
            ..
        } => (id, result, removals, warnings),
        other => panic!("expected ready, got {other:?}"),
    }
}

async fn plan(core: &Core, cluster: &Cluster, id: PreviewId) -> Plan {
    core.command_plan(
        "main",
        PlanRequest::Apply {
            space: cluster.context.clone(),
            preview: id,
        },
    )
    .await
    .unwrap()
}

async fn applied(core: &Core, cluster: &Cluster, id: PreviewId) {
    let plan = plan(core, cluster, id).await;
    let events = run(core, &plan, None).await.unwrap();
    assert!(
        matches!(events.last(), Some(twigo_ipc::OperationEvent::Done { .. })),
        "{events:?}"
    );
}

fn deployment_ref(namespace: &str, name: &str) -> ResourceRef {
    reference("apps", "v1", "deployments", Some(namespace), name)
}

fn entry<'a>(object: &'a Value, manager: &str, operation: &str) -> Option<&'a Value> {
    object["metadata"]["managedFields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["manager"] == manager && entry["operation"] == operation)
        .map(|entry| &entry["fieldsV1"])
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_second_edit_keeps_the_first_and_twigo_owns_only_what_it_should() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-keep").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;

    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["replicas"] = json!(5);
    let (id, result, removals, _) = ready(
        preview(
            &core,
            edit(
                &cluster,
                deployment_ref(&namespace, "web"),
                &live,
                edited,
                true,
                vec![],
            ),
        )
        .await,
    );
    assert_eq!(result["spec"]["replicas"], 5);
    assert!(removals.is_empty());
    assert_eq!(result["metadata"].get("managedFields"), None);
    assert_eq!(result["metadata"].get("resourceVersion"), None);
    applied(&core, &cluster, id).await;

    let live = settled(&cluster.admin, &path).await;
    assert_eq!(live["spec"]["replicas"], 5);
    assert_eq!(
        entry(&live, "twigo", "Apply").unwrap(),
        &json!({ "f:spec": { "f:replicas": {} } })
    );

    let mut edited = view(&live);
    edited["metadata"]["annotations"]["mine"] = json!("2");
    let (id, _, _, _) = ready(
        preview(
            &core,
            edit(
                &cluster,
                deployment_ref(&namespace, "web"),
                &live,
                edited,
                false,
                vec![],
            ),
        )
        .await,
    );
    applied(&core, &cluster, id).await;

    let live = settled(&cluster.admin, &path).await;
    assert_eq!(live["spec"]["replicas"], 5, "a forced replicas: 5 stayed");
    assert_eq!(live["metadata"]["annotations"]["mine"], "2");
    assert_eq!(
        entry(&live, "twigo", "Apply").unwrap(),
        &json!({
            "f:metadata": { "f:annotations": { "f:mine": {} } },
            "f:spec": { "f:replicas": {} },
        })
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_conflict_answers_its_field_and_manager_and_force_and_drop_both_work() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-conflict").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;

    let mut edited = view(&live);
    edited["spec"]["replicas"] = json!(3);
    edited["metadata"]["annotations"]["mine"] = json!("1");
    let target = deployment_ref(&namespace, "web");
    let answer = preview(
        &core,
        edit(
            &cluster,
            target.clone(),
            &live,
            edited.clone(),
            false,
            vec![],
        ),
    )
    .await;
    assert_eq!(
        answer,
        ApplyPreviewed::Conflicts {
            conflicts: vec![ApplyConflict {
                path: ".spec.replicas".to_owned(),
                manager: "other".to_owned(),
            }],
        }
    );

    let dropped = vec![".spec.replicas".to_owned()];
    let (id, result, _, _) = ready(
        preview(
            &core,
            edit(
                &cluster,
                target.clone(),
                &live,
                edited.clone(),
                false,
                dropped,
            ),
        )
        .await,
    );
    assert_eq!(result["spec"]["replicas"], 1);
    applied(&core, &cluster, id).await;
    let after_drop = settled(&cluster.admin, &path).await;
    assert_eq!(after_drop["spec"]["replicas"], 1);
    assert_eq!(after_drop["metadata"]["annotations"]["mine"], "1");
    assert_eq!(
        entry(&after_drop, "twigo", "Apply").unwrap(),
        &json!({ "f:metadata": { "f:annotations": { "f:mine": {} } } })
    );

    let (id, result, _, _) = ready(
        preview(
            &core,
            edit(&cluster, target, &after_drop, edited, true, vec![]),
        )
        .await,
    );
    assert_eq!(result["spec"]["replicas"], 3);
    applied(&core, &cluster, id).await;
    let forced = read(&cluster.admin, &path).await;
    assert_eq!(forced["spec"]["replicas"], 3);
    assert!(
        entry(&forced, "twigo", "Apply").unwrap()["f:spec"]
            .get("f:replicas")
            .is_some()
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_field_another_manager_owns_goes_by_the_merge_patch_inside_a_list_too() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-merge").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;

    let mut edited = view(&live);
    edited["metadata"]["annotations"]
        .as_object_mut()
        .unwrap()
        .remove("theirs");
    edited["spec"]["template"]["spec"]["containers"][0]
        .as_object_mut()
        .unwrap()
        .remove("workingDir");
    let target = deployment_ref(&namespace, "web");
    let (id, result, removals, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, false, vec![])).await);
    let container_field = ".spec.template.spec.containers[name=\"app\"].workingDir";
    assert_eq!(
        removals,
        vec![".metadata.annotations.theirs", container_field]
    );
    assert_eq!(result["metadata"]["annotations"].get("theirs"), None);
    assert_eq!(
        result["spec"]["template"]["spec"]["containers"][0].get("workingDir"),
        None
    );
    let plan = plan(&core, &cluster, id).await;
    assert!(
        plan.kubectl.contains("patch deployments.apps web")
            && plan.kubectl.contains("--type=merge"),
        "{}",
        plan.kubectl
    );
    assert!(!plan.kubectl.contains(" apply "), "{}", plan.kubectl);
    let events = run(&core, &plan, None).await.unwrap();
    assert!(
        matches!(events.last(), Some(twigo_ipc::OperationEvent::Done { .. })),
        "{events:?}"
    );

    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["annotations"].get("theirs"), None);
    let container = &after["spec"]["template"]["spec"]["containers"][0];
    assert_eq!(container.get("workingDir"), None);
    assert_eq!(container["image"], "fake:1");
    assert_eq!(
        entry(&after, "twigo", "Apply"),
        None,
        "the merge patch owned nothing"
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_field_only_twigo_owns_goes_without_a_merge_patch() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-sole").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("/api/v1/namespaces/{namespace}/configmaps/settings");
    server_apply(
        &cluster.admin,
        &path,
        &json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "settings", "annotations": { "mine": "1" } },
            "data": { "a": "1", "b": "2" },
        }),
        "twigo",
    )
    .await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["data"].as_object_mut().unwrap().remove("b");
    edited["metadata"]["annotations"]
        .as_object_mut()
        .unwrap()
        .remove("mine");
    let target = reference("", "v1", "configmaps", Some(&namespace), "settings");
    let (id, result, removals, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, false, vec![])).await);
    assert!(removals.is_empty(), "{removals:?}");
    assert_eq!(result["data"], json!({ "a": "1" }));
    let plan = plan(&core, &cluster, id).await;
    assert!(!plan.kubectl.contains(" patch "), "{}", plan.kubectl);
    let events = run(&core, &plan, None).await.unwrap();
    assert!(matches!(
        events.last(),
        Some(twigo_ipc::OperationEvent::Done { .. })
    ));

    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["data"], json!({ "a": "1" }));
    assert_eq!(after["metadata"].get("annotations"), None);
    assert_eq!(
        entry(&after, "twigo", "Update"),
        None,
        "no merge patch was sent"
    );
    assert_eq!(
        entry(&after, "twigo", "Apply").unwrap(),
        &json!({ "f:data": { "f:a": {} } })
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_plan_s_kubectl_line_does_what_the_plan_does_with_its_merge_patch() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-kubectl").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]
        .as_object_mut()
        .unwrap()
        .remove("theirs");
    edited["spec"]["replicas"] = json!(4);
    let target = deployment_ref(&namespace, "web");
    let (id, _, removals, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await);
    assert_eq!(removals, vec![".metadata.annotations.theirs"]);
    let plan = plan(&core, &cluster, id).await;
    assert!(
        plan.kubectl.contains("--force-conflicts"),
        "{}",
        plan.kubectl
    );
    assert!(
        plan.kubectl.contains("--field-manager=twigo"),
        "{}",
        plan.kubectl
    );
    kubectl(&plan, &kubeconfig);
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["spec"]["replicas"], 4);
    assert_eq!(after["metadata"]["annotations"].get("theirs"), None);
    assert!(
        entry(&after, "twigo", "Apply").unwrap()["f:spec"]
            .get("f:replicas")
            .is_some()
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_port_without_protocol_and_an_edited_one_pair_by_key() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-port").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["template"]["spec"]["containers"][0]["ports"] = json!([
        { "containerPort": 80, "name": "web" },
        { "containerPort": 8080 },
    ]);
    let target = deployment_ref(&namespace, "web");
    let (id, _, removals, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await);
    assert!(removals.is_empty(), "{removals:?}");
    applied(&core, &cluster, id).await;

    let after = read(&cluster.admin, &path).await;
    assert_eq!(
        after["spec"]["template"]["spec"]["containers"][0]["ports"],
        json!([
            { "containerPort": 80, "name": "web", "protocol": "TCP" },
            { "containerPort": 8080, "protocol": "TCP" },
        ])
    );
    let owned = entry(&after, "twigo", "Apply").unwrap();
    let ports =
        &owned["f:spec"]["f:template"]["f:spec"]["f:containers"]["k:{\"name\":\"app\"}"]["f:ports"];
    assert_eq!(
        ports["k:{\"containerPort\":8080,\"protocol\":\"TCP\"}"],
        json!({ ".": {}, "f:containerPort": {} })
    );
    assert_eq!(
        ports["k:{\"containerPort\":80,\"protocol\":\"TCP\"}"],
        json!({ ".": {}, "f:containerPort": {}, "f:name": {} })
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_stale_lock_answers_stale_and_keep_mine_does_not_revert_the_other_writer() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-stale").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let opened = settled(&cluster.admin, &path).await;

    merge_patch(
        &cluster.admin,
        &path,
        &json!({ "metadata": { "labels": { "other": "writer" } } }),
        "other",
    )
    .await;
    let mut edited = view(&opened);
    edited["metadata"]["annotations"]["mine"] = json!("1");
    let target = deployment_ref(&namespace, "web");
    match preview(
        &core,
        edit(
            &cluster,
            target.clone(),
            &opened,
            edited.clone(),
            false,
            vec![],
        ),
    )
    .await
    {
        ApplyPreviewed::Stale { message } => {
            assert!(message.contains("modified"), "{message}");
        }
        other => panic!("expected stale, got {other:?}"),
    }

    let current = read(&cluster.admin, &path).await;
    let mut keep = edit(&cluster, target, &opened, edited, false, vec![]);
    keep.opened.as_mut().unwrap().lock = rv(&current);
    let (id, result, _, _) = ready(preview(&core, keep).await);
    assert_eq!(result["metadata"]["labels"]["other"], "writer");
    applied(&core, &cluster, id).await;

    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["labels"]["other"], "writer");
    assert_eq!(after["metadata"]["annotations"]["mine"], "1");
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_immutable_field_is_caught_at_the_dry_run_and_only_a_pod_or_a_job_offers_recreate() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-immutable").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["selector"] = json!({ "matchLabels": { "app": "other" } });
    edited["spec"]["template"]["metadata"]["labels"] = json!({ "app": "other" });
    let target = deployment_ref(&namespace, "web");
    match preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await {
        ApplyPreviewed::Immutable { message, recreate } => {
            assert!(message.contains("immutable"), "{message}");
            assert_eq!(recreate, None);
        }
        other => panic!("expected immutable, got {other:?}"),
    }

    let pods = format!("/api/v1/namespaces/{namespace}/pods");
    post(
        &cluster.admin,
        &pods,
        &json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "web" },
            "spec": {
                "nodeName": "kwok-node-0",
                "containers": [{ "name": "app", "image": "fake:1" }],
            },
        }),
    )
    .await;
    let pod_path = format!("{pods}/web");
    let live = settled(&cluster.admin, &pod_path).await;
    let uid = live["metadata"]["uid"].clone();
    let mut edited = view(&live);
    edited["spec"]["containers"][0]["command"] = json!(["sh"]);
    let target = reference("", "v1", "pods", Some(&namespace), "web");
    let recreate = match preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await {
        ApplyPreviewed::Immutable {
            message,
            recreate: Some(recreate),
        } => {
            assert!(message.contains("may not change"), "{message}");
            recreate
        }
        other => panic!("expected a recreate, got {other:?}"),
    };
    let pod_plan = plan(&core, &cluster, recreate).await;
    assert!(pod_plan.destructive);
    let events = run(&core, &pod_plan, None).await.unwrap();
    assert!(
        matches!(events.last(), Some(twigo_ipc::OperationEvent::Done { .. })),
        "{events:?}"
    );
    let recreated = read(&cluster.admin, &pod_path).await;
    assert_ne!(recreated["metadata"]["uid"], uid);
    assert_eq!(recreated["spec"]["containers"][0]["command"], json!(["sh"]));

    let jobs = format!("/apis/batch/v1/namespaces/{namespace}/jobs");
    post(
        &cluster.admin,
        &jobs,
        &json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "migrate", "labels": { "team": "a" } },
            "spec": {
                "template": {
                    "metadata": { "labels": { "tier": "b" } },
                    "spec": {
                        "nodeName": "kwok-node-0",
                        "restartPolicy": "Never",
                        "containers": [{ "name": "app", "image": "fake:1" }],
                    },
                },
            },
        }),
    )
    .await;
    let job_path = format!("{jobs}/migrate");
    let live = settled(&cluster.admin, &job_path).await;
    let uid = live["metadata"]["uid"].as_str().unwrap().to_owned();
    let mut edited = view(&live);
    edited["spec"]["template"]["spec"]["containers"][0]["image"] = json!("fake:2");
    let target = reference("batch", "v1", "jobs", Some(&namespace), "migrate");
    let recreate = match preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await {
        ApplyPreviewed::Immutable {
            recreate: Some(recreate),
            ..
        } => recreate,
        other => panic!("expected a recreate, got {other:?}"),
    };
    let plan = plan(&core, &cluster, recreate).await;
    let events = run(&core, &plan, None).await.unwrap();
    assert!(
        matches!(events.last(), Some(twigo_ipc::OperationEvent::Done { .. })),
        "{events:?}"
    );
    let recreated = read(&cluster.admin, &job_path).await;
    let new_uid = recreated["metadata"]["uid"].as_str().unwrap();
    assert_ne!(new_uid, uid);
    assert_eq!(
        recreated["spec"]["template"]["spec"]["containers"][0]["image"],
        "fake:2"
    );
    assert_eq!(
        recreated["spec"]["selector"]["matchLabels"]["batch.kubernetes.io/controller-uid"],
        new_uid
    );
    assert_eq!(recreated["metadata"]["labels"]["team"], "a");
    assert_eq!(
        recreated["spec"]["template"]["metadata"]["labels"]["controller-uid"], new_uid,
        "the generated labels follow the new uid"
    );
    assert_eq!(
        recreated["spec"]["template"]["metadata"]["labels"]["tier"],
        "b"
    );
    let manager = &recreated["metadata"]["managedFields"][0]["manager"];
    assert_eq!(manager, "twigo");
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_recreate_s_kubectl_line_does_what_the_plan_does() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-recreate-line").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let pods = format!("/api/v1/namespaces/{namespace}/pods");
    post(
        &cluster.admin,
        &pods,
        &json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "web" },
            "spec": {
                "nodeName": "kwok-node-0",
                "containers": [{ "name": "app", "image": "fake:1" }],
            },
        }),
    )
    .await;
    let path = format!("{pods}/web");
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["containers"][0]["command"] = json!(["sh"]);
    let target = reference("", "v1", "pods", Some(&namespace), "web");
    let recreate = match preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await {
        ApplyPreviewed::Immutable {
            recreate: Some(recreate),
            ..
        } => recreate,
        other => panic!("expected a recreate, got {other:?}"),
    };
    let plan = plan(&core, &cluster, recreate).await;
    kubectl(&plan, &kubeconfig);
    let recreated = read(&cluster.admin, &path).await;
    assert_ne!(recreated["metadata"]["uid"], live["metadata"]["uid"]);
    assert_eq!(recreated["spec"]["containers"][0]["command"], json!(["sh"]));
    cluster.delete(&namespace).await;
}

const SECRET: &str = "s3cret-value";
const SECRET_B64: &str = "czNjcmV0LXZhbHVl";
const STRING_VALUE: &str = "typed-by-the-person";

fn secret_text_free(context: &str, text: &str) {
    assert!(
        !text.contains(SECRET) && !text.contains(SECRET_B64) && !text.contains(STRING_VALUE),
        "{context}: {text}"
    );
}

async fn secret_kept(cluster: &Cluster, namespace: &str) -> (String, Value) {
    let path = format!("/api/v1/namespaces/{namespace}/secrets/db");
    server_apply(
        &cluster.admin,
        &path,
        &json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": { "name": "db" },
            "data": { "password": SECRET_B64 },
        }),
        "twigo",
    )
    .await;
    let live = settled(&cluster.admin, &path).await;
    (path, live)
}

fn masked_base(live: &Value) -> Value {
    let mut base = view(live);
    base["data"]["password"] = json!("<12 bytes>");
    base
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn no_secret_value_reaches_the_webview_by_any_answer() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-secret").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let (path, live) = secret_kept(&cluster, &namespace).await;
    let target = reference("", "v1", "secrets", Some(&namespace), "db");

    let mut edited = masked_base(&live);
    edited["metadata"]["annotations"] = json!({ "note": "1" });
    edited["stringData"] = json!({ "token": STRING_VALUE });
    let request = ApplyRequest {
        space: cluster.context.clone(),
        opened: Some(OpenedEdit {
            target: target.clone(),
            base: masked_base(&live),
            lock: rv(&live),
        }),
        edited,
        force: false,
        drop: vec![],
    };
    let answer = preview(&core, request).await;
    secret_text_free("the preview", &serde_json::to_string(&answer).unwrap());
    let (id, result, _, _) = ready(answer);
    assert_eq!(result["data"]["password"], "<12 bytes>");
    let plan = plan(&core, &cluster, id).await;
    secret_text_free("the plan", &serde_json::to_string(&plan).unwrap());
    assert!(
        plan.kubectl.ends_with(&format!("-f - -n {namespace}")),
        "{}",
        plan.kubectl
    );
    assert!(!plan.kubectl.contains("printf"), "{}", plan.kubectl);
    let events = run(&core, &plan, None).await.unwrap();
    secret_text_free("the events", &serde_json::to_string(&events).unwrap());

    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["data"]["password"], SECRET_B64);
    assert_eq!(
        after["data"]["token"],
        json!("dHlwZWQtYnktdGhlLXBlcnNvbg==")
    );
    assert_eq!(after["metadata"]["annotations"]["note"], "1");

    let mut edited = masked_base(&after);
    edited["data"]["fresh"] = json!("<12 bytes>");
    let refused = core
        .apply_preview(
            "main",
            ApplyRequest {
                space: cluster.context.clone(),
                opened: Some(OpenedEdit {
                    target: target.clone(),
                    base: masked_base(&after),
                    lock: rv(&after),
                }),
                edited,
                force: false,
                drop: vec![],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    secret_text_free(
        "the mask refusal",
        &serde_json::to_string(&refused).unwrap(),
    );

    let mut edited = masked_base(&after);
    edited["data"]["broken"] = json!(format!("{SECRET}!!not base64"));
    let error = core
        .apply_preview(
            "main",
            ApplyRequest {
                space: cluster.context.clone(),
                opened: Some(OpenedEdit {
                    target,
                    base: masked_base(&after),
                    lock: rv(&after),
                }),
                edited,
                force: false,
                drop: vec![],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    secret_text_free(
        "the server's error",
        &serde_json::to_string(&error).unwrap(),
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn read_only_lets_the_preview_answer_and_blocks_the_apply() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-readonly").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    core.set_context_mode(SetContextMode {
        context: cluster.context.clone(),
        mode: Some(Mode::ReadOnly),
    })
    .await
    .unwrap();

    let mut edited = view(&live);
    edited["metadata"]["annotations"]["mine"] = json!("1");
    let target = deployment_ref(&namespace, "web");
    let (id, result, _, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await);
    assert_eq!(result["metadata"]["annotations"]["mine"], "1");

    let refused = core
        .command_plan(
            "main",
            PlanRequest::Apply {
                space: cluster.context.clone(),
                preview: id,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Permissions);
    let after = read(&cluster.admin, &path).await;
    assert_eq!(rv(&after), rv(&live), "the server saw no write");
    assert_eq!(after["metadata"]["annotations"].get("mine"), None);

    core.set_context_mode(SetContextMode {
        context: cluster.context.clone(),
        mode: Some(Mode::ReadWrite),
    })
    .await
    .unwrap();
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["annotations"]["mine"], "1");
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_preview_applies_once_and_belongs_to_its_window() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-once").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]["mine"] = json!("1");
    let target = deployment_ref(&namespace, "web");
    let (id, _, _, _) = ready(
        preview(
            &core,
            edit(
                &cluster,
                target.clone(),
                &live,
                edited.clone(),
                true,
                vec![],
            ),
        )
        .await,
    );
    let not_found = |error: twigo_ipc::IpcError| assert_eq!(error.kind, ErrorKind::NotFound);
    not_found(
        core.command_plan(
            "other",
            PlanRequest::Apply {
                space: cluster.context.clone(),
                preview: id,
            },
        )
        .await
        .unwrap_err(),
    );
    applied(&core, &cluster, id).await;
    not_found(
        core.command_plan(
            "main",
            PlanRequest::Apply {
                space: cluster.context.clone(),
                preview: id,
            },
        )
        .await
        .unwrap_err(),
    );

    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]["mine"] = json!("2");
    let (again, _, _, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await);
    core.drop_window("main");
    not_found(
        core.command_plan(
            "main",
            PlanRequest::Apply {
                space: cluster.context.clone(),
                preview: again,
            },
        )
        .await
        .unwrap_err(),
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_manifest_without_a_base_is_its_whole_object_and_comes_from_discovery() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-manifest").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("/api/v1/namespaces/{namespace}/configmaps/fresh");
    let manifest = json!({
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": { "name": "fresh", "namespace": namespace, "uid": "ignored" },
        "data": { "a": "1" },
    });
    let answer = preview(
        &core,
        ApplyRequest {
            space: cluster.context.clone(),
            opened: None,
            edited: manifest.clone(),
            force: false,
            drop: vec![],
        },
    )
    .await;
    let ApplyPreviewed::Ready {
        id,
        live,
        ignored,
        result,
        ..
    } = answer
    else {
        panic!("expected ready");
    };
    assert_eq!(live, Value::Null);
    assert_eq!(ignored, vec![".metadata.uid"]);
    assert_eq!(result["data"], json!({ "a": "1" }));
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["data"], json!({ "a": "1" }));
    assert_eq!(
        entry(&after, "twigo", "Apply").unwrap(),
        &json!({ "f:data": { "f:a": {} } })
    );
    cluster.delete(&namespace).await;
}

async fn wait_served(core: &Core, request: &ApplyRequest) -> ApplyPreviewed {
    tokio::time::timeout(super::WAIT, async {
        loop {
            match core.apply_preview("main", request.clone()).await {
                Ok(found) => return found,
                Err(error) if error.kind == ErrorKind::NotFound => {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
                Err(error) => panic!("{error:?}"),
            }
        }
    })
    .await
    .expect("the CRD is served with its schema within 60 s")
}

fn widget_crd(group: &str, kind_plural: &str, kind: &str, spec: Value) -> Value {
    json!({
        "apiVersion": "apiextensions.k8s.io/v1",
        "kind": "CustomResourceDefinition",
        "metadata": { "name": format!("{kind_plural}.{group}") },
        "spec": {
            "group": group,
            "scope": "Namespaced",
            "names": { "plural": kind_plural, "singular": kind.to_lowercase(), "kind": kind },
            "versions": [{
                "name": "v1",
                "served": true,
                "storage": true,
                "schema": { "openAPIV3Schema": {
                    "type": "object",
                    "properties": { "spec": spec },
                } },
            }],
        },
    })
}

async fn with_crd(cluster: &Cluster, crd: Value) -> String {
    let crds = Api::<CustomResourceDefinition>::all(cluster.admin.clone());
    let crd: CustomResourceDefinition = serde_json::from_value(crd).unwrap();
    let name = crd.metadata.name.clone().unwrap();
    crds.create(&PostParams::default(), &crd).await.unwrap();
    let path = format!("/apis/apiextensions.k8s.io/v1/customresourcedefinitions/{name}");
    let admin = cluster.admin.clone();
    eventually("the CRD is established", || {
        let admin = admin.clone();
        let path = path.clone();
        async move {
            let crd: Value = admin
                .request(http::Request::get(path).body(Vec::new()).unwrap())
                .await
                .unwrap();
            crd["status"]["conditions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|condition| {
                    condition["type"] == "Established" && condition["status"] == "True"
                })
        }
    })
    .await;
    name
}

async fn delete_crd(cluster: &Cluster, name: &str) {
    Api::<CustomResourceDefinition>::all(cluster.admin.clone())
        .delete(name, &Default::default())
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_crd_with_a_list_map_pairs_by_key_and_a_preserved_field_is_taken_as_it_stands() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-crd").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let group = format!("g{nanos}.twigo.test");
    let crd_name = with_crd(
        &cluster,
        widget_crd(
            &group,
            "widgets",
            "Widget",
            json!({
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "x-kubernetes-list-type": "map",
                        "x-kubernetes-list-map-keys": ["name"],
                        "items": {
                            "type": "object",
                            "required": ["name"],
                            "properties": {
                                "name": { "type": "string" },
                                "weight": { "type": "integer" },
                                "kind": { "type": "string" },
                            },
                        },
                    },
                    "free": {
                        "type": "object",
                        "x-kubernetes-preserve-unknown-fields": true,
                    },
                },
            }),
        ),
    )
    .await;

    let collection = format!("/apis/{group}/v1/namespaces/{namespace}/widgets");
    let path = format!("{collection}/one");
    let admin = cluster.admin.clone();
    eventually("the widgets are served", || {
        let admin = admin.clone();
        let collection = collection.clone();
        async move {
            admin
                .request::<Value>(http::Request::get(collection).body(Vec::new()).unwrap())
                .await
                .is_ok()
        }
    })
    .await;
    post(
        &cluster.admin,
        &collection,
        &json!({
            "apiVersion": format!("{group}/v1"),
            "kind": "Widget",
            "metadata": { "name": "one" },
            "spec": {
                "items": [
                    { "name": "a", "weight": 1, "kind": "x" },
                    { "name": "b", "weight": 2 },
                ],
                "free": { "keep": { "deep": 1 }, "edit": 1 },
            },
        }),
    )
    .await;

    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["items"][0]["weight"] = json!(9);
    edited["spec"]["free"]["edit"] = json!(2);
    let target = reference(&group, "v1", "widgets", Some(&namespace), "one");
    let request = edit(&cluster, target, &live, edited, true, vec![]);
    let answer = wait_served(&core, &request).await;
    let (id, result, removals, _) = ready(answer);
    assert!(removals.is_empty(), "{removals:?}");
    assert_eq!(result["spec"]["free"]["keep"], json!({ "deep": 1 }));
    applied(&core, &cluster, id).await;

    let after = read(&cluster.admin, &path).await;
    assert_eq!(
        after["spec"]["items"],
        json!([
            { "name": "a", "weight": 9, "kind": "x" },
            { "name": "b", "weight": 2 },
        ])
    );
    assert_eq!(
        after["spec"]["free"],
        json!({ "keep": { "deep": 1 }, "edit": 2 })
    );
    assert_eq!(
        entry(&after, "twigo", "Apply").unwrap(),
        &json!({
            "f:spec": {
                "f:free": { "f:edit": {} },
                "f:items": { "k:{\"name\":\"a\"}": { ".": {}, "f:name": {}, "f:weight": {} } },
            },
        })
    );
    delete_crd(&cluster, &crd_name).await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_entry_at_another_version_is_carried_when_its_paths_still_reach_the_object() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-versions").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let group = format!("v{nanos}.twigo.test");
    let schema = json!({
        "type": "object",
        "properties": { "first": { "type": "string" }, "second": { "type": "string" } },
    });
    let crd_name = format!("widgets.{group}");
    with_crd(
        &cluster,
        json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": { "name": crd_name },
            "spec": {
                "group": group,
                "scope": "Namespaced",
                "names": { "plural": "widgets", "singular": "widget", "kind": "Widget" },
                "versions": [
                    { "name": "v1beta1", "served": true, "storage": false,
                      "schema": { "openAPIV3Schema": { "type": "object", "properties": { "spec": schema } } } },
                    { "name": "v1", "served": true, "storage": true,
                      "schema": { "openAPIV3Schema": { "type": "object", "properties": { "spec": schema } } } },
                ],
            },
        }),
    )
    .await;
    let beta = format!("/apis/{group}/v1beta1/namespaces/{namespace}/widgets/one");
    let stable = format!("/apis/{group}/v1/namespaces/{namespace}/widgets/one");
    let admin = cluster.admin.clone();
    eventually("v1beta1 is served", || {
        let admin = admin.clone();
        let beta = beta.clone();
        async move {
            let probe = http::Request::get(beta.rsplit_once('/').unwrap().0.to_owned())
                .body(Vec::new())
                .unwrap();
            admin.request::<Value>(probe).await.is_ok()
        }
    })
    .await;
    server_apply(
        &cluster.admin,
        &beta,
        &json!({
            "apiVersion": format!("{group}/v1beta1"),
            "kind": "Widget",
            "metadata": { "name": "one" },
            "spec": { "first": "kept" },
        }),
        "twigo",
    )
    .await;

    let live = settled(&cluster.admin, &stable).await;
    let mut edited = view(&live);
    edited["spec"]["second"] = json!("added");
    let target = reference(&group, "v1", "widgets", Some(&namespace), "one");
    let request = edit(&cluster, target, &live, edited, true, vec![]);
    let answer = wait_served(&core, &request).await;
    let (id, result, _, _) = ready(answer);
    assert_eq!(
        result["spec"],
        json!({ "first": "kept", "second": "added" })
    );
    applied(&core, &cluster, id).await;

    let after = read(&cluster.admin, &stable).await;
    assert_eq!(after["spec"], json!({ "first": "kept", "second": "added" }));
    let twigo = after["metadata"]["managedFields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["manager"] == "twigo")
        .unwrap();
    assert_eq!(twigo["apiVersion"], format!("{group}/v1"));
    delete_crd(&cluster, &crd_name).await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_apply_and_its_merge_patch_land_together_through_the_bus() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-both").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]["mine"] = json!("1");
    edited["metadata"]["annotations"]
        .as_object_mut()
        .unwrap()
        .remove("theirs");
    let target = deployment_ref(&namespace, "web");
    let (id, result, removals, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, false, vec![])).await);
    assert_eq!(removals, vec![".metadata.annotations.theirs"]);
    assert_eq!(result["metadata"]["annotations"].get("theirs"), None);
    assert_eq!(result["metadata"]["annotations"]["mine"], "1");
    applied(&core, &cluster, id).await;

    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["annotations"]["mine"], "1");
    assert_eq!(after["metadata"]["annotations"].get("theirs"), None);
    assert_eq!(
        entry(&after, "twigo", "Apply").unwrap(),
        &json!({ "f:metadata": { "f:annotations": { "f:mine": {} } } })
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn what_the_server_refuses_shows_at_the_dry_run_and_sends_nothing() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-refused").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    let target = deployment_ref(&namespace, "web");

    let mut removal = view(&live);
    removal["spec"].as_object_mut().unwrap().remove("selector");
    match preview(
        &core,
        edit(&cluster, target.clone(), &live, removal, false, vec![]),
    )
    .await
    {
        ApplyPreviewed::Immutable { message, recreate } => {
            assert!(message.contains("selector"), "{message}");
            assert_eq!(recreate, None);
        }
        other => panic!("expected the merge patch's refusal, got {other:?}"),
    }

    let mut invalid = view(&live);
    invalid["spec"]["replicas"] = json!(-1);
    let refused = core
        .apply_preview(
            "main",
            edit(&cluster, target.clone(), &live, invalid, true, vec![]),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    assert!(refused.message.contains("replicas"), "{}", refused.message);

    let mut unknown = view(&live);
    unknown["spec"]["bogus"] = json!(true);
    let refused = core
        .apply_preview(
            "main",
            edit(&cluster, target, &live, unknown, false, vec![]),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    assert!(refused.message.contains("bogus"), "{}", refused.message);
    assert_eq!(rv(&read(&cluster.admin, &path).await), rv(&live));
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_warning_of_the_dry_run_reaches_the_preview() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-warning").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let answer = preview(
        &core,
        ApplyRequest {
            space: cluster.context.clone(),
            opened: None,
            edited: json!({
                "apiVersion": "networking.k8s.io/v1",
                "kind": "Ingress",
                "metadata": {
                    "name": "edge",
                    "namespace": namespace,
                    "annotations": { "kubernetes.io/ingress.class": "nginx" },
                },
                "spec": { "defaultBackend": { "service": { "name": "a", "port": { "number": 80 } } } },
            }),
            force: false,
            drop: vec![],
        },
    )
    .await;
    let (_, _, _, warnings) = ready(answer);
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("deprecated")),
        "{warnings:?}"
    );
    cluster.delete(&namespace).await;
}

async fn status_write(admin: &kube::Client, path: &str, value: u32) {
    merge_patch(
        admin,
        &format!("{path}/status"),
        &json!({ "status": { "collisionCount": value } }),
        "status-writer",
    )
    .await;
}

fn failed(events: &[twigo_ipc::OperationEvent]) -> &twigo_ipc::IpcError {
    match events.last() {
        Some(twigo_ipc::OperationEvent::Failed { error }) => error,
        other => panic!("expected the run to fail, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_status_write_at_the_preview_and_at_the_run_still_applies() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-status").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]["mine"] = json!("1");
    let target = deployment_ref(&namespace, "web");

    status_write(&cluster.admin, &path, 1).await;
    let (id, result, _, _) = ready(
        preview(
            &core,
            edit(&cluster, target.clone(), &live, edited, false, vec![]),
        )
        .await,
    );
    assert_eq!(result["metadata"]["annotations"]["mine"], "1");
    status_write(&cluster.admin, &path, 2).await;
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["annotations"]["mine"], "1");

    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]
        .as_object_mut()
        .unwrap()
        .remove("theirs");
    let (id, _, removals, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, false, vec![])).await);
    assert_eq!(removals, vec![".metadata.annotations.theirs"]);
    status_write(&cluster.admin, &path, 3).await;
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["annotations"].get("theirs"), None);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_spec_or_a_metadata_change_between_the_preview_and_the_run_does_not_apply() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-changed").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let target = deployment_ref(&namespace, "web");
    for (name, change) in [
        ("spec", json!({ "spec": { "paused": true } })),
        (
            "metadata",
            json!({ "metadata": { "labels": { "other": "writer" } } }),
        ),
    ] {
        let live = settled(&cluster.admin, &path).await;
        let mut edited = view(&live);
        edited["metadata"]["annotations"]["mine"] = json!(name);
        let (id, _, _, _) = ready(
            preview(
                &core,
                edit(&cluster, target.clone(), &live, edited, false, vec![]),
            )
            .await,
        );
        merge_patch(&cluster.admin, &path, &change, "other").await;
        let plan = plan(&core, &cluster, id).await;
        let events = run(&core, &plan, None).await.unwrap();
        let error = failed(&events);
        assert_eq!(error.kind, ErrorKind::Conflict, "{name}: {error:?}");
        assert!(error.message.contains("changed since"), "{error:?}");
        let after = read(&cluster.admin, &path).await;
        assert_eq!(after["metadata"]["annotations"].get("mine"), None, "{name}");

        let mut edited = view(&live);
        edited["metadata"]["annotations"]["mine"] = json!(name);
        match preview(
            &core,
            edit(&cluster, target.clone(), &live, edited, false, vec![]),
        )
        .await
        {
            ApplyPreviewed::Stale { .. } => {}
            other => panic!("{name}: expected stale, got {other:?}"),
        }
    }
    cluster.delete(&namespace).await;
}

fn by_patch(answer: ApplyPreviewed) -> (PreviewId, Value) {
    match answer {
        ApplyPreviewed::Ready {
            id,
            result,
            strategy: ApplyStrategy::MergePatch,
            ..
        } => (id, result),
        other => panic!("expected the merge patch, got {other:?}"),
    }
}

fn strategy_deployment(name: &str) -> Value {
    let mut object = deployment(name);
    object["spec"]["template"]["spec"]["containers"][0]["env"] =
        json!([{ "name": "A", "value": "1" }]);
    object
}

fn manager_entry<'a>(object: &'a Value, manager: &str) -> Option<&'a Value> {
    object["metadata"]["managedFields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["manager"] == manager)
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_edit_an_apply_cannot_express_goes_by_one_merge_patch_and_owns_nothing() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-strategy").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let collection = deployments(&namespace);
    let target = |name: &str| deployment_ref(&namespace, name);
    for name in ["web", "line"] {
        post(&cluster.admin, &collection, &strategy_deployment(name)).await;
    }
    let path = format!("{collection}/web");
    let live = settled(&cluster.admin, &path).await;
    assert!(live["spec"]["strategy"]["rollingUpdate"].is_object());

    let mut edited = view(&live);
    edited["spec"]["strategy"] = json!({ "type": "Recreate" });
    match preview(
        &core,
        edit(
            &cluster,
            target("web"),
            &live,
            edited.clone(),
            false,
            vec![],
        ),
    )
    .await
    {
        ApplyPreviewed::Conflicts { .. } => {}
        other => panic!("a conflict is never routed to the merge patch: {other:?}"),
    }

    let (id, result) = by_patch(
        preview(
            &core,
            edit(&cluster, target("web"), &live, edited, true, vec![]),
        )
        .await,
    );
    assert_eq!(result["spec"]["strategy"], json!({ "type": "Recreate" }));
    let plan_of = plan(&core, &cluster, id).await;
    assert!(
        plan_of.kubectl.contains("patch deployments.apps web")
            && plan_of.kubectl.contains("--type=merge")
            && plan_of.kubectl.contains("--field-manager=twigo-edit"),
        "{}",
        plan_of.kubectl
    );
    assert!(!plan_of.kubectl.contains(" apply "), "{}", plan_of.kubectl);
    let events = run(&core, &plan_of, None).await.unwrap();
    assert!(
        matches!(events.last(), Some(twigo_ipc::OperationEvent::Done { .. })),
        "{events:?}"
    );
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["spec"]["strategy"], json!({ "type": "Recreate" }));
    assert_eq!(entry(&after, "twigo", "Apply"), None);
    assert_eq!(
        manager_entry(&after, "twigo-edit").unwrap()["operation"],
        "Update"
    );

    let line_path = format!("{collection}/line");
    let live = settled(&cluster.admin, &line_path).await;
    let mut edited = view(&live);
    edited["spec"]["strategy"] = json!({ "type": "Recreate" });
    let (id, _) = by_patch(
        preview(
            &core,
            edit(&cluster, target("line"), &live, edited, true, vec![]),
        )
        .await,
    );
    let plan_of = plan(&core, &cluster, id).await;
    kubectl(&plan_of, &kubeconfig);
    let after = read(&cluster.admin, &line_path).await;
    assert_eq!(after["spec"]["strategy"], json!({ "type": "Recreate" }));
    assert_eq!(entry(&after, "twigo", "Apply"), None);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn the_one_merge_patch_changes_value_to_value_from_and_a_bad_edit_keeps_its_422() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-env").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let collection = deployments(&namespace);
    post(&cluster.admin, &collection, &strategy_deployment("web")).await;
    let path = format!("{collection}/web");
    let live = settled(&cluster.admin, &path).await;
    let target = deployment_ref(&namespace, "web");

    let mut edited = view(&live);
    edited["spec"]["template"]["spec"]["containers"][0]["env"][0] = json!({
        "name": "A",
        "valueFrom": { "fieldRef": { "fieldPath": "metadata.name" } },
    });
    let (id, result) = by_patch(
        preview(
            &core,
            edit(&cluster, target.clone(), &live, edited, true, vec![]),
        )
        .await,
    );
    assert_eq!(
        result["spec"]["template"]["spec"]["containers"][0]["env"][0].get("value"),
        None
    );
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    let env = &after["spec"]["template"]["spec"]["containers"][0]["env"][0];
    assert_eq!(env.get("value"), None);
    assert_eq!(env["valueFrom"]["fieldRef"]["fieldPath"], "metadata.name");
    assert_eq!(entry(&after, "twigo", "Apply"), None);

    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["strategy"] = json!({ "type": "Bogus" });
    let refused = core
        .apply_preview("main", edit(&cluster, target, &live, edited, true, vec![]))
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput, "{refused:?}");
    assert!(refused.message.contains("strategy"), "{}", refused.message);
    assert!(refused.message.contains("Bogus"), "{}", refused.message);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_reorder_and_a_touched_duplicate_go_by_the_patch_and_an_untouched_duplicate_stays() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-order").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let collection = deployments(&namespace);
    let mut object = deployment("web");
    object["spec"]["template"]["spec"]["containers"][0]["env"] = json!([
        { "name": "A", "value": "1" },
        { "name": "A", "value": "2" },
        { "name": "B", "value": "x" },
    ]);
    post(&cluster.admin, &collection, &object).await;
    let path = format!("{collection}/web");
    let target = deployment_ref(&namespace, "web");
    let env_of =
        |object: &Value| object["spec"]["template"]["spec"]["containers"][0]["env"].clone();

    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["template"]["spec"]["containers"][0]["env"][2]["value"] = json!("y");
    let (id, _, _, _) = ready(
        preview(
            &core,
            edit(&cluster, target.clone(), &live, edited, true, vec![]),
        )
        .await,
    );
    applied(&core, &cluster, id).await;
    let after = settled(&cluster.admin, &path).await;
    assert_eq!(
        env_of(&after),
        json!([
            { "name": "A", "value": "1" },
            { "name": "A", "value": "2" },
            { "name": "B", "value": "y" },
        ]),
        "the duplicate is not touched"
    );

    let mut edited = view(&after);
    edited["spec"]["template"]["spec"]["containers"][0]["env"][1]["value"] = json!("3");
    let (id, _) = by_patch(
        preview(
            &core,
            edit(&cluster, target.clone(), &after, edited, false, vec![]),
        )
        .await,
    );
    applied(&core, &cluster, id).await;
    let after = settled(&cluster.admin, &path).await;
    assert_eq!(
        env_of(&after),
        json!([
            { "name": "A", "value": "1" },
            { "name": "A", "value": "3" },
            { "name": "B", "value": "y" },
        ])
    );

    let mut edited = view(&after);
    edited["spec"]["template"]["spec"]["containers"][0]["env"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let (id, _) = by_patch(
        preview(
            &core,
            edit(&cluster, target.clone(), &after, edited, false, vec![]),
        )
        .await,
    );
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(
        env_of(&after),
        json!([
            { "name": "B", "value": "y" },
            { "name": "A", "value": "3" },
            { "name": "A", "value": "1" },
        ]),
        "a reorder of a list map is written"
    );
    cluster.delete(&namespace).await;
}

async fn admission_policy(
    cluster: &Cluster,
    namespace: &str,
    resource: (&str, &str),
    actions: Value,
    validation: Value,
) -> String {
    let name = namespace.to_owned();
    let (group, plural) = resource;
    let admin = &cluster.admin;
    let _: Value = admin
        .request(
            http::Request::post(
                "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies",
            )
            .header("content-type", "application/json")
            .body(
                serde_json::to_vec(&json!({
                    "apiVersion": "admissionregistration.k8s.io/v1",
                    "kind": "ValidatingAdmissionPolicy",
                    "metadata": { "name": name },
                    "spec": {
                        "failurePolicy": "Fail",
                        "matchConstraints": { "resourceRules": [{
                            "apiGroups": [group],
                            "apiVersions": ["*"],
                            "operations": ["CREATE", "UPDATE"],
                            "resources": [plural],
                        }] },
                        "validations": [validation],
                    },
                }))
                .unwrap(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let _: Value = admin
        .request(
            http::Request::post(
                "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings",
            )
            .header("content-type", "application/json")
            .body(
                serde_json::to_vec(&json!({
                    "apiVersion": "admissionregistration.k8s.io/v1",
                    "kind": "ValidatingAdmissionPolicyBinding",
                    "metadata": { "name": name },
                    "spec": {
                        "policyName": name,
                        "validationActions": actions,
                        "matchResources": { "namespaceSelector": { "matchLabels": {
                            "kubernetes.io/metadata.name": namespace,
                        } } },
                    },
                }))
                .unwrap(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    name
}

async fn delete_admission_policy(cluster: &Cluster, name: &str) {
    for kind in [
        "validatingadmissionpolicybindings",
        "validatingadmissionpolicies",
    ] {
        let _: Value = cluster
            .admin
            .request(
                http::Request::delete(format!(
                    "/apis/admissionregistration.k8s.io/v1/{kind}/{name}"
                ))
                .body(Vec::new())
                .unwrap(),
            )
            .await
            .unwrap();
    }
}

async fn merge_answer(
    admin: &kube::Client,
    path: &str,
    body: &Value,
) -> Result<Value, kube::Error> {
    admin
        .request(
            http::Request::patch(path.to_owned())
                .header("content-type", "application/merge-patch+json")
                .body(serde_json::to_vec(body).unwrap())
                .unwrap(),
        )
        .await
}

fn pod(name: &str, finalizer: Option<&str>) -> Value {
    let mut object = json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": { "name": name },
        "spec": {
            "nodeName": "kwok-node-0",
            "containers": [{ "name": "app", "image": "fake:1" }],
        },
    });
    if let Some(finalizer) = finalizer {
        object["metadata"]["finalizers"] = json!([finalizer]);
    }
    object
}

async fn recreate_of(core: &Core, request: ApplyRequest) -> PreviewId {
    match preview(core, request).await {
        ApplyPreviewed::Immutable {
            recreate: Some(recreate),
            ..
        } => recreate,
        other => panic!("expected a recreate, got {other:?}"),
    }
}

fn changed_pod(live: &Value) -> Value {
    let mut edited = view(live);
    edited["spec"]["containers"][0]["command"] = json!(["sh"]);
    edited
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_merge_patch_refused_after_its_apply_says_what_is_left() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-after").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let configmaps = format!("/api/v1/namespaces/{namespace}/configmaps");
    let with_theirs = |name: &str| {
        json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": name, "annotations": { "theirs": "1" } },
        })
    };
    post(&cluster.admin, &configmaps, &with_theirs("probe")).await;
    post(&cluster.admin, &configmaps, &with_theirs("settings")).await;
    let policy = admission_policy(
        &cluster,
        &namespace,
        ("", "configmaps"),
        json!(["Deny"]),
        json!({
            "expression": "request.dryRun == true || !has(oldObject.metadata.annotations) || !('theirs' in oldObject.metadata.annotations) || (has(object.metadata.annotations) && 'theirs' in object.metadata.annotations)",
            "message": "theirs stays",
        }),
    )
    .await;
    let probe = format!("{configmaps}/probe");
    let admin = cluster.admin.clone();
    eventually("the policy refuses", || {
        let (admin, probe) = (admin.clone(), probe.clone());
        async move {
            match merge_answer(
                &admin,
                &probe,
                &json!({ "metadata": { "annotations": { "theirs": null } } }),
            )
            .await
            {
                Ok(_) => {
                    merge_answer(
                        &admin,
                        &probe,
                        &json!({ "metadata": { "annotations": { "theirs": "1" } } }),
                    )
                    .await
                    .unwrap();
                    false
                }
                Err(_) => true,
            }
        }
    })
    .await;

    let path = format!("{configmaps}/settings");
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]["mine"] = json!("1");
    edited["metadata"]["annotations"]
        .as_object_mut()
        .unwrap()
        .remove("theirs");
    let target = reference("", "v1", "configmaps", Some(&namespace), "settings");
    let (id, _, removals, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, false, vec![])).await);
    assert_eq!(removals, vec![".metadata.annotations.theirs"]);
    let plan = plan(&core, &cluster, id).await;
    let events = run(&core, &plan, None).await.unwrap();
    let error = failed(&events);
    assert!(
        error.message.contains("Applied config map settings")
            && error.message.contains("but the merge patch that removes")
            && error.message.contains("still there"),
        "{error:?}"
    );
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["annotations"]["mine"], "1");
    assert_eq!(after["metadata"]["annotations"]["theirs"], "1");
    delete_admission_policy(&cluster, &policy).await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_recreate_stopped_while_its_object_lingers_creates_nothing() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-finalizer").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let pods = format!("/api/v1/namespaces/{namespace}/pods");
    let finalizer = "twigo.test/hold";
    post(&cluster.admin, &pods, &pod("held", Some(finalizer))).await;
    let path = format!("{pods}/held");
    let live = settled(&cluster.admin, &path).await;
    let target = reference("", "v1", "pods", Some(&namespace), "held");
    let id = recreate_of(
        &core,
        edit(&cluster, target, &live, changed_pod(&live), true, vec![]),
    )
    .await;
    let plan_of = plan(&core, &cluster, id).await;
    assert!(plan_of.destructive);

    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    core.command_execute(
        "main",
        twigo_ipc::Execute {
            plan: plan_of.id,
            typed: None,
        },
        move |event| sender.send(event).is_ok(),
    )
    .await
    .unwrap();
    let stopped = tokio::time::timeout(super::WAIT, async {
        while let Some(event) = events.recv().await {
            match event {
                twigo_ipc::OperationEvent::Running { text } if text.starts_with("Waiting") => {
                    core.command_cancel("main", plan_of.id);
                }
                twigo_ipc::OperationEvent::Stopped { text } => return text,
                twigo_ipc::OperationEvent::Running { .. } => {}
                other => panic!("expected the wait to stop, got {other:?}"),
            }
        }
        panic!("no last event");
    })
    .await
    .expect("the stop ends within 60 s");
    assert!(stopped.contains("created nothing"), "{stopped}");
    let lingering = read(&cluster.admin, &path).await;
    assert_eq!(lingering["metadata"]["uid"], live["metadata"]["uid"]);
    assert_eq!(lingering["spec"]["containers"][0].get("command"), None);
    assert!(lingering["metadata"]["deletionTimestamp"].is_string());
    merge_patch(
        &cluster.admin,
        &path,
        &json!({ "metadata": { "finalizers": null } }),
        "other",
    )
    .await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_recreate_holds_to_the_uid_it_previewed() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-uid").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let pods = format!("/api/v1/namespaces/{namespace}/pods");
    post(&cluster.admin, &pods, &pod("web", None)).await;
    let path = format!("{pods}/web");
    let live = settled(&cluster.admin, &path).await;
    let target = reference("", "v1", "pods", Some(&namespace), "web");
    let id = recreate_of(
        &core,
        edit(&cluster, target, &live, changed_pod(&live), true, vec![]),
    )
    .await;
    let plan_of = plan(&core, &cluster, id).await;

    let _: Value = cluster
        .admin
        .request(
            http::Request::delete(path.clone())
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&json!({ "gracePeriodSeconds": 0 })).unwrap())
                .unwrap(),
        )
        .await
        .unwrap();
    let admin = cluster.admin.clone();
    let gone_path = path.clone();
    eventually("the old pod is gone", || {
        let (admin, path) = (admin.clone(), gone_path.clone());
        async move {
            admin
                .request::<Value>(http::Request::get(path).body(Vec::new()).unwrap())
                .await
                .is_err()
        }
    })
    .await;
    post(&cluster.admin, &pods, &pod("web", None)).await;
    let replacement = settled(&cluster.admin, &path).await;

    let events = run(&core, &plan_of, None).await.unwrap();
    let error = failed(&events);
    assert_eq!(error.kind, ErrorKind::Conflict, "{error:?}");
    assert!(error.message.contains("replaced since"), "{error:?}");
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["uid"], replacement["metadata"]["uid"]);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_recreate_is_offered_only_for_what_can_be_created_and_is_not_a_controller_s() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-offer").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;

    let replica_sets = format!("/apis/apps/v1/namespaces/{namespace}/replicasets");
    post(
        &cluster.admin,
        &replica_sets,
        &json!({
            "apiVersion": "apps/v1",
            "kind": "ReplicaSet",
            "metadata": { "name": "web" },
            "spec": {
                "replicas": 1,
                "selector": { "matchLabels": { "app": "web" } },
                "template": {
                    "metadata": { "labels": { "app": "web" } },
                    "spec": {
                        "nodeName": "kwok-node-0",
                        "containers": [{ "name": "app", "image": "fake:1" }],
                    },
                },
            },
        }),
    )
    .await;
    let pods = format!("/api/v1/namespaces/{namespace}/pods");
    let admin = cluster.admin.clone();
    let list = pods.clone();
    eventually("the replica set makes its pod", || {
        let (admin, list) = (admin.clone(), list.clone());
        async move {
            let pods: Value = admin
                .request(http::Request::get(list).body(Vec::new()).unwrap())
                .await
                .unwrap();
            pods["items"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        }
    })
    .await;
    let listed = read(&cluster.admin, &pods).await;
    let name = listed["items"][0]["metadata"]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("{pods}/{name}");
    let live = settled(&cluster.admin, &path).await;
    let target = reference("", "v1", "pods", Some(&namespace), &name);
    match preview(
        &core,
        edit(&cluster, target, &live, changed_pod(&live), true, vec![]),
    )
    .await
    {
        ApplyPreviewed::Immutable {
            message,
            recreate: None,
        } => {
            assert!(message.contains("replica set web"), "{message}");
            assert!(message.contains("edit that"), "{message}");
        }
        other => panic!("expected no recreate, got {other:?}"),
    }

    let jobs = format!("/apis/batch/v1/namespaces/{namespace}/jobs");
    post(
        &cluster.admin,
        &jobs,
        &json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "migrate" },
            "spec": {
                "template": { "spec": {
                    "nodeName": "kwok-node-0",
                    "restartPolicy": "Never",
                    "containers": [{ "name": "app", "image": "fake:1" }],
                } },
            },
        }),
    )
    .await;
    let path = format!("{jobs}/migrate");
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["template"]["spec"]["containers"][0]["image"] = json!("fake:2");
    edited["spec"]["template"]["spec"]["restartPolicy"] = json!("Always");
    let target = reference("batch", "v1", "jobs", Some(&namespace), "migrate");
    match preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await {
        ApplyPreviewed::Immutable {
            message,
            recreate: None,
        } => {
            assert!(message.contains("Nor can it be created"), "{message}");
            assert!(message.contains("restartPolicy"), "{message}");
        }
        other => panic!("expected no recreate of what cannot be created, got {other:?}"),
    }
    let unchanged = read(&cluster.admin, &path).await;
    assert_eq!(unchanged["metadata"]["uid"], live["metadata"]["uid"]);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_recreate_checks_its_body_again_before_it_deletes() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-recheck").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let pods = format!("/api/v1/namespaces/{namespace}/pods");
    post(&cluster.admin, &pods, &pod("web", None)).await;
    let path = format!("{pods}/web");
    let live = settled(&cluster.admin, &path).await;
    let target = reference("", "v1", "pods", Some(&namespace), "web");
    let id = recreate_of(
        &core,
        edit(&cluster, target, &live, changed_pod(&live), true, vec![]),
    )
    .await;
    let plan_of = plan(&core, &cluster, id).await;

    let policy = admission_policy(
        &cluster,
        &namespace,
        ("", "pods"),
        json!(["Deny"]),
        json!({ "expression": "request.operation != 'CREATE'", "message": "no new pods" }),
    )
    .await;
    let admin = cluster.admin.clone();
    let probe = format!("{pods}?dryRun=All");
    eventually("the policy refuses creating", || {
        let (admin, probe) = (admin.clone(), probe.clone());
        async move {
            admin
                .request::<Value>(
                    http::Request::post(probe)
                        .header("content-type", "application/json")
                        .body(serde_json::to_vec(&pod("probe", None)).unwrap())
                        .unwrap(),
                )
                .await
                .is_err()
        }
    })
    .await;

    let events = run(&core, &plan_of, None).await.unwrap();
    let error = failed(&events);
    assert!(error.message.contains("deleted nothing"), "{error:?}");
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["uid"], live["metadata"]["uid"]);
    assert_eq!(after["metadata"].get("deletionTimestamp"), None);
    delete_admission_policy(&cluster, &policy).await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_job_s_recreate_lists_its_pods_and_says_it_runs_again() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-job-plan").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let jobs = format!("/apis/batch/v1/namespaces/{namespace}/jobs");
    post(
        &cluster.admin,
        &jobs,
        &json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": "migrate" },
            "spec": { "template": { "spec": {
                "nodeName": "kwok-node-0",
                "restartPolicy": "Never",
                "containers": [{ "name": "app", "image": "fake:1" }],
            } } },
        }),
    )
    .await;
    let path = format!("{jobs}/migrate");
    let pods = format!("/api/v1/namespaces/{namespace}/pods");
    let admin = cluster.admin.clone();
    eventually("the job makes its pod", || {
        let (admin, list) = (admin.clone(), pods.clone());
        async move {
            let pods: Value = admin
                .request(http::Request::get(list).body(Vec::new()).unwrap())
                .await
                .unwrap();
            pods["items"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        }
    })
    .await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["template"]["spec"]["containers"][0]["image"] = json!("fake:2");
    let target = reference("batch", "v1", "jobs", Some(&namespace), "migrate");
    let id = recreate_of(&core, edit(&cluster, target, &live, edited, true, vec![])).await;
    let plan_of = plan(&core, &cluster, id).await;
    let listed = read(&cluster.admin, &pods).await;
    let name = listed["items"][0]["metadata"]["name"].as_str().unwrap();
    assert_eq!(plan_of.affected.len(), 1, "{:?}", plan_of.affected);
    assert_eq!(plan_of.affected[0].title, "With it go");
    assert!(
        plan_of.affected[0]
            .objects
            .iter()
            .any(|object| object.name == name),
        "{:?}",
        plan_of.affected
    );
    assert!(
        plan_of.consequences[0].contains("runs from the start"),
        "{:?}",
        plan_of.consequences
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn drop_my_change_clears_a_manifest_s_conflict() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-manifest-drop").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("/api/v1/namespaces/{namespace}/configmaps/settings");
    post(
        &cluster.admin,
        &format!("/api/v1/namespaces/{namespace}/configmaps"),
        &json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "settings" },
            "data": { "a": "1" },
        }),
    )
    .await;
    let manifest = json!({
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": { "name": "settings", "namespace": namespace },
        "data": { "a": "2", "b": "1" },
    });
    let request = |drop: Vec<String>, edited: Value| ApplyRequest {
        space: cluster.context.clone(),
        opened: None,
        edited,
        force: false,
        drop,
    };
    let answer = preview(&core, request(vec![], manifest.clone())).await;
    assert_eq!(
        answer,
        ApplyPreviewed::Conflicts {
            conflicts: vec![ApplyConflict {
                path: ".data.a".to_owned(),
                manager: "other".to_owned(),
            }],
        }
    );
    let dropped = vec![".data.a".to_owned()];
    let (id, result, _, _) = ready(preview(&core, request(dropped.clone(), manifest)).await);
    assert_eq!(result["data"], json!({ "a": "1", "b": "1" }));
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["data"], json!({ "a": "1", "b": "1" }));
    assert_eq!(
        entry(&after, "twigo", "Apply").unwrap(),
        &json!({ "f:data": { "f:b": {} } })
    );

    let lone = json!({
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": { "name": "settings", "namespace": namespace },
        "data": { "a": "2" },
    });
    assert_eq!(
        preview(&core, request(dropped, lone)).await,
        ApplyPreviewed::Unchanged { ignored: vec![] },
        "a manifest whose every change was given up sends nothing"
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_preview_is_replaced_by_a_newer_one_whatever_that_answers() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-newer").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]["mine"] = json!("1");
    let target = deployment_ref(&namespace, "web");
    let (older, _, _, _) = ready(
        preview(
            &core,
            edit(
                &cluster,
                target.clone(),
                &live,
                edited.clone(),
                true,
                vec![],
            ),
        )
        .await,
    );

    merge_patch(
        &cluster.admin,
        &path,
        &json!({ "metadata": { "labels": { "other": "writer" } } }),
        "other",
    )
    .await;
    match preview(
        &core,
        edit(
            &cluster,
            target.clone(),
            &live,
            edited.clone(),
            true,
            vec![],
        ),
    )
    .await
    {
        ApplyPreviewed::Stale { .. } => {}
        other => panic!("expected stale, got {other:?}"),
    }
    let refused = core
        .command_plan(
            "main",
            PlanRequest::Apply {
                space: cluster.context.clone(),
                preview: older,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::NotFound, "{refused:?}");

    let live = read(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]["mine"] = json!("2");
    let (older, _, _, _) = ready(
        preview(
            &core,
            edit(&cluster, target.clone(), &live, edited, true, vec![]),
        )
        .await,
    );
    let mut newer = view(&live);
    newer["metadata"]["annotations"]["mine"] = json!("3");
    let (latest, _, _, _) =
        ready(preview(&core, edit(&cluster, target, &live, newer, true, vec![])).await);
    let refused = core
        .command_plan(
            "main",
            PlanRequest::Apply {
                space: cluster.context.clone(),
                preview: older,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::NotFound, "{refused:?}");
    applied(&core, &cluster, latest).await;
    assert_eq!(
        read(&cluster.admin, &path).await["metadata"]["annotations"]["mine"],
        "3"
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_api_version_written_slash_v1_is_still_a_secret() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-slash").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let request = |data: Value| ApplyRequest {
        space: cluster.context.clone(),
        opened: None,
        edited: json!({
            "apiVersion": "/v1",
            "kind": "Secret",
            "metadata": { "name": "db", "namespace": namespace },
            "data": data,
        }),
        force: false,
        drop: vec![],
    };
    let refused = core
        .apply_preview("main", request(json!({ "password": "<12 bytes>" })))
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput, "{refused:?}");
    assert!(refused.message.contains("masked"), "{}", refused.message);

    let answer = core
        .apply_preview("main", request(json!({ "broken": format!("{SECRET}!!!") })))
        .await;
    match answer {
        Ok(answer) => secret_text_free("the preview", &serde_json::to_string(&answer).unwrap()),
        Err(error) => secret_text_free("the refusal", &serde_json::to_string(&error).unwrap()),
    }
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_warning_that_echoes_what_the_answer_holds_is_scrubbed_and_a_merge_patch_s_is_kept() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-warnings").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let policy = admission_policy(
        &cluster,
        &namespace,
        ("", "secrets"),
        json!(["Warn"]),
        json!({
            "expression": "false",
            "messageExpression": "'token is ' + string(object.data.token)",
        }),
    )
    .await;
    let request = || ApplyRequest {
        space: cluster.context.clone(),
        opened: None,
        edited: json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": { "name": "api", "namespace": namespace },
            "stringData": { "token": STRING_VALUE },
        }),
        force: false,
        drop: vec![],
    };
    let mut warned = None;
    let wait = tokio::time::timeout(super::WAIT, async {
        loop {
            match preview(&core, request()).await {
                ApplyPreviewed::Ready { warnings, .. } if !warnings.is_empty() => {
                    warned = Some(warnings);
                    return;
                }
                ApplyPreviewed::Ready { .. } => {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }
                other => panic!("expected ready, got {other:?}"),
            }
        }
    })
    .await;
    assert!(wait.is_ok(), "the policy warns within 60 s");
    let warnings = warned.unwrap();
    let text = warnings.join(" ");
    secret_text_free("the warning", &text);
    assert!(text.contains("token is <hidden>"), "{text}");
    delete_admission_policy(&cluster, &policy).await;

    let configmaps = format!("/api/v1/namespaces/{namespace}/configmaps");
    post(
        &cluster.admin,
        &configmaps,
        &json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "settings", "annotations": { "theirs": "1" } },
        }),
    )
    .await;
    let path = format!("{configmaps}/settings");
    let policy = admission_policy(
        &cluster,
        &namespace,
        ("", "configmaps"),
        json!(["Warn"]),
        json!({ "expression": "false", "message": "kept from the merge patch" }),
    )
    .await;
    let target = reference("", "v1", "configmaps", Some(&namespace), "settings");
    let mut warned = false;
    let wait = tokio::time::timeout(super::WAIT, async {
        while !warned {
            let live = read(&cluster.admin, &path).await;
            let mut edited = view(&live);
            edited["metadata"]["annotations"]
                .as_object_mut()
                .unwrap()
                .remove("theirs");
            let (_, _, _, warnings) = ready(
                preview(
                    &core,
                    edit(&cluster, target.clone(), &live, edited, false, vec![]),
                )
                .await,
            );
            warned = warnings
                .iter()
                .any(|text| text.contains("kept from the merge patch"));
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    })
    .await;
    assert!(
        wait.is_ok(),
        "the merge patch's warning reaches the preview"
    );
    delete_admission_policy(&cluster, &policy).await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn deleting_an_object_s_only_label_map_removes_it_and_its_kubectl_line_is_what_is_sent() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-labels").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, kubeconfig) = core(dir.path(), &cluster).await;
    let configmaps = format!("/api/v1/namespaces/{namespace}/configmaps");
    for name in ["c1", "c2"] {
        post(
            &cluster.admin,
            &configmaps,
            &json!({
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": { "name": name, "labels": { "a": "1" } },
                "data": { "k": "v" },
            }),
        )
        .await;
    }
    let forget_labels = |live: &Value| {
        let mut edited = view(live);
        edited["metadata"].as_object_mut().unwrap().remove("labels");
        edited
    };
    let target = |name: &str| reference("", "v1", "configmaps", Some(&namespace), name);

    let path = format!("{configmaps}/c1");
    let live = settled(&cluster.admin, &path).await;
    let (id, _, removals, _) = ready(
        preview(
            &core,
            edit(
                &cluster,
                target("c1"),
                &live,
                forget_labels(&live),
                false,
                vec![],
            ),
        )
        .await,
    );
    assert_eq!(removals, vec![".metadata.labels"]);
    applied(&core, &cluster, id).await;
    assert_eq!(
        read(&cluster.admin, &path).await["metadata"].get("labels"),
        None
    );

    let path = format!("{configmaps}/c2");
    let live = settled(&cluster.admin, &path).await;
    let (id, _, _, _) = ready(
        preview(
            &core,
            edit(
                &cluster,
                target("c2"),
                &live,
                forget_labels(&live),
                false,
                vec![],
            ),
        )
        .await,
    );
    let plan_of = plan(&core, &cluster, id).await;
    assert!(
        plan_of.kubectl.contains("\"labels\":null")
            && plan_of
                .kubectl
                .contains(&format!("\"resourceVersion\":\"{}\"", rv(&live))),
        "{}",
        plan_of.kubectl
    );
    kubectl(&plan_of, &kubeconfig);
    assert_eq!(
        read(&cluster.admin, &path).await["metadata"].get("labels"),
        None
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn twigo_s_only_field_removed_leaves_no_claim_that_keeps_another_appliers_container() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-claim").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    let gitops = |containers: Value| {
        json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "web" },
            "spec": {
                "replicas": 1,
                "selector": { "matchLabels": { "app": "web" } },
                "template": {
                    "metadata": { "labels": { "app": "web" } },
                    "spec": { "nodeName": "kwok-node-0", "containers": containers },
                },
            },
        })
    };
    server_apply(
        &cluster.admin,
        &path,
        &gitops(json!([
            { "name": "app", "image": "fake:1" },
            { "name": "side", "image": "fake:2" },
        ])),
        "gitops",
    )
    .await;
    server_apply(
        &cluster.admin,
        &path,
        &json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "web" },
            "spec": { "template": { "spec": { "containers": [
                { "name": "app", "workingDir": "/x" },
            ] } } },
        }),
        "twigo",
    )
    .await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["template"]["spec"]["containers"][0]
        .as_object_mut()
        .unwrap()
        .remove("workingDir");
    let target = deployment_ref(&namespace, "web");
    let (id, _, removals, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, false, vec![])).await);
    assert_eq!(removals, Vec::<String>::new());
    applied(&core, &cluster, id).await;

    let after = read(&cluster.admin, &path).await;
    assert_eq!(
        after["spec"]["template"]["spec"]["containers"][0].get("workingDir"),
        None
    );
    assert_eq!(entry(&after, "twigo", "Apply"), None, "{after}");

    server_apply(
        &cluster.admin,
        &path,
        &gitops(json!([{ "name": "side", "image": "fake:2" }])),
        "gitops",
    )
    .await;
    let after = read(&cluster.admin, &path).await;
    let names: Vec<&str> = after["spec"]["template"]["spec"]["containers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|container| container["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["side"], "the container went, as no claim keeps it");
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_null_a_person_left_is_no_value_on_the_server() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-null").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(&cluster.admin, &deployments(&namespace), &deployment("web")).await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["annotations"]["note"] = Value::Null;
    edited["spec"]["template"]["spec"]["containers"][0]["ports"][0]["protocol"] = Value::Null;
    edited["spec"]["template"]["spec"]["containers"][0]["ports"][0]["name"] = json!("web");
    let target = deployment_ref(&namespace, "web");
    let (id, _, removals, _) =
        ready(preview(&core, edit(&cluster, target, &live, edited, true, vec![])).await);
    assert_eq!(removals, Vec::<String>::new());
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["annotations"].get("note"), None);
    assert_eq!(
        after["spec"]["template"]["spec"]["containers"][0]["ports"],
        json!([{ "name": "web", "containerPort": 80, "protocol": "TCP" }])
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_co_owner_of_an_element_keeps_it_for_the_patch_on_the_server() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-coowner").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let group = format!("o{nanos}.twigo.test");
    let crd_name = with_crd(
        &cluster,
        widget_crd(
            &group,
            "widgets",
            "Widget",
            json!({
                "type": "object",
                "properties": {
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
                            },
                        },
                    },
                },
            }),
        ),
    )
    .await;
    let collection = format!("/apis/{group}/v1/namespaces/{namespace}/widgets");
    let admin = cluster.admin.clone();
    eventually("the widgets are served", || {
        let (admin, collection) = (admin.clone(), collection.clone());
        async move {
            admin
                .request::<Value>(http::Request::get(collection).body(Vec::new()).unwrap())
                .await
                .is_ok()
        }
    })
    .await;
    let path = format!("{collection}/one");
    let widget = |value: &str| {
        json!({
            "apiVersion": format!("{group}/v1"),
            "kind": "Widget",
            "metadata": { "name": "one" },
            "spec": { "items": [{ "name": "x", "value": value }] },
        })
    };
    server_apply(&cluster.admin, &path, &widget("1"), "gitops").await;
    server_apply(&cluster.admin, &path, &widget("2"), "twigo").await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["spec"]["items"] = json!([]);
    let target = reference(&group, "v1", "widgets", Some(&namespace), "one");
    let request = edit(&cluster, target, &live, edited, false, vec![]);
    let (id, result, removals, _) = ready(wait_served(&core, &request).await);
    assert_eq!(removals, vec![".spec.items[name=\"x\"]"]);
    assert_eq!(result["spec"]["items"], json!([]), "{result}");
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["spec"]["items"], json!([]), "{after}");
    delete_crd(&cluster, &crd_name).await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn the_one_merge_patch_adds_no_field_to_what_twigo_applied() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-owns").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    let mut object = deployment("web");
    object["spec"]["template"]["spec"]["containers"][0]["env"] = json!([
        { "name": "A", "value": "1" },
        { "name": "B", "value": "2" },
    ]);
    post(&cluster.admin, &deployments(&namespace), &object).await;
    server_apply(
        &cluster.admin,
        &path,
        &json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "web" },
            "spec": { "replicas": 3 },
        }),
        "twigo",
    )
    .await;
    let live = settled(&cluster.admin, &path).await;
    let mine = json!({ "f:spec": { "f:replicas": {} } });
    assert_eq!(entry(&live, "twigo", "Apply").unwrap(), &mine);

    let mut edited = view(&live);
    edited["spec"]["template"]["spec"]["containers"][0]["env"]
        .as_array_mut()
        .unwrap()
        .reverse();
    edited["metadata"]["annotations"]["mine"] = json!("1");
    let target = deployment_ref(&namespace, "web");
    let (id, _) =
        by_patch(preview(&core, edit(&cluster, target, &live, edited, false, vec![])).await);
    applied(&core, &cluster, id).await;

    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["metadata"]["annotations"]["mine"], "1");
    assert_eq!(after["spec"]["replicas"], 3);
    assert_eq!(
        after["spec"]["template"]["spec"]["containers"][0]["env"][0]["name"],
        "B"
    );
    assert_eq!(entry(&after, "twigo", "Apply").unwrap(), &mine);
    assert_eq!(
        manager_entry(&after, "twigo-edit").unwrap()["operation"],
        "Update"
    );
    cluster.delete(&namespace).await;
}

fn names(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect()
}

fn containers(object: &Value) -> &Value {
    &object["spec"]["template"]["spec"]["containers"]
}

fn containers_mut(object: &mut Value) -> &mut Value {
    &mut object["spec"]["template"]["spec"]["containers"]
}

fn with_containers(name: &str, list: Value) -> Value {
    let mut object = deployment(name);
    *containers_mut(&mut object) = list;
    object
}

fn env_of(pairs: &[(&str, &str)]) -> Value {
    Value::Array(
        pairs
            .iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect(),
    )
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_edit_leaves_a_list_in_the_order_the_server_holds_it() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-order").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(
        &cluster.admin,
        &deployments(&namespace),
        &with_containers(
            "web",
            json!([
                { "name": "app", "image": "fake:1", "env": env_of(&[("BASE", "x"), ("DERIVED", "$(BASE)/y")]) },
                { "name": "sidecar", "image": "fake:2" },
            ]),
        ),
    )
    .await;
    server_apply(
        &cluster.admin,
        &path,
        &with_only_containers(
            "web",
            json!([
                { "name": "app", "env": [{ "name": "DERIVED", "value": "$(BASE)/z" }] },
                { "name": "sidecar", "image": "fake:3" },
            ]),
        ),
        "twigo",
    )
    .await;
    let target = deployment_ref(&namespace, "web");

    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    containers_mut(&mut edited)[0]["env"][0]["value"] = json!("x2");
    let (id, result, _, _) = ready(
        preview(
            &core,
            edit(&cluster, target.clone(), &live, edited, true, vec![]),
        )
        .await,
    );
    assert_eq!(names(containers(&result)), ["app", "sidecar"], "{result}");
    assert_eq!(names(&containers(&result)[0]["env"]), ["BASE", "DERIVED"]);
    applied(&core, &cluster, id).await;
    let after = settled(&cluster.admin, &path).await;
    assert_eq!(names(containers(&after)), ["app", "sidecar"]);
    assert_eq!(names(&containers(&after)[0]["env"]), ["BASE", "DERIVED"]);
    assert_eq!(containers(&after)[0]["env"][1]["value"], "$(BASE)/z");

    let mut edited = view(&after);
    containers_mut(&mut edited)
        .as_array_mut()
        .unwrap()
        .push(json!({ "name": "extra", "image": "fake:4" }));
    let (id, result, _, _) =
        ready(preview(&core, edit(&cluster, target, &after, edited, false, vec![])).await);
    assert_eq!(
        names(containers(&result)),
        ["app", "sidecar", "extra"],
        "a new one goes after them"
    );
    applied(&core, &cluster, id).await;
    cluster.delete(&namespace).await;
}

fn with_only_containers(name: &str, list: Value) -> Value {
    json!({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": { "name": name },
        "spec": { "template": { "spec": { "containers": list } } },
    })
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn an_element_put_before_the_end_stands_there_on_the_server() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-insert").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(
        &cluster.admin,
        &deployments(&namespace),
        &with_containers(
            "web",
            json!([{ "name": "app", "image": "fake:1", "env": env_of(&[("A", "1"), ("B", "$(C)/b")]) }]),
        ),
    )
    .await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    containers_mut(&mut edited)[0]["env"] = env_of(&[("A", "1"), ("C", "c"), ("B", "$(C)/b")]);
    let (id, result) = by_patch(
        preview(
            &core,
            edit(
                &cluster,
                deployment_ref(&namespace, "web"),
                &live,
                edited,
                false,
                vec![],
            ),
        )
        .await,
    );
    assert_eq!(names(&containers(&result)[0]["env"]), ["A", "C", "B"]);
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(names(&containers(&after)[0]["env"]), ["A", "C", "B"]);
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_new_duplicate_key_keeps_the_element_it_copies_on_the_server() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-dup").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(
        &cluster.admin,
        &deployments(&namespace),
        &with_containers(
            "web",
            json!([{ "name": "app", "image": "fake:1", "env": env_of(&[("A", "1")]) }]),
        ),
    )
    .await;
    let live = settled(&cluster.admin, &path).await;
    let mut edited = view(&live);
    containers_mut(&mut edited)[0]["env"] = env_of(&[("A", "1"), ("A", "2")]);
    let (id, _) = by_patch(
        preview(
            &core,
            edit(
                &cluster,
                deployment_ref(&namespace, "web"),
                &live,
                edited,
                false,
                vec![],
            ),
        )
        .await,
    );
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(
        containers(&after)[0]["env"],
        env_of(&[("A", "1"), ("A", "2")])
    );
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_reversed_set_reaches_the_server() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-set").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let configmaps = format!("/api/v1/namespaces/{namespace}/configmaps");
    let path = format!("{configmaps}/held");
    post(
        &cluster.admin,
        &configmaps,
        &json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "held", "finalizers": ["a.example.com/x", "b.example.com/y"] },
        }),
    )
    .await;
    let live = read(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["finalizers"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let (id, _) = by_patch(
        preview(
            &core,
            edit(
                &cluster,
                reference("", "v1", "configmaps", Some(&namespace), "held"),
                &live,
                edited,
                false,
                vec![],
            ),
        )
        .await,
    );
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(
        after["metadata"]["finalizers"],
        json!(["b.example.com/y", "a.example.com/x"])
    );
    merge_patch(
        &cluster.admin,
        &path,
        &json!({ "metadata": { "finalizers": null } }),
        "cleanup",
    )
    .await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_changed_owner_reference_stays_whole_as_its_items_are_atomic() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-owners").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let configmaps = format!("/api/v1/namespaces/{namespace}/configmaps");
    let path = format!("{configmaps}/owned");
    let owner = post(
        &cluster.admin,
        &configmaps,
        &json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "owner" } }),
    )
    .await;
    post(
        &cluster.admin,
        &configmaps,
        &json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "owned", "ownerReferences": [{
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "name": "owner",
                "uid": owner["metadata"]["uid"],
                "blockOwnerDeletion": true,
            }] },
        }),
    )
    .await;
    let live = read(&cluster.admin, &path).await;
    let mut edited = view(&live);
    edited["metadata"]["ownerReferences"][0]["blockOwnerDeletion"] = json!(false);
    let (id, result, _, _) = ready(
        preview(
            &core,
            edit(
                &cluster,
                reference("", "v1", "configmaps", Some(&namespace), "owned"),
                &live,
                edited,
                true,
                vec![],
            ),
        )
        .await,
    );
    assert_eq!(
        result["metadata"]["ownerReferences"][0]["kind"],
        "ConfigMap"
    );
    assert_eq!(
        result["metadata"]["ownerReferences"][0]["blockOwnerDeletion"],
        false
    );
    applied(&core, &cluster, id).await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_crd_s_atomic_items_stay_whole_and_a_null_in_a_preserved_field_stays() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-crd2").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let group = format!("a{nanos}.twigo.test");
    let crd_name = with_crd(
        &cluster,
        widget_crd(
            &group,
            "things",
            "Thing",
            json!({
                "type": "object",
                "properties": {
                    "note": { "type": "string" },
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
                    "free": {
                        "type": "object",
                        "x-kubernetes-preserve-unknown-fields": true,
                    },
                },
            }),
        ),
    )
    .await;
    let collection = format!("/apis/{group}/v1/namespaces/{namespace}/things");
    let path = format!("{collection}/one");
    let admin = cluster.admin.clone();
    eventually("the things are served", || {
        let admin = admin.clone();
        let collection = collection.clone();
        async move {
            admin
                .request::<Value>(http::Request::get(collection).body(Vec::new()).unwrap())
                .await
                .is_ok()
        }
    })
    .await;
    post(
        &cluster.admin,
        &collection,
        &json!({
            "apiVersion": format!("{group}/v1"),
            "kind": "Thing",
            "metadata": { "name": "one" },
            "spec": { "note": "n", "refs": [
                { "name": "r", "ns": "n1", "kind": "K" },
                { "name": "s", "ns": "n2", "kind": "L" },
            ] },
        }),
    )
    .await;
    server_apply(
        &cluster.admin,
        &path,
        &json!({
            "apiVersion": format!("{group}/v1"),
            "kind": "Thing",
            "metadata": { "name": "one" },
            "spec": { "free": { "hosts": [{ "host": "a", "tls": null }] } },
        }),
        "twigo",
    )
    .await;
    let target = reference(&group, "v1", "things", Some(&namespace), "one");

    let live = read(&cluster.admin, &path).await;
    assert_eq!(
        live["spec"]["free"]["hosts"][0].get("tls"),
        Some(&Value::Null)
    );
    let mut edited = view(&live);
    edited["spec"]["refs"][0]["ns"] = json!("n9");
    let answer = wait_served(
        &core,
        &edit(&cluster, target.clone(), &live, edited, true, vec![]),
    )
    .await;
    let (id, result, _, _) = ready(answer);
    assert_eq!(
        result["spec"]["refs"][0],
        json!({ "name": "r", "ns": "n9", "kind": "K" }),
        "{result}"
    );
    assert_eq!(result["spec"]["refs"][1]["kind"], "L");
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(after["spec"]["refs"][0]["kind"], "K");
    assert_eq!(after["spec"]["refs"][0]["ns"], "n9");

    let mut edited = view(&after);
    edited["spec"]["note"] = json!("other");
    let (id, result, _, _) =
        ready(preview(&core, edit(&cluster, target, &after, edited, true, vec![])).await);
    assert_eq!(
        result["spec"]["free"]["hosts"][0].get("tls"),
        Some(&Value::Null),
        "{result}"
    );
    applied(&core, &cluster, id).await;
    let after = read(&cluster.admin, &path).await;
    assert_eq!(
        after["spec"]["free"]["hosts"][0].get("tls"),
        Some(&Value::Null)
    );

    delete_crd(&cluster, &crd_name).await;
    cluster.delete(&namespace).await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn keep_mine_with_a_list_sent_whole_is_stale_when_the_server_holds_it_otherwise() {
    let cluster = Cluster::connect().await;
    let namespace = cluster.namespace("apply-keepall").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path(), &cluster).await;
    let path = format!("{}/web", deployments(&namespace));
    post(
        &cluster.admin,
        &deployments(&namespace),
        &with_containers(
            "web",
            json!([{ "name": "app", "image": "fake:1", "env": env_of(&[("A", "1"), ("B", "2")]) }]),
        ),
    )
    .await;
    let opened = settled(&cluster.admin, &path).await;
    let mut edited = view(&opened);
    containers_mut(&mut edited)[0]["env"] = env_of(&[("B", "2"), ("A", "1")]);
    let target = deployment_ref(&namespace, "web");

    merge_patch(
        &cluster.admin,
        &path,
        &json!({ "spec": { "template": { "spec": { "containers": [
            { "name": "app", "image": "fake:1", "env": env_of(&[("A", "other"), ("B", "2")]) },
        ] } } } }),
        "other",
    )
    .await;
    let current = settled(&cluster.admin, &path).await;
    let mut keep_mine = edit(
        &cluster,
        target.clone(),
        &opened,
        edited.clone(),
        false,
        vec![],
    );
    keep_mine.opened.as_mut().unwrap().lock = rv(&current);
    let answer = preview(&core, keep_mine).await;
    assert!(matches!(answer, ApplyPreviewed::Stale { .. }), "{answer:?}");

    merge_patch(
        &cluster.admin,
        &path,
        &json!({ "spec": { "template": { "spec": { "containers": [
            { "name": "renamed", "image": "fake:1" },
        ] } } } }),
        "other",
    )
    .await;
    let current = settled(&cluster.admin, &path).await;
    let mut keep_mine = edit(&cluster, target, &opened, edited, false, vec![]);
    keep_mine.opened.as_mut().unwrap().lock = rv(&current);
    let answer = preview(&core, keep_mine).await;
    assert!(
        matches!(answer, ApplyPreviewed::Stale { .. }),
        "the outer element is gone: {answer:?}"
    );
    let after = read(&cluster.admin, &path).await;
    assert_eq!(names(containers(&after)), ["renamed"]);
    cluster.delete(&namespace).await;
}
