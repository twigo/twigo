use std::ffi::OsString;
use std::path::PathBuf;
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
    let core = Core::new(dir.path(), &dir.path().join("cache"));
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

/// A kubeconfig whose contexts `kind-0` and on each run a plugin that notes
/// its run, then prints a token or, when `hangs`, never answers.
struct Plugins {
    dir: tempfile::TempDir,
}

impl Plugins {
    fn new(contexts: usize, hangs: bool) -> Self {
        let plugins = Self {
            dir: tempfile::tempdir().unwrap(),
        };
        let answer = if hangs {
            "exec /bin/sleep 1000"
        } else {
            r#"printf '{"status":{"token":"t"}}'"#
        };
        let script = plugins.dir.path().join("plugin");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho run >> '{}'\n{answer}\n",
                plugins.dir.path().join("runs").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        plugins.write(contexts, &[]);
        plugins
    }

    /// Every context's user runs the plugin with `args`; contexts on their
    /// own clusters, which refuse connections.
    fn write(&self, contexts: usize, args: &[&str]) {
        let mut config = String::from(
            "clusters: [{ name: c, cluster: { server: 'https://127.0.0.1:1' } }]\ncontexts:\n",
        );
        let mut users = String::from("users:\n");
        for i in 0..contexts {
            config.push_str(&format!(
                "- {{ name: kind-{i}, context: {{ cluster: c, user: u{i} }} }}\n"
            ));
            users.push_str(&format!(
                "- {{ name: u{i}, user: {{ exec: {{ apiVersion: client.authentication.k8s.io/v1, interactiveMode: Never, command: '{}', args: {args:?}, env: [{{ name: CONTEXT, value: '{i}' }}] }} }} }}\n",
                self.dir.path().join("plugin").display()
            ));
        }
        std::fs::write(self.kubeconfig(), config + &users).unwrap();
    }

    fn kubeconfig(&self) -> PathBuf {
        self.dir.path().join("config")
    }

    fn runs(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("runs"))
            .map(|runs| runs.lines().count())
            .unwrap_or(0)
    }

    async fn core(&self) -> (Arc<Core>, tempfile::TempDir) {
        let data = tempfile::tempdir().unwrap();
        let core = Core::new(data.path(), &data.path().join("cache"));
        let env = Arc::new(ShellEnv::from_iter(Vec::<(OsString, OsString)>::new()));
        let (status, followed) = watch::channel(Status::Resolved(env));
        tokio::spawn({
            let core = Arc::clone(&core);
            let explicit = self.kubeconfig();
            async move {
                let _status = status;
                core.run(followed, Some(explicit)).await;
            }
        });
        core.catalog.contexts().await;
        (core, data)
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(300)).await;
}

#[tokio::test]
async fn an_untrusted_plugin_never_runs_and_a_changed_one_asks_again() {
    let plugins = Plugins::new(1, false);
    let (core, _data) = plugins.core().await;
    core.set_focused(true);
    let refused = core.cluster_version("kind-0").await.unwrap_err();
    assert_eq!(
        refused.kind,
        twigo_ipc::ErrorKind::Unauthorized,
        "{refused:?}"
    );
    settle().await;
    assert_eq!(plugins.runs(), 0);

    let review = core.review().await;
    assert!(!review.reviewed);
    assert_eq!(review.plugins.len(), 1);
    assert_eq!(review.plugins[0].contexts, ["kind-0"]);
    core.trust_plugins(vec![review.plugins[0].plugin.digest.clone()])
        .unwrap();
    let unreachable = core.cluster_version("kind-0").await.unwrap_err();
    assert_eq!(
        unreachable.kind,
        twigo_ipc::ErrorKind::Unavailable,
        "{unreachable:?}"
    );
    assert_eq!(plugins.runs(), 1);

    plugins.write(1, &["--profile", "other"]);
    let mut contexts = core.catalog.subscribe();
    contexts.changed().await.unwrap();
    let refused = core.cluster_version("kind-0").await.unwrap_err();
    assert_eq!(
        refused.kind,
        twigo_ipc::ErrorKind::Unauthorized,
        "{refused:?}"
    );
    settle().await;
    assert_eq!(
        plugins.runs(),
        1,
        "a changed argument asks again before it runs"
    );
    let review = core.review().await;
    assert!(review.reviewed);
    assert_eq!(review.plugins.len(), 1);
}

#[tokio::test]
async fn twenty_five_plugins_that_never_answer_run_only_for_the_space_opened() {
    let plugins = Plugins::new(25, true);
    let (core, _data) = plugins.core().await;
    let review = core.review().await;
    assert_eq!(review.plugins.len(), 25, "each context's env differs");
    core.trust_plugins(
        review
            .plugins
            .into_iter()
            .map(|p| p.plugin.digest)
            .collect(),
    )
    .unwrap();
    core.set_focused(true);
    assert_eq!(core.catalog.contexts().await.iter().count(), 25);
    settle().await;
    assert_eq!(plugins.runs(), 0, "listing runs nothing");

    let opened = tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.cluster_version("kind-7").await }
    });
    let mut auth = core.follow_auth("kind-7".to_owned());
    loop {
        if let twigo_ipc::ContextAuth::Plugin {
            status: twigo_ipc::PluginStatus::Running { .. },
            ..
        } = auth.next().await
        {
            break;
        }
    }
    settle().await;
    assert_eq!(plugins.runs(), 1);
    core.cancel_sign_in("kind-7").await.unwrap();
    let cancelled = opened.await.unwrap().unwrap_err();
    assert_eq!(
        cancelled.kind,
        twigo_ipc::ErrorKind::Unauthorized,
        "{cancelled:?}"
    );
    let twigo_ipc::ContextAuth::Plugin {
        status: twigo_ipc::PluginStatus::Failed { error, .. },
        ..
    } = auth.next().await
    else {
        panic!("the cancelled run shows as failed");
    };
    assert!(error.contains("cancelled"), "{error}");
    assert_eq!(plugins.runs(), 1);
}

#[tokio::test]
async fn a_plugin_that_may_ask_waits_for_the_focus() {
    let plugins = Plugins::new(1, false);
    let (core, _data) = plugins.core().await;
    let review = core.review().await;
    core.trust_plugins(vec![review.plugins[0].plugin.digest.clone()])
        .unwrap();
    let mut auth = core.follow_auth("kind-0".to_owned());
    let twigo_ipc::ContextAuth::Plugin { plugin, status } = auth.next().await else {
        panic!("a trusted plugin");
    };
    assert!(plugin.signs_in, "an unknown command may ask");
    assert_eq!(status, twigo_ipc::PluginStatus::Idle);
    let opened = tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.cluster_version("kind-0").await }
    });
    let twigo_ipc::ContextAuth::Plugin { status, .. } = auth.next().await else {
        panic!("a trusted plugin");
    };
    assert_eq!(status, twigo_ipc::PluginStatus::Waiting);
    assert_eq!(plugins.runs(), 0);
    core.set_focused(true);
    let unreachable = opened.await.unwrap().unwrap_err();
    assert_eq!(unreachable.kind, twigo_ipc::ErrorKind::Unavailable);
    assert_eq!(plugins.runs(), 1);
}

#[test]
fn only_sign_in_links_open() {
    assert!(sign_in_url("https://microsoft.com/devicelogin").is_ok());
    assert!(sign_in_url("http://127.0.0.1:53712/2c9b0d6e").is_ok());
    assert!(sign_in_url("http://localhost/callback").is_ok());
    assert!(sign_in_url("http://example.com/login").is_err());
    assert!(sign_in_url("http://localhost:1@example.com/").is_err());
    assert!(sign_in_url("file:///etc/passwd").is_err());
    assert!(sign_in_url("javascript:alert(1)").is_err());
}

#[tokio::test]
async fn a_credential_got_by_signing_in_outlives_a_reread_of_its_context() {
    let plugins = Plugins::new(1, false);
    let (core, _data) = plugins.core().await;
    let review = core.review().await;
    core.trust_plugins(vec![review.plugins[0].plugin.digest.clone()])
        .unwrap();
    let mut auth = core.follow_auth("kind-0".to_owned());
    auth.next().await;
    core.sign_in("kind-0").await.unwrap();
    let ready = async {
        loop {
            if let twigo_ipc::ContextAuth::Plugin {
                status: twigo_ipc::PluginStatus::Ready { .. },
                ..
            } = auth.next().await
            {
                break;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(5), ready)
        .await
        .expect("the follower sees the credential come");
    core.trust_plugins(vec!["another".to_owned()]).unwrap();
    let reread = tokio::time::timeout(Duration::from_millis(300), auth.next()).await;
    assert!(
        reread.is_err(),
        "nothing changed for the context: {reread:?}"
    );
    let mut again = core.follow_auth("kind-0".to_owned());
    let twigo_ipc::ContextAuth::Plugin { status, .. } = again.next().await else {
        panic!("a trusted plugin");
    };
    assert!(
        matches!(status, twigo_ipc::PluginStatus::Ready { .. }),
        "{status:?}"
    );
    assert_eq!(plugins.runs(), 1);
}

fn pods(space: &str) -> ListQuery {
    ListQuery {
        space: space.to_owned(),
        gvr: twigo_ipc::Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
        },
        namespaced: true,
        namespaces: Vec::new(),
        label_selector: None,
        text: None,
        columns: None,
        sort: None,
        count_by: None,
        group_by: None,
        values: None,
    }
}

#[tokio::test]
async fn a_window_reaches_only_its_own_lists_and_a_reload_drops_them() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(dir.path(), &dir.path().join("cache"));
    let space = core.state.open_space("kind-test").id;
    let (sender, mut batches) = tokio::sync::mpsc::unbounded_channel();
    let id = core
        .list_subscribe("main", pods(&space), move |batch| {
            sender.send(batch).is_ok()
        })
        .await
        .unwrap();
    let window = SetWindow {
        id,
        start: 0,
        end: 40,
    };
    core.list_set_window("main", window).unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), batches.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.status, ViewState::Connecting);
    let ack = Ack { id, seq: first.seq };
    core.list_ack("main", ack).unwrap();
    for refused in [
        core.list_set_window("other", window),
        core.list_ack("other", ack),
        core.list_unsubscribe("other", id),
    ] {
        assert_eq!(refused.unwrap_err().kind, ErrorKind::NotFound);
    }

    let ticket = core.lists.ticket("main");
    core.drop_window("main");
    assert_eq!(
        core.list_ack("main", ack).unwrap_err().kind,
        ErrorKind::NotFound
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while batches.recv().await.is_some() {}
    })
    .await
    .expect("the batcher ended with its window");
    let (sender, _batches) = tokio::sync::mpsc::unbounded_channel();
    let late = core.hub.rows(Query {
        context: "kind-test".to_owned(),
        resource: Resource {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
            namespaced: true,
        },
        format: RowFormat::Table,
        namespaces: Vec::new(),
        field_selector: None,
    });
    let late = Batcher::spawn(
        late.await.unwrap(),
        Spec::new("kind-test", &pods(&space)).unwrap(),
        move |batch| sender.send(batch).is_ok(),
    );
    assert_eq!(
        core.lists.keep(ticket, late).unwrap_err().kind,
        ErrorKind::Unavailable,
        "asked for before the reload, answered after"
    );
}

#[tokio::test]
async fn a_list_of_an_unknown_space_or_a_bad_selector_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(dir.path(), &dir.path().join("cache"));
    let refused = core.list_subscribe("main", pods("nowhere"), |_| true).await;
    assert_eq!(refused.unwrap_err().kind, ErrorKind::NotFound);
    let space = core.state.open_space("kind-test").id;
    let mut bad = pods(&space);
    bad.label_selector = Some("app in web".to_owned());
    let refused = core.list_subscribe("main", bad, |_| true).await;
    assert_eq!(refused.unwrap_err().kind, ErrorKind::InvalidInput);
}

fn pod(space: &str) -> twigo_ipc::OpenObject {
    twigo_ipc::OpenObject {
        object: twigo_ipc::ObjectQuery {
            space: space.to_owned(),
            gvr: twigo_ipc::Gvr {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
            },
            namespaced: true,
            namespace: Some("default".to_owned()),
            name: "web".to_owned(),
        },
        parts: twigo_ipc::ObjectParts {
            overview: true,
            ..Default::default()
        },
    }
}

#[tokio::test]
async fn a_window_reaches_only_its_own_objects_and_a_reload_closes_them() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(dir.path(), &dir.path().join("cache"));
    let space = core.state.open_space("kind-test").id;
    let (sender, mut batches) = tokio::sync::mpsc::unbounded_channel();
    let id = core
        .object_open("main", pod(&space), move |batch| sender.send(batch).is_ok())
        .await
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), batches.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.status, ViewState::Connecting);
    assert!(!first.exists && first.overview.is_none());
    let ack = Ack { id, seq: first.seq };
    core.object_ack("main", ack).unwrap();
    let parts = twigo_ipc::SetParts {
        id,
        parts: twigo_ipc::ObjectParts::default(),
    };
    let values = twigo_ipc::GetValues {
        id,
        keys: vec!["mode".to_owned()],
    };
    assert_eq!(
        core.object_values("main", values.clone()).unwrap_err().kind,
        ErrorKind::NotFound,
        "nothing is listed yet"
    );
    for refused in [
        core.object_set_parts("other", parts),
        core.object_ack("other", ack),
        core.object_values("other", values).map(drop),
        core.object_close("other", id),
    ] {
        assert_eq!(refused.unwrap_err().kind, ErrorKind::NotFound);
    }

    core.drop_window("main");
    assert_eq!(
        core.object_ack("main", ack).unwrap_err().kind,
        ErrorKind::NotFound
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while batches.recv().await.is_some() {}
    })
    .await
    .expect("the object ended with its window");
}

#[tokio::test]
async fn a_namespaced_object_without_a_namespace_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(dir.path(), &dir.path().join("cache"));
    let space = core.state.open_space("kind-test").id;
    let mut nowhere = pod(&space);
    nowhere.object.namespace = None;
    let refused = core.object_open("main", nowhere, |_| true).await;
    assert_eq!(refused.unwrap_err().kind, ErrorKind::InvalidInput);
}
