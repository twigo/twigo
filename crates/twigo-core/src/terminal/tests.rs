use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    AnswerKubeconfigOffer, ErrorKind, KubeconfigNames, KubeconfigOffer, KubeconfigOfferAnswer,
    KubeconfigOfferEvent, Mode, NewTerminal, OpenShell, ProxyWhy, SetContextMode, ShellAck,
    ShellEnd, ShellEvent, ShellInput, SubscriptionId, TerminalKind,
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
        Self::with_login(|_| Vec::new()).await
    }

    async fn with_login(login: impl FnOnce(&Path) -> Vec<(&'static str, OsString)>) -> Self {
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
            ("HOME", home.clone().into_os_string()),
            ("PATH", "/usr/bin:/bin".into()),
            ("TWIGO_KUBECONFIG", "/elsewhere".into()),
            ("LANG", "C".into()),
        ]
        .into_iter()
        .chain(login(&home))
        .map(|(name, value)| (OsString::from(name), value))
        .collect();
        core.set_terminal_zdotdir(None);
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
        self.create_running(context, "/bin/sh", &["-c", script])
            .await
    }

    async fn create_running(
        &self,
        context: &str,
        program: &str,
        args: &[&str],
    ) -> twigo_ipc::TerminalSession {
        let args = args.iter().map(OsString::from).collect();
        self.core.set_terminal_program(PathBuf::from(program), args);
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
        self.run_typed(id, "").await
    }

    async fn run_typed(&self, id: SubscriptionId, typed: &str) -> (String, ShellEnd) {
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
        if !typed.is_empty() {
            let data = typed.as_bytes().to_vec();
            self.core
                .shell_input("main", ShellInput { id, data })
                .await
                .unwrap();
        }
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
        let (id, revision) = (offer.id, offer.revision);
        self.core
            .answer_kubeconfig_offer(
                "main",
                AnswerKubeconfigOffer {
                    id,
                    revision,
                    answer,
                },
            )
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
        KubeconfigOfferEvent::Offered { offer } => *offer,
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
async fn only_zsh_bash_fish_and_pwsh_keep_the_terminal_s_kubeconfig() {
    let setup = Setup::new().await;
    for (program, kept) in [
        ("/bin/zsh", true),
        ("/bin/bash", true),
        ("/usr/bin/fish", true),
        ("/usr/bin/pwsh", true),
        ("/bin/sh", false),
        ("/usr/bin/nu", false),
    ] {
        let session = setup.create_running("kind-a", program, &[]).await;
        assert_eq!(session.kubeconfig_kept, kept, "{program}");
        setup.core.shell_close("main", session.id).unwrap();
    }
}

#[tokio::test]
async fn a_zsh_terminal_keeps_its_kubeconfig_over_a_zshrc_that_exports_one() {
    let setup = Setup::new().await;
    std::fs::write(setup.home().join(".zshrc"), "export KUBECONFIG=/theirs\n").unwrap();
    let session = setup.create_running("kind-a", "/bin/zsh", &[]).await;
    let dir = setup.terminals().join("0");
    assert!(dir.join(".zshenv").is_file());
    let out = setup.dir.path().join("out");
    let typed = format!(
        "print -r -- \"$KUBECONFIG|${{+ZDOTDIR}}\" > {}; exit\n",
        quoted(&out)
    );
    let (output, end) = setup.run_typed(session.id, &typed).await;
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    let kubeconfig = format!(
        "{}:{}",
        dir.join("kubeconfig").display(),
        setup.mine().display()
    );
    assert_eq!(
        std::fs::read_to_string(&out).unwrap(),
        format!("{kubeconfig}|0\n"),
        "{output}"
    );
}

#[tokio::test]
async fn zsh_reads_the_zshenv_in_home_that_moves_zdotdir_though_the_login_environment_holds_it() {
    let setup = Setup::with_login(|home| {
        vec![("ZDOTDIR", home.join(".config").join("zsh").into_os_string())]
    })
    .await;
    let config = setup.home().join(".config").join("zsh");
    std::fs::create_dir_all(&config).unwrap();
    let ran = setup.dir.path().join("ran");
    let record = |name: &str| format!("echo {name} >> {}\n", quoted(&ran));
    std::fs::write(
        setup.home().join(".zshenv"),
        format!(
            "{}export ZDOTDIR=$HOME/.config/zsh\n",
            record("home/.zshenv")
        ),
    )
    .unwrap();
    std::fs::write(config.join(".zshenv"), record("zdotdir/.zshenv")).unwrap();
    std::fs::write(
        config.join(".zshrc"),
        format!("{}export KUBECONFIG=/theirs\n", record("zdotdir/.zshrc")),
    )
    .unwrap();
    let session = setup.create_running("kind-a", "/bin/zsh", &[]).await;
    let out = setup.dir.path().join("out");
    let typed = format!(
        "print -r -- \"$KUBECONFIG|${{ZDOTDIR-}}\" > {}; exit\n",
        quoted(&out)
    );
    let (output, end) = setup.run_typed(session.id, &typed).await;
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    assert_eq!(
        std::fs::read_to_string(&ran).unwrap(),
        "home/.zshenv\nzdotdir/.zshrc\n",
        "{output}"
    );
    let kubeconfig = format!(
        "{}:{}",
        setup.terminals().join("0").join("kubeconfig").display(),
        setup.mine().display()
    );
    assert_eq!(
        std::fs::read_to_string(&out).unwrap(),
        format!("{kubeconfig}|{}\n", config.display()),
        "{output}"
    );
}

#[tokio::test]
async fn a_proxy_terminal_keeps_the_proxy_s_file_over_a_bashrc_and_its_directory_goes_with_its_tab()
{
    let setup = Setup::new().await;
    setup
        .core
        .set_context_mode(SetContextMode {
            context: "kind-b".to_owned(),
            mode: Some(Mode::Guarded),
        })
        .await
        .unwrap();
    std::fs::write(setup.home().join(".bashrc"), "export KUBECONFIG=/theirs\n").unwrap();
    let session = setup.create_running("kind-b", "/bin/bash", &[]).await;
    let dir = setup.terminals().join("0");
    assert!(dir.join("bashrc").is_file());
    let out = setup.dir.path().join("out");
    let typed = format!("printf '%s\\n' \"$KUBECONFIG\" > {}; exit\n", quoted(&out));
    let (output, end) = setup.run_typed(session.id, &typed).await;
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    let kubeconfig = std::fs::read_to_string(&out).unwrap();
    assert!(
        kubeconfig.starts_with(
            &setup
                .dir
                .path()
                .join("data")
                .join("proxy")
                .display()
                .to_string()
        ),
        "{kubeconfig}: {output}"
    );
    assert!(dir.exists(), "gone with the shell");
    setup.core.shell_close("main", session.id).unwrap();
    assert!(!dir.exists());
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
        assert_eq!(
            first.left_out,
            KubeconfigNames {
                clusters: vec!["kind-a".to_owned()],
                ..KubeconfigNames::default()
            }
        );
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
        offer.left_out,
        KubeconfigNames {
            contexts: ["dangling", "kind-b-new", "ns"].map(str::to_owned).into(),
            clusters: vec!["kind-a".to_owned()],
            users: Vec::new(),
        }
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
                revision: offer.revision,
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
                revision: offer.revision,
                answer: KubeconfigOfferAnswer::Move,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(gone.kind, ErrorKind::NotFound);
}

const TWO: &str = "apiVersion: v1
kind: Config
clusters:
- name: b
  cluster:
    server: https://b.example
- name: c
  cluster:
    server: https://c.example
users:
- name: b
  user:
    token: b
- name: c
  user:
    token: c
contexts:
- name: prod
  context:
    cluster: b
    user: b
- name: other
  context:
    cluster: c
    user: c
";

fn mine_with(contexts: &[&str]) -> String {
    let added: String = contexts
        .iter()
        .map(|name| format!("- name: {name}\n  context:\n    cluster: kind-a\n    user: kind-a\n"))
        .collect();
    MINE.replace("current-context:", &format!("{added}current-context:"))
}

fn names(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

#[tokio::test]
async fn an_offer_is_made_anew_as_the_person_s_files_change_and_goes_while_it_would_move_nothing() {
    let setup = Setup::new().await;
    let (_, mut events) = setup.follow();
    let two = setup.dir.path().join("two.yaml");
    std::fs::write(&two, TWO).unwrap();
    let session = setup
        .create(
            "kind-a",
            &format!(r#"cat {} > "${{KUBECONFIG%%:*}}""#, quoted(&two)),
        )
        .await;
    setup.run(session.id).await;
    let first = offered(&mut events).await;
    assert_eq!(first.left_out, KubeconfigNames::default());
    std::fs::write(setup.mine(), mine_with(&["prod"])).unwrap();
    let renewed = offered(&mut events).await;
    assert_eq!(renewed.id, first.id);
    let prod = KubeconfigNames {
        contexts: names(&["prod"]),
        clusters: names(&["b"]),
        users: names(&["b"]),
    };
    assert_eq!(renewed.left_out, prod);
    std::fs::write(setup.mine(), mine_with(&["prod", "other"])).unwrap();
    assert_eq!(
        next(&mut events).await,
        KubeconfigOfferEvent::Withdrawn { id: first.id }
    );
    let (waiting, mut events) = setup.follow();
    assert!(waiting.is_empty());
    std::fs::write(setup.mine(), mine_with(&["prod"])).unwrap();
    let back = offered(&mut events).await;
    assert_eq!((back.id, &back.left_out), (first.id, &prod));
    setup.answer(&back, KubeconfigOfferAnswer::Move).await;
    let mine = kube::config::Kubeconfig::from_yaml(&std::fs::read_to_string(setup.mine()).unwrap())
        .unwrap();
    let listed = |names: Vec<String>| names.join(" ");
    assert_eq!(
        listed(mine.clusters.iter().map(|c| c.name.clone()).collect()),
        "kind-a c"
    );
    assert_eq!(
        listed(mine.auth_infos.iter().map(|u| u.name.clone()).collect()),
        "kind-a c"
    );
    assert_eq!(
        listed(mine.contexts.iter().map(|c| c.name.clone()).collect()),
        "kind-a kind-b prod other"
    );
}

#[tokio::test]
async fn an_offered_entry_rewritten_in_place_makes_the_offer_anew() {
    let setup = Setup::new().await;
    let (_, mut events) = setup.follow();
    let text = "apiVersion: v1
kind: Config
clusters:
- name: own
  cluster:
    server: https://own.example
users:
- name: kind-a
  user:
    token: secret
- name: mine
  user:
    token: m
contexts:
- name: c
  context:
    cluster: own
    user: kind-a
- name: d
  context:
    cluster: own
    user: mine
";
    let first = setup.dir.path().join("first.yaml");
    std::fs::write(&first, text).unwrap();
    let rotated = setup.dir.path().join("rotated.yaml");
    std::fs::write(&rotated, text.replace("token: secret", "token: rotated")).unwrap();
    let session = setup
        .create(
            "kind-a",
            &format!(
                r#"f="${{KUBECONFIG%%:*}}"; cat {} > "$f"; sleep 1.5; cat {} > "$f"; sleep 1.5"#,
                quoted(&first),
                quoted(&rotated)
            ),
        )
        .await;
    let running = setup.run(session.id);
    let offers = async {
        let first = offered(&mut events).await;
        assert_eq!(
            first.left_out,
            KubeconfigNames {
                users: names(&["kind-a"]),
                ..KubeconfigNames::default()
            }
        );
        let renewed = offered(&mut events).await;
        assert_eq!(renewed.id, first.id);
        assert_eq!(
            renewed.left_out,
            KubeconfigNames {
                contexts: names(&["c"]),
                clusters: Vec::new(),
                users: names(&["kind-a"]),
            }
        );
    };
    tokio::join!(running, offers);
    nothing_more(&mut events).await;
}

#[tokio::test]
async fn names_the_person_s_files_all_hold_as_they_are_raise_no_offer() {
    let setup = Setup::new().await;
    let (_, mut events) = setup.follow();
    let same = "apiVersion: v1
kind: Config
clusters:
- name: kind-a
  cluster:
    server: https://127.0.0.1:6443
contexts:
- name: kind-b
  context:
    cluster: kind-a
    user: kind-a
current-context: kind-b
users:
- name: kind-a
  user:
    token: secret
";
    let rerun = setup.dir.path().join("rerun.yaml");
    std::fs::write(&rerun, same).unwrap();
    let more = setup.dir.path().join("more.yaml");
    std::fs::write(&more, format!("{same}- name: new\n  user:\n    token: n\n")).unwrap();
    let session = setup
        .create(
            "kind-a",
            &format!(
                r#"f="${{KUBECONFIG%%:*}}"; cat {} > "$f"; sleep 1.5; cat {} > "$f""#,
                quoted(&rerun),
                quoted(&more)
            ),
        )
        .await;
    setup.run(session.id).await;
    let offer = offered(&mut events).await;
    assert_eq!(offer.users, ["kind-a", "new"]);
    assert_eq!(
        offer.left_out,
        KubeconfigNames {
            contexts: names(&["kind-b"]),
            clusters: names(&["kind-a"]),
            users: names(&["kind-a"]),
        }
    );
}

impl Setup {
    async fn guard(&self, context: &str) {
        self.core
            .set_context_mode(SetContextMode {
                context: context.to_owned(),
                mode: Some(Mode::Guarded),
            })
            .await
            .unwrap();
    }

    fn proxied(&self) -> serde_json::Value {
        let dir = self.dir.path().join("data").join("proxy");
        let files: Vec<PathBuf> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "kubeconfig"))
            .collect();
        assert_eq!(files.len(), 1, "{files:?}");
        serde_json::from_str(&std::fs::read_to_string(&files[0]).unwrap()).unwrap()
    }

    fn step(&self, n: usize) -> PathBuf {
        self.dir.path().join(format!("step-{n}"))
    }

    fn writing(&self, steps: usize) -> String {
        (0..steps)
            .map(|n| {
                format!(
                    r#"cat {} > "${{KUBECONFIG%%:*}}"; sleep 1; "#,
                    quoted(&self.step(n))
                )
            })
            .collect::<String>()
            + "true"
    }

    fn steps(&self, steps: &[String]) {
        for (n, step) in steps.iter().enumerate() {
            std::fs::write(self.step(n), step).unwrap();
        }
    }
}

fn with_eks(config: &serde_json::Value) -> serde_json::Value {
    let mut config = config.clone();
    config["clusters"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "name": ARN, "cluster": { "server": "https://eks.example" }
        }));
    config["users"].as_array_mut().unwrap().push(serde_json::json!({
        "name": ARN,
        "user": { "exec": { "apiVersion": "client.authentication.k8s.io/v1beta1", "command": "aws" } }
    }));
    config
}

fn context_mut<'a>(config: &'a mut serde_json::Value, name: &str) -> &'a mut serde_json::Value {
    config["contexts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|context| context["name"] == name)
        .unwrap()
}

async fn directs(
    events: &mut mpsc::UnboundedReceiver<KubeconfigOfferEvent>,
    session: SubscriptionId,
) -> Vec<Vec<String>> {
    let mut told = Vec::new();
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(1), events.recv()).await {
        if let KubeconfigOfferEvent::Direct {
            session: of,
            contexts,
        } = event
        {
            assert_eq!(of, session);
            told.push(contexts);
        }
    }
    told
}

#[tokio::test]
async fn a_tool_s_context_in_a_proxy_terminal_s_file_goes_direct_until_it_is_deleted() {
    let setup = Setup::new().await;
    setup.guard("kind-b").await;
    let (_, mut events) = setup.follow();
    let session = setup.create("kind-b", &setup.writing(3)).await;
    let written = setup.proxied();
    let mut aws = with_eks(&written);
    aws["contexts"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "name": ARN, "context": { "cluster": ARN, "user": ARN }
        }));
    aws["current-context"] = ARN.into();
    let mut namespaced = aws.clone();
    context_mut(&mut namespaced, "kind-b")["context"]["namespace"] = "edited".into();
    let mut deleted = namespaced.clone();
    deleted["contexts"]
        .as_array_mut()
        .unwrap()
        .retain(|context| context["name"] != ARN);
    setup.steps(&[
        serde_json::to_string_pretty(&aws).unwrap(),
        serde_json::to_string(&namespaced).unwrap(),
        serde_json::to_string(&deleted).unwrap(),
    ]);
    let (output, end) = setup.run(session.id).await;
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    assert_eq!(
        directs(&mut events, session.id).await,
        [vec![ARN.to_owned()], vec![]]
    );
}

#[tokio::test]
async fn an_entry_a_tool_rewrote_goes_direct_by_its_name_and_a_later_follower_gets_it_until_the_tab_closes()
 {
    let setup = Setup::new().await;
    setup.guard("kind-b").await;
    let (_, mut events) = setup.follow();
    let session = setup.create("kind-b", &setup.writing(1)).await;
    let mut aliased = with_eks(&setup.proxied());
    context_mut(&mut aliased, "kind-a")["context"] =
        serde_json::json!({ "cluster": ARN, "user": ARN });
    setup.steps(&[serde_json::to_string_pretty(&aliased).unwrap()]);
    let (output, end) = setup.run(session.id).await;
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    assert_eq!(
        directs(&mut events, session.id).await,
        [vec!["kind-a".to_owned()]]
    );
    let (_, mut later) = setup.follow();
    assert_eq!(
        directs(&mut later, session.id).await,
        [vec!["kind-a".to_owned()]]
    );
    setup.core.shell_close("main", session.id).unwrap();
    nothing_more(&mut later).await;
    let (_, mut after) = setup.follow();
    nothing_more(&mut after).await;
}

#[tokio::test]
async fn a_kubeconfig_terminal_never_says_its_contexts_go_direct() {
    let setup = Setup::new().await;
    let (_, mut events) = setup.follow();
    let session = setup.create("kind-a", &setup.writing(1)).await;
    setup.steps(&[EKS.to_owned()]);
    let (output, end) = setup.run(session.id).await;
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    let offer = offered(&mut events).await;
    assert_eq!(offer.contexts, [ARN]);
    assert!(directs(&mut events, session.id).await.is_empty());
}
