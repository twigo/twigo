//! An apply of an edit on kind: what each answer of the preview is for, and
//! what is on the server after it, field by field.

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::Api;
use kube::api::PostParams;
use serde_json::{Value, json};
use twigo_core::Core;
use twigo_ipc::{
    ApplyConflict, ApplyPreviewed, ApplyRequest, ErrorKind, Mode, OpenedEdit, Plan, PlanRequest,
    PreviewId, ResourceRef, SetContextMode,
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
