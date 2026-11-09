use std::ffi::OsString;
use std::sync::Arc;

use kube::config::Kubeconfig;
use tokio::sync::watch;
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::SchemaQuery;

async fn cluster() -> (Arc<Core>, String, tempfile::TempDir) {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let context = Kubeconfig::read_from(&path)
        .unwrap()
        .current_context
        .unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: only kind and kwok clusters"
    );
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let env = ShellEnv::from_iter(Vec::<(OsString, OsString)>::new());
    let (_status, followed) = watch::channel(Status::Resolved(Arc::new(env)));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.run(followed, Some(path.into())).await }
    });
    (core, context, dir)
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn the_namespaces_and_the_version_come_from_the_cluster() {
    let (core, context, _dir) = cluster().await;

    let space = core.state.open_space(&context);
    let namespaces = core.namespaces(&space.id).await.unwrap();
    assert!(
        ["default", "kube-system"]
            .iter()
            .all(|name| namespaces.iter().any(|listed| listed == name)),
        "{namespaces:?}"
    );
    let unknown = core.namespaces("no-such-space").await.unwrap_err();
    assert_eq!(unknown.kind, twigo_ipc::ErrorKind::NotFound);

    let version = core.cluster_version(&context).await.unwrap();
    assert!(version.git_version.starts_with("v1."), "{version:?}");
    let missing = core.cluster_version("kind-missing").await.unwrap_err();
    assert_eq!(missing.kind, twigo_ipc::ErrorKind::NotFound);
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_kinds_schema_comes_from_the_clusters_openapi() {
    let (core, context, dir) = cluster().await;
    let space = core.state.open_space(&context);
    let query = |space: &str, group: &str, version: &str, kind: &str| SchemaQuery {
        space: space.to_owned(),
        group: group.to_owned(),
        version: version.to_owned(),
        kind: kind.to_owned(),
    };

    let schema = core
        .schema(query(&space.id, "apps", "v1", "Deployment"))
        .await
        .unwrap();
    let schema: serde_json::Value = serde_json::from_str(&schema).unwrap();
    assert_eq!(schema["$schema"], "http://json-schema.org/draft-07/schema#");
    assert_eq!(
        schema["properties"]["kind"]["enum"],
        serde_json::json!(["Deployment"])
    );
    assert_eq!(
        std::fs::read_dir(dir.path().join("cache/openapi"))
            .unwrap()
            .count(),
        1
    );

    let core_pod = core
        .schema(query(&space.id, "", "v1", "Pod"))
        .await
        .unwrap();
    assert!(core_pod.contains("#/definitions/io.k8s.api.core.v1.PodSpec"));

    for (space, group, version, kind) in [
        (space.id.as_str(), "apps", "v1", "Nothing"),
        (space.id.as_str(), "apps", "v9", "Deployment"),
        ("no-such-space", "apps", "v1", "Deployment"),
    ] {
        let missing = core
            .schema(query(space, group, version, kind))
            .await
            .unwrap_err();
        assert_eq!(missing.kind, twigo_ipc::ErrorKind::NotFound, "{missing:?}");
    }
}
