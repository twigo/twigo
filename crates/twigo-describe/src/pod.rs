//! Pods: what kubectl describe prints of them (kubectl v1.37.1,
//! `describePod`), and what is wrong with them in words.

use jiff::{SignedDuration, Timestamp};
use serde_json::Value;
use twigo_ipc::{Block, Finding, Section, Span, Tone, TreeNode, TreeValue, Value as Shown};

use crate::show::{
    Fields, NODE, SERVICE_ACCOUNT, code, labels, link, list, plain, quantities, toned,
};
use crate::{Described, Input, containers, message, printed, text, tree, volumes};

pub(crate) fn describe(input: &Input<'_>) -> Described {
    let pod = input.object;
    let spec = &pod["spec"];
    let namespace = text(&pod["metadata"]["namespace"]);
    let mut sections = vec![Section {
        id: "core.pod".to_owned(),
        title: "Pod".to_owned(),
        blocks: vec![Block::Fields {
            fields: fields(input).0,
        }],
    }];
    sections.extend(containers::block(spec, Some(pod)).map(|block| Section {
        id: "core.containers".to_owned(),
        title: "Containers".to_owned(),
        blocks: vec![block],
    }));
    sections.extend(
        volumes::block(spec, namespace.as_deref()).map(|block| Section {
            id: "core.volumes".to_owned(),
            title: "Volumes".to_owned(),
            blocks: vec![block],
        }),
    );
    sections.extend(scheduling(spec));
    Described {
        findings: findings(input),
        sections,
    }
}

fn fields(input: &Input<'_>) -> Fields {
    let pod = input.object;
    let spec = &pod["spec"];
    let status = &pod["status"];
    let namespace = text(&pod["metadata"]["namespace"]);
    let mut fields = Fields::default();
    let finished = matches!(status["phase"].as_str(), Some("Succeeded" | "Failed"));
    if pod["metadata"]["deletionTimestamp"].is_string() && !finished {
        fields.add("Phase", toned("Terminating", Tone::Warning));
    } else {
        fields.text("Phase", &status["phase"]);
    }
    fields.text("Reason", &status["reason"]);
    fields.text("Message", &status["message"]);
    if let Some(ready) = printed(input.printed, "Ready") {
        let all = ready
            .split_once('/')
            .is_some_and(|(have, want)| have == want);
        fields.add(
            "Ready",
            if all || finished {
                plain(ready)
            } else {
                toned(ready, Tone::Warning)
            },
        );
    }
    if let Some(node) = text(&spec["nodeName"]) {
        fields.add("Node", link(NODE, None, &node, node.clone()));
    }
    fields.maybe(
        "Host IP",
        ips(&status["hostIPs"], &status["hostIP"]).map(code),
    );
    fields.maybe("Pod IP", ips(&status["podIPs"], &status["podIP"]).map(code));
    fields.time("Started", &status["startTime"]);
    fields.text("QoS class", &status["qosClass"]);
    fields.scalar("Priority", &spec["priority"]);
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
        "Service account",
        text(&spec["serviceAccountName"])
            .map(|name| link(SERVICE_ACCOUNT, namespace.as_deref(), &name, name.clone())),
    );
    fields.text("Nominated node", &status["nominatedNodeName"]);
    fields.maybe("Readiness gates", readiness_gates(pod));
    fields.text("Restart policy", &spec["restartPolicy"]);
    fields.text("DNS policy", &spec["dnsPolicy"]);
    fields.flag("Host network", &spec["hostNetwork"]);
    fields.flag("Host PID", &spec["hostPID"]);
    fields.flag("Host IPC", &spec["hostIPC"]);
    fields.maybe(
        "Termination grace",
        spec["terminationGracePeriodSeconds"]
            .as_i64()
            .map(|seconds| plain(format!("{seconds} s"))),
    );
    fields.maybe(
        "Security",
        containers::security(&spec["securityContext"]).map(plain),
    );
    fields.maybe("Requests", quantities(&spec["resources"]["requests"]));
    fields.maybe("Limits", quantities(&spec["resources"]["limits"]));
    fields
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
fn readiness_gates(pod: &Value) -> Option<Shown> {
    list(
        pod["spec"]["readinessGates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|gate| {
                let kind = gate["conditionType"].as_str()?;
                let status = pod["status"]["conditions"]
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
/// as kubectl prints them, the scheduler when it is not the default, and
/// affinity, which kubectl leaves out, as a tree.
pub(crate) fn scheduling(spec: &Value) -> Option<Section> {
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
    if let Some(scheduler) = text(&spec["schedulerName"]).filter(|name| name != "default-scheduler")
    {
        fields.add("Scheduler", plain(scheduler));
    }
    let mut blocks = Vec::new();
    if !fields.is_empty() {
        blocks.push(Block::Fields { fields: fields.0 });
    }
    if let Some(nodes) = tree::nodes(&spec["affinity"]) {
        blocks.push(Block::Tree {
            nodes: vec![TreeNode {
                key: "affinity".to_owned(),
                label: "Affinity".to_owned(),
                value: TreeValue::Map { entries: nodes },
            }],
        });
    }
    (!blocks.is_empty()).then(|| Section {
        id: "core.scheduling".to_owned(),
        title: "Scheduling".to_owned(),
        blocks,
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

/// What keeps the pod from running, the worst first.
fn findings(input: &Input<'_>) -> Vec<Finding> {
    let pod = input.object;
    let status = &pod["status"];
    let mut findings = Vec::new();
    if status["phase"] == "Failed" {
        let reason = text(&status["reason"]);
        findings.push(Finding {
            tone: Tone::Danger,
            title: match reason.as_deref() {
                Some("Evicted") => "The pod was evicted".to_owned(),
                Some(reason) => format!("The pod failed: {reason}"),
                None => "The pod failed".to_owned(),
            },
            detail: Vec::new(),
            message: message(&status["message"]),
        });
    }
    if status["phase"] == "Unknown" {
        findings.push(Finding {
            tone: Tone::Warning,
            title: "Its node does not report the pod's state".to_owned(),
            detail: Vec::new(),
            message: message(&status["message"]),
        });
    }
    if let Some(terminating) = terminating(pod) {
        findings.push(terminating);
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
        findings.push(Finding {
            tone: Tone::Danger,
            title: "The pod cannot be scheduled".to_owned(),
            detail,
            message: message(&scheduled["message"]),
        });
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
            findings.extend(container(
                input,
                status,
                noun,
                specs == "containers" || sidecar,
            ));
        }
    }
    findings.sort_by_key(|finding| finding.tone != Tone::Danger);
    findings
}

/// A pod asked to stop that has not finished: since when, and how long it
/// may take, as kubectl prints `Terminating (lasts …)` and its grace period.
fn terminating(pod: &Value) -> Option<Finding> {
    let metadata = &pod["metadata"];
    let deadline: Timestamp = metadata["deletionTimestamp"].as_str()?.parse().ok()?;
    if matches!(
        pod["status"]["phase"].as_str(),
        Some("Succeeded" | "Failed")
    ) {
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
    let finalizers: Vec<&str> = metadata["finalizers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    Some(Finding {
        tone: Tone::Warning,
        title: "The pod is terminating".to_owned(),
        detail,
        message: (!finalizers.is_empty()).then(|| format!("Finalizers: {}", finalizers.join(", "))),
    })
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

/// Containers that cannot be created: none of them runs or has stopped now,
/// as the kubelet mounts volumes and makes the sandbox before it starts
/// them, and the pod's newest event is the warning that says why, so a
/// warning that passed, followed by an image's pull, finds nothing. A
/// container that ran before counts as waiting, as one does whose sandbox
/// the kubelet makes again after its node restarted.
fn creating(input: &Input<'_>) -> Option<Finding> {
    let status = &input.object["status"];
    let statuses: Vec<&Value> = ["initContainerStatuses", "containerStatuses"]
        .iter()
        .flat_map(|key| status[*key].as_array().into_iter().flatten())
        .collect();
    let started = statuses.iter().any(|container| {
        container["state"]["running"].is_object() || container["state"]["terminated"].is_object()
    });
    if statuses.is_empty() || started {
        return None;
    }
    let event = input.events.events.first()?;
    let (_, title) = CREATING
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
    Some(Finding {
        tone: Tone::Danger,
        title: (*title).to_owned(),
        detail,
        message: Some(event.message.trim().to_owned()),
    })
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
/// be pulled, it cannot be created, it failed, or it runs but is not ready.
fn container(input: &Input<'_>, status: &Value, noun: &str, serving: bool) -> Option<Finding> {
    let name = status["name"].as_str().unwrap_or_default();
    let state = &status["state"];
    let waiting = &state["waiting"];
    let reason = waiting["reason"].as_str().unwrap_or_default();
    let last = &status["lastState"]["terminated"];
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
                tone: Tone::Danger,
                title: format!("{noun} {name} keeps crashing"),
                detail,
                message: message(&last["message"]),
            })
        }
        "ImagePullBackOff" | "ErrImagePull" | "ErrImageNeverPull" | "InvalidImageName"
        | "ImageInspectError" => Some(Finding {
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

/// When the kubelet starts a crashing container again: its back-off after
/// the last exit, which it names in the waiting message as Go writes a
/// duration (kubernetes v1.37.1, `kuberuntime_manager.go` `doBackOff`:
/// `back-off 5m0s restarting failed container=…`), a form jiff's friendly
/// format reads.
fn next_start(finished: &str, message: &str) -> Option<String> {
    let backoff: SignedDuration = message
        .strip_prefix("back-off ")?
        .split_once(' ')?
        .0
        .parse()
        .ok()?;
    let finished: Timestamp = finished.parse().ok()?;
    Some((finished + backoff).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
