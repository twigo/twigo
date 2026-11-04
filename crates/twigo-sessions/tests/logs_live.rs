//! Logs sessions against a kind cluster, on every supported release: a
//! followed pod, a container's previous instance after a forced restart, a
//! crash loop's next start, a cut stream that reopens, the cluster's
//! budget of followed logs, a Deployment's pods through a rollout, and a
//! StatefulSet's pod made again under its name.
//! They need a kubelet, so kwok's pods will not do; the pods run an image
//! kind's node holds already.

use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{Namespace, Node, Pod, ServiceAccount};
use kube::api::{DeleteParams, Patch, PatchParams, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Config};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use twigo_cache::hub::{Connect, Hub};
use twigo_ipc::{
    Containers, Gvr, LevelFilter, LogBatch, LogEntry, LogPod, LogSource, LogTarget, LogView,
    LogWindow, OpenLogs, Since, StreamState, ViewState,
};
use twigo_kube::client::{Clients, Options};
use twigo_sessions::logs::Session;

const WITHIN: Duration = Duration::from_secs(120);

/// The image of kind's local-path provisioner's helper, which every kind
/// node holds: bash 5 without other commands, so the scripts sleep by
/// reading a coprocess that never writes.
const HELPER: &str = "docker.io/kindest/local-path-helper:";
const SLEEP: &str = "coproc S { read; }; pause() { read -t \"$1\" -u \"${S[0]}\"; };";

struct Live {
    hub: Hub,
    clients: Arc<Clients>,
    context: String,
    node: String,
    image: String,
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
    let clients = Arc::new(Clients::new(&config, Options::default()).unwrap());
    let connect: Connect = {
        let clients = Arc::clone(&clients);
        Arc::new(move |_context| {
            let clients = Arc::clone(&clients);
            Box::pin(async move { Ok(clients) })
        })
    };
    let held = Api::<Node>::all(clients.api.clone())
        .get(&node)
        .await
        .unwrap();
    let image = held
        .status
        .and_then(|status| status.images)
        .into_iter()
        .flatten()
        .flat_map(|image| image.names.unwrap_or_default())
        .find(|name| name.starts_with(HELPER))
        .unwrap_or_else(|| panic!("{node} holds no {HELPER}*"));
    let namespace = namespace(&clients.api, prefix).await;
    Live {
        hub: Hub::new(connect),
        clients,
        context,
        node,
        image,
        namespace,
    }
}

/// A new namespace, once its `default` ServiceAccount, which pods need, is
/// there.
async fn namespace(admin: &kube::Client, prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let name = format!("{prefix}-{nanos}");
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": name } })).unwrap();
    Api::<Namespace>::all(admin.clone())
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
    let accounts = Api::<ServiceAccount>::namespaced(admin.clone(), &name);
    let given = async {
        while !matches!(accounts.get_opt("default").await, Ok(Some(_))) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    tokio::time::timeout(WITHIN, given)
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

    /// A pod spec of containers that run `script` each on kind's node,
    /// with a volume that outlives their restarts.
    fn spec(&self, containers: &[(&str, &str)]) -> Value {
        json!({
            "nodeName": self.node,
            "terminationGracePeriodSeconds": 0,
            "volumes": [{ "name": "state", "emptyDir": {} }],
            "containers": containers.iter().map(|(name, script)| json!({
                "name": name,
                "image": self.image,
                "imagePullPolicy": "Never",
                "command": ["sh", "-c", format!("{SLEEP} {script}")],
                "volumeMounts": [{ "name": "state", "mountPath": "/state" }],
            })).collect::<Vec<_>>(),
        })
    }

    async fn pod(&self, name: &str, containers: &[(&str, &str)]) {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": { "name": name },
            "spec": self.spec(containers),
        }))
        .unwrap();
        self.pods()
            .create(&PostParams::default(), &pod)
            .await
            .unwrap();
        self.until_pod(name, |pod| running(pod, containers.len()))
            .await;
    }

    async fn until_pod(&self, name: &str, done: impl Fn(&Pod) -> bool) -> Pod {
        let pods = self.pods();
        let reached = async {
            loop {
                if let Some(pod) = pods.get_opt(name).await.unwrap()
                    && done(&pod)
                {
                    return pod;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        };
        tokio::time::timeout(WITHIN, reached)
            .await
            .unwrap_or_else(|_| panic!("{name} within {WITHIN:?}"))
    }

    async fn open(&self, gvr: (&str, &str), name: &str, source: LogSource) -> Tab {
        let (sent, batches) = mpsc::unbounded_channel();
        let request = OpenLogs {
            target: LogTarget {
                space: self.context.clone(),
                gvr: Gvr {
                    group: gvr.0.to_owned(),
                    version: "v1".to_owned(),
                    resource: gvr.1.to_owned(),
                },
                namespace: self.namespace.clone(),
                name: name.to_owned(),
            },
            source,
            view: LogView {
                level: LevelFilter::All,
                filter: None,
                search: None,
                range: None,
            },
        };
        let session = Session::open(
            self.hub.clone(),
            self.context.clone(),
            request,
            move |batch| sent.send(batch).is_ok(),
        )
        .await
        .unwrap();
        session.set_window(LogWindow::Tail { count: 50_000 });
        Tab {
            session,
            batches,
            status: None,
            pods: Vec::new(),
            entries: Vec::new(),
        }
    }

    async fn delete(self) {
        Api::<Namespace>::all(self.admin())
            .delete(&self.namespace, &DeleteParams::default())
            .await
            .unwrap();
    }
}

fn running(pod: &Pod, containers: usize) -> bool {
    pod.status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref())
        .is_some_and(|statuses| {
            statuses.len() == containers
                && statuses
                    .iter()
                    .all(|status| status.state.as_ref().is_some_and(|s| s.running.is_some()))
        })
}

fn source(containers: Containers, since: Since, previous: bool) -> LogSource {
    LogSource {
        containers,
        pods: None,
        since,
        previous,
    }
}

/// A session and what its batches said last.
struct Tab {
    session: Session,
    batches: mpsc::UnboundedReceiver<LogBatch>,
    status: Option<ViewState>,
    pods: Vec<LogPod>,
    entries: Vec<LogEntry>,
}

impl Tab {
    /// Reads batches, acknowledging each, until `done` holds.
    async fn until(&mut self, what: &str, done: impl Fn(&Tab) -> bool) {
        let reached = async {
            while !done(self) {
                let batch = self.batches.recv().await.expect("the session runs");
                self.session.ack(batch.seq);
                self.status = Some(batch.status);
                if let Some(pods) = batch.pods {
                    self.pods = pods;
                }
                if let Some(window) = batch.window {
                    assert_eq!(window.start, 0, "the tail of fewer entries than it reads");
                    self.entries = window.entries;
                }
            }
        };
        tokio::time::timeout(WITHIN, reached)
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "{what} within {WITHIN:?}; last {:?} {:?} {:#?}",
                    self.status,
                    self.pods,
                    self.entries.iter().rev().take(5).collect::<Vec<_>>()
                )
            });
    }

    fn lines(&self) -> Vec<&str> {
        self.entries
            .iter()
            .filter_map(|entry| match entry {
                LogEntry::Line { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn state(&self, pod: &str, container: &str) -> Option<&StreamState> {
        self.pods
            .iter()
            .find(|found| found.name == pod)?
            .containers
            .iter()
            .find(|found| found.name == container)
            .map(|found| &found.stream)
    }
}

/// Lines `prefix 1`, `prefix 2`, … with none missing or repeated, as many
/// as the tab holds.
fn numbered(lines: &[&str], prefix: &str) -> usize {
    let numbers: Vec<usize> = lines
        .iter()
        .filter_map(|line| line.strip_prefix(prefix)?.strip_prefix(' ')?.parse().ok())
        .collect();
    let expected: Vec<usize> = (1..=numbers.len()).collect();
    assert_eq!(numbers, expected, "{prefix}: neither gaps nor duplicates");
    numbers.len()
}

/// Writes `line 1`, `line 2`, … twenty a second.
const COUNTER: &str = "i=0; while true; do i=$((i+1)); echo \"line $i\"; pause 0.05; done";

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_pod_is_followed() {
    let live = live("logs-follow").await;
    live.pod("talker", &[("talker", COUNTER)]).await;
    let mut tab = live
        .open(
            ("", "pods"),
            "talker",
            source(Containers::Default, Since::Start, false),
        )
        .await;
    tab.until("40 lines", |tab| tab.lines().len() >= 40).await;
    numbered(&tab.lines(), "line");
    assert_eq!(tab.status, Some(ViewState::Ready));
    let [pod] = &tab.pods[..] else {
        panic!("one pod: {:?}", tab.pods);
    };
    assert_eq!(
        (pod.name.as_str(), pod.status.as_str()),
        ("talker", "Running")
    );
    assert_eq!(tab.state("talker", "talker"), Some(&StreamState::Following));
    live.delete().await;
}

/// Counts its instances in the pod's volume: `run 1 line 1`, …
const RUNS: &str = "n=0; [ -e /state/runs ] && read n < /state/runs; n=$((n+1)); echo $n > /state/runs; \
                    i=0; while true; do i=$((i+1)); echo \"run $n line $i\"; pause 0.05; done";

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_restarted_container_ends_its_instance_and_keeps_its_previous() {
    let live = live("logs-previous").await;
    live.pod("restarted", &[("app", RUNS)]).await;
    let mut tab = live
        .open(
            ("", "pods"),
            "restarted",
            source(Containers::Default, Since::Start, false),
        )
        .await;
    tab.until("the first run's lines", |tab| tab.lines().len() >= 20)
        .await;

    let id = docker(
        &live.node,
        &[
            "crictl",
            "ps",
            "--name",
            "^app$",
            "--label",
            &format!("io.kubernetes.pod.namespace={}", live.namespace),
            "-q",
        ],
    );
    docker(&live.node, &["crictl", "stop", &id]);
    tab.until("the second run's lines", |tab| {
        tab.lines()
            .iter()
            .filter(|line| line.starts_with("run 2 "))
            .count()
            >= 10
    })
    .await;
    let first = numbered(&tab.lines(), "run 1 line");
    numbered(&tab.lines(), "run 2 line");
    let ended = tab
        .entries
        .iter()
        .position(|entry| matches!(entry, LogEntry::Ended { .. }))
        .expect("an Ended entry");
    let LogEntry::Ended { exit_code, .. } = &tab.entries[ended] else {
        unreachable!();
    };
    assert_eq!(*exit_code, Some(137), "killed: {:?}", tab.entries[ended]);
    let around: Vec<&str> = [ended - 1, ended + 1]
        .iter()
        .filter_map(|at| match &tab.entries[*at] {
            LogEntry::Line { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        around,
        [format!("run 1 line {first}").as_str(), "run 2 line 1"]
    );

    let mut previous = live
        .open(
            ("", "pods"),
            "restarted",
            source(Containers::Default, Since::Start, true),
        )
        .await;
    previous
        .until("the previous instance, read to its end", |tab| {
            tab.state("restarted", "app") == Some(&StreamState::Ended)
        })
        .await;
    assert_eq!(numbered(&previous.lines(), "run 1 line"), first);
    assert!(
        previous
            .lines()
            .iter()
            .all(|line| line.starts_with("run 1 "))
    );
    assert!(
        matches!(
            previous.entries.last(),
            Some(LogEntry::Ended {
                exit_code: Some(137),
                ..
            })
        ),
        "{:?}",
        previous.entries.last()
    );
    live.delete().await;
}

/// Writes a line and exits with 1, so the kubelet starts it again at once,
/// then after back-offs of 10 s and more.
const CRASHES: &str = "echo started; exit 1";

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_crash_loops_end_gets_its_next_start() {
    let live = live("logs-crash").await;
    let pod: Pod = serde_json::from_value(json!({
        "metadata": { "name": "crash" },
        "spec": live.spec(&[("app", CRASHES)]),
    }))
    .unwrap();
    live.pods()
        .create(&PostParams::default(), &pod)
        .await
        .unwrap();
    let mut tab = live
        .open(
            ("", "pods"),
            "crash",
            source(Containers::Default, Since::Start, false),
        )
        .await;
    tab.until("an Ended entry with its next start", |tab| {
        tab.entries.iter().any(|entry| {
            matches!(
                entry,
                LogEntry::Ended {
                    restarting: Some(_),
                    ..
                }
            )
        })
    })
    .await;
    for entry in &tab.entries {
        if let LogEntry::Ended {
            exit_code, reason, ..
        } = entry
        {
            assert_eq!((*exit_code, reason.as_deref()), (Some(1), Some("Error")));
        }
    }
    live.delete().await;
}

const UIDS: &str =
    "trap '' TERM; i=0; while true; do i=$((i+1)); echo \"$POD_UID line $i\"; pause 0.05; done";

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_statefulsets_pod_made_again_under_its_name_bounds_each_ones_lines() {
    let live = live("logs-made-again").await;
    let mut spec = live.spec(&[("web", UIDS)]);
    spec["containers"][0]["env"] = json!([{
        "name": "POD_UID",
        "valueFrom": { "fieldRef": { "fieldPath": "metadata.uid" } },
    }]);
    let set: StatefulSet = serde_json::from_value(json!({
        "metadata": { "name": "web" },
        "spec": {
            "replicas": 1,
            "serviceName": "web",
            "selector": { "matchLabels": { "app": "web" } },
            "template": { "metadata": { "labels": { "app": "web" } }, "spec": spec },
        },
    }))
    .unwrap();
    Api::<StatefulSet>::namespaced(live.admin(), &live.namespace)
        .create(&PostParams::default(), &set)
        .await
        .unwrap();
    let old = live.until_pod("web-0", |pod| running(pod, 1)).await;
    let old = old.metadata.uid.expect("a uid");
    let mut tab = live
        .open(
            ("apps", "statefulsets"),
            "web",
            source(Containers::Default, Since::Start, false),
        )
        .await;
    let of = |tab: &Tab, uid: &str| -> Vec<usize> {
        tab.entries
            .iter()
            .enumerate()
            .filter_map(|(at, entry)| match entry {
                LogEntry::Line { text, .. } if text.starts_with(uid) => Some(at),
                _ => None,
            })
            .collect()
    };
    tab.until("the old pod's lines", |tab| of(tab, &old).len() >= 20)
        .await;

    live.pods()
        .delete("web-0", &DeleteParams::default())
        .await
        .unwrap();
    let new = live
        .until_pod("web-0", |pod| {
            pod.metadata.uid.as_deref() != Some(old.as_str()) && running(pod, 1)
        })
        .await;
    let new = new.metadata.uid.expect("a uid");
    let marks = |tab: &Tab| -> (Vec<usize>, Vec<usize>) {
        let at = |joined: bool| {
            tab.entries
                .iter()
                .enumerate()
                .filter_map(|(at, entry)| match entry {
                    LogEntry::Joined { .. } if joined => Some(at),
                    LogEntry::Left { .. } if !joined => Some(at),
                    _ => None,
                })
                .collect()
        };
        (at(true), at(false))
    };
    tab.until("the old pod left and the new one wrote", |tab| {
        let (joined, left) = marks(tab);
        joined.len() == 1 && left.len() == 1 && of(tab, &new).len() >= 20
    })
    .await;
    let (old_lines, new_lines) = (of(&tab, &old), of(&tab, &new));
    let (joined, left) = marks(&tab);
    let order = format!(
        "old lines {:?}..={:?}, its Left {left:?}; new lines {:?}..={:?}, its Joined {joined:?}",
        old_lines.first(),
        old_lines.last(),
        new_lines.first(),
        new_lines.last()
    );
    assert!(old_lines.iter().all(|line| *line < left[0]), "{order}");
    assert!(new_lines.iter().all(|line| *line > joined[0]), "{order}");
    if old_lines.last() < new_lines.first() {
        assert!(left[0] < joined[0], "{order}");
    }
    let lines = tab.lines();
    numbered(&lines, &format!("{old} line"));
    numbered(&lines, &format!("{new} line"));
    eprintln!("{order}");
    live.delete().await;
}

fn docker(node: &str, args: &[&str]) -> String {
    let output = Command::new("docker")
        .arg("exec")
        .arg(node)
        .args(args)
        .output()
        .expect("docker runs");
    assert!(output.status.success(), "{args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_cut_stream_reopens_without_gaps_or_duplicates() {
    let live = live("logs-cut").await;
    live.pod("talker", &[("talker", COUNTER)]).await;
    let mut tab = live
        .open(
            ("", "pods"),
            "talker",
            source(Containers::Default, Since::Start, false),
        )
        .await;
    tab.until("20 lines", |tab| tab.lines().len() >= 20).await;
    let dialled = live.clients.connections().dialled();
    live.clients.connections().retire();
    let before = tab.lines().len();
    tab.until("40 lines after the cut", |tab| {
        tab.lines().len() >= before + 40
    })
    .await;
    numbered(&tab.lines(), "line");
    assert!(live.clients.connections().dialled() > dialled);
    let moved = async {
        while live.clients.connections().open() > 1 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), moved)
        .await
        .expect("the retired connection closes once the stream reopened on the new one");
    live.delete().await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn the_33rd_followed_log_waits_until_one_closes() {
    let live = live("logs-budget").await;
    let quiet = "read -u \"${S[0]}\"";
    let names: Vec<String> = (0..11).map(|i| format!("c{i}")).collect();
    let containers: Vec<(&str, &str)> = names.iter().map(|name| (name.as_str(), quiet)).collect();
    live.pod("many", &containers).await;
    let pod = ("", "pods");
    let named = |name: &str| Containers::Named {
        name: name.to_owned(),
    };
    let mut tabs = Vec::new();
    for _ in 0..3 {
        tabs.push(
            live.open(pod, "many", source(Containers::All, Since::Start, false))
                .await,
        );
    }
    for name in ["c0", "c1"] {
        tabs.push(
            live.open(pod, "many", source(named(name), Since::Start, false))
                .await,
        );
    }
    for tab in &mut tabs {
        tab.until("its streams follow", |tab| {
            let states: Vec<&StreamState> = tab
                .pods
                .iter()
                .flat_map(|pod| &pod.containers)
                .map(|c| &c.stream)
                .collect();
            let following = states
                .iter()
                .filter(|s| ***s == StreamState::Following)
                .count();
            following == 10
                || (following == 1
                    && states.iter().filter(|s| ***s == StreamState::Off).count() == 10)
        })
        .await;
    }
    assert_eq!(tabs[0].state("many", "c10"), Some(&StreamState::OverLimit));
    let mut last = live
        .open(pod, "many", source(named("c2"), Since::Start, false))
        .await;
    last.until("queued", |tab| {
        tab.state("many", "c2") == Some(&StreamState::Queued)
    })
    .await;
    let usage = *live.clients.usage().borrow();
    assert_eq!((usage.logs.held, usage.logs.queued), (32, 1));

    drop(tabs.pop());
    last.until("following once one closed", |tab| {
        tab.state("many", "c2") == Some(&StreamState::Following)
    })
    .await;
    live.delete().await;
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_deployment_is_followed_through_a_rollout() {
    let live = live("logs-rollout").await;
    let deployment: Deployment = serde_json::from_value(json!({
        "metadata": { "name": "web" },
        "spec": {
            "replicas": 2,
            "selector": { "matchLabels": { "app": "web" } },
            "template": {
                "metadata": { "labels": { "app": "web" } },
                "spec": live.spec(&[("web", COUNTER)]),
            },
        },
    }))
    .unwrap();
    let deployments = Api::<Deployment>::namespaced(live.admin(), &live.namespace);
    deployments
        .create(&PostParams::default(), &deployment)
        .await
        .unwrap();
    let mut tab = live
        .open(
            ("apps", "deployments"),
            "web",
            source(Containers::Default, Since::Start, false),
        )
        .await;
    let following = |tab: &Tab| {
        tab.pods
            .iter()
            .filter(|pod| {
                pod.containers
                    .iter()
                    .any(|c| c.stream == StreamState::Following)
            })
            .count()
    };
    tab.until("both pods followed", |tab| {
        following(tab) == 2 && tab.lines().len() >= 20
    })
    .await;
    let first: Vec<String> = tab.pods.iter().map(|pod| pod.name.clone()).collect();
    assert!(
        tab.pods.iter().all(|pod| pod.generated.is_some()),
        "{:?}",
        tab.pods
    );

    let restart = json!({ "spec": { "template": { "metadata": { "annotations": { "twigo.io/restarted": "1" } } } } });
    deployments
        .patch("web", &PatchParams::default(), &Patch::Merge(&restart))
        .await
        .unwrap();
    let marked = |tab: &Tab, joined: bool| -> Vec<String> {
        tab.entries
            .iter()
            .filter_map(|entry| match entry {
                LogEntry::Joined { pod, .. } if joined => Some(pod.clone()),
                LogEntry::Left { pod, .. } if !joined => Some(pod.clone()),
                _ => None,
            })
            .filter(|pod| first.contains(pod) != joined)
            .collect()
    };
    tab.until("the new pods joined and the old left", |tab| {
        marked(tab, true).len() == 2
            && marked(tab, false).len() == 2
            && following(tab) == 2
            && tab.pods.iter().all(|pod| !first.contains(&pod.name))
    })
    .await;
    let mut new: Vec<String> = tab.pods.iter().map(|pod| pod.name.clone()).collect();
    let mut joined = marked(&tab, true);
    let mut left = marked(&tab, false);
    new.sort();
    joined.sort();
    left.sort();
    let mut first = first.clone();
    first.sort();
    assert_eq!((joined, left), (new.clone(), first));
    for entry in &tab.entries {
        if let LogEntry::Joined { pod, owner, .. } = entry
            && new.contains(pod)
        {
            let owner = owner.as_ref().expect("a new pod's controller");
            assert_eq!(
                (owner.group.as_str(), owner.kind.as_str()),
                ("apps", "ReplicaSet")
            );
            assert!(
                pod.starts_with(&format!("{}-", owner.name)),
                "{pod} of {owner:?}"
            );
        }
    }
    live.delete().await;
}
