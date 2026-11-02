use std::ffi::OsString;
use std::sync::Arc;

use kube::config::Kubeconfig;
use tokio::sync::watch;
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn the_namespaces_and_the_version_come_from_the_cluster() {
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
    let core = Core::new(dir.path());
    let env = ShellEnv::from_iter(Vec::<(OsString, OsString)>::new());
    let (_status, followed) = watch::channel(Status::Resolved(Arc::new(env)));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.run(followed, Some(path.into())).await }
    });

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
