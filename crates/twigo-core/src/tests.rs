use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use twigo_env::{Failure, Reason, ShellEnv, Status};

use super::*;
use twigo_ipc::{BlockReason, Environment, Mode, ModeSource};

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
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
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
        let core = Core::new(
            data.path(),
            &data.path().join("cache"),
            &data.path().join("policy.json"),
        );
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
async fn the_audit_log_names_each_plugin_trusted_by_its_digest_and_program_alone() {
    let plugins = Plugins::new(1, false);
    plugins.write(1, &["--token", "s3cret"]);
    let (core, data) = plugins.core().await;
    let digest = core.review().await.plugins[0].plugin.digest.clone();
    core.trust_plugins(vec![digest.clone()]).unwrap();
    core.trust_plugins(vec![digest.clone()]).unwrap();

    let text = std::fs::read_to_string(data.path().join("audit.jsonl")).unwrap();
    assert!(!text.contains("s3cret"), "{text}");
    let lines: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 1, "trusted once: {lines:?}");
    assert_eq!(lines[0]["event"], "trusted");
    assert_eq!(lines[0]["digest"], digest);
    let program = plugins.dir.path().join("plugin");
    assert_eq!(lines[0]["program"], program.display().to_string());
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
        field_selector: None,
        owners: None,
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
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
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
        metrics: false,
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
        None,
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
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
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
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
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
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let space = core.state.open_space("kind-test").id;
    let mut nowhere = pod(&space);
    nowhere.object.namespace = None;
    let refused = core.object_open("main", nowhere, |_| true).await;
    assert_eq!(refused.unwrap_err().kind, ErrorKind::InvalidInput);
}

fn logs(space: &str, group: &str, resource: &str) -> twigo_ipc::OpenLogs {
    twigo_ipc::OpenLogs {
        target: twigo_ipc::LogTarget {
            space: space.to_owned(),
            gvr: twigo_ipc::Gvr {
                group: group.to_owned(),
                version: "v1".to_owned(),
                resource: resource.to_owned(),
            },
            namespace: "default".to_owned(),
            name: "web".to_owned(),
        },
        source: twigo_ipc::LogSource {
            containers: twigo_ipc::Containers::Default,
            pods: None,
            since: twigo_ipc::Since::Seconds { seconds: 900 },
            previous: false,
        },
        view: twigo_ipc::LogView {
            level: twigo_ipc::LevelFilter::All,
            filter: None,
            search: None,
            range: None,
        },
    }
}

#[tokio::test]
async fn a_window_reaches_only_its_own_logs_and_a_reload_closes_them() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let space = core.state.open_space("kind-test").id;
    let (sender, mut batches) = tokio::sync::mpsc::unbounded_channel();
    let id = core
        .logs_open("main", logs(&space, "", "pods"), move |batch| {
            sender.send(batch).is_ok()
        })
        .await
        .unwrap();
    let window = twigo_ipc::SetLogWindow {
        id,
        window: twigo_ipc::LogWindow::Tail { count: 100 },
    };
    core.logs_set_window("main", window).unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), batches.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.status, ViewState::Connecting);
    assert_eq!(first.pods, Some(Vec::new()));
    assert_eq!(first.window.map(|window| window.entries.len()), Some(0));
    let ack = Ack { id, seq: first.seq };
    core.logs_ack("main", ack).unwrap();
    assert_eq!(core.logs_file_name("main", id).unwrap(), "web.log");
    let bad = twigo_ipc::SetLogView {
        id,
        view: twigo_ipc::LogView {
            filter: Some("/web-[/".to_owned()),
            ..logs(&space, "", "pods").view
        },
    };
    assert_eq!(
        core.logs_set_view("main", bad).unwrap_err().kind,
        ErrorKind::InvalidInput
    );
    let file = dir.path().join("web.log");
    let download = twigo_ipc::DownloadLogs { id, filtered: true };
    core.logs_write("main", download, &file).await.unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), b"");
    for refused in [
        core.logs_set_window("other", window),
        core.logs_ack("other", ack),
        core.logs_close("other", id),
    ] {
        assert_eq!(refused.unwrap_err().kind, ErrorKind::NotFound);
    }

    core.drop_window("main");
    assert_eq!(
        core.logs_ack("main", ack).unwrap_err().kind,
        ErrorKind::NotFound
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while batches.recv().await.is_some() {}
    })
    .await
    .expect("the session ended with its window");
}

#[tokio::test]
async fn logs_of_a_kind_without_pods_or_an_unknown_space_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let refused = core
        .logs_open("main", logs("nowhere", "", "pods"), |_| true)
        .await;
    assert_eq!(refused.unwrap_err().kind, ErrorKind::NotFound);
    let space = core.state.open_space("kind-test").id;
    let refused = core
        .logs_open("main", logs(&space, "", "services"), |_| true)
        .await;
    assert_eq!(refused.unwrap_err().kind, ErrorKind::InvalidInput);
    let deployment = core
        .logs_open("main", logs(&space, "apps", "deployments"), |_| true)
        .await;
    assert!(deployment.is_ok(), "{deployment:?}");
}

/// A running core over the kubeconfig `text`, whose cluster nothing listens
/// on, so a request that reaches the network fails as unavailable.
fn running(dir: &Path, text: &str) -> Arc<Core> {
    let kubeconfig = dir.join("config");
    std::fs::write(&kubeconfig, text).unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let (_status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter([]))));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.run(followed, Some(kubeconfig)).await }
    });
    core
}

const UNREACHABLE: &str = "
clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]
users: [{ name: u, user: {} }]
contexts:
- name: kind-local
  context:
    cluster: c
    user: u
    extensions: [{ name: twigo, extension: { environment: local } }]
- name: kind-unmarked
  context: { cluster: c, user: u }
- name: kind-locked
  context:
    cluster: c
    user: u
    extensions: [{ name: twigo, extension: { readOnly: true } }]
- name: kind-prod
  context:
    cluster: c
    user: u
    extensions: [{ name: twigo, extension: { environment: production } }]
";

async fn create_a_configmap(core: &Core, context: &str) -> IpcError {
    let clients = core.clients(context).await.unwrap();
    let request = http::Request::post("/api/v1/namespaces/a/configmaps")
        .body(Vec::new())
        .unwrap();
    let error = clients.api.request_text(request).await.unwrap_err();
    twigo_kube::errors::request(&error)
}

/// Changes a context's protection as the webview does: plans it, types the
/// name where the plan asks, and runs it.
async fn protect(core: &Core, request: PlanRequest) -> Result<(), IpcError> {
    let plan = core.command_plan("main", request).await?;
    let typed = match plan.friction {
        Friction::Typed { text } => Some(text),
        _ => None,
    };
    let execute = Execute {
        plan: plan.id,
        typed,
    };
    core.command_execute("main", execute, |_| true).await
}

fn access(core: &Core, context: &str) -> twigo_ipc::ContextAccess {
    let contexts = core.contexts().unwrap();
    let found = contexts.into_iter().find(|c| c.name == context);
    found.unwrap().access
}

/// Marks kind-local Local, as a person would: its kubeconfig's `local` is
/// no mark.
fn mark_local(core: &Core) {
    core.policy
        .set_environment("kind-local", Some(Environment::Local))
        .unwrap();
}

#[tokio::test]
async fn a_context_s_mode_comes_from_its_kubeconfig_and_reaches_its_clients() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;

    assert_eq!(access(&core, "kind-locked").mode, Mode::ReadOnly);
    assert_eq!(access(&core, "kind-locked").source, ModeSource::Kubeconfig);
    let prod = access(&core, "kind-prod");
    assert_eq!(prod.mode, Mode::ReadOnly);
    assert_eq!(prod.environment, Some(Environment::Production));

    for context in ["kind-unmarked", "kind-local"] {
        let unmarked = access(&core, context);
        assert_eq!(unmarked.mode, Mode::Guarded, "{context}");
        assert_eq!(unmarked.source, ModeSource::Unmarked, "{context}");
        assert_eq!(unmarked.environment, None, "{context}");
        let blocked = create_a_configmap(&core, context).await;
        assert_eq!(blocked.blocked.unwrap().reason, BlockReason::Unmarked);
    }
    for context in ["kind-locked", "kind-prod"] {
        let blocked = create_a_configmap(&core, context).await;
        assert_eq!(blocked.kind, ErrorKind::Permissions, "{context}");
    }

    mark_local(&core);
    let open = create_a_configmap(&core, "kind-local").await;
    assert_eq!(open.kind, ErrorKind::Unavailable, "it reached the network");
}

#[tokio::test]
async fn an_edit_of_a_kubeconfig_only_tightens_and_the_log_records_what_it_changed() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;
    let mut contexts = core.catalog.subscribe();
    contexts.borrow_and_update();
    let edited = UNREACHABLE
        .replace("environment: production", "environment: development")
        .replace(
            "- name: kind-unmarked\n  context: { cluster: c, user: u }",
            "- name: kind-unmarked\n  context: { cluster: c, user: u, extensions: [{ name: twigo, extension: { environment: development } }] }",
        );
    assert_eq!(edited.matches("environment: development").count(), 2);
    std::fs::write(dir.path().join("config"), edited).unwrap();
    tokio::time::timeout(Duration::from_secs(5), contexts.changed())
        .await
        .expect("the catalog reads the edit")
        .unwrap();

    for context in ["kind-prod", "kind-unmarked"] {
        let unmarked = access(&core, context);
        assert_eq!(unmarked.mode, Mode::Guarded, "{context}");
        assert_eq!(unmarked.source, ModeSource::Unmarked, "{context}");
        assert_eq!(unmarked.environment, None, "{context}");
        let blocked = create_a_configmap(&core, context).await;
        assert_eq!(blocked.blocked.unwrap().reason, BlockReason::Unmarked);
    }
    protect(
        &core,
        PlanRequest::SetMode {
            context: "kind-prod".to_owned(),
            mode: Some(Mode::ReadOnly),
        },
    )
    .await
    .unwrap();

    let logged = std::fs::read_to_string(dir.path().join("audit.jsonl")).unwrap();
    let lines: Vec<serde_json::Value> = logged
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|line: &serde_json::Value| line["event"] != "request")
        .collect();
    assert_eq!(lines.len(), 2, "{logged}");
    let edit = &lines[0];
    assert_eq!(edit["event"], "catalog");
    assert_eq!(edit["context"], "kind-prod");
    assert_eq!(edit["before"]["mode"], "read-only");
    assert_eq!(
        edit["before"]["source"],
        serde_json::json!({ "kind": "environment", "environment": "production" })
    );
    assert_eq!(edit["after"]["mode"], "guarded");
    assert_eq!(edit["after"]["source"]["kind"], "unmarked");
    assert_eq!(lines[1]["event"], "protection");
}

#[tokio::test]
async fn a_person_s_choice_changes_clients_already_built_and_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;
    mark_local(&core);
    let mut changes = core.policy.changes();

    let open = create_a_configmap(&core, "kind-local").await;
    assert_eq!(open.kind, ErrorKind::Unavailable);

    protect(
        &core,
        PlanRequest::SetMode {
            context: "kind-local".to_owned(),
            mode: Some(Mode::ReadOnly),
        },
    )
    .await
    .unwrap();
    assert!(changes.has_changed().unwrap());
    changes.borrow_and_update();
    let blocked = create_a_configmap(&core, "kind-local").await;
    assert_eq!(blocked.kind, ErrorKind::Permissions);
    let user = ModeSource::User { overrides: None };
    assert_eq!(blocked.blocked.unwrap().source, user);

    protect(
        &core,
        PlanRequest::SetEnvironment {
            context: "kind-locked".to_owned(),
            environment: Some(Environment::Staging),
        },
    )
    .await
    .unwrap();
    assert!(changes.has_changed().unwrap());

    core.state.flush().unwrap();
    let reopened = running(dir.path(), UNREACHABLE);
    reopened.catalog.contexts().await;
    assert_eq!(access(&reopened, "kind-local").mode, Mode::ReadOnly);
    assert_eq!(access(&reopened, "kind-local").source, user);
    assert_eq!(
        access(&reopened, "kind-locked").environment,
        Some(Environment::Staging)
    );
}

#[tokio::test]
async fn an_unlock_does_not_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;
    protect(
        &core,
        PlanRequest::Unlock {
            context: "kind-locked".to_owned(),
        },
    )
    .await
    .unwrap();
    assert_eq!(access(&core, "kind-locked").mode, Mode::Guarded);
    let through = create_a_configmap(&core, "kind-locked").await;
    assert_eq!(through.kind, ErrorKind::Unavailable);

    core.state.flush().unwrap();
    let reopened = running(dir.path(), UNREACHABLE);
    reopened.catalog.contexts().await;
    assert_eq!(access(&reopened, "kind-locked").mode, Mode::ReadOnly);
}

#[tokio::test]
async fn a_policy_file_entry_refuses_a_mode_and_an_unlock_and_holds_its_mode_under_a_type() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        r#"{"contexts": {"kind-local": "read-only"}}"#,
    )
    .unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;

    let context = || "kind-local".to_owned();
    for request in [
        PlanRequest::SetMode {
            context: context(),
            mode: Some(Mode::ReadWrite),
        },
        PlanRequest::Unlock { context: context() },
    ] {
        let refused = core.command_plan("main", request).await.unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Permissions);
    }
    let development = PlanRequest::SetEnvironment {
        context: context(),
        environment: Some(Environment::Development),
    };
    protect(&core, development).await.unwrap();
    let named = access(&core, "kind-local");
    assert_eq!(named.environment, Some(Environment::Development));
    assert_eq!(named.mode, Mode::ReadOnly);

    assert!(matches!(
        access(&core, "kind-local").source,
        ModeSource::PolicyFile {
            pattern: Some(_),
            ..
        }
    ));
    let blocked = create_a_configmap(&core, "kind-local").await;
    assert_eq!(blocked.kind, ErrorKind::Permissions);
}

#[tokio::test]
async fn under_a_policy_file_a_type_asks_as_it_would_with_no_lock_but_itself() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        r#"{"contexts": {"kind-*": "read-only"}}"#,
    )
    .unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;
    let typed = |context: &str| Friction::Typed {
        text: context.to_owned(),
    };
    let file = dir.path().join("policy.json").display().to_string();
    let gives = |then: &str| Some(format!("When {file} no longer sets its mode{then}."));
    let read_write = gives(", it will be read-write");
    let cases = [
        (
            "kind-local",
            Environment::Staging,
            Friction::AtOnce,
            gives(", it will be guarded"),
        ),
        (
            "kind-local",
            Environment::Development,
            typed("kind-local"),
            read_write.clone(),
        ),
        (
            "kind-prod",
            Environment::Development,
            typed("kind-prod"),
            read_write,
        ),
        (
            "kind-locked",
            Environment::Development,
            typed("kind-locked"),
            gives(" and its kubeconfig's lock goes, it will be read-write"),
        ),
        (
            "kind-unmarked",
            Environment::Production,
            Friction::AtOnce,
            None,
        ),
    ];
    for (context, environment, friction, then) in cases {
        let request = PlanRequest::SetEnvironment {
            context: context.to_owned(),
            environment: Some(environment),
        };
        let plan = core.command_plan("main", request).await.unwrap();
        assert_eq!(plan.friction, friction, "{context} as {environment:?}");
        assert_eq!(plan.consequences.get(1), then.as_ref(), "{context}");
        let typed = match plan.friction {
            Friction::Typed { text } => Some(text),
            _ => None,
        };
        let execute = Execute {
            plan: plan.id,
            typed,
        };
        core.command_execute("main", execute, |_| true)
            .await
            .unwrap();
        let named = access(&core, context);
        assert_eq!(named.environment, Some(environment), "{context}");
        assert_eq!(named.mode, Mode::ReadOnly, "{context}");
    }
}

#[tokio::test]
async fn a_type_under_a_kubeconfig_s_lock_asks_as_what_it_gives_once_the_lock_goes() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;
    let development = PlanRequest::SetEnvironment {
        context: "kind-locked".to_owned(),
        environment: Some(Environment::Development),
    };
    let plan = core.command_plan("main", development).await.unwrap();
    let typed = Friction::Typed {
        text: "kind-locked".to_owned(),
    };
    assert_eq!(plan.friction, typed);
    assert_eq!(
        plan.consequences,
        [
            "It stays read-only as its kubeconfig says.",
            "When its kubeconfig's lock goes, it will be read-write.",
        ]
    );
    let execute = Execute {
        plan: plan.id,
        typed: Some("kind-locked".to_owned()),
    };
    core.command_execute("main", execute, |_| true)
        .await
        .unwrap();
    assert_eq!(access(&core, "kind-locked").mode, Mode::ReadOnly);

    let mut contexts = core.catalog.subscribe();
    contexts.borrow_and_update();
    let unlocked = UNREACHABLE.replace(
        "\n    extensions: [{ name: twigo, extension: { readOnly: true } }]",
        "",
    );
    assert_ne!(unlocked, UNREACHABLE);
    std::fs::write(dir.path().join("config"), unlocked).unwrap();
    tokio::time::timeout(Duration::from_secs(5), contexts.changed())
        .await
        .expect("the catalog reads the edit")
        .unwrap();
    let lifted = access(&core, "kind-locked");
    assert_eq!(lifted.mode, Mode::ReadWrite);
    assert_eq!(lifted.environment, Some(Environment::Development));
}

#[tokio::test]
async fn commands_refuse_a_context_no_source_lists() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    for request in [
        PlanRequest::SetMode {
            context: "kind-absent".to_owned(),
            mode: Some(Mode::ReadOnly),
        },
        PlanRequest::Unlock {
            context: "kind-absent".to_owned(),
        },
    ] {
        let absent = core.command_plan("main", request).await.unwrap_err();
        assert_eq!(absent.kind, ErrorKind::NotFound);
    }
}

#[tokio::test]
async fn clients_already_built_stop_writing_once_no_source_lists_their_context() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;
    mark_local(&core);
    let clients = core.clients("kind-local").await.unwrap();
    let write = || {
        http::Request::post("/api/v1/namespaces/a/configmaps")
            .body(Vec::new())
            .unwrap()
    };
    let open = clients.api.request_text(write()).await.unwrap_err();
    assert_eq!(
        twigo_kube::errors::request(&open).kind,
        ErrorKind::Unavailable
    );

    std::fs::write(
        dir.path().join("config"),
        "
clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]
users: [{ name: u, user: {} }]
contexts: [{ name: kind-other, context: { cluster: c, user: u } }]
",
    )
    .unwrap();
    names(&core, &["kind-other"]).await;

    let error = clients.api.request_text(write()).await.unwrap_err();
    let error = twigo_kube::errors::request(&error);
    assert_eq!(error.kind, ErrorKind::Permissions);
    assert_eq!(error.blocked.unwrap().source, ModeSource::Unlisted);
}

#[tokio::test]
async fn a_wake_retires_the_connections_and_a_network_change_that_moved_no_route_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;
    let clients = core.clients("kind-local").await.unwrap();
    let (retired, network) = (
        clients.connections().retired(),
        clients.connections().network(),
    );

    core.network_event(Event::NetworkChanged);
    assert!(!retired.has_changed().unwrap());
    assert!(!network.has_changed().unwrap());

    core.network_event(Event::Woke);
    assert!(retired.has_changed().unwrap());
    assert!(network.has_changed().unwrap());
}

#[tokio::test]
async fn an_unlock_holds_only_for_the_cluster_it_was_given_on() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;
    protect(
        &core,
        PlanRequest::Unlock {
            context: "kind-locked".to_owned(),
        },
    )
    .await
    .unwrap();
    assert_eq!(access(&core, "kind-locked").mode, Mode::Guarded);

    let mut contexts = core.catalog.subscribe();
    contexts.borrow_and_update();
    std::fs::write(
        dir.path().join("config"),
        UNREACHABLE.replace("127.0.0.1:1", "127.0.0.1:2"),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), contexts.changed())
        .await
        .expect("the catalog reads the new server")
        .unwrap();
    let moved = access(&core, "kind-locked");
    assert_eq!(moved.mode, Mode::ReadOnly);
    assert_eq!(moved.unlocked_until, None);
}

#[tokio::test]
async fn clients_built_for_one_cluster_write_nothing_once_their_name_means_another() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path(), UNREACHABLE);
    core.catalog.contexts().await;
    mark_local(&core);
    let clients = core.clients("kind-local").await.unwrap();
    let write = || {
        http::Request::post("/api/v1/namespaces/a/configmaps")
            .body(Vec::new())
            .unwrap()
    };
    let open = clients.api.request_text(write()).await.unwrap_err();
    assert_eq!(
        twigo_kube::errors::request(&open).kind,
        ErrorKind::Unavailable
    );

    let mut contexts = core.catalog.subscribe();
    contexts.borrow_and_update();
    std::fs::write(
        dir.path().join("config"),
        UNREACHABLE.replace("127.0.0.1:1", "127.0.0.1:2"),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), contexts.changed())
        .await
        .expect("the catalog reads the new server")
        .unwrap();

    let held = clients.api.request_text(write()).await.unwrap_err();
    let held = twigo_kube::errors::request(&held);
    assert_eq!(held.kind, ErrorKind::Permissions);
    assert_eq!(held.blocked.unwrap().source, ModeSource::Moved);

    let rebuilt = create_a_configmap(&core, "kind-local").await;
    assert_eq!(
        rebuilt.kind,
        ErrorKind::Unavailable,
        "the new one's own mode"
    );
}
