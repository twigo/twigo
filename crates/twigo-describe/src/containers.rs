//! Containers as kubectl describes them (kubectl v1.37.1,
//! `describeContainers`): a pod's with their states, or a pod template's
//! without.

use serde_json::Value;
use twigo_ipc::{Block, Container, ContainerRole, ContainerState, Field, Tone, Value as Shown};

use crate::show::{CONFIG_MAP, Fields, SECRET, Summary, code, link, plain, quantities};
use crate::{message, text};
use twigo_quantity::{Quantity, div_ceil};

/// Waiting reasons that the kubelet keeps a container in until something
/// changes: its image, its configuration or its process.
const STUCK: &[&str] = &[
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "ErrImageNeverPull",
    "InvalidImageName",
    "ImageInspectError",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
    "PreCreateHookError",
    "PreStartHookError",
    "PostStartHookError",
];

/// The block of a pod's containers: init containers and sidecars first,
/// then the regular ones, then the ephemeral ones. `pod` is None for a pod
/// template, whose containers have no status and whose environment's
/// field references resolve to nothing.
pub(crate) fn block(spec: &Value, pod: Option<&Value>) -> Option<Block> {
    let status = pod.map(|pod| &pod["status"]);
    let namespace = pod.and_then(|pod| text(&pod["metadata"]["namespace"]));
    let groups = [
        (
            "initContainers",
            "initContainerStatuses",
            ContainerRole::Init,
        ),
        ("containers", "containerStatuses", ContainerRole::Regular),
        (
            "ephemeralContainers",
            "ephemeralContainerStatuses",
            ContainerRole::Ephemeral,
        ),
    ];
    let mut containers = Vec::new();
    for (key, statuses, role) in groups {
        for container in spec[key].as_array().into_iter().flatten() {
            let name = container["name"].as_str().unwrap_or_default();
            let role = if role == ContainerRole::Init && container["restartPolicy"] == "Always" {
                ContainerRole::Sidecar
            } else {
                role
            };
            let status = status.and_then(|status| {
                status[statuses]
                    .as_array()?
                    .iter()
                    .find(|status| status["name"] == name)
            });
            containers.push(describe(container, role, status, pod, namespace.as_deref()));
        }
    }
    (!containers.is_empty()).then_some(Block::Containers { containers })
}

fn describe(
    container: &Value,
    role: ContainerRole,
    status: Option<&Value>,
    pod: Option<&Value>,
    namespace: Option<&str>,
) -> Container {
    let mut fields = Fields::default();
    let mut details = Fields::default();
    if let Some(status) = status {
        let state = &status["state"];
        let last = if state["terminated"].is_object() {
            &state["terminated"]
        } else {
            &status["lastState"]["terminated"]
        };
        if state["terminated"].is_object() {
            fields.maybe("Exited", exit(&state["terminated"], false));
        }
        if status["lastState"]["terminated"].is_object() {
            fields.maybe("Last exit", exit(&status["lastState"]["terminated"], true));
        }
        let ran = if state["running"].is_object() {
            &state["running"]
        } else {
            &state["terminated"]
        };
        details.time("Started", &ran["startedAt"]);
        if last.is_object() {
            details.maybe("Last message", message(&last["message"]).map(plain));
        }
    }
    details.maybe("Requests", quantities(&container["resources"]["requests"]));
    details.maybe("Limits", quantities(&container["resources"]["limits"]));
    details.maybe("Command", argv(&container["command"]));
    details.maybe("Args", argv(&container["args"]));
    details.text("Working directory", &container["workingDir"]);
    let image = container["image"].as_str().unwrap_or_default();
    details.add_default_maybe(
        "Image pull policy",
        text(&container["imagePullPolicy"]).map(plain),
        container["imagePullPolicy"] == pull_policy(image),
    );
    for (label, key) in [
        ("Liveness", "livenessProbe"),
        ("Readiness", "readinessProbe"),
        ("Startup", "startupProbe"),
    ] {
        if container[key].is_object() {
            details.add(label, code(probe(&container[key])));
        }
    }
    details.maybe(
        "Security",
        security(&container["securityContext"]).map(plain),
    );
    if let Some(status) = status {
        details.maybe("Image ID", text(&status["imageID"]).map(code));
        details.maybe("Container ID", text(&status["containerID"]).map(code));
    }
    Container {
        name: text(&container["name"]).unwrap_or_default(),
        role,
        image: text(&container["image"]).unwrap_or_default(),
        state: status.map(|status| state(status, role)),
        ports: ports(&container["ports"]),
        fields: fields.0,
        details: details.0,
        env: env(container, pod, namespace),
        mounts: mounts(container),
    }
}

/// The pull policy the API server gives a container that sets none: `Always`
/// for the tag `latest` and for an image with neither a tag nor a digest,
/// else `IfNotPresent` (kubernetes v1.37.0,
/// [`SetDefaults_Container`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/apis/core/v1/defaults.go#L82-L93) over
/// [`ParseImageName`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/util/parsers/parsers.go#L32-L55)).
fn pull_policy(image: &str) -> &'static str {
    let (name, digest) = image
        .split_once('@')
        .map_or((image, false), |(name, _)| (name, true));
    let tag = name
        .rsplit('/')
        .next()
        .and_then(|last| last.split_once(':'))
        .map(|(_, tag)| tag);
    match tag {
        Some("latest") => "Always",
        None if !digest => "Always",
        _ => "IfNotPresent",
    }
}

/// The state as one line: a container that serves, a regular one or a
/// sidecar, is not ready while it runs unready; an init or ephemeral one
/// that runs is simply running.
fn state(status: &Value, role: ContainerRole) -> ContainerState {
    let state = &status["state"];
    let ready = status["ready"].as_bool() == Some(true);
    let serves = matches!(role, ContainerRole::Regular | ContainerRole::Sidecar);
    let (text, tone) = if state["running"].is_object() {
        match (serves, ready) {
            (true, true) => ("Running".to_owned(), Tone::Success),
            (true, false) => ("Running · not ready".to_owned(), Tone::Warning),
            (false, _) => ("Running".to_owned(), Tone::Neutral),
        }
    } else if let Some(waiting) = state["waiting"].as_object() {
        let reason = waiting.get("reason").and_then(Value::as_str).unwrap_or("");
        let tone = if STUCK.contains(&reason) {
            Tone::Danger
        } else {
            Tone::Neutral
        };
        (
            if reason.is_empty() {
                "Waiting".to_owned()
            } else {
                format!("Waiting · {reason}")
            },
            tone,
        )
    } else if state["terminated"].is_object() {
        let terminated = &state["terminated"];
        let tone = if terminated["exitCode"].as_i64() == Some(0) {
            Tone::Neutral
        } else {
            Tone::Danger
        };
        (
            crate::text(&terminated["reason"]).map_or_else(
                || "Terminated".to_owned(),
                |reason| format!("Terminated · {reason}"),
            ),
            tone,
        )
    } else {
        ("Waiting".to_owned(), Tone::Neutral)
    };
    ContainerState {
        text,
        tone,
        ready,
        running: state["running"].is_object(),
        restarts: status["restartCount"]
            .as_u64()
            .and_then(|count| u32::try_from(count).ok())
            .unwrap_or_default(),
    }
}

/// `code 1 (Error) · 11d ago`: how a container ended and when; None without
/// an exit code. A container that is terminated now has its reason in its
/// state, so its row leaves it out: `code 1 · 11d ago`.
fn exit(terminated: &Value, with_reason: bool) -> Option<Shown> {
    let mut how = format!("code {}", terminated["exitCode"].as_i64()?);
    if let Some(signal) = terminated["signal"].as_i64().filter(|signal| *signal > 0) {
        how.push_str(&format!(", signal {signal}"));
    }
    if let Some(reason) = text(&terminated["reason"]).filter(|_| with_reason) {
        how.push_str(&format!(" ({reason})"));
    }
    let summary = Summary::default().part(how);
    let spans = match text(&terminated["finishedAt"]) {
        Some(at) => summary.ago("", at),
        None => summary,
    };
    Some(Shown::Spans {
        spans: spans.done(),
    })
}

/// One `code` item per element, even for one, since an element may hold a
/// line end, which a copy of the command line must quote and not mistake
/// for the end of an element.
fn argv(list: &Value) -> Option<Shown> {
    let items: Vec<Shown> = list
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(code)
        .collect();
    (!items.is_empty()).then_some(Shown::List { items })
}

/// `8080/TCP (http)`, with its host port when it has one.
fn ports(ports: &Value) -> Vec<String> {
    ports
        .as_array()
        .into_iter()
        .flatten()
        .map(|port| {
            let number = crate::show::scalar(&port["containerPort"]).unwrap_or_default();
            let protocol = port["protocol"].as_str().unwrap_or("TCP");
            let mut shown = format!("{number}/{protocol}");
            if let Some(name) = text(&port["name"]) {
                shown.push_str(&format!(" ({name})"));
            }
            if let Some(host) = port["hostPort"].as_u64().filter(|port| *port > 0) {
                shown.push_str(&format!(", host {host}"));
            }
            shown
        })
        .collect()
}

/// A probe as kubectl's `DescribeProbe` prints it.
pub(crate) fn probe(probe: &Value) -> String {
    let number = |key: &str| probe[key].as_i64().unwrap_or_default();
    let attrs = format!(
        "delay={}s timeout={}s period={}s successThreshold={} failureThreshold={}",
        number("initialDelaySeconds"),
        number("timeoutSeconds"),
        number("periodSeconds"),
        number("successThreshold"),
        number("failureThreshold"),
    );
    let port = |value: &Value| crate::show::scalar(value).unwrap_or_default();
    if let Some(exec) = probe["exec"].as_object() {
        let command: Vec<&str> = exec
            .get("command")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        format!("exec [{}] {attrs}", command.join(" "))
    } else if probe["httpGet"].is_object() {
        let get = &probe["httpGet"];
        let scheme = get["scheme"]
            .as_str()
            .unwrap_or("HTTP")
            .to_ascii_lowercase();
        let host = get["host"].as_str().unwrap_or_default();
        let port = port(&get["port"]);
        let host = if port.is_empty() {
            host.to_owned()
        } else if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        let path = get["path"].as_str().unwrap_or_default();
        format!("http-get {scheme}://{host}{path} {attrs}")
    } else if probe["tcpSocket"].is_object() {
        let socket = &probe["tcpSocket"];
        format!(
            "tcp-socket {}:{} {attrs}",
            socket["host"].as_str().unwrap_or_default(),
            port(&socket["port"])
        )
    } else if probe["grpc"].is_object() {
        let grpc = &probe["grpc"];
        format!(
            "grpc <pod>:{} {} {attrs}",
            port(&grpc["port"]),
            grpc["service"].as_str().unwrap_or_default()
        )
    } else {
        format!("unknown {attrs}")
    }
}

/// What a security context sets, as a phrase: `user 1000, non-root,
/// read-only root filesystem, drop ALL`.
pub(crate) fn security(context: &Value) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(user) = context["runAsUser"].as_i64() {
        parts.push(format!("user {user}"));
    }
    if let Some(group) = context["runAsGroup"].as_i64() {
        parts.push(format!("group {group}"));
    }
    if let Some(group) = context["fsGroup"].as_i64() {
        parts.push(format!("fs group {group}"));
    }
    if context["runAsNonRoot"].as_bool() == Some(true) {
        parts.push("non-root".to_owned());
    }
    if context["privileged"].as_bool() == Some(true) {
        parts.push("privileged".to_owned());
    }
    if context["readOnlyRootFilesystem"].as_bool() == Some(true) {
        parts.push("read-only root filesystem".to_owned());
    }
    if context["allowPrivilegeEscalation"].as_bool() == Some(false) {
        parts.push("no privilege escalation".to_owned());
    }
    for (key, verb) in [("add", "add"), ("drop", "drop")] {
        let capabilities: Vec<&str> = context["capabilities"][key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if !capabilities.is_empty() {
            parts.push(format!("{verb} {}", capabilities.join(" ")));
        }
    }
    if let Some(kind) = text(&context["seccompProfile"]["type"]) {
        match text(&context["seccompProfile"]["localhostProfile"]) {
            Some(profile) => parts.push(format!("seccomp {kind} {profile}")),
            None => parts.push(format!("seccomp {kind}")),
        }
    }
    if let Some(kind) = text(&context["appArmorProfile"]["type"]) {
        parts.push(format!("AppArmor {kind}"));
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// The environment by variable, then its sources of many variables, each
/// reference to a ConfigMap or Secret a link (kubectl v1.37.1,
/// `describeContainerEnvVars` and `describeContainerEnvFrom`); a Secret's
/// value is never read.
fn env(container: &Value, pod: Option<&Value>, namespace: Option<&str>) -> Vec<Field> {
    let mut fields = Vec::new();
    for variable in container["env"].as_array().into_iter().flatten() {
        let name = text(&variable["name"]).unwrap_or_default();
        let from = &variable["valueFrom"];
        let value = if !from.is_object() {
            plain(variable["value"].as_str().unwrap_or_default())
        } else if from["fieldRef"].is_object() {
            let path = from["fieldRef"]["fieldPath"].as_str().unwrap_or_default();
            match pod.and_then(|pod| field_path(pod, path)) {
                Some(value) => plain(format!("{value} (from {path})")),
                None => plain(format!("from {path}")),
            }
        } else if from["resourceFieldRef"].is_object() {
            plain(resource_field(container, &from["resourceFieldRef"]))
        } else if from["secretKeyRef"].is_object() {
            key_ref(&from["secretKeyRef"], SECRET, "secret", namespace)
        } else if from["configMapKeyRef"].is_object() {
            key_ref(
                &from["configMapKeyRef"],
                CONFIG_MAP,
                "config map",
                namespace,
            )
        } else {
            let source = from
                .as_object()
                .and_then(|from| from.keys().next())
                .cloned()
                .unwrap_or_default();
            plain(format!("from {source}"))
        };
        fields.push(Field {
            label: name,
            value,
            default: false,
        });
    }
    for source in container["envFrom"].as_array().into_iter().flatten() {
        let (kind, reference, noun) = if source["configMapRef"].is_object() {
            (CONFIG_MAP, &source["configMapRef"], "Config map")
        } else if source["secretRef"].is_object() {
            (SECRET, &source["secretRef"], "Secret")
        } else {
            continue;
        };
        let name = reference["name"].as_str().unwrap_or_default();
        let mut shown = format!("{noun} {name}");
        if let Some(prefix) = text(&source["prefix"]) {
            shown.push_str(&format!(" with prefix {prefix}"));
        }
        if reference["optional"].as_bool() == Some(true) {
            shown.push_str(", optional");
        }
        fields.push(Field {
            default: false,
            label: "From".to_owned(),
            value: link(kind, namespace, name, shown),
        });
    }
    fields
}

fn key_ref(
    reference: &Value,
    kind: (&str, &str, &str),
    noun: &str,
    namespace: Option<&str>,
) -> Shown {
    let name = reference["name"].as_str().unwrap_or_default();
    let key = reference["key"].as_str().unwrap_or_default();
    let mut shown = format!("key {key} of {noun} {name}");
    if reference["optional"].as_bool() == Some(true) {
        shown.push_str(", optional");
    }
    link(kind, namespace, name, shown)
}

/// The value of a pod field a variable reads, as the kubelet resolves the
/// paths a pod's `fieldRef` may name (kubernetes v1.37.1,
/// `pkg/apis/core/validation` `validEnvDownwardAPIFieldPathExpressions`).
fn field_path(pod: &Value, path: &str) -> Option<String> {
    let metadata = &pod["metadata"];
    let joined = |list: &Value| -> Option<String> {
        let ips: Vec<&str> = list
            .as_array()?
            .iter()
            .filter_map(|ip| ip["ip"].as_str())
            .collect();
        (!ips.is_empty()).then(|| ips.join(","))
    };
    if let Some(rest) = path
        .strip_prefix("metadata.labels['")
        .and_then(|rest| rest.strip_suffix("']"))
    {
        return text(&metadata["labels"][rest]);
    }
    if let Some(rest) = path
        .strip_prefix("metadata.annotations['")
        .and_then(|rest| rest.strip_suffix("']"))
    {
        return text(&metadata["annotations"][rest]);
    }
    match path {
        "metadata.name" => text(&metadata["name"]),
        "metadata.namespace" => text(&metadata["namespace"]),
        "metadata.uid" => text(&metadata["uid"]),
        "spec.nodeName" => text(&pod["spec"]["nodeName"]),
        "spec.serviceAccountName" => text(&pod["spec"]["serviceAccountName"]),
        "status.hostIP" => text(&pod["status"]["hostIP"]),
        "status.hostIPs" => joined(&pod["status"]["hostIPs"]),
        "status.podIP" => text(&pod["status"]["podIP"]),
        "status.podIPs" => joined(&pod["status"]["podIPs"]),
        _ => None,
    }
}

/// A variable from the container's resources, resolved as kubectl resolves
/// it (kubectl v1.37.1, `ExtractContainerResourceValue`): the quantity over
/// the divisor, rounded up, and an unset CPU or memory limit as the node's
/// allocatable.
fn resource_field(container: &Value, reference: &Value) -> String {
    let resource = reference["resource"].as_str().unwrap_or_default();
    let (class, name) = resource.split_once('.').unwrap_or(("", resource));
    let divisor = reference["divisor"]
        .as_str()
        .and_then(Quantity::parse)
        .filter(|divisor| divisor.milli() > 0)
        .unwrap_or(Quantity::ONE);
    let quantity = container["resources"][class][name]
        .as_str()
        .and_then(Quantity::parse);
    let value = quantity.map_or(0, |quantity| {
        if name == "cpu" {
            div_ceil(quantity.milli(), divisor.milli())
        } else {
            div_ceil(quantity.value(), divisor.value().max(1))
        }
    });
    let value = if value == 0 && class == "limits" && matches!(name, "cpu" | "memory") {
        "node allocatable".to_owned()
    } else {
        value.to_string()
    };
    format!("{value} (from {resource})")
}

/// By mount path: `data (rw, path="logs")`, then the devices.
fn mounts(container: &Value) -> Vec<Field> {
    let mut mounts: Vec<&Value> = container["volumeMounts"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    mounts.sort_by_key(|mount| mount["mountPath"].as_str().unwrap_or_default());
    let mut fields: Vec<Field> = mounts
        .into_iter()
        .map(|mount| {
            let mut flags = vec![if mount["readOnly"].as_bool() == Some(true) {
                "ro".to_owned()
            } else {
                "rw".to_owned()
            }];
            if let Some(path) = text(&mount["subPath"]).or_else(|| text(&mount["subPathExpr"])) {
                flags.push(format!("path={path:?}"));
            }
            Field {
                default: false,
                label: text(&mount["mountPath"]).unwrap_or_default(),
                value: plain(format!(
                    "{} ({})",
                    mount["name"].as_str().unwrap_or_default(),
                    flags.join(",")
                )),
            }
        })
        .collect();
    let mut devices: Vec<&Value> = container["volumeDevices"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    devices.sort_by_key(|device| device["devicePath"].as_str().unwrap_or_default());
    fields.extend(devices.into_iter().map(|device| Field {
        default: false,
        label: text(&device["devicePath"]).unwrap_or_default(),
        value: plain(format!(
            "{} (device)",
            device["name"].as_str().unwrap_or_default()
        )),
    }));
    fields
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use twigo_ipc::Span;

    use super::*;

    const FIRST: &str = "2026-11-01T10:00:00Z";
    const SECOND: &str = "2026-11-02T10:00:00Z";

    fn card(status: Value) -> Container {
        let spec = json!({ "containers": [{ "name": "api", "image": "api:1" }] });
        let mut status = status;
        status["name"] = json!("api");
        let pod = json!({
            "metadata": { "namespace": "default" },
            "status": { "containerStatuses": [status] },
        });
        let Some(Block::Containers { mut containers }) = block(&spec, Some(&pod)) else {
            panic!("a container");
        };
        containers.remove(0)
    }

    fn terminated(code: i64, reason: &str, finished: &str) -> Value {
        json!({ "exitCode": code, "reason": reason, "finishedAt": finished })
    }

    fn rows(card: &Container) -> Vec<(&str, String)> {
        card.fields
            .iter()
            .map(|field| {
                let Shown::Spans { spans } = &field.value else {
                    panic!("spans: {:?}", field.value);
                };
                let said = spans
                    .iter()
                    .map(|span| match span {
                        Span::Text { text } => text.clone(),
                        Span::Ago { at } | Span::Until { at } => format!("<{at}>"),
                    })
                    .collect();
                (field.label.as_str(), said)
            })
            .collect()
    }

    #[test]
    fn a_container_terminated_now_says_its_code_and_when_not_its_reason() {
        for (code, reason) in [(0, "Completed"), (1, "Error")] {
            let card = card(json!({
                "state": { "terminated": terminated(code, reason, SECOND) },
            }));
            assert_eq!(
                card.state.as_ref().map(|state| state.text.as_str()),
                Some(format!("Terminated · {reason}").as_str())
            );
            assert_eq!(
                rows(&card),
                [("Exited", format!("code {code} · <{SECOND}>"))],
                "{reason}"
            );
        }
    }

    #[test]
    fn a_signal_stays_in_the_row_of_a_container_terminated_now() {
        let mut ended = terminated(137, "Error", SECOND);
        ended["signal"] = json!(9);
        let card = card(json!({ "state": { "terminated": ended } }));
        assert_eq!(
            rows(&card),
            [("Exited", format!("code 137, signal 9 · <{SECOND}>"))]
        );
    }

    #[test]
    fn an_earlier_termination_stays_as_the_last_exit_with_its_reason() {
        for (code, reason) in [(0, "Completed"), (1, "Error")] {
            let card = card(json!({
                "state": { "terminated": terminated(code, reason, SECOND) },
                "lastState": { "terminated": terminated(137, "OOMKilled", FIRST) },
            }));
            assert_eq!(
                rows(&card),
                [
                    ("Exited", format!("code {code} · <{SECOND}>")),
                    ("Last exit", format!("code 137 (OOMKilled) · <{FIRST}>")),
                ],
                "{reason}"
            );
        }
    }

    #[test]
    fn a_running_or_waiting_container_keeps_its_last_exit_as_it_was() {
        for state in [
            json!({ "running": { "startedAt": SECOND } }),
            json!({ "waiting": { "reason": "CrashLoopBackOff" } }),
        ] {
            let card = card(json!({
                "state": state,
                "lastState": { "terminated": terminated(1, "Error", FIRST) },
            }));
            assert_eq!(
                rows(&card),
                [("Last exit", format!("code 1 (Error) · <{FIRST}>"))]
            );
        }
    }

    #[test]
    fn a_container_that_never_ended_has_no_row() {
        let card = card(json!({ "state": { "running": { "startedAt": SECOND } } }));
        assert!(card.fields.is_empty(), "{:?}", card.fields);
    }
}
