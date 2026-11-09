//! A shell in a pod against a kind cluster: a command's output and exit
//! code, resizes, the shell chosen and `TERM`, a shell-less image, bytes
//! that survive, the flood of `yes` with and without acks, the budget of
//! sessions, a pod deleted under a session, a retired connection, and an
//! attach. They need a kubelet, so they refuse anything but `kind-*`.
//!
//! TWIGO_TEST_KUBECONFIG=… cargo test -p twigo-sessions --test shell_live -- --ignored

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use k8s_openapi::api::core::v1::{Namespace, Node, Pod, ServiceAccount};
use kube::api::{DeleteParams, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use serde_json::{Value, json};
use twigo_ipc::{ShellEnd, ShellEvent};
use twigo_kube::client::{Clients, Gate, Options};
use twigo_sessions::shell::{Frame, Join, Session, Spec};

const WITHIN: Duration = Duration::from_secs(120);
const BUSYBOX: &str = "registry.k8s.io/e2e-test-images/busybox:1.36.1-1";
const PAUSE: &str = "registry.k8s.io/pause:3.10";
const HELPER: &str = "docker.io/kindest/local-path-helper:";
const HIGH_WATER: u64 = 256 * 1024;
const FRAME_MAX: u64 = 64 * 1024;

struct Live {
    clients: Arc<Clients>,
    node: String,
    helper: String,
    namespace: String,
}

async fn live(prefix: &str) -> Live {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    let cluster = context.strip_prefix("kind-").unwrap_or_else(|| {
        panic!("refusing context {context:?}: these tests need a kubelet, so they run only against kind clusters")
    });
    let node = format!("{cluster}-control-plane");
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    let clients =
        Arc::new(Clients::new(&config, Gate::unrestricted(), Options::default()).unwrap());
    let held = Api::<Node>::all(clients.api.clone())
        .get(&node)
        .await
        .unwrap();
    let helper = held
        .status
        .and_then(|status| status.images)
        .into_iter()
        .flatten()
        .flat_map(|image| image.names.unwrap_or_default())
        .find(|name| name.starts_with(HELPER))
        .unwrap_or_else(|| panic!("{node} holds no {HELPER}*"));
    let namespace = namespace(&clients.api, prefix).await;
    Live {
        clients,
        node,
        helper,
        namespace,
    }
}

async fn namespace(admin: &kube::Client, prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let name = format!("shell-{prefix}-{nanos}");
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap();
    Api::<Namespace>::all(admin.clone())
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
    let accounts = Api::<ServiceAccount>::namespaced(admin.clone(), &name);
    tokio::time::timeout(WITHIN, async {
        while !matches!(accounts.get_opt("default").await, Ok(Some(_))) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the default ServiceAccount");
    name
}

impl Live {
    fn admin(&self) -> kube::Client {
        self.clients.api.clone()
    }

    fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.admin(), &self.namespace)
    }

    fn spec(&self, pod: &str, join: Join, stdin: bool, tty: bool) -> Spec {
        Spec {
            namespace: self.namespace.clone(),
            pod: pod.to_owned(),
            container: "app".to_owned(),
            join,
            stdin,
            tty,
        }
    }

    fn shell_spec(&self, pod: &str) -> Spec {
        Spec::shell(self.namespace.clone(), pod.to_owned(), "app".to_owned())
    }

    async fn pod(&self, name: &str, container: Value) {
        let object: Pod = serde_json::from_value(json!({
            "metadata": { "name": name },
            "spec": {
                "nodeName": self.node,
                "terminationGracePeriodSeconds": 0,
                "containers": [container],
            },
        }))
        .unwrap();
        self.pods()
            .create(&PostParams::default(), &object)
            .await
            .unwrap();
        tokio::time::timeout(WITHIN, async {
            loop {
                let phase = self
                    .pods()
                    .get(name)
                    .await
                    .unwrap()
                    .status
                    .and_then(|status| status.phase);
                if phase.as_deref() == Some("Running") {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{name} never ran"));
    }

    async fn busybox(&self, name: &str) {
        self.pod(
            name,
            json!({
                "name": "app",
                "image": BUSYBOX,
                "command": ["sh", "-c", "sleep 3600"],
            }),
        )
        .await;
    }

    async fn delete_namespace(&self) {
        Api::<Namespace>::all(self.admin())
            .delete(&self.namespace, &DeleteParams::default())
            .await
            .unwrap();
    }
}

#[derive(Default)]
struct Told {
    total: u64,
    tail: Vec<u8>,
    events: Vec<ShellEvent>,
}

impl Told {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.tail).into_owned()
    }

    fn ended(&self) -> Option<ShellEnd> {
        self.events.iter().find_map(|event| match event {
            ShellEvent::Ended { end } => Some(end.clone()),
            _ => None,
        })
    }
}

struct Open {
    session: Session,
    told: Arc<Mutex<Told>>,
}

fn open(clients: &Arc<Clients>, spec: Spec, cols: u16, rows: u16) -> Open {
    let session = Session::park(
        Arc::clone(clients),
        spec,
        futures::future::pending().boxed(),
    );
    let told: Arc<Mutex<Told>> = Arc::default();
    let sent = Arc::clone(&told);
    session
        .open(cols, rows, move |frame| {
            let mut told = sent.lock().unwrap();
            match frame {
                Frame::Output(bytes) => {
                    told.total += bytes.len() as u64;
                    told.tail.extend_from_slice(&bytes);
                    let over = told.tail.len().saturating_sub(1024 * 1024);
                    told.tail.drain(..over);
                }
                Frame::Event(event) => told.events.push(event),
            }
            true
        })
        .unwrap();
    Open { session, told }
}

impl Open {
    fn told(&self) -> std::sync::MutexGuard<'_, Told> {
        self.told.lock().unwrap()
    }

    async fn until(&self, what: &str, mut done: impl FnMut(&Told) -> bool) {
        let waited = tokio::time::timeout(WITHIN, async {
            while !done(&self.told()) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        if waited.is_err() {
            let told = self.told();
            panic!(
                "{what}: {:?}, {} bytes, ends with {:?}",
                told.events,
                told.total,
                told.text()
                    .chars()
                    .rev()
                    .take(300)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            );
        }
    }

    async fn running(&self) {
        self.until("it runs", |told| {
            told.events.contains(&ShellEvent::Running) || told.ended().is_some()
        })
        .await;
        assert!(
            self.told().events.contains(&ShellEvent::Running),
            "{:?}",
            self.told().events
        );
    }

    async fn prompt(&self) {
        self.running().await;
        self.until("the shell prompts", |told| told.total > 0).await;
    }

    async fn ended(&self) -> ShellEnd {
        self.until("it ends", |told| told.ended().is_some()).await;
        self.told().ended().unwrap()
    }

    async fn run(&self, line: &str) {
        self.session.input(format!("{line}\n").into_bytes()).await;
    }

    async fn sees(&self, text: &str) {
        self.until(&format!("{text:?} shows"), |told| {
            told.text().contains(text)
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_command_shows_its_output_and_exit_code() {
    let live = live("command").await;
    live.busybox("p").await;
    let command = vec![
        "sh".to_owned(),
        "-c".to_owned(),
        "echo hello; echo oops >&2; exit 3".to_owned(),
    ];
    let open = open(
        &live.clients,
        live.spec("p", Join::Exec(command), false, false),
        80,
        24,
    );
    assert_eq!(open.ended().await, ShellEnd::Exited { code: 3 });
    let text = open.told().text();
    assert!(text.contains("hello") && text.contains("oops"), "{text}");
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_resize_reaches_the_terminal_and_the_first_size_too() {
    let live = live("resize").await;
    live.busybox("p").await;
    let open = open(&live.clients, live.shell_spec("p"), 100, 40);
    open.prompt().await;
    open.run("stty size").await;
    open.sees("40 100").await;

    open.session.resize(120, 50);
    tokio::time::sleep(Duration::from_millis(500)).await;
    open.run("stty size").await;
    open.sees("50 120").await;
    drop(open);
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn term_is_set_and_bash_is_chosen_where_it_exists() {
    let live = live("term").await;
    live.busybox("busybox").await;
    live.pod(
        "bash",
        json!({
            "name": "app",
            "image": live.helper,
            "imagePullPolicy": "Never",
            "command": ["sh", "-c", "coproc S { read; }; read -u \"${S[0]}\""],
        }),
    )
    .await;

    let busybox = open(&live.clients, live.shell_spec("busybox"), 80, 24);
    busybox.prompt().await;
    busybox
        .run("echo \"M:$TERM:${BASH_VERSION:-none}:M\"")
        .await;
    busybox.sees("M:xterm-256color:none:M").await;

    let bash = open(&live.clients, live.shell_spec("bash"), 80, 24);
    bash.prompt().await;
    bash.run("echo \"M:$TERM:${BASH_VERSION:-none}:M\"").await;
    bash.sees("M:xterm-256color:5.").await;
    drop((busybox, bash));
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_shell_less_image_ends_as_no_shell() {
    let live = live("pause").await;
    live.pod("p", json!({ "name": "app", "image": PAUSE }))
        .await;
    let open = open(&live.clients, live.shell_spec("p"), 80, 24);
    let end = open.ended().await;
    let ShellEnd::NoShell { message } = &end else {
        panic!("{end:?}");
    };
    assert!(message.contains("executable file not found"), "{message}");
    assert_eq!(open.told().total, 0);
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn every_byte_value_comes_back_exact() {
    let live = live("bytes").await;
    live.busybox("p").await;
    let script: String = std::iter::once("printf '".to_owned())
        .chain((0..=255_u8).map(|byte| format!("\\{byte:03o}")))
        .chain(std::iter::once("'".to_owned()))
        .collect();
    let open = open(
        &live.clients,
        live.spec(
            "p",
            Join::Exec(vec!["sh".to_owned(), "-c".to_owned(), script]),
            false,
            false,
        ),
        80,
        24,
    );
    assert_eq!(open.ended().await, ShellEnd::Exited { code: 0 });
    let expected: Vec<u8> = (0..=255_u8).collect();
    assert_eq!(open.told().tail, expected);
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn yes_with_acks_runs_and_ctrl_c_ends_it_within_seconds() {
    let live = live("yes").await;
    live.busybox("p").await;
    let open = Arc::new(open(&live.clients, live.shell_spec("p"), 80, 24));
    open.prompt().await;
    let acking = {
        let open = Arc::clone(&open);
        tokio::spawn(async move {
            let mut acked = 0;
            loop {
                let total = open.told().total;
                if total > acked {
                    let step = u32::try_from((total - acked).min(u64::from(u32::MAX))).unwrap();
                    open.session.ack(step);
                    acked += u64::from(step);
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
    };
    open.run("yes").await;
    open.until("yes floods", |told| told.total > 4 * 1024 * 1024)
        .await;

    open.session.input(vec![3]).await;
    open.run("echo END-$((40+2))").await;
    tokio::time::timeout(Duration::from_secs(20), open.sees("END-42"))
        .await
        .expect("Ctrl-C ends yes within seconds");
    acking.abort();
    drop(open);
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn yes_with_no_acks_stops_growing_at_the_high_water_mark() {
    let live = live("no-acks").await;
    live.busybox("p").await;
    let open = open(&live.clients, live.shell_spec("p"), 80, 24);
    open.prompt().await;
    let before = open.told().total;
    open.session.ack(u32::try_from(before).unwrap());
    open.run("yes").await;
    open.until("it reaches the mark", |told| {
        told.total - before >= HIGH_WATER - FRAME_MAX
    })
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let first = open.told().total;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let second = open.told().total;
    assert_eq!(first, second, "it stopped growing");
    assert!(
        (second - before) <= HIGH_WATER + FRAME_MAX + 4096,
        "{} bytes sent past the prompt",
        second - before
    );
    drop(open);
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn the_sixty_fifth_session_waits_and_closing_one_starts_it() {
    let live = live("budget").await;
    live.busybox("p").await;
    let mut sessions = Vec::new();
    for _ in 0..64 {
        let session = open(&live.clients, live.shell_spec("p"), 80, 24);
        session.running().await;
        sessions.push(session);
    }
    assert_eq!(live.clients.usage().borrow().sessions.held, 64);

    let waiting = open(&live.clients, live.shell_spec("p"), 80, 24);
    waiting
        .until("it says it waits", |told| {
            told.events.contains(&ShellEvent::Queued)
        })
        .await;
    assert_eq!(waiting.told().events, vec![ShellEvent::Queued]);

    sessions.truncate(63);
    waiting.running().await;
    assert_eq!(live.clients.usage().borrow().sessions.held, 64);
    drop(waiting);
    drop(sessions);
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_pod_deleted_under_a_session_ends_it_visibly() {
    let live = live("deleted").await;
    live.busybox("p").await;
    let open = open(&live.clients, live.shell_spec("p"), 80, 24);
    open.prompt().await;
    live.pods()
        .delete("p", &DeleteParams::default().grace_period(0))
        .await
        .unwrap();
    let end = open.ended().await;
    eprintln!("a pod deleted under a session ended it as {end:?}");
    assert!(
        matches!(end, ShellEnd::Exited { .. } | ShellEnd::ConnectionLost),
        "{end:?}"
    );
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_retired_connection_ends_the_session_as_lost() {
    let live = live("retired").await;
    live.busybox("p").await;
    let open = open(&live.clients, live.shell_spec("p"), 80, 24);
    open.prompt().await;
    live.clients.connections().retire();
    assert_eq!(open.ended().await, ShellEnd::ConnectionLost);
    drop(open);
    live.delete_namespace().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn attach_joins_a_container_with_a_tty_and_stdin() {
    let live = live("attach").await;
    live.pod(
        "p",
        json!({
            "name": "app",
            "image": BUSYBOX,
            "command": ["sh"],
            "tty": true,
            "stdin": true,
        }),
    )
    .await;
    let open = open(
        &live.clients,
        live.spec("p", Join::Attach, true, true),
        80,
        24,
    );
    open.running().await;
    open.run("echo ATT-$((40+2))").await;
    open.sees("ATT-42").await;
    drop(open);
    live.delete_namespace().await;
}
