use std::ffi::OsString;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use twigo_env::{Failure, Reason, ShellEnv, Status};

use super::*;

fn env(kubeconfig: &Path) -> Arc<ShellEnv> {
    Arc::new(ShellEnv::from_iter([(
        OsString::from("KUBECONFIG"),
        kubeconfig.as_os_str().to_owned(),
    )]))
}

async fn names(core: &Core, wanted: &[&str]) {
    let mut contexts = core.catalog.subscribe();
    let read = tokio::time::timeout(
        Duration::from_secs(5),
        contexts.wait_for(|listed| {
            listed.as_ref().is_some_and(|listed| {
                listed
                    .iter()
                    .map(|c| c.name.as_str())
                    .eq(wanted.iter().copied())
            })
        }),
    )
    .await;
    assert!(read.is_ok(), "the catalog never listed {wanted:?}");
}

#[tokio::test]
async fn the_catalog_follows_the_login_shell_and_tells_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let process = dir.path().join("process");
    let shell = dir.path().join("shell");
    std::fs::write(
        &process,
        "contexts: [{ name: kind-process, context: { cluster: c } }]",
    )
    .unwrap();
    std::fs::write(
        &shell,
        "contexts: [{ name: kind-shell, context: { cluster: c } }]",
    )
    .unwrap();
    let state_file = dir.path().join("state.json");
    let core = Arc::new(Core::new(state_file.clone()));
    core.state.open_space("kind-process");
    let (status, followed) = watch::channel(Status::Resolving);
    tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.run(followed, None).await }
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        core.catalog.subscribe().borrow().is_none(),
        "nothing before the shell answers"
    );

    status.send_replace(Status::Failed {
        env: env(&process),
        failure: Arc::new(Failure {
            shell: "/bin/zsh".into(),
            reason: Reason::Timeout,
            output: String::new(),
        }),
    });
    names(&core, &["kind-process"]).await;

    status.send_replace(Status::Resolving);
    status.send_replace(Status::Resolved(env(&shell)));
    names(&core, &["kind-shell"]).await;

    core.state.flush().unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&state_file).unwrap()).unwrap();
    let space = &saved["spaces"][0];
    assert_eq!(space["id"], "kind-process");
    assert!(space["missing_since"].is_string(), "{space}");
}
