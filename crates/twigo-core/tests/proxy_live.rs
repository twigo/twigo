//! The policy proxy on kind, with the kubectl on `PATH` and the kubeconfig
//! the core writes for a terminal: each command passes or is refused as the
//! context's mode says, proven by what the server holds afterwards. Its pods
//! run on kind's node from its local-path helper, which has bash and no
//! other command, so a port-forward reaches the kubelet's healthz through a
//! pod on the host's network.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-core --test proxy_live -- --ignored

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Node, Pod};
use kube::api::{DeleteParams, PostParams};
use kube::config::Kubeconfig;
use kube::{Api, Config};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::watch;
use twigo_cache::hub::{Query, Resource, RowFormat};
use twigo_core::{Core, ProxyProcess};
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{AnswerApproval, ApprovalAnswer, ApprovalEvent, Mode, ViewState};
use twigo_policy::Actor;

const WAIT: Duration = Duration::from_secs(60);

fn unique() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!("{nanos}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// The test cluster, a namespace of its own on it, and the image its pods
/// run.
struct Cluster {
    path: PathBuf,
    context: String,
    node: String,
    image: String,
    admin: kube::Client,
    namespace: String,
}

impl Cluster {
    async fn connect(prefix: &str) -> Self {
        let found = std::process::Command::new("kubectl")
            .args(["version", "--client"])
            .output();
        assert!(
            found.is_ok_and(|output| output.status.success()),
            "these tests run kubectl, which must be on PATH"
        );
        let path: PathBuf = std::env::var_os("TWIGO_TEST_KUBECONFIG")
            .expect("TWIGO_TEST_KUBECONFIG")
            .into();
        let kubeconfig = Kubeconfig::read_from(&path).unwrap();
        let context = kubeconfig.current_context.clone().unwrap_or_default();
        let name = context.strip_prefix("kind-").unwrap_or_else(|| {
            panic!("refusing context {context:?}: only kind clusters, whose node runs real pods")
        });
        let node = format!("{name}-control-plane");
        let config = Config::from_custom_kubeconfig(kubeconfig, &Default::default())
            .await
            .unwrap();
        let admin = kube::Client::try_from(config).unwrap();
        let image = Api::<Node>::all(admin.clone())
            .get(&node)
            .await
            .unwrap()
            .status
            .and_then(|status| status.images)
            .into_iter()
            .flatten()
            .flat_map(|image| image.names.into_iter().flatten())
            .find(|name| name.starts_with("docker.io/kindest/local-path-helper:"))
            .expect("kind's node holds the local-path helper");
        let namespace = format!("core-proxy-{prefix}-{}", unique());
        Api::<Namespace>::all(admin.clone())
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({ "metadata": { "name": namespace } })).unwrap(),
            )
            .await
            .unwrap();
        Cluster {
            path,
            context,
            node,
            image,
            admin,
            namespace,
        }
    }

    async fn delete(&self) {
        Api::<Namespace>::all(self.admin.clone())
            .delete(&self.namespace, &DeleteParams::default())
            .await
            .unwrap();
    }

    fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.admin.clone(), &self.namespace)
    }

    fn config_maps(&self) -> Api<ConfigMap> {
        Api::namespaced(self.admin.clone(), &self.namespace)
    }

    /// A pod on kind's node running `script` in bash, once it runs.
    async fn running(&self, name: &str, script: &str, host_network: bool) {
        self.started(name, script, host_network, false).await;
    }

    /// A pod on kind's node that writes the first line an attach gives its
    /// stdin to `/tmp/written`, once it runs.
    async fn reading(&self, name: &str) {
        self.started(name, READS, false, true).await;
    }

    async fn started(&self, name: &str, script: &str, host_network: bool, stdin: bool) {
        let pod = json!({
            "metadata": { "name": name },
            "spec": {
                "nodeName": self.node,
                "hostNetwork": host_network,
                "restartPolicy": "Never",
                "terminationGracePeriodSeconds": 0,
                "containers": [{
                    "name": "app",
                    "image": self.image,
                    "imagePullPolicy": "Never",
                    "command": ["bash", "-c", script],
                    "stdin": stdin,
                }],
            },
        });
        let pods = self.pods();
        pods.create(
            &PostParams::default(),
            &serde_json::from_value(pod).unwrap(),
        )
        .await
        .unwrap();
        eventually("the pod runs", || async {
            let pod = pods.get(name).await.unwrap();
            pod.status
                .and_then(|status| status.container_statuses)
                .into_iter()
                .flatten()
                .any(|status| status.state.is_some_and(|state| state.running.is_some()))
        })
        .await;
    }

    /// What the pod's `/tmp/written` is, read with the admin's own
    /// credentials.
    async fn written(&self, pod: &str) -> String {
        let output = Command::new("kubectl")
            .args(["--kubeconfig".as_ref(), self.path.as_os_str()])
            .args([
                "--context",
                &self.context,
                "-n",
                &self.namespace,
                "exec",
                pod,
            ])
            .args([
                "--",
                "bash",
                "-c",
                "test -e /tmp/written && echo present || echo absent",
            ])
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    async fn config_map(&self, name: &str) -> Option<Value> {
        self.config_maps()
            .get_opt(name)
            .await
            .unwrap()
            .map(|found| serde_json::to_value(found.data).unwrap())
    }
}

async fn eventually<F, Done>(what: &str, mut check: F)
where
    F: FnMut() -> Done,
    Done: std::future::Future<Output = bool>,
{
    let waited = tokio::time::timeout(WAIT, async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
    assert!(waited.await.is_ok(), "{what} within 60 s");
}

/// A core over a copy of the test's kubeconfig, and a terminal's process on
/// its context with the window `main` to ask.
async fn core(dir: &Path, cluster: &Cluster) -> (Arc<Core>, ProxyProcess) {
    let kubeconfig = dir.join("config");
    std::fs::copy(&cluster.path, &kubeconfig).unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let (status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            let _status = status;
            core.run(followed, Some(kubeconfig)).await;
        }
    });
    core.catalog.contexts().await;
    let process = core
        .proxy_process(
            Actor::Terminal,
            "Terminal 1",
            Some("main"),
            &cluster.context,
        )
        .await
        .unwrap();
    (core, process)
}

/// kubectl over the process's kubeconfig only, with a discovery cache of the
/// test's own.
struct Kubectl {
    kubeconfig: PathBuf,
    cache: PathBuf,
    namespace: String,
}

impl Kubectl {
    fn new(process: &ProxyProcess, dir: &Path, cluster: &Cluster) -> Self {
        Self {
            kubeconfig: process.kubeconfig().to_owned(),
            cache: dir.join("kubectl-cache"),
            namespace: cluster.namespace.clone(),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new("kubectl");
        command
            .arg("--kubeconfig")
            .arg(&self.kubeconfig)
            .args(["-n", &self.namespace])
            .args(args)
            .env("KUBECACHEDIR", &self.cache)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    async fn run(&self, args: &[&str], input: &str) -> Output {
        let mut child = self.command(args).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(input.as_bytes()).await.unwrap();
        drop(stdin);
        let read = |mut from: Box<dyn tokio::io::AsyncRead + Send + Unpin>| {
            tokio::spawn(async move {
                let mut read = Vec::new();
                let _ = from.read_to_end(&mut read).await;
                read
            })
        };
        let stdout = read(Box::new(child.stdout.take().unwrap()));
        let stderr = read(Box::new(child.stderr.take().unwrap()));
        let status = tokio::time::timeout(WAIT, child.wait()).await;
        if status.is_err() {
            child.kill().await.unwrap();
        }
        let (stdout, stderr) = (stdout.await.unwrap(), stderr.await.unwrap());
        let Ok(status) = status else {
            panic!(
                "kubectl {args:?} ends within 60 s: {}{}",
                String::from_utf8_lossy(&stdout),
                String::from_utf8_lossy(&stderr)
            );
        };
        Output {
            status: status.unwrap(),
            stdout,
            stderr,
        }
    }

    /// Runs and says what it printed, failing unless it succeeded.
    async fn passes(&self, args: &[&str], input: &str) -> String {
        let output = self.run(args, input).await;
        assert!(
            output.status.success(),
            "kubectl {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    /// Runs and says what it printed on stderr, failing unless Twigo refused
    /// it.
    async fn refused(&self, args: &[&str], input: &str) -> String {
        let output = self.run(args, input).await;
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(!output.status.success(), "kubectl {args:?} passed");
        assert!(stderr.contains("Twigo: "), "kubectl {args:?}: {stderr}");
        stderr
    }

    /// One connection through `kubectl port-forward` to the kubelet's
    /// healthz, which the host-network pod `host` reaches.
    async fn forwards(&self) -> String {
        let mut child = self
            .command(&["port-forward", "pod/host", ":10248"])
            .spawn()
            .unwrap();
        let port = until_line(&mut child, "Forwarding from 127.0.0.1:").await;
        let port: u16 = port
            .split("127.0.0.1:")
            .nth(1)
            .and_then(|rest| rest.split(' ').next())
            .unwrap()
            .parse()
            .unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut answer = String::new();
        tokio::time::timeout(WAIT, stream.read_to_string(&mut answer))
            .await
            .expect("the kubelet answers")
            .unwrap();
        child.kill().await.unwrap();
        answer
    }
}

/// The first line of the child's stdout that contains `wanted`.
async fn until_line(child: &mut Child, wanted: &str) -> String {
    let stdout = child.stdout.as_mut().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    tokio::time::timeout(WAIT, async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if line.contains(wanted) {
                return line;
            }
        }
        panic!("kubectl ended before printing {wanted:?}");
    })
    .await
    .unwrap_or_else(|_| panic!("{wanted:?} within 60 s"))
}

/// Answers every ask of the window `main` with `answer`, the context's name
/// typed, and counts them.
fn window(core: &Arc<Core>, answer: ApprovalAnswer) -> watch::Receiver<usize> {
    let (asks, mut events) = tokio::sync::mpsc::unbounded_channel();
    core.follow_approvals("main", move |event| asks.send(event).is_ok());
    let (count, counted) = watch::channel(0);
    let core = Arc::clone(core);
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if let ApprovalEvent::Asked { ask } = event {
                let typed = Some(ask.context.clone());
                core.answer_approval(
                    "main",
                    AnswerApproval {
                        id: ask.id,
                        answer,
                        typed,
                    },
                )
                .unwrap();
                count.send_modify(|count| *count += 1);
            }
        }
    });
    counted
}

fn manifest(name: &str, value: &str) -> String {
    json!({
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": { "name": name },
        "data": { "value": value },
    })
    .to_string()
}

const SLEEPS: &str = "coproc S { read; }; read -u \"${S[0]}\"";
const TICKS: &str = "coproc S { read; }; while true; do echo tick; read -t 1 -u \"${S[0]}\"; done";
const WRITES: &str = "echo hi > /tmp/written && echo done";
const READS: &str =
    "read line; echo \"$line\" > /tmp/written; coproc S { read; }; read -u \"${S[0]}\"";

/// `kubectl run -i --rm` of a pod on kind's node that echoes a line. Not
/// `-it`: without a terminal kubectl attaches with `stderr` to a container
/// that has a TTY, which kind 1.37 answers with a 500, through the proxy or
/// not, and kubectl falls back to its logs.
fn run(cluster: &Cluster) -> Vec<String> {
    let spec = json!({ "apiVersion": "v1", "spec": { "nodeName": cluster.node } });
    [
        "run".to_owned(),
        "runner".to_owned(),
        format!("--image={}", cluster.image),
        "-i".to_owned(),
        "--rm".to_owned(),
        "--restart=Never".to_owned(),
        "--image-pull-policy=Never".to_owned(),
        format!("--overrides={spec}"),
        "--command".to_owned(),
        "--".to_owned(),
        "bash".to_owned(),
        "-c".to_owned(),
        "read line; echo got:$line".to_owned(),
    ]
    .to_vec()
}

fn strs(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG and kubectl"]
async fn read_write_lets_every_command_through() {
    let cluster = Cluster::connect("rw").await;
    let dir = tempfile::tempdir().unwrap();
    let (_core, process) = core(dir.path(), &cluster).await;
    let kubectl = Kubectl::new(&process, dir.path(), &cluster);
    cluster.running("sleeper", SLEEPS, false).await;
    cluster.running("ticker", TICKS, false).await;
    cluster.running("host", SLEEPS, true).await;

    let listed = kubectl.passes(&["get", "pods"], "").await;
    assert!(listed.contains("sleeper"), "{listed}");
    kubectl
        .passes(&["apply", "-f", "-"], &manifest("client", "1"))
        .await;
    assert_eq!(
        cluster.config_map("client").await,
        Some(json!({ "value": "1" }))
    );
    kubectl
        .passes(
            &["apply", "--server-side", "-f", "-"],
            &manifest("server", "1"),
        )
        .await;
    assert_eq!(
        cluster.config_map("server").await,
        Some(json!({ "value": "1" }))
    );

    let ran = kubectl
        .passes(&["exec", "sleeper", "--", "bash", "-c", WRITES], "")
        .await;
    assert_eq!(ran.trim(), "done");
    assert_eq!(cluster.written("sleeper").await, "present");

    let mut attach = kubectl.command(&["attach", "ticker"]).spawn().unwrap();
    until_line(&mut attach, "tick").await;
    attach.kill().await.unwrap();
    cluster.reading("reader").await;
    let mut attach = kubectl
        .command(&["attach", "-i", "reader"])
        .spawn()
        .unwrap();
    let mut stdin = attach.stdin.take().unwrap();
    stdin.write_all(b"hello\n").await.unwrap();
    eventually("what the attach sent reaches the pod", || async {
        cluster.written("reader").await == "present"
    })
    .await;
    attach.kill().await.unwrap();

    let forwarded = kubectl.forwards().await;
    assert!(forwarded.ends_with("ok"), "{forwarded}");

    let ran = kubectl.passes(&strs(&run(&cluster)), "hello\n").await;
    assert!(ran.contains("got:hello"), "{ran}");
    let pods = cluster.pods();
    eventually("--rm deletes the pod", || async {
        pods.get_opt("runner")
            .await
            .unwrap()
            .is_none_or(|pod| pod.metadata.deletion_timestamp.is_some())
    })
    .await;
    cluster.delete().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG and kubectl"]
async fn read_only_lets_reads_and_port_forwards_through_and_nothing_else() {
    let cluster = Cluster::connect("ro").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, process) = core(dir.path(), &cluster).await;
    let kubectl = Kubectl::new(&process, dir.path(), &cluster);
    cluster.running("sleeper", SLEEPS, false).await;
    cluster.reading("reader").await;
    cluster.running("host", SLEEPS, true).await;
    cluster
        .config_maps()
        .create(
            &PostParams::default(),
            &serde_json::from_str(&manifest("kept", "1")).unwrap(),
        )
        .await
        .unwrap();
    core.policy
        .set_mode(&cluster.context, Some(Mode::ReadOnly))
        .unwrap();

    let listed = kubectl.passes(&["get", "pods"], "").await;
    assert!(listed.contains("sleeper"), "{listed}");
    let forwarded = kubectl.forwards().await;
    assert!(forwarded.ends_with("ok"), "{forwarded}");

    let refusal = kubectl
        .refused(&["apply", "-f", "-"], &manifest("client", "1"))
        .await;
    assert!(refusal.contains("read-only"), "{refusal}");
    kubectl
        .refused(
            &["apply", "--server-side", "-f", "-"],
            &manifest("server", "1"),
        )
        .await;
    kubectl
        .refused(&["apply", "-f", "-"], &manifest("kept", "2"))
        .await;
    assert_eq!(cluster.config_map("client").await, None);
    assert_eq!(cluster.config_map("server").await, None);
    assert_eq!(
        cluster.config_map("kept").await,
        Some(json!({ "value": "1" }))
    );

    kubectl
        .refused(&["exec", "sleeper", "--", "bash", "-c", WRITES], "")
        .await;
    assert_eq!(cluster.written("sleeper").await, "absent");
    kubectl
        .refused(&["attach", "-i", "reader"], "hello\n")
        .await;
    assert_eq!(
        cluster.written("reader").await,
        "absent",
        "what the refused attach sent reached no file"
    );

    kubectl.refused(&strs(&run(&cluster)), "hello\n").await;
    assert!(cluster.pods().get_opt("runner").await.unwrap().is_none());
    cluster.delete().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG and kubectl"]
async fn guarded_applies_what_the_window_allows_once_and_nothing_it_denies() {
    let cluster = Cluster::connect("guarded").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, process) = core(dir.path(), &cluster).await;
    let kubectl = Kubectl::new(&process, dir.path(), &cluster);
    core.policy
        .set_mode(&cluster.context, Some(Mode::Guarded))
        .unwrap();

    let asked = window(&core, ApprovalAnswer::Once);
    kubectl
        .passes(&["apply", "-f", "-"], &manifest("allowed", "1"))
        .await;
    assert_eq!(
        cluster.config_map("allowed").await,
        Some(json!({ "value": "1" }))
    );
    assert_eq!(*asked.borrow(), 1);

    let asked = window(&core, ApprovalAnswer::Deny);
    let refusal = kubectl
        .refused(&["apply", "-f", "-"], &manifest("denied", "1"))
        .await;
    assert!(refusal.contains("was denied"), "{refusal}");
    assert_eq!(cluster.config_map("denied").await, None);
    assert_eq!(*asked.borrow(), 1);
    cluster.delete().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG and kubectl"]
async fn an_exec_held_open_in_guarded_ends_soon_after_the_context_turns_read_only() {
    let cluster = Cluster::connect("relock").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, process) = core(dir.path(), &cluster).await;
    let kubectl = Kubectl::new(&process, dir.path(), &cluster);
    cluster.running("sleeper", SLEEPS, false).await;
    core.policy
        .set_mode(&cluster.context, Some(Mode::Guarded))
        .unwrap();
    let _window = window(&core, ApprovalAnswer::Once);

    let echo = "while read line; do echo got:$line; done";
    let mut exec = kubectl
        .command(&["exec", "-i", "sleeper", "--", "bash", "-c", echo])
        .spawn()
        .unwrap();
    let mut stdin = exec.stdin.take().unwrap();
    stdin.write_all(b"a\n").await.unwrap();
    until_line(&mut exec, "got:a").await;

    core.policy
        .set_mode(&cluster.context, Some(Mode::ReadOnly))
        .unwrap();
    let relocked = Instant::now();
    let ended = tokio::time::timeout(Duration::from_secs(10), exec.wait())
        .await
        .expect("kubectl exec ends once the context turns read-only");
    let took = relocked.elapsed();
    eprintln!("kubectl exec ended {took:?} after the relock, {ended:?}");
    assert!(took < Duration::from_secs(5), "{took:?}");
    drop(stdin);
    cluster.delete().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG and kubectl"]
async fn sixteen_watches_fill_the_proxy_and_a_get_waits_on_429s_until_one_ends() {
    let cluster = Cluster::connect("budget").await;
    let dir = tempfile::tempdir().unwrap();
    let (core, process) = core(dir.path(), &cluster).await;
    let kubectl = Kubectl::new(&process, dir.path(), &cluster);
    cluster.running("sleeper", SLEEPS, false).await;
    let mut ui = core
        .hub
        .rows(Query {
            context: cluster.context.clone(),
            resource: Resource {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
                namespaced: true,
            },
            format: RowFormat::Table,
            namespaces: vec![cluster.namespace.clone()],
            field_selector: None,
        })
        .await
        .unwrap();
    ui.whole().await.unwrap();
    assert_eq!(ui.state(), ViewState::Ready);
    kubectl.passes(&["get", "pods"], "").await;

    let clients = core.clients(&cluster.context).await.unwrap();
    let mut watches = Vec::new();
    for started in 1..=16 {
        let mut watch = kubectl.command(&["get", "pods", "-w"]).spawn().unwrap();
        until_line(&mut watch, "sleeper").await;
        eventually("the watch holds a stream of the proxy's", || {
            let held = clients.usage().borrow().proxied.held;
            async move { held == started }
        })
        .await;
        watches.push(watch);
    }
    assert_eq!(
        ui.state(),
        ViewState::Ready,
        "the UI's watch waits for none of them"
    );

    let get = kubectl.command(&["get", "pods", "-v=6"]).spawn().unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(ui.state(), ViewState::Ready);
    let mut ended = watches.pop().unwrap();
    ended.kill().await.unwrap();
    let output = tokio::time::timeout(WAIT, get.wait_with_output())
        .await
        .expect("the get ends")
        .unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(output.status.success(), "{stderr}");
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("sleeper")
    );
    // As client-go's debugging round tripper logs a response at -v=6.
    let refused = stderr
        .lines()
        .filter(|line| line.contains(r#"status="429 Too Many Requests""#))
        .count();
    assert!(refused >= 1, "it waited on 429s: {stderr}");
    eprintln!("the get was answered 429 {refused} times before a watch ended");
    assert_eq!(ui.state(), ViewState::Ready);
    drop(watches);
    cluster.delete().await;
}
