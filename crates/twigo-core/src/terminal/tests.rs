use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    AnswerKubeconfigOffer, ErrorKind, KubeconfigOffer, KubeconfigOfferAnswer, KubeconfigOfferEvent,
    Mode, NewTerminal, OpenShell, ProxyWhy, SetContextMode, ShellAck, ShellEnd, ShellEvent,
    SubscriptionId, TerminalKind,
};
use twigo_policy::{Audit, Choices, Metadata, Policy, PolicyFile};

use super::kind;
use crate::{Core, ShellFrame};

const WAIT: Duration = Duration::from_secs(10);

const MINE: &str = "# mine
apiVersion: v1
kind: Config
clusters:
- name: kind-a
  cluster:
    server: https://127.0.0.1:6443
users:
- name: kind-a
  user:
    token: secret
contexts:
- name: kind-a
  context:
    cluster: kind-a
    user: kind-a
    namespace: apps
- name: kind-b
  context:
    cluster: kind-a
    user: kind-a
current-context: kind-b
";

const EKS: &str = "apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://eks.example
    certificate-authority: ca.pem
  name: arn:aws:eks:eu-west-1:1:cluster/new
- cluster:
    server: https://127.0.0.1:6443
  name: kind-a
contexts:
- context:
    cluster: arn:aws:eks:eu-west-1:1:cluster/new
    user: arn:aws:eks:eu-west-1:1:cluster/new
  name: arn:aws:eks:eu-west-1:1:cluster/new
- context:
    cluster: kind-a
    user: kind-a
  name: kind-a
current-context: arn:aws:eks:eu-west-1:1:cluster/new
users:
- name: arn:aws:eks:eu-west-1:1:cluster/new
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args:
      - eks
      - get-token
";

const ARN: &str = "arn:aws:eks:eu-west-1:1:cluster/new";

struct Setup {
    dir: tempfile::TempDir,
    core: Arc<Core>,
    _status: watch::Sender<Status>,
}

impl Setup {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".kube")).unwrap();
        std::fs::write(home.join(".kube").join("config"), MINE).unwrap();
        std::fs::create_dir_all(dir.path().join("data").join("terminals").join("stale")).unwrap();
        let data = dir.path().join("data");
        let core = Core::new(
            &data,
            &dir.path().join("cache"),
            &dir.path().join("policy.json"),
        );
        let env: ShellEnv = [
            ("HOME", home.as_os_str()),
            ("PATH", "/usr/bin:/bin".as_ref()),
            ("TWIGO_KUBECONFIG", "/elsewhere".as_ref()),
            ("LANG", "C".as_ref()),
        ]
        .into_iter()
        .map(|(name, value)| (OsString::from(name), value.to_owned()))
        .collect();
        let (status, followed) = watch::channel(Status::Resolved(Arc::new(env)));
        tokio::spawn({
            let core = Arc::clone(&core);
            async move { core.run(followed, None).await }
        });
        core.catalog.contexts().await;
        Self {
            dir,
            core,
            _status: status,
        }
    }

    fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    fn mine(&self) -> PathBuf {
        self.home().join(".kube").join("config")
    }

    fn terminals(&self) -> PathBuf {
        self.dir.path().join("data").join("terminals")
    }

    async fn create(&self, context: &str, script: &str) -> twigo_ipc::TerminalSession {
        self.core
            .set_terminal_program(PathBuf::from("/bin/sh"), vec!["-c".into(), script.into()]);
        self.core
            .terminal_create(
                "main",
                NewTerminal {
                    context: context.to_owned(),
                    label: "Terminal 1".to_owned(),
                },
            )
            .await
            .unwrap()
    }

    async fn run(&self, id: SubscriptionId) -> (String, ShellEnd) {
        let (frames, mut received) = mpsc::unbounded_channel();
        self.core
            .shell_open(
                "main",
                OpenShell {
                    id,
                    cols: 80,
                    rows: 24,
                },
                move |frame| frames.send(frame).is_ok(),
            )
            .await
            .unwrap();
        let mut output = Vec::new();
        loop {
            let frame = tokio::time::timeout(WAIT, received.recv())
                .await
                .expect("a frame within 10 s")
                .expect("frames until the end");
            match frame {
                ShellFrame::Output(bytes) => {
                    let acked = ShellAck {
                        id,
                        bytes: bytes.len() as u32,
                    };
                    self.core.shell_ack("main", acked).unwrap();
                    output.extend(bytes);
                }
                ShellFrame::Event(ShellEvent::Ended { end }) => {
                    let output = String::from_utf8_lossy(&output).replace("\r\n", "\n");
                    return (output, end);
                }
                ShellFrame::Event(_) => {}
            }
        }
    }

    fn follow(
        &self,
    ) -> (
        Vec<KubeconfigOffer>,
        mpsc::UnboundedReceiver<KubeconfigOfferEvent>,
    ) {
        let (events, received) = mpsc::unbounded_channel();
        let waiting = self
            .core
            .follow_kubeconfig_offers("main", move |event| events.send(event).is_ok());
        (waiting, received)
    }

    async fn answer(&self, offer: &KubeconfigOffer, answer: KubeconfigOfferAnswer) {
        let id = offer.id;
        self.core
            .answer_kubeconfig_offer("main", AnswerKubeconfigOffer { id, answer })
            .await
            .unwrap();
    }
}

async fn next(events: &mut mpsc::UnboundedReceiver<KubeconfigOfferEvent>) -> KubeconfigOfferEvent {
    tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("an offer's event within 10 s")
        .expect("events while followed")
}

async fn offered(events: &mut mpsc::UnboundedReceiver<KubeconfigOfferEvent>) -> KubeconfigOffer {
    match next(events).await {
        KubeconfigOfferEvent::Offered { offer } => offer,
        event => panic!("{event:?}"),
    }
}

async fn nothing_more(events: &mut mpsc::UnboundedReceiver<KubeconfigOfferEvent>) {
    let more = tokio::time::timeout(Duration::from_secs(1), events.recv()).await;
    assert!(more.is_err(), "{more:?}");
}

fn quoted(path: &Path) -> String {
    format!("'{}'", path.display())
}

#[test]
fn a_terminal_goes_through_the_proxy_where_the_policy_file_or_the_mode_says() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("policy.json");
    std::fs::write(&file, r#"{"terminal": {"usePolicyProxy": ["prod-*"]}}"#).unwrap();
    let listed = Metadata {
        read_only: None,
        provider: None,
        environment: None,
        connection: 1,
        revision: 0,
    };
    let policy = Policy::new(
        PolicyFile::read(&file),
        move |_| Some(listed),
        Choices::default(),
        Audit::off(),
    );
    let proxied = |why| TerminalKind::Proxy { why };
    assert_eq!(kind(&policy, "prod-eu"), proxied(ProxyWhy::PolicyFile));
    assert_eq!(kind(&policy, "dev"), TerminalKind::Kubeconfig);
    policy.set_mode("dev", Some(Mode::Guarded)).unwrap();
    assert_eq!(kind(&policy, "dev"), proxied(ProxyWhy::Mode));
    policy.set_mode("dev", Some(Mode::ReadOnly)).unwrap();
    assert_eq!(kind(&policy, "dev"), proxied(ProxyWhy::Mode));
    policy.unlock("dev").unwrap();
    assert_eq!(policy.access("dev").mode, Mode::Guarded);
    assert_eq!(kind(&policy, "dev"), proxied(ProxyWhy::Mode));
}

#[tokio::test]
async fn a_kubeconfig_terminal_has_twigo_s_file_first_and_its_directory_goes_with_it() {
    let setup = Setup::new().await;
    assert!(!setup.terminals().join("stale").exists());
    let session = setup
        .create(
            "kind-a",
            r#"printf '%s|%s|%s|%s|%s|%s|%s\n' "$KUBECONFIG" "$TERM" "$COLORTERM" "$TERM_PROGRAM" "$TWIGO_KUBECONFIG" "$PWD" "$LANG""#,
        )
        .await;
    assert_eq!(session.kind, TerminalKind::Kubeconfig);
    assert_eq!(session.shell, "sh");
    let (output, end) = setup.run(session.id).await;
    assert_eq!(end, ShellEnd::Exited { code: 0 });
    let file = setup.terminals().join("0").join("kubeconfig");
    let printed: Vec<&str> = output.trim_end().split('|').collect();
    let kubeconfig = format!("{}:{}", file.display(), setup.mine().display());
    let home = setup.home().display().to_string();
    assert_eq!(
        printed[..5],
        [
            kubeconfig.as_str(),
            "xterm-256color",
            "truecolor",
            "Twigo",
            ""
        ]
    );
    assert_eq!(
        std::fs::canonicalize(printed[5]).unwrap(),
        std::fs::canonicalize(&home).unwrap()
    );
    assert!(printed[6].ends_with(".UTF-8"), "{}", printed[6]);
    let written = kube::config::Kubeconfig::read_from(&file).unwrap();
    assert_eq!(written.current_context.as_deref(), Some("kind-a"));
    assert!(written.clusters.is_empty() && written.auth_infos.is_empty());
    let entry = written.contexts[0].context.as_ref().unwrap();
    assert_eq!(
        (entry.cluster.as_str(), entry.namespace.as_deref()),
        ("kind-a", Some("apps"))
    );
    setup.core.shell_close("main", session.id).unwrap();
    assert!(!file.parent().unwrap().exists());
}

#[tokio::test]
async fn a_terminal_of_a_guarded_context_has_the_proxy_s_file_alone() {
    let setup = Setup::new().await;
    setup
        .core
        .set_context_mode(SetContextMode {
            context: "kind-b".to_owned(),
            mode: Some(Mode::Guarded),
        })
        .await
        .unwrap();
    let session = setup
        .create(
            "kind-b",
            r#"printf '%s\n' "$KUBECONFIG"; cat "$KUBECONFIG""#,
        )
        .await;
    assert_eq!(
        session.kind,
        TerminalKind::Proxy {
            why: ProxyWhy::Mode
        }
    );
    let (output, _) = setup.run(session.id).await;
    let (path, text) = output.split_once('\n').unwrap();
    assert!(
        path.starts_with(
            &setup
                .dir
                .path()
                .join("data")
                .join("proxy")
                .display()
                .to_string()
        ),
        "{path}"
    );
    let proxied = kube::config::Kubeconfig::from_yaml(text).unwrap();
    assert_eq!(proxied.current_context.as_deref(), Some("kind-b"));
    let server = proxied.clusters[0]
        .cluster
        .as_ref()
        .unwrap()
        .server
        .clone()
        .unwrap();
    assert!(server.starts_with("https://127.0.0.1:"), "{server}");
    setup.core.shell_close("main", session.id).unwrap();
    assert!(!Path::new(path).exists());
}

#[tokio::test]
async fn a_proxy_terminal_s_file_and_tokens_go_when_its_shell_ends() {
    let setup = Setup::new().await;
    setup
        .core
        .set_context_mode(SetContextMode {
            context: "kind-b".to_owned(),
            mode: Some(Mode::Guarded),
        })
        .await
        .unwrap();
    let session = setup
        .create(
            "kind-b",
            r#"printf '%s\n' "$KUBECONFIG"; cat "$KUBECONFIG""#,
        )
        .await;
    let (output, end) = setup.run(session.id).await;
    assert_eq!(end, ShellEnd::Exited { code: 0 });
    let (path, text) = output.split_once('\n').unwrap();
    assert!(!Path::new(path).exists(), "{path} outlived the shell");
    let proxied = kube::config::Kubeconfig::from_yaml(text).unwrap();
    let config = kube::Config::from_custom_kubeconfig(proxied, &Default::default())
        .await
        .unwrap();
    let client = kube::Client::try_from(config).unwrap();
    let answer = kube::Api::<k8s_openapi::api::core::v1::Namespace>::all(client)
        .list(&Default::default())
        .await;
    assert!(
        matches!(&answer, Err(kube::Error::Api(status)) if status.code == 401),
        "{answer:?}"
    );
}

#[tokio::test]
async fn a_terminal_waits_for_the_login_environment_and_takes_its_kind_after() {
    let dir = tempfile::tempdir().unwrap();
    let mine = dir.path().join("config");
    std::fs::write(&mine, MINE).unwrap();
    let core = Core::new(
        &dir.path().join("data"),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let (status, followed) = watch::channel(Status::Resolving);
    tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.run(followed, Some(mine)).await }
    });
    core.catalog.contexts().await;
    core.set_terminal_program(PathBuf::from("/bin/sh"), vec!["-c".into(), "exit".into()]);
    let creating = tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            core.terminal_create(
                "main",
                NewTerminal {
                    context: "kind-a".to_owned(),
                    label: "Terminal 1".to_owned(),
                },
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!creating.is_finished(), "made before the login environment");
    core.set_context_mode(SetContextMode {
        context: "kind-a".to_owned(),
        mode: Some(Mode::Guarded),
    })
    .await
    .unwrap();
    let home = dir.path().join("home");
    let env: ShellEnv = [(OsString::from("HOME"), home.into_os_string())]
        .into_iter()
        .collect();
    status.send(Status::Resolved(Arc::new(env))).unwrap();
    let session = tokio::time::timeout(WAIT, creating)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        session.kind,
        TerminalKind::Proxy {
            why: ProxyWhy::Mode
        }
    );
}

#[tokio::test]
async fn shutdown_hangs_up_every_terminal() {
    let setup = Setup::new().await;
    let mut pids = Vec::new();
    for n in 0..2 {
        let file = setup.dir.path().join(format!("{n}.pid"));
        let session = setup
            .create(
                "kind-a",
                &format!("echo $$ > {}; exec sleep 1000", quoted(&file)),
            )
            .await;
        let open = OpenShell {
            id: session.id,
            cols: 80,
            rows: 24,
        };
        setup.core.shell_open("main", open, |_| true).await.unwrap();
        pids.push(file);
    }
    let mut running = Vec::new();
    for file in pids {
        let pid = tokio::time::timeout(WAIT, async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&file)
                    && !pid.trim().is_empty()
                {
                    return pid.trim().to_owned();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        running.push(pid);
    }
    setup.core.shutdown();
    let alive = |pid: &str| {
        std::process::Command::new("kill")
            .args(["-0", pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    };
    let ended = tokio::time::timeout(Duration::from_secs(2), async {
        while running.iter().any(|pid| alive(pid)) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    for pid in &running {
        let _ = std::process::Command::new("kill")
            .args(["-KILL", pid])
            .status();
    }
    assert!(ended.is_ok(), "a shell outlived the shutdown");
}

#[tokio::test]
async fn a_context_no_source_lists_has_no_terminal() {
    let setup = Setup::new().await;
    let refused = setup
        .core
        .terminal_create(
            "main",
            NewTerminal {
                context: "gone".to_owned(),
                label: "Terminal 1".to_owned(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::NotFound);
}

#[tokio::test]
async fn what_a_tool_writes_in_place_is_offered_once_and_more_comes_in_the_same_offer() {
    let setup = Setup::new().await;
    let (waiting, mut events) = setup.follow();
    assert!(waiting.is_empty());
    let eks = setup.dir.path().join("eks.yaml");
    std::fs::write(&eks, EKS).unwrap();
    let more = setup.dir.path().join("more.yaml");
    std::fs::write(
        &more,
        format!("{EKS}- name: second\n  user:\n    token: t\n"),
    )
    .unwrap();
    let session = setup
        .create(
            "kind-a",
            &format!(
                r#"f="${{KUBECONFIG%%:*}}"; printf 'clusters:\n- name: half\n  cluster: [' > "$f"; sleep 0.3; cat {} > "$f"; sleep 1.5; cat {} > "$f"; sleep 1.5"#,
                quoted(&eks),
                quoted(&more)
            ),
        )
        .await;
    let running = setup.run(session.id);
    let offers = async {
        let first = offered(&mut events).await;
        assert_eq!(first.terminal, "Terminal 1");
        assert_eq!(
            (first.session, first.context.as_str()),
            (session.id, "kind-a")
        );
        assert_eq!(first.clusters, [ARN, "kind-a"]);
        assert_eq!(first.users, [ARN]);
        assert_eq!(first.contexts, [ARN]);
        assert_eq!(first.target, "~/.kube/config");
        assert_eq!(first.taken, ["cluster kind-a"]);
        let second = offered(&mut events).await;
        assert_eq!(second.id, first.id);
        assert_eq!(second.users, [ARN, "second"]);
        second
    };
    let ((_, end), second) = tokio::join!(running, offers);
    assert_eq!(end, ShellEnd::Exited { code: 0 });
    nothing_more(&mut events).await;
    let (waiting, _) = setup.follow();
    assert_eq!(waiting, [second]);
}

#[tokio::test]
async fn a_move_appends_what_the_user_s_files_lack_and_the_catalog_lists_it() {
    let setup = Setup::new().await;
    let (_, mut events) = setup.follow();
    let eks = setup.dir.path().join("eks.yaml");
    std::fs::write(&eks, EKS).unwrap();
    let session = setup
        .create(
            "kind-a",
            &format!(r#"cat {} > "${{KUBECONFIG%%:*}}""#, quoted(&eks)),
        )
        .await;
    setup.run(session.id).await;
    let offer = offered(&mut events).await;
    setup.core.shell_close("main", session.id).unwrap();
    setup.answer(&offer, KubeconfigOfferAnswer::Move).await;
    assert_eq!(
        next(&mut events).await,
        KubeconfigOfferEvent::Withdrawn { id: offer.id }
    );
    let mine = std::fs::read_to_string(setup.mine()).unwrap();
    assert!(
        mine.starts_with("# mine\napiVersion: v1\nkind: Config\nclusters:\n- name: kind-a\n"),
        "{mine}"
    );
    let config = kube::config::Kubeconfig::from_yaml(&mine).unwrap();
    let clusters: Vec<&str> = config.clusters.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(clusters, ["kind-a", ARN]);
    assert_eq!(config.current_context.as_deref(), Some("kind-b"));
    let moved = config.clusters[1].cluster.as_ref().unwrap();
    let base = setup.terminals().join("0");
    assert_eq!(
        moved.certificate_authority.as_deref(),
        Some(base.join("ca.pem").to_str().unwrap())
    );
    let mut contexts = setup.core.catalog.subscribe();
    let listed = tokio::time::timeout(
        WAIT,
        contexts.wait_for(|listed| {
            listed
                .as_ref()
                .is_some_and(|listed| listed.find(ARN).is_some())
        }),
    )
    .await;
    assert!(listed.is_ok(), "the catalog never listed the moved context");
}

#[tokio::test]
async fn a_move_takes_each_entry_as_last_seen_though_the_file_dropped_it_since() {
    let setup = Setup::new().await;
    let (_, mut events) = setup.follow();
    let eks = setup.dir.path().join("eks.yaml");
    std::fs::write(&eks, EKS).unwrap();
    let later = setup.dir.path().join("later.yaml");
    std::fs::write(
        &later,
        "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers:\n- name: later\n  user:\n    token: t\n",
    )
    .unwrap();
    let session = setup
        .create(
            "kind-a",
            &format!(
                r#"f="${{KUBECONFIG%%:*}}"; cat {} > "$f"; sleep 1.5; mv "$f" "$f.backup"; cat {} > "$f"; sleep 1.5"#,
                quoted(&eks),
                quoted(&later)
            ),
        )
        .await;
    let running = setup.run(session.id);
    let offers = async {
        offered(&mut events).await;
        offered(&mut events).await
    };
    let ((_, end), offer) = tokio::join!(running, offers);
    assert_eq!(end, ShellEnd::Exited { code: 0 });
    assert_eq!(offer.users, [ARN, "later"]);
    setup.answer(&offer, KubeconfigOfferAnswer::Move).await;
    let mine = kube::config::Kubeconfig::from_yaml(&std::fs::read_to_string(setup.mine()).unwrap())
        .unwrap();
    let names = |names: Vec<&str>| names.into_iter().map(str::to_owned).collect::<Vec<_>>();
    assert_eq!(
        mine.clusters
            .iter()
            .map(|c| c.name.clone())
            .collect::<Vec<_>>(),
        names(vec!["kind-a", ARN])
    );
    assert_eq!(
        mine.auth_infos
            .iter()
            .map(|u| u.name.clone())
            .collect::<Vec<_>>(),
        names(vec!["kind-a", ARN, "later"])
    );
    assert_eq!(
        mine.contexts
            .iter()
            .map(|c| c.name.clone())
            .collect::<Vec<_>>(),
        names(vec!["kind-a", "kind-b", ARN])
    );
}

#[tokio::test]
async fn names_are_taken_by_section_and_a_context_moves_only_with_what_it_names() {
    let setup = Setup::new().await;
    let (_, mut events) = setup.follow();
    let written = setup.dir.path().join("written.yaml");
    std::fs::write(
        &written,
        "apiVersion: v1
kind: Config
clusters:
- name: own
  cluster:
    server: https://own.example
- name: kind-a
  cluster:
    server: https://other.example
users:
- name: own
  user:
    token: t
contexts:
- name: kind-b-new
  context:
    cluster: kind-a
    user: own
- name: ns
  context:
    cluster: kind-a
    user: kind-a
    namespace: ns
- name: dangling
  context:
    cluster: nowhere
    user: kind-a
- name: proper
  context:
    cluster: own
    user: own
",
    )
    .unwrap();
    let session = setup
        .create(
            "kind-a",
            &format!(r#"cat {} > "${{KUBECONFIG%%:*}}""#, quoted(&written)),
        )
        .await;
    setup.run(session.id).await;
    let offer = offered(&mut events).await;
    assert_eq!(
        offer.taken,
        [
            "context dangling",
            "context kind-b-new",
            "context ns",
            "cluster kind-a"
        ]
    );
    setup.answer(&offer, KubeconfigOfferAnswer::Move).await;
    let mine = kube::config::Kubeconfig::from_yaml(&std::fs::read_to_string(setup.mine()).unwrap())
        .unwrap();
    let names = |names: Vec<String>| names.join(" ");
    assert_eq!(
        names(mine.clusters.iter().map(|c| c.name.clone()).collect()),
        "kind-a own"
    );
    assert_eq!(
        names(mine.auth_infos.iter().map(|u| u.name.clone()).collect()),
        "kind-a own"
    );
    assert_eq!(
        names(mine.contexts.iter().map(|c| c.name.clone()).collect()),
        "kind-a kind-b proper"
    );
}

#[tokio::test]
async fn a_dismissed_offer_is_not_made_again_and_only_new_names_come_after() {
    let setup = Setup::new().await;
    let (_, mut events) = setup.follow();
    let eks = setup.dir.path().join("eks.yaml");
    std::fs::write(&eks, EKS).unwrap();
    let renamed = setup.dir.path().join("renamed.yaml");
    std::fs::write(
        &renamed,
        format!("{EKS}- name: later\n  user:\n    token: t\n"),
    )
    .unwrap();
    let go = setup.dir.path().join("go");
    let session = setup
        .create(
            "kind-a",
            &format!(
                r#"f="${{KUBECONFIG%%:*}}"; cat {} > "$f"; while [ ! -e {} ]; do sleep 0.1; done; mv "$f" "$f.backup"; cat {} > "$f.new"; mv "$f.new" "$f"; sleep 1.5"#,
                quoted(&eks),
                quoted(&go),
                quoted(&renamed)
            ),
        )
        .await;
    let running = setup.run(session.id);
    let offers = async {
        let offer = offered(&mut events).await;
        setup.answer(&offer, KubeconfigOfferAnswer::Dismiss).await;
        assert_eq!(
            next(&mut events).await,
            KubeconfigOfferEvent::Withdrawn { id: offer.id }
        );
        std::fs::write(&go, "").unwrap();
        let later = offered(&mut events).await;
        assert_ne!(later.id, offer.id);
        assert_eq!((later.clusters.len(), later.contexts.len()), (0, 0));
        assert_eq!(later.users, ["later"]);
    };
    tokio::join!(running, offers);
    nothing_more(&mut events).await;
    assert_eq!(std::fs::read_to_string(setup.mine()).unwrap(), MINE);
}

#[tokio::test]
async fn offers_outlive_their_terminal_and_end_with_their_window() {
    let setup = Setup::new().await;
    let (_, mut events) = setup.follow();
    let eks = setup.dir.path().join("eks.yaml");
    std::fs::write(&eks, EKS).unwrap();
    let session = setup
        .create(
            "kind-a",
            &format!(r#"cat {} > "${{KUBECONFIG%%:*}}""#, quoted(&eks)),
        )
        .await;
    setup.run(session.id).await;
    let offer = offered(&mut events).await;
    setup.core.shell_close("main", session.id).unwrap();
    let elsewhere = setup
        .core
        .answer_kubeconfig_offer(
            "other",
            AnswerKubeconfigOffer {
                id: offer.id,
                answer: KubeconfigOfferAnswer::Dismiss,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(elsewhere.kind, ErrorKind::Forbidden);
    let (waiting, mut followed) = setup.follow();
    assert_eq!(waiting, std::slice::from_ref(&offer));
    setup.core.drop_window("main");
    assert_eq!(
        next(&mut followed).await,
        KubeconfigOfferEvent::Withdrawn { id: offer.id }
    );
    let (waiting, _) = setup.follow();
    assert!(waiting.is_empty());
    let gone = setup
        .core
        .answer_kubeconfig_offer(
            "main",
            AnswerKubeconfigOffer {
                id: offer.id,
                answer: KubeconfigOfferAnswer::Move,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(gone.kind, ErrorKind::NotFound);
}
