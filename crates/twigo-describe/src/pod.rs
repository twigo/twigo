//! Pods: what kubectl describe prints of them (kubectl v1.37.1,
//! `describePod`), and what is wrong with them in words.

use jiff::{SignedDuration, Timestamp};
use serde_json::Value;
use twigo_ipc::{
    Block, Finding, FindingLogs, Section, Span, Tone, TreeNode, TreeValue, Value as Shown, Vital,
};

use crate::layout::wrong;
use crate::show::{
    Fields, NODE, SERVICE_ACCOUNT, Summary, code, counted, labels, link, list, plain, quantities,
    said, section, toned,
};
use crate::{Described, Input, Need, containers, header, message, printed, text, tree, volumes};

const CONTAINERS: &str = "core.containers";
const PLACEMENT: &str = "core.placement";
const STORAGE: &str = "core.volumes";

pub(crate) fn needs(pod: &Value) -> Vec<Need> {
    header::above(pod).into_iter().collect()
}

pub(crate) fn describe(input: &Input<'_>) -> Described {
    let pod = input.object;
    let spec = &pod["spec"];
    let namespace = text(&pod["metadata"]["namespace"]);
    let (found, explained) = findings(input);
    let (findings, subjects): (Vec<Finding>, Vec<Option<&str>>) = found.into_iter().unzip();
    let about = |id: &str| {
        findings
            .iter()
            .zip(&subjects)
            .find_map(|(finding, subject)| (*subject == Some(id)).then_some(finding))
    };
    let restarts = Restarts::of(pod);
    let mut sections = Vec::new();
    sections.extend(containers::block(spec, Some(pod)).map(|block| Section {
        summary: containers_summary(&block),
        tone: about(CONTAINERS).and_then(|finding| wrong(finding.tone)),
        ..section(CONTAINERS, "Containers", vec![block])
    }));
    sections.push(placement(input, about(PLACEMENT)));
    sections.extend(volumes::block(spec, namespace.as_deref()).map(|block| {
        let (summary, tone) = said(about(STORAGE), || storage_summary(spec));
        Section {
            summary,
            tone,
            ..section(STORAGE, "Storage", vec![block])
        }
    }));
    sections.push(configuration(spec, &pod["status"], namespace.as_deref()));
    let mut metadata = Fields::default();
    metadata.time("Started", &pod["status"]["startTime"]);
    Described {
        sentence: sentence(input, &restarts),
        vitals: vitals(input, &restarts, crashed(&pod["status"])),
        explained,
        node: text(&spec["nodeName"]),
        metadata: metadata.0,
        findings,
        sections,
        ..Described::default()
    }
}

fn containers_summary(block: &Block) -> Vec<Span> {
    let Block::Containers { containers } = block else {
        return Vec::new();
    };
    let states = || {
        containers
            .iter()
            .filter_map(|container| container.state.as_ref())
    };
    let failing = states().filter(|state| state.tone == Tone::Danger).count();
    let unready = states()
        .filter(|state| state.tone == Tone::Warning && state.running && !state.ready)
        .count();
    let running = states().filter(|state| state.running).count();
    let mut summary = Summary::default().part(if failing == 0 && unready == 0 && running > 0 {
        format!("{running} running")
    } else {
        containers.len().to_string()
    });
    if failing > 0 {
        summary = summary.part(format!("{failing} failing"));
    }
    if unready > 0 {
        summary = summary.part(format!("{unready} not ready"));
    }
    summary.done()
}

/// `2 volumes · 1 claim`: a claim is a volume that a claim backs.
fn storage_summary(spec: &Value) -> Vec<Span> {
    let volumes = spec["volumes"].as_array().map_or(&[][..], Vec::as_slice);
    let claims = volumes
        .iter()
        .filter(|volume| {
            volume["persistentVolumeClaim"].is_object() || volume["ephemeral"].is_object()
        })
        .count();
    Summary::default()
        .count(volumes.len(), "volume")
        .count(claims, "claim")
        .done()
}

fn placement(input: &Input<'_>, finding: Option<&Finding>) -> Section {
    let pod = input.object;
    let spec = &pod["spec"];
    let status = &pod["status"];
    let mut fields = Fields::default();
    let node = text(&spec["nodeName"]);
    if let Some(node) = &node {
        fields.add("Node", link(NODE, None, node, node.clone()));
    }
    fields.maybe(
        "Host IP",
        ips(&status["hostIPs"], &status["hostIP"]).map(code),
    );
    let address = ips(&status["podIPs"], &status["podIP"]);
    fields.maybe("Pod IP", address.clone().map(code));
    fields.text("QoS class", &status["qosClass"]);
    fields.add_default_maybe(
        "Priority",
        crate::show::scalar(&spec["priority"]).map(plain),
        spec["priority"] == 0,
    );
    fields.maybe(
        "Priority class",
        text(&spec["priorityClassName"]).map(|name| {
            link(
                ("scheduling.k8s.io", "v1", "PriorityClass"),
                None,
                &name,
                name.clone(),
            )
        }),
    );
    fields.text("Nominated node", &status["nominatedNodeName"]);
    fields.0.extend(scheduling(spec).0);
    let mut blocks = Vec::new();
    if !fields.is_empty() {
        blocks.push(Block::Fields { fields: fields.0 });
    }
    blocks.extend(affinity(spec));
    let (summary, tone) = said(finding, || {
        Summary::default()
            .part(node.unwrap_or_default())
            .part(address.unwrap_or_default())
            .done()
    });
    Section {
        summary,
        tone,
        ..section(PLACEMENT, "Placement", blocks)
    }
}

/// How the pod is set up, apart from where it runs: the rows that are the
/// cluster's defaults fold behind their count.
fn configuration(spec: &Value, status: &Value, namespace: Option<&str>) -> Section {
    let mut fields = Fields::default();
    let account = text(&spec["serviceAccountName"]);
    fields.add_default_maybe(
        "Service account",
        account
            .as_ref()
            .map(|name| link(SERVICE_ACCOUNT, namespace, name, name.clone())),
        account.as_deref() == Some("default"),
    );
    fields.add_default_maybe(
        "Restart policy",
        text(&spec["restartPolicy"]).map(plain),
        spec["restartPolicy"] == "Always",
    );
    fields.add_default_maybe(
        "DNS policy",
        text(&spec["dnsPolicy"]).map(plain),
        spec["dnsPolicy"] == "ClusterFirst",
    );
    fields.flag("Host network", &spec["hostNetwork"]);
    fields.flag("Host PID", &spec["hostPID"]);
    fields.flag("Host IPC", &spec["hostIPC"]);
    fields.add_default_maybe(
        "Termination grace",
        spec["terminationGracePeriodSeconds"]
            .as_i64()
            .map(|seconds| plain(format!("{seconds} s"))),
        spec["terminationGracePeriodSeconds"] == 30,
    );
    fields.add_default_maybe(
        "Scheduler",
        text(&spec["schedulerName"]).map(plain),
        spec["schedulerName"] == "default-scheduler",
    );
    fields.maybe(
        "Security",
        containers::security(&spec["securityContext"]).map(plain),
    );
    fields.maybe(
        "Runtime class",
        text(&spec["runtimeClassName"]).map(|name| {
            link(
                ("node.k8s.io", "v1", "RuntimeClass"),
                None,
                &name,
                name.clone(),
            )
        }),
    );
    fields.maybe(
        "Readiness gates",
        readiness_gates(&spec["readinessGates"], status),
    );
    fields.maybe("Requests", quantities(&spec["resources"]["requests"]));
    fields.maybe("Limits", quantities(&spec["resources"]["limits"]));
    let defaults = fields.0.iter().filter(|field| field.default).count();
    let summary = match account.filter(|name| name != "default") {
        Some(name) => Summary::default().part(format!("service account {name}")),
        None => Summary::default(),
    };
    Section {
        summary: summary.count(defaults, "default").done(),
        ..section(
            "core.configuration",
            "Configuration",
            vec![Block::Fields { fields: fields.0 }],
        )
    }
}

struct Restarts {
    count: u64,
    last: Option<String>,
}

/// Restart counts and the newest end of a previous run, over the statuses
/// added.
#[derive(Default)]
struct Tally {
    count: u64,
    last: Option<(Timestamp, String)>,
}

impl Tally {
    fn add(&mut self, status: &Value) {
        self.count += status["restartCount"].as_u64().unwrap_or_default();
        let ended = text(&status["lastState"]["terminated"]["finishedAt"])
            .and_then(|at| Some((at.parse::<Timestamp>().ok()?, at)));
        if let Some(ended) = ended
            && self.last.as_ref().is_none_or(|(last, _)| ended.0 > *last)
        {
            self.last = Some(ended);
        }
    }
}

impl Restarts {
    /// What the list's Restarts column prints, as kubectl's `printPod` counts
    /// it (kubernetes v1.37.0,
    /// [`printers.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/printers/internalversion/printers.go#L999-L1112)):
    /// while an init container is yet to complete and the pod is not
    /// Initialized, the restarts of the init containers up to it, and
    /// after that the sidecars' and the containers', the restarts of an init
    /// container that is no sidecar being left behind with its completion.
    fn of(pod: &Value) -> Self {
        let statuses = |key: &str| pod["status"][key].as_array().into_iter().flatten();
        let sidecar = |name: &Value| {
            pod["spec"]["initContainers"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|spec| spec["name"] == *name && spec["restartPolicy"] == "Always")
        };
        let mut inits = Tally::default();
        let mut sidecars = Tally::default();
        let mut initializing = false;
        for status in statuses("initContainerStatuses") {
            inits.add(status);
            let restartable = sidecar(&status["name"]);
            if restartable {
                sidecars.add(status);
            }
            let terminated = &status["state"]["terminated"];
            let completed =
                terminated.is_object() && terminated["exitCode"].as_i64().unwrap_or(0) == 0;
            if completed || (restartable && status["started"] == true) {
                continue;
            }
            initializing = true;
            break;
        }
        let initialized =
            condition(pod, "Initialized").is_some_and(|ready| ready["status"] == "True");
        let tally = if initializing && !initialized {
            inits
        } else {
            statuses("containerStatuses").for_each(|status| sidecars.add(status));
            sidecars
        };
        Restarts {
            count: tally.count,
            last: tally.last.map(|(_, at)| at),
        }
    }
}

/// Whether a container keeps crashing or ended in failure, which is what
/// its restarts led to.
fn crashed(status: &Value) -> bool {
    ["initContainerStatuses", "containerStatuses"]
        .into_iter()
        .flat_map(|key| status[key].as_array().into_iter().flatten())
        .any(|container| {
            let state = &container["state"];
            state["waiting"]["reason"] == "CrashLoopBackOff"
                || state["terminated"]["exitCode"]
                    .as_i64()
                    .is_some_and(|code| code != 0)
        })
}

/// Ready as the list prints it, and how often it restarted, the Ready
/// toned where a pod that has not finished is short of containers, and the
/// restarts where a container crashes or failed.
fn vitals(input: &Input<'_>, restarts: &Restarts, crashed: bool) -> Vec<Vital> {
    let mut vitals = Vec::new();
    if let Some(ready) = printed(input.printed, "Ready") {
        let all = ready
            .split_once('/')
            .is_some_and(|(have, want)| have == want);
        vitals.push(Vital {
            label: "Ready".to_owned(),
            value: if all || finished(input.object) {
                plain(ready)
            } else {
                toned(ready, Tone::Warning)
            },
            note: Vec::new(),
        });
    }
    let count = restarts.count.to_string();
    vitals.push(Vital {
        label: "Restarts".to_owned(),
        value: if restarts.count > 0 && crashed {
            toned(count, Tone::Warning)
        } else {
            plain(count)
        },
        note: restarts
            .last
            .iter()
            .filter(|_| restarts.count > 0)
            .map(|at| Span::Ago { at: at.clone() })
            .collect(),
    });
    vitals
}

/// `2/2 ready · no restarts`, `2/2 ready · 3 restarts, last 28 m ago`, and
/// for a pod that finished, when.
fn sentence(input: &Input<'_>, restarts: &Restarts) -> Vec<Span> {
    let pod = input.object;
    if finished(pod) {
        let ended = ["initContainerStatuses", "containerStatuses"]
            .into_iter()
            .flat_map(|key| pod["status"][key].as_array().into_iter().flatten())
            .filter_map(|status| text(&status["state"]["terminated"]["finishedAt"]))
            .filter_map(|at| Some((at.parse::<Timestamp>().ok()?, at)))
            .max();
        return match ended {
            Some((_, at)) => Summary::default().ago("Finished ", at).done(),
            None => Summary::default().part("Finished").done(),
        };
    }
    let Some(ready) = printed(input.printed, "Ready") else {
        return Vec::new();
    };
    let summary = Summary::default().part(format!("{ready} ready"));
    let summary = match (restarts.count, &restarts.last) {
        (0, _) => summary.part("no restarts"),
        (count, Some(at)) => summary.ago(
            &format!("{}, last ", counted(count as usize, "restart")),
            at.clone(),
        ),
        (count, None) => summary.part(counted(count as usize, "restart")),
    };
    summary.done()
}

/// The IPs a pod or its node has, the list or the one field.
fn ips(list: &Value, one: &Value) -> Option<String> {
    let ips: Vec<&str> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|ip| ip["ip"].as_str())
        .collect();
    if ips.is_empty() {
        text(one)
    } else {
        Some(ips.join(", "))
    }
}

/// Each gate with the status of its condition, `<none>` until one is set.
fn readiness_gates(gates: &Value, status: &Value) -> Option<Shown> {
    list(
        gates
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|gate| {
                let kind = gate["conditionType"].as_str()?;
                let status = status["conditions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|condition| condition["type"] == kind)
                    .and_then(|condition| condition["status"].as_str())
                    .unwrap_or("<none>");
                Some(plain(format!("{kind}: {status}")))
            })
            .collect(),
    )
}

/// Where the pod may run: node selector, tolerations and topology spread
/// as kubectl prints them, and the group it is scheduled with.
pub(crate) fn scheduling(spec: &Value) -> Fields {
    let mut fields = Fields::default();
    fields.maybe("Node selector", labels(&spec["nodeSelector"]));
    fields.maybe("Tolerations", tolerations(&spec["tolerations"]));
    fields.maybe(
        "Topology spread",
        list(
            sorted_spread(&spec["topologySpreadConstraints"])
                .into_iter()
                .map(plain)
                .collect(),
        ),
    );
    fields.text("Scheduling group", &spec["schedulingGroup"]["podGroupName"]);
    fields
}

/// Affinity, which kubectl leaves out, as a tree.
pub(crate) fn affinity(spec: &Value) -> Option<Block> {
    tree::nodes(&spec["affinity"]).map(|nodes| Block::Tree {
        nodes: vec![TreeNode {
            key: "affinity".to_owned(),
            label: "Affinity".to_owned(),
            value: TreeValue::Map { entries: nodes },
        }],
    })
}

/// Sorted by key, as kubectl prints them: `node.kubernetes.io/not-ready:NoExecute op=Exists for 300s`.
fn tolerations(tolerations: &Value) -> Option<Shown> {
    let mut tolerations: Vec<&Value> = tolerations.as_array()?.iter().collect();
    tolerations.sort_by_key(|toleration| toleration["key"].as_str().unwrap_or_default());
    list(
        tolerations
            .into_iter()
            .map(|toleration| {
                let key = toleration["key"].as_str().unwrap_or_default();
                let value = toleration["value"].as_str().unwrap_or_default();
                let effect = toleration["effect"].as_str().unwrap_or_default();
                let mut shown = key.to_owned();
                if !value.is_empty() {
                    shown.push_str(&format!("={value}"));
                }
                if !effect.is_empty() {
                    shown.push_str(&format!(":{effect}"));
                }
                if toleration["operator"] == "Exists" && value.is_empty() {
                    if shown.is_empty() {
                        shown.push_str("op=Exists");
                    } else {
                        shown.push_str(" op=Exists");
                    }
                }
                if let Some(seconds) = toleration["tolerationSeconds"].as_i64() {
                    shown.push_str(&format!(" for {seconds}s"));
                }
                plain(shown)
            })
            .collect(),
    )
}

/// `zone:DoNotSchedule when max skew 1 is exceeded for selector app=web`,
/// sorted by topology key.
fn sorted_spread(constraints: &Value) -> Vec<String> {
    let mut constraints: Vec<&Value> = constraints.as_array().into_iter().flatten().collect();
    constraints.sort_by_key(|constraint| constraint["topologyKey"].as_str().unwrap_or_default());
    constraints
        .into_iter()
        .map(|constraint| {
            let mut shown = format!(
                "{}:{} when max skew {} is exceeded",
                constraint["topologyKey"].as_str().unwrap_or_default(),
                constraint["whenUnsatisfiable"].as_str().unwrap_or_default(),
                constraint["maxSkew"].as_i64().unwrap_or_default()
            );
            if let Some(selector) = crate::show::selector(&constraint["labelSelector"]) {
                shown.push_str(&format!(" for selector {selector}"));
            }
            shown
        })
        .collect()
}

/// What keeps the pod from running, the worst first, each with the section
/// it is about, if one; and the conditions only a finding that says their
/// cause explains.
fn findings(input: &Input<'_>) -> (Vec<(Finding, Option<&'static str>)>, Vec<&'static str>) {
    let pod = input.object;
    let status = &pod["status"];
    let mut findings = Vec::new();
    let mut explained = Vec::new();
    if status["phase"] == "Failed" {
        let reason = text(&status["reason"]);
        let own = message(&status["message"]);
        let (cause, why) = if own.is_some() || disrupted_after(pod) {
            (None, None)
        } else {
            disruption(pod)
        };
        if own.is_some() || cause.is_some() || why.is_some() {
            explained.push(DISRUPTION);
        }
        let detail = cause
            .map(|cause| span(&format!("{DISRUPTION}: {cause}.")))
            .into_iter()
            .collect();
        findings.push((
            Finding {
                logs: None,
                tone: Tone::Danger,
                title: match reason.as_deref() {
                    Some("Evicted") => "The pod was evicted".to_owned(),
                    Some(reason) => format!("The pod failed: {reason}"),
                    None => "The pod failed".to_owned(),
                },
                detail,
                message: own.or(why),
            },
            None,
        ));
    }
    if status["phase"] == "Unknown" {
        findings.push((
            Finding {
                logs: None,
                tone: Tone::Warning,
                title: "Its node does not report the pod's state".to_owned(),
                detail: Vec::new(),
                message: message(&status["message"]),
            },
            None,
        ));
    }
    if let Some((terminating, disruption)) = terminating(pod) {
        explained.extend(disruption.then_some(DISRUPTION));
        findings.push((terminating, None));
    }
    if let Some(creating) = creating(input) {
        findings.push(creating);
    }
    if let Some(scheduled) = condition(pod, "PodScheduled")
        && scheduled["status"] == "False"
    {
        let mut detail = Vec::new();
        if let Some(at) = text(&scheduled["lastTransitionTime"]) {
            detail.push(span("Waiting since "));
            detail.push(Span::Ago { at });
            detail.push(span("."));
        }
        findings.push((
            Finding {
                logs: None,
                tone: Tone::Danger,
                title: "The pod cannot be scheduled".to_owned(),
                detail,
                message: message(&scheduled["message"]),
            },
            Some(PLACEMENT),
        ));
    }
    let groups = [
        ("initContainers", "initContainerStatuses", "Init container"),
        ("containers", "containerStatuses", "Container"),
    ];
    for (specs, statuses, noun) in groups {
        for status in status[statuses].as_array().into_iter().flatten() {
            let name = status["name"].as_str().unwrap_or_default();
            let sidecar = pod["spec"][specs]
                .as_array()
                .into_iter()
                .flatten()
                .any(|spec| spec["name"] == name && spec["restartPolicy"] == "Always");
            let noun = if sidecar { "Sidecar" } else { noun };
            findings.extend(
                container(input, status, noun, specs == "containers" || sidecar)
                    .map(|finding| (finding, Some(CONTAINERS))),
            );
        }
    }
    findings.sort_by_key(|(finding, _)| finding.tone != Tone::Danger);
    (findings, explained)
}

const DISRUPTION: &str = "DisruptionTarget";

/// Why the pod is disrupted, where its DisruptionTarget is True: the reason
/// and the message of an eviction, a preemption, the taint manager's
/// deletion or Pod GC's of an orphaned pod
/// ([`gc_controller.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/controller/podgc/gc_controller.go#L253-L259)).
fn disruption(pod: &Value) -> (Option<String>, Option<String>) {
    let target = condition(pod, DISRUPTION).filter(|target| target["status"] == "True");
    (
        target.and_then(|target| text(&target["reason"])),
        target.and_then(|target| message(&target["message"])),
    )
}

/// Whether the pod's DisruptionTarget came after its containers' last
/// finish. The eviction API marks a pod that has finished all the same
/// before it deletes it
/// ([`eviction.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/core/pod/storage/eviction.go#L318-L356)),
/// so such a disruption is not why the pod failed.
fn disrupted_after(pod: &Value) -> bool {
    let at = |value: &Value| value.as_str().and_then(|at| at.parse::<Timestamp>().ok());
    let finish = ["initContainerStatuses", "containerStatuses"]
        .into_iter()
        .flat_map(|statuses| pod["status"][statuses].as_array().into_iter().flatten())
        .filter_map(|status| at(&status["state"]["terminated"]["finishedAt"]))
        .max();
    let disrupted = condition(pod, DISRUPTION)
        .filter(|target| target["status"] == "True")
        .and_then(|target| at(&target["lastTransitionTime"]));
    matches!((disrupted, finish), (Some(disrupted), Some(finish)) if disrupted > finish)
}

/// A pod asked to stop that has not finished: since when, and how long it
/// may take, as kubectl prints `Terminating (lasts …)` and its grace period;
/// and why, where its DisruptionTarget is True: the reason and the message
/// of an eviction, a preemption or the taint manager's deletion, which
/// `kubectl drain` leaves on a pod that still runs. Whether the finding
/// says that cause comes with it.
fn terminating(pod: &Value) -> Option<(Finding, bool)> {
    let metadata = &pod["metadata"];
    let deadline: Timestamp = metadata["deletionTimestamp"].as_str()?.parse().ok()?;
    if finished(pod) {
        return None;
    }
    let grace = metadata["deletionGracePeriodSeconds"]
        .as_i64()
        .unwrap_or_default();
    let asked = deadline - SignedDuration::from_secs(grace);
    let mut detail = vec![
        span("Asked to stop "),
        Span::Ago {
            at: asked.to_string(),
        },
    ];
    detail.push(span(&format!(", with a grace period of {grace} s.")));
    let (reason, why) = disruption(pod);
    if let Some(reason) = &reason {
        detail.push(span(&format!(" {DISRUPTION}: {reason}.")));
    }
    let stated = reason.is_some() || why.is_some();
    let finalizers: Vec<&str> = metadata["finalizers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let lines: Vec<String> = why
        .into_iter()
        .chain((!finalizers.is_empty()).then(|| format!("Finalizers: {}", finalizers.join(", "))))
        .collect();
    Some((
        Finding {
            logs: None,
            tone: Tone::Warning,
            title: "The pod is terminating".to_owned(),
            detail,
            message: (!lines.is_empty()).then(|| lines.join("\n")),
        },
        stated,
    ))
}

/// Event reasons that keep a pod's containers from being created, by what
/// they say (kubernetes v1.37.1 `pkg/kubelet/events`): the kubelet's, and
/// the attach/detach controller's FailedAttachVolume.
const CREATING: &[(&str, &str)] = &[
    ("FailedMount", "A volume of the pod cannot be mounted"),
    (
        "FailedAttachVolume",
        "A volume of the pod cannot be attached",
    ),
    (
        "FailedCreatePodSandBox",
        "The pod's sandbox cannot be created",
    ),
];

/// A pod whose containers cannot start, as its sandbox is not ready:
/// PodReadyToStartContainers is False until the sandbox is made with its
/// network, and the kubelet mounts the volumes before it asks for one
/// (kubernetes v1.37.1 status/generate.go, kubelet.go SyncPod); and the
/// pod's newest event is the warning that says why. A pod that runs or
/// crash-loops has its sandbox, so a remount that fails under it, which the
/// kubelet tries on every sync, finds nothing; nor does a warning that
/// passed, followed by an image's pull, nor one under a pod that finished,
/// whose sandbox the kubelet stops.
fn creating(input: &Input<'_>) -> Option<(Finding, Option<&'static str>)> {
    if finished(input.object) {
        return None;
    }
    let sandbox = condition(input.object, "PodReadyToStartContainers")?;
    if sandbox["status"] != "False" {
        return None;
    }
    let event = input.events.events.first()?;
    let (reason, title) = CREATING
        .iter()
        .find(|(reason, _)| event.kind == "Warning" && event.reason == *reason)?;
    let mut detail = vec![span(&event.reason)];
    if event.count > 1 {
        detail.push(span(&format!(", {} times", event.count)));
    }
    if let Some(at) = &event.last {
        detail.push(span(", last "));
        detail.push(Span::Ago { at: at.clone() });
    }
    detail.push(span("."));
    Some((
        Finding {
            logs: None,
            tone: Tone::Danger,
            title: (*title).to_owned(),
            detail,
            message: Some(event.message.trim().to_owned()),
        },
        (*reason != "FailedCreatePodSandBox").then_some(STORAGE),
    ))
}

fn finished(pod: &Value) -> bool {
    matches!(
        pod["status"]["phase"].as_str(),
        Some("Succeeded" | "Failed")
    )
}

fn condition<'a>(object: &'a Value, kind: &str) -> Option<&'a Value> {
    object["status"]["conditions"]
        .as_array()?
        .iter()
        .find(|condition| condition["type"] == kind)
}

fn span(text: &str) -> Span {
    Span::Text {
        text: text.to_owned(),
    }
}

/// What is wrong with one container: it keeps crashing, its image cannot
/// be pulled, it cannot be created, it failed, or it runs but is not ready;
/// with its logs, whose previous instance's last line twigo-core reads.
fn container(input: &Input<'_>, status: &Value, noun: &str, serving: bool) -> Option<Finding> {
    let name = status["name"].as_str().unwrap_or_default();
    let state = &status["state"];
    let waiting = &state["waiting"];
    let reason = waiting["reason"].as_str().unwrap_or_default();
    let last = &status["lastState"]["terminated"];
    let logs = Some(FindingLogs {
        container: name.to_owned(),
        previous: last.is_object(),
        last_line: None,
    });
    match reason {
        "CrashLoopBackOff" => {
            let mut detail = vec![span(&exited(last))];
            let restarts = status["restartCount"].as_u64().unwrap_or_default();
            detail.push(span(&match restarts {
                1 => ", 1 restart".to_owned(),
                count => format!(", {count} restarts"),
            }));
            let finished = text(&last["finishedAt"]);
            if let Some(at) = &finished {
                detail.push(span(", last "));
                detail.push(Span::Ago { at: at.clone() });
            }
            detail.push(span("."));
            if let Some(next) =
                finished.and_then(|at| next_start(&at, waiting["message"].as_str()?))
            {
                detail.push(span(" Next start "));
                detail.push(Span::Until { at: next });
                detail.push(span("."));
            }
            Some(Finding {
                logs: logs.clone(),
                tone: Tone::Danger,
                title: format!("{noun} {name} keeps crashing"),
                detail,
                message: message(&last["message"]),
            })
        }
        "ImagePullBackOff" | "ErrImagePull" | "ErrImageNeverPull" | "InvalidImageName"
        | "ImageInspectError" => Some(Finding {
            logs: logs.clone(),
            tone: Tone::Danger,
            title: format!(
                "The image of {} {name} cannot be pulled",
                noun.to_lowercase()
            ),
            detail: text(&status["image"])
                .map(|image| vec![span(&image)])
                .unwrap_or_default(),
            message: message(&waiting["message"]),
        }),
        "CreateContainerConfigError"
        | "CreateContainerError"
        | "RunContainerError"
        | "PreCreateHookError"
        | "PreStartHookError"
        | "PostStartHookError" => Some(Finding {
            logs: logs.clone(),
            tone: Tone::Danger,
            title: format!("{noun} {name} cannot start"),
            detail: vec![span(reason)],
            message: message(&waiting["message"]),
        }),
        _ if state["terminated"].is_object()
            && state["terminated"]["exitCode"]
                .as_i64()
                .is_some_and(|code| code != 0) =>
        {
            let terminated = &state["terminated"];
            let mut detail = vec![span(&exited(terminated))];
            if let Some(at) = text(&terminated["finishedAt"]) {
                detail.push(span(" "));
                detail.push(Span::Ago { at });
            }
            detail.push(span("."));
            Some(Finding {
                logs: logs.clone(),
                tone: Tone::Danger,
                title: format!("{noun} {name} failed"),
                detail,
                message: message(&terminated["message"]),
            })
        }
        _ if serving
            && state["running"].is_object()
            && status["ready"].as_bool() == Some(false)
            && input.object["metadata"]["deletionTimestamp"].is_null() =>
        {
            let mut detail = Vec::new();
            if let Some(at) = text(&state["running"]["startedAt"]) {
                detail.push(span("Running since "));
                detail.push(Span::Ago { at });
                detail.push(span("."));
            }
            let field = format!("spec.containers{{{name}}}");
            let probe = input
                .events
                .events
                .iter()
                .find(|event| {
                    event.kind == "Warning"
                        && event.reason == "Unhealthy"
                        && event.field_path.as_deref() == Some(field.as_str())
                })
                .map(|event| event.message.trim().to_owned());
            Some(Finding {
                logs: logs.clone(),
                tone: Tone::Warning,
                title: format!("{noun} {name} is not ready"),
                detail,
                message: probe,
            })
        }
        _ => None,
    }
}

/// How a container ended: `Exited with code 1`, `Killed for running out
/// of memory (exit code 137)`.
fn exited(terminated: &Value) -> String {
    let code = terminated["exitCode"].as_i64().unwrap_or_default();
    match terminated["reason"].as_str() {
        Some("OOMKilled") => format!("Killed for running out of memory (exit code {code})"),
        Some("Error") | None => format!("Exited with code {code}"),
        Some(reason) => format!("{reason}, exit code {code}"),
    }
}

/// The tone of a pod's Status column, as the pod list gives it (its
/// `podStatus` rule in `packages/kube/src/columns.ts`, over the statuses
/// printPod prints in kubernetes v1.37.1): neutral once it runs or
/// completed, a warning while it waits or its init containers run, danger
/// otherwise, since kubelets, runtimes and admission keep adding reasons.
pub fn status_tone(status: &str) -> Tone {
    const HEALTHY: &[&str] = &["Running", "Completed", "Succeeded", "ExitCode:0"];
    const WAITING: &[&str] = &[
        "Pending",
        "ContainerCreating",
        "PodInitializing",
        "SchedulingGated",
        "NotReady",
        "Terminating",
        "RestartingAllContainers",
    ];
    let init = status.strip_prefix("Init:");
    let running_inits =
        init.and_then(|counts| counts.split_once('/'))
            .is_some_and(|(done, all)| {
                [done, all]
                    .iter()
                    .all(|count| !count.is_empty() && count.bytes().all(|b| b.is_ascii_digit()))
            });
    let state = init.unwrap_or(status);
    if running_inits || WAITING.contains(&state) {
        Tone::Warning
    } else if HEALTHY.contains(&state) {
        Tone::Neutral
    } else {
        Tone::Danger
    }
}

/// When the kubelet starts a crashing container again: its back-off after
/// the last exit, which it names in the waiting message as Go writes a
/// duration (kubernetes v1.37.1, `kuberuntime_manager.go` `doBackOff`:
/// `back-off 5m0s restarting failed container=…`), a form jiff's friendly
/// format reads; none past jiff's range, which a crafted message reaches.
pub fn next_start(finished: &str, message: &str) -> Option<String> {
    let backoff: SignedDuration = message
        .strip_prefix("back-off ")?
        .split_once(' ')?
        .0
        .parse()
        .ok()?;
    let finished: Timestamp = finished.parse().ok()?;
    Some(finished.checked_add(backoff).ok()?.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_takes_the_pod_lists_tone() {
        assert_eq!(status_tone("Running"), Tone::Neutral);
        assert_eq!(status_tone("Completed"), Tone::Neutral);
        assert_eq!(status_tone("Init:ExitCode:0"), Tone::Neutral);
        assert_eq!(status_tone("ContainerCreating"), Tone::Warning);
        assert_eq!(status_tone("Init:1/3"), Tone::Warning);
        assert_eq!(status_tone("Terminating"), Tone::Warning);
        assert_eq!(status_tone("CrashLoopBackOff"), Tone::Danger);
        assert_eq!(status_tone("Init:CrashLoopBackOff"), Tone::Danger);
        assert_eq!(status_tone("OutOfcpu"), Tone::Danger);
    }

    #[test]
    fn the_next_start_is_the_back_off_after_the_last_exit() {
        assert_eq!(
            next_start(
                "2026-11-03T10:00:00Z",
                "back-off 2m40s restarting failed container=api pod=api-0_default(5c2f)"
            )
            .as_deref(),
            Some("2026-11-03T10:02:40Z")
        );
        assert_eq!(
            next_start("2026-11-03T10:00:00Z", "back-off 1h0m0s restarting failed").as_deref(),
            Some("2026-11-03T11:00:00Z")
        );
        assert_eq!(
            next_start("2026-11-03T10:00:00Z", "Back-off pulling image"),
            None
        );
        assert_eq!(
            next_start(
                "2026-11-03T10:00:00Z",
                "back-off 99999999999h restarting failed"
            ),
            None
        );
    }
}
