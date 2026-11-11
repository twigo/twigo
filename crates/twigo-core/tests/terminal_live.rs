use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::{ConfigMap, Namespace};
use kube::api::{DeleteParams, PostParams};
use kube::config::Kubeconfig;
use kube::{Api, Config};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use twigo_core::{Core, ShellFrame};
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    AnswerApproval, AnswerKubeconfigOffer, ApprovalAnswer, ApprovalEvent, KubeconfigNames,
    KubeconfigOffer, KubeconfigOfferAnswer, KubeconfigOfferEvent, Mode, NewTerminal, OpenShell,
    ProxyWhy, SetContextMode, ShellAck, ShellEnd, ShellEvent, ShellInput, TerminalKind,
    TerminalSession,
};

const WAIT: Duration = Duration::from_secs(60);
const ARN: &str = "arn:aws:eks:eu-west-1:111122223333:cluster/twigo-live";
const LATER: &str = "arn:aws:eks:eu-west-1:111122223333:cluster/twigo-later";

fn unique() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!("{nanos}")
}

struct Live {
    dir: tempfile::TempDir,
    core: Arc<Core>,
    context: String,
    alias: String,
    server: String,
    _status: watch::Sender<Status>,
}

impl Live {
    async fn new(policy: &str) -> Self {
        let found = Command::new("kubectl")
            .args(["version", "--client"])
            .output();
        assert!(
            found.is_ok_and(|output| output.status.success()),
            "these tests run kubectl, which must be on PATH"
        );
        let test: PathBuf = std::env::var_os("TWIGO_TEST_KUBECONFIG")
            .expect("TWIGO_TEST_KUBECONFIG")
            .into();
        let read = Kubeconfig::read_from(&test).unwrap();
        let context = read.current_context.clone().unwrap_or_default();
        assert!(
            context.starts_with("kind-"),
            "refusing context {context:?}: only kind clusters"
        );
        let server = read.clusters[0]
            .cluster
            .as_ref()
            .unwrap()
            .server
            .clone()
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let mine = home.join(".kube").join("config");
        std::fs::create_dir_all(mine.parent().unwrap()).unwrap();
        std::fs::copy(&test, &mine).unwrap();
        let named = &read.contexts[0];
        let entry = named.context.as_ref().unwrap();
        let alias = format!("{context}-alias");
        let added = Command::new("kubectl")
            .arg("--kubeconfig")
            .arg(&mine)
            .args(["config", "set-context", &alias])
            .arg(format!("--cluster={}", entry.cluster))
            .arg(format!("--user={}", entry.user.clone().unwrap()))
            .output()
            .unwrap();
        assert!(added.status.success(), "{added:?}");
        let text = std::fs::read_to_string(&mine).unwrap();
        std::fs::write(
            &mine,
            format!("# the kind cluster, under two names\n{text}"),
        )
        .unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let path = std::env::join_paths(
            std::iter::once(bin.clone())
                .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
        )
        .unwrap();
        let env: ShellEnv = [
            ("HOME", home.into_os_string()),
            ("KUBECONFIG", mine.into_os_string()),
            (
                "KUBECACHEDIR",
                dir.path().join("kubectl-cache").into_os_string(),
            ),
            ("PATH", path),
        ]
        .into_iter()
        .map(|(name, value)| (OsString::from(name), value))
        .collect();
        let policy_file = dir.path().join("policy.json");
        std::fs::write(&policy_file, policy).unwrap();
        let core = Core::new(
            &dir.path().join("data"),
            &dir.path().join("cache"),
            &policy_file,
        );
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
            context,
            alias,
            server,
            _status: status,
        }
    }

    fn mine(&self) -> PathBuf {
        self.dir.path().join("home").join(".kube").join("config")
    }

    fn fake_aws(&self) {
        let script = format!(
            r#"#!/bin/sh
f="${{KUBECONFIG%%:*}}"
case "$*" in
  *twigo-later*) name='{LATER}' ;;
  *) name='{ARN}' ;;
esac
cat > "$f" <<EOF
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==
    server: https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com
  name: $name
contexts:
- context:
    cluster: {cluster}
    user: {user}
  name: {context}
- context:
    cluster: $name
    user: $name
  name: $name
current-context: $name
kind: Config
preferences: {{}}
users:
- name: $name
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      args:
      - --region
      - eu-west-1
      - eks
      - get-token
      - --cluster-name
      - twigo-live
      - --output
      - json
      command: aws
EOF
echo "Added new context $name to $f"
"#,
            cluster = self.context,
            user = self.context,
            context = self.context,
        );
        let path = self.dir.path().join("bin").join("aws");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    async fn terminal(&self, context: &str, script: &str) -> (TerminalKind, String, ShellEnd) {
        let (session, output, end) = self
            .run(context, "/bin/sh", vec!["-c".into(), script.into()], "")
            .await;
        (session.kind, output, end)
    }

    async fn run(
        &self,
        context: &str,
        program: &str,
        args: Vec<OsString>,
        typed: &str,
    ) -> (TerminalSession, String, ShellEnd) {
        self.core.set_terminal_program(PathBuf::from(program), args);
        let session = self
            .core
            .terminal_create(
                "main",
                NewTerminal {
                    context: context.to_owned(),
                    label: "Terminal 1".to_owned(),
                },
            )
            .await
            .unwrap();
        let id = session.id;
        let (frames, mut received) = mpsc::unbounded_channel();
        self.core
            .shell_open(
                "main",
                OpenShell {
                    id,
                    cols: 200,
                    rows: 50,
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
        let end = loop {
            let frame = tokio::time::timeout(WAIT, received.recv())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "the terminal ends within 60 s: {}",
                        String::from_utf8_lossy(&output)
                    )
                })
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
                ShellFrame::Event(ShellEvent::Ended { end }) => break end,
                ShellFrame::Event(_) => {}
            }
        };
        self.core.shell_close("main", id).unwrap();
        let output = String::from_utf8_lossy(&output).replace("\r\n", "\n");
        (session, output, end)
    }

    async fn admin(&self) -> kube::Client {
        let path: PathBuf = std::env::var_os("TWIGO_TEST_KUBECONFIG").unwrap().into();
        let config = Config::from_custom_kubeconfig(
            Kubeconfig::read_from(path).unwrap(),
            &Default::default(),
        )
        .await
        .unwrap();
        kube::Client::try_from(config).unwrap()
    }
}

fn lines(output: &str) -> Vec<&str> {
    output.lines().collect()
}

async fn offered(events: &mut mpsc::UnboundedReceiver<KubeconfigOfferEvent>) -> KubeconfigOffer {
    let event = tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("an offer within 60 s")
        .unwrap();
    match event {
        KubeconfigOfferEvent::Offered { offer } => *offer,
        event => panic!("{event:?}"),
    }
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn each_kind_prints_its_context_and_a_kubeconfig_terminal_leaves_the_user_s_file_alone() {
    let live = Live::new("{}").await;
    let before = std::fs::read(live.mine()).unwrap();
    let script = format!(
        "kubectl config current-context && kubectl config set-context --current --namespace=edited && kubectl config view --minify -o 'jsonpath={{..namespace}}' && echo && kubectl config use-context {alias} && kubectl config current-context",
        alias = live.alias
    );
    let (kind, output, end) = live.terminal(&live.context, &script).await;
    assert_eq!(kind, TerminalKind::Kubeconfig);
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    let printed = lines(&output);
    assert_eq!(printed[0], live.context, "{output}");
    assert_eq!(printed[2], "edited", "{output}");
    assert_eq!(printed[4], live.alias, "{output}");
    assert_eq!(std::fs::read(live.mine()).unwrap(), before);
    assert!(!live.mine().with_extension("lock").exists());

    let live = Live::new(&json!({"terminal": {"usePolicyProxy": ["kind-*"]}}).to_string()).await;
    let (kind, output, end) = live
        .terminal(&live.context, "kubectl config current-context")
        .await;
    assert_eq!(
        kind,
        TerminalKind::Proxy {
            why: ProxyWhy::PolicyFile
        }
    );
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    assert_eq!(lines(&output), [live.context.as_str()]);
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_zshrc_that_exports_kubeconfig_leaves_each_kind_its_space_s_context() {
    let proxied = json!({"terminal": {"usePolicyProxy": ["kind-*"]}}).to_string();
    for policy in ["{}", proxied.as_str()] {
        let live = Live::new(policy).await;
        let theirs = live.dir.path().join("theirs");
        std::fs::copy(live.mine(), &theirs).unwrap();
        let used = Command::new("kubectl")
            .arg("--kubeconfig")
            .arg(&theirs)
            .args(["config", "use-context", &live.alias])
            .output()
            .unwrap();
        assert!(used.status.success(), "{used:?}");
        std::fs::write(
            live.dir.path().join("home").join(".zshrc"),
            format!("export KUBECONFIG='{}'\n", theirs.display()),
        )
        .unwrap();
        let typed = "printf '<%s>\\n' \"$(kubectl config current-context)\"; exit\n";
        let (session, output, end) = live.run(&live.context, "/bin/zsh", Vec::new(), typed).await;
        assert!(session.kubeconfig_kept);
        assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
        assert!(
            output.contains(&format!("<{}>", live.context)),
            "{policy}: {output}"
        );
    }
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_context_kubectl_writes_into_a_proxy_terminal_s_file_goes_direct_until_it_is_deleted() {
    let live = Live::new(&json!({"terminal": {"usePolicyProxy": ["kind-*"]}}).to_string()).await;
    let (events, mut followed) = mpsc::unbounded_channel();
    live.core
        .follow_kubeconfig_offers("main", move |event| events.send(event).is_ok());
    let script = format!(
        "kubectl config set-cluster {ARN} --server=https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com \
         && kubectl config set-credentials {ARN} --token=theirs \
         && kubectl config set-context {ARN} --cluster={ARN} --user={ARN} \
         && kubectl config use-context {ARN} && sleep 1.5 \
         && kubectl config set-context {context} --namespace=edited && sleep 1.5 \
         && kubectl config use-context {context} && kubectl config delete-context {ARN} && sleep 1.5",
        context = live.context
    );
    let (session, output, end) = live
        .run(
            &live.context,
            "/bin/sh",
            vec!["-c".into(), script.into()],
            "",
        )
        .await;
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    let mut told = Vec::new();
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(1), followed.recv()).await
    {
        if let KubeconfigOfferEvent::Direct {
            session: of,
            contexts,
        } = event
        {
            assert_eq!(of, session.id);
            told.push(contexts);
        }
    }
    assert_eq!(told, [vec![ARN.to_owned()], vec![]], "{output}");
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_proxy_terminal_reaches_another_context_only_through_the_proxy() {
    let live = Live::new(&json!({"terminal": {"usePolicyProxy": ["kind-*"]}}).to_string()).await;
    let script = format!(
        r#"grep -o '"server": "[^"]*"' "$KUBECONFIG"; kubectl --context {alias} get ns -v=6 2>&1"#,
        alias = live.alias
    );
    let (_, output, end) = live.terminal(&live.context, &script).await;
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    let servers: Vec<String> = output
        .lines()
        .filter_map(|line| line.strip_prefix(r#""server": ""#))
        .map(|server| server.trim_end_matches('"').to_owned())
        .collect();
    assert!(!servers.is_empty(), "{output}");
    assert!(output.contains("kube-system"), "{output}");
    let urls: Vec<&str> = output
        .match_indices("https://")
        .map(|(at, _)| {
            let rest = &output[at..];
            &rest[..rest.find(['"', ' ', '\n']).unwrap_or(rest.len())]
        })
        .filter(|url| !servers.iter().any(|server| server == url))
        .collect();
    assert!(!urls.is_empty(), "{output}");
    for url in urls {
        let own = url == live.server || url.starts_with(&format!("{}/", live.server));
        assert!(!own, "{url} is the cluster's own");
        assert!(
            servers
                .iter()
                .any(|server| url.starts_with(server.as_str())),
            "{url} is not the proxy's: {servers:?}"
        );
    }
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn what_a_cloud_cli_writes_is_offered_and_a_move_keeps_the_user_s_comments_and_lists_it() {
    let live = Live::new("{}").await;
    live.fake_aws();
    let (events, mut followed) = mpsc::unbounded_channel();
    let waiting = live
        .core
        .follow_kubeconfig_offers("main", move |event| events.send(event).is_ok());
    assert!(waiting.is_empty());
    let (_, output, end) = live
        .terminal(
            &live.context,
            "aws eks update-kubeconfig --name twigo-live && sleep 2 && kubectl config current-context",
        )
        .await;
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    assert!(output.ends_with(&format!("{ARN}\n")), "{output}");
    let offer = offered(&mut followed).await;
    assert_eq!(
        (&offer.clusters, &offer.users, &offer.contexts),
        (
            &vec![ARN.to_owned()],
            &vec![ARN.to_owned()],
            &vec![ARN.to_owned()]
        )
    );
    assert_eq!(offer.target, "~/.kube/config");
    assert_eq!(offer.context, live.context);
    assert_eq!(offer.left_out, KubeconfigNames::default());
    let id = offer.id;
    live.core
        .answer_kubeconfig_offer(
            "main",
            AnswerKubeconfigOffer {
                id,
                revision: offer.revision,
                answer: KubeconfigOfferAnswer::Move,
            },
        )
        .await
        .unwrap();
    let withdrawn = tokio::time::timeout(WAIT, followed.recv()).await.unwrap();
    assert_eq!(withdrawn, Some(KubeconfigOfferEvent::Withdrawn { id }));
    let mine = std::fs::read_to_string(live.mine()).unwrap();
    assert!(
        mine.starts_with("# the kind cluster, under two names\n"),
        "{mine}"
    );
    let config = Kubeconfig::from_yaml(&mine).unwrap();
    assert!(config.clusters.iter().any(|named| named.name == ARN));
    assert!(config.auth_infos.iter().any(|named| named.name == ARN));
    let mut contexts = live.core.catalog.subscribe();
    let listed = tokio::time::timeout(
        WAIT,
        contexts.wait_for(|listed| {
            listed
                .as_ref()
                .is_some_and(|listed| listed.find(ARN).is_some())
        }),
    )
    .await;
    assert!(listed.is_ok(), "the catalog lists the moved context");

    let go = live.dir.path().join("go");
    let script = format!(
        "aws eks update-kubeconfig --name twigo-later && while [ ! -e '{}' ]; do sleep 0.1; done && aws eks update-kubeconfig --name twigo-later && sleep 2",
        go.display()
    );
    let running = live.terminal(&live.context, &script);
    let answering = async {
        let later = offered(&mut followed).await;
        assert_eq!(later.contexts, [LATER]);
        live.core
            .answer_kubeconfig_offer(
                "main",
                AnswerKubeconfigOffer {
                    id: later.id,
                    revision: later.revision,
                    answer: KubeconfigOfferAnswer::Dismiss,
                },
            )
            .await
            .unwrap();
        let withdrawn = tokio::time::timeout(WAIT, followed.recv()).await.unwrap();
        assert_eq!(
            withdrawn,
            Some(KubeconfigOfferEvent::Withdrawn { id: later.id })
        );
        std::fs::write(&go, "").unwrap();
        let again = tokio::time::timeout(Duration::from_secs(3), followed.recv()).await;
        assert!(again.is_err(), "offered again: {again:?}");
    };
    let ((_, output, end), ()) = tokio::join!(running, answering);
    assert_eq!(end, ShellEnd::Exited { code: 0 }, "{output}");
    assert!(
        !std::fs::read_to_string(live.mine())
            .unwrap()
            .contains(LATER)
    );
}

#[tokio::test]
#[ignore = "needs a kind cluster: TWIGO_TEST_KUBECONFIG"]
async fn a_write_from_a_guarded_terminal_asks_and_a_denial_leaves_the_server_untouched() {
    let live = Live::new("{}").await;
    let admin = live.admin().await;
    let namespace = format!("core-terminal-{}", unique());
    Api::<Namespace>::all(admin.clone())
        .create(
            &PostParams::default(),
            &serde_json::from_value(json!({ "metadata": { "name": namespace } })).unwrap(),
        )
        .await
        .unwrap();
    live.core
        .set_context_mode(SetContextMode {
            context: live.context.clone(),
            mode: Some(Mode::Guarded),
        })
        .await
        .unwrap();
    let asked = Arc::new(AtomicUsize::new(0));
    let (asks, mut events) = mpsc::unbounded_channel();
    live.core
        .follow_approvals("main", move |event| asks.send(event).is_ok());
    let answering = {
        let (core, asked) = (Arc::clone(&live.core), Arc::clone(&asked));
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if let ApprovalEvent::Asked { ask } = event {
                    asked.fetch_add(1, Ordering::Relaxed);
                    let answer = AnswerApproval {
                        id: ask.id,
                        answer: ApprovalAnswer::Deny,
                        typed: None,
                    };
                    core.answer_approval("main", answer).unwrap();
                }
            }
        })
    };
    let script = format!("kubectl -n {namespace} create configmap denied --from-literal=a=b");
    let (kind, output, end) = live.terminal(&live.context, &script).await;
    answering.abort();
    assert_eq!(
        kind,
        TerminalKind::Proxy {
            why: ProxyWhy::Mode
        }
    );
    assert_ne!(end, ShellEnd::Exited { code: 0 }, "{output}");
    assert!(output.contains("Twigo: "), "{output}");
    assert!(asked.load(Ordering::Relaxed) >= 1);
    let found = Api::<ConfigMap>::namespaced(admin.clone(), &namespace)
        .get_opt("denied")
        .await
        .unwrap();
    assert!(found.is_none(), "the server holds the configmap");
    Api::<Namespace>::all(admin)
        .delete(&namespace, &DeleteParams::default())
        .await
        .unwrap();
}
