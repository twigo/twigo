//! Nodes: what kubectl describe prints of them (kubectl v1.37.1,
//! `describeNode`), its pods as a live list, and what is wrong with it.

use std::collections::BTreeMap;

use serde_json::Value;
use twigo_ipc::{Block, EmbeddedList, Finding, Gvr, Section, Span, Tone, Value as Shown};

use crate::quantity::Quantity;
use crate::show::{Fields, POD, code, link, list, plain, toned};
use crate::workloads::fact;
use crate::{Described, Found, Input, Need, text};

const ROLE: &str = "node-role.kubernetes.io/";

fn pods_need(node: &Value) -> Need {
    Need {
        group: String::new(),
        version: "v1".to_owned(),
        resource: "pods".to_owned(),
        namespaced: true,
        namespace: None,
        field_selector: Some(on(node)),
    }
}

fn lease_need(node: &Value) -> Need {
    Need {
        group: "coordination.k8s.io".to_owned(),
        version: "v1".to_owned(),
        resource: "leases".to_owned(),
        namespaced: true,
        namespace: Some("kube-node-lease".to_owned()),
        field_selector: Some(format!(
            "metadata.name={}",
            node["metadata"]["name"].as_str().unwrap_or_default()
        )),
    }
}

/// The field selector of the node's pods.
fn on(node: &Value) -> String {
    format!(
        "spec.nodeName={}",
        node["metadata"]["name"].as_str().unwrap_or_default()
    )
}

pub(crate) fn needs(node: &Value) -> Vec<Need> {
    vec![pods_need(node), lease_need(node)]
}

pub(crate) fn describe(input: &Input<'_>) -> Described {
    let node = input.object;
    let spec = &node["spec"];
    let status = &node["status"];
    let info = &status["nodeInfo"];
    let mut fields = Fields::default();
    fields.maybe("Roles", roles(node).map(plain));
    if spec["unschedulable"].as_bool() == Some(true) {
        fields.add("Unschedulable", toned("true", Tone::Warning));
    }
    fields.maybe("Taints", taints(&spec["taints"]));
    if let Some(Found::Listed { objects }) = fact(input.facts, &lease_need(node))
        && let Some(lease) = objects.first()
    {
        fields.text("Lease holder", &lease["spec"]["holderIdentity"]);
        fields.time("Lease renewed", &lease["spec"]["renewTime"]);
    }
    fields.maybe(
        "Addresses",
        list(
            status["addresses"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|address| {
                    code(format!(
                        "{}: {}",
                        address["type"].as_str().unwrap_or_default(),
                        address["address"].as_str().unwrap_or_default()
                    ))
                })
                .collect(),
        ),
    );
    fields.maybe(
        "Pod CIDRs",
        list(
            spec["podCIDRs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(code)
                .collect(),
        ),
    );
    fields.maybe("Provider ID", text(&spec["providerID"]).map(code));
    let mut system = Fields::default();
    system.text("Kubelet", &info["kubeletVersion"]);
    system.text("Container runtime", &info["containerRuntimeVersion"]);
    system.text("OS image", &info["osImage"]);
    system.text("Kernel", &info["kernelVersion"]);
    if let (Some(os), Some(arch)) = (text(&info["operatingSystem"]), text(&info["architecture"])) {
        system.add("Platform", plain(format!("{os}/{arch}")));
    }
    system.maybe("Machine ID", text(&info["machineID"]).map(code));
    system.maybe("System UUID", text(&info["systemUUID"]).map(code));
    system.maybe("Boot ID", text(&info["bootID"]).map(code));

    let pods = fact(input.facts, &pods_need(node));
    let running: Option<Vec<&Value>> = match pods {
        Some(Found::Listed { objects }) => Some(
            objects
                .iter()
                .filter(|pod| {
                    !matches!(
                        pod["status"]["phase"].as_str(),
                        Some("Succeeded" | "Failed")
                    )
                })
                .collect(),
        ),
        _ => None,
    };
    let mut sections = vec![Section {
        id: "core.node".to_owned(),
        title: "Node".to_owned(),
        blocks: vec![Block::Fields { fields: fields.0 }],
    }];
    sections.push(resources(node, running.as_deref(), pods));
    sections.push(Section {
        id: "core.pods".to_owned(),
        title: "Pods".to_owned(),
        blocks: vec![Block::List(EmbeddedList {
            gvr: Gvr {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
            },
            kind: "Pod".to_owned(),
            namespaced: true,
            namespace: None,
            field_selector: Some(on(node)),
            owners: None,
        })],
    });
    if let Some(running) = &running {
        sections.extend(pod_resources(node, running));
    }
    sections.push(Section {
        id: "core.system".to_owned(),
        title: "System".to_owned(),
        blocks: vec![Block::Fields { fields: system.0 }],
    });
    Described {
        findings: findings(node),
        sections,
    }
}

/// The roles its labels give it, as kubectl's `findNodeRoles` reads them.
fn roles(node: &Value) -> Option<String> {
    let mut roles: Vec<&str> = node["metadata"]["labels"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| {
            if let Some(role) = key.strip_prefix(ROLE) {
                (!role.is_empty()).then_some(role)
            } else if key == "kubernetes.io/role" {
                value.as_str().filter(|role| !role.is_empty())
            } else {
                None
            }
        })
        .collect();
    roles.sort_unstable();
    roles.dedup();
    (!roles.is_empty()).then(|| roles.join(", "))
}

/// `key=value:Effect`, as kubectl prints a taint.
fn taints(taints: &Value) -> Option<Shown> {
    list(
        taints
            .as_array()?
            .iter()
            .map(|taint| {
                let key = taint["key"].as_str().unwrap_or_default();
                let effect = taint["effect"].as_str().unwrap_or_default();
                plain(match text(&taint["value"]) {
                    Some(value) => format!("{key}={value}:{effect}"),
                    None => format!("{key}:{effect}"),
                })
            })
            .collect(),
    )
}

/// Each resource the node has: its capacity, what it allocates to pods,
/// and what the pods on it request and may use at most, as kubectl's
/// `describeNodeResource` adds them up.
fn resources(node: &Value, running: Option<&[&Value]>, pods: Option<&Found>) -> Section {
    let capacity = node["status"]["capacity"].as_object();
    let allocatable = &node["status"]["allocatable"];
    let (requests, limits) = running.map_or_else(Default::default, |pods| {
        let mut requests: BTreeMap<String, Quantity> = BTreeMap::new();
        let mut limits: BTreeMap<String, Quantity> = BTreeMap::new();
        for pod in pods {
            add(&mut requests, pod_requests(pod));
            add(&mut limits, pod_limits(pod));
        }
        (requests, limits)
    });
    let mut names: Vec<&String> = capacity
        .into_iter()
        .flatten()
        .map(|(name, _)| name)
        .collect();
    names.sort_by_key(|name| (order(name), (*name).clone()));
    let used = |totals: &BTreeMap<String, Quantity>, name: &str| -> Shown {
        if running.is_none() {
            return plain("");
        }
        let total = totals.get(name).copied().unwrap_or(Quantity::ZERO);
        let percent = allocatable[name]
            .as_str()
            .and_then(Quantity::parse)
            .filter(|of| of.milli() > 0)
            .map(|of| total.milli() * 100 / of.milli());
        match percent {
            Some(percent) if percent > 100 => {
                toned(format!("{} ({percent}%)", show(name, total)), Tone::Warning)
            }
            Some(percent) => plain(format!("{} ({percent}%)", show(name, total))),
            None => plain(show(name, total)),
        }
    };
    let rows: Vec<Vec<Shown>> = names
        .iter()
        .map(|name| {
            let (requested, limited) = match (name.as_str(), running) {
                ("pods", Some(running)) => (plain(running.len().to_string()), plain("")),
                _ => (used(&requests, name), used(&limits, name)),
            };
            vec![
                plain(name.as_str()),
                plain(
                    capacity
                        .and_then(|capacity| capacity[name.as_str()].as_str())
                        .unwrap_or_default(),
                ),
                plain(allocatable[name.as_str()].as_str().unwrap_or_default()),
                requested,
                limited,
            ]
        })
        .collect();
    let mut blocks = Vec::new();
    if let Some(Found::Unavailable { message }) = pods {
        blocks.push(Block::Fields {
            fields: vec![twigo_ipc::Field {
                label: "Pods".to_owned(),
                value: plain(message.clone()),
            }],
        });
    }
    blocks.push(Block::Table {
        columns: ["Resource", "Capacity", "Allocatable", "Requests", "Limits"]
            .map(str::to_owned)
            .to_vec(),
        rows,
    });
    Section {
        id: "core.resources".to_owned(),
        title: "Resources".to_owned(),
        blocks,
    }
}

/// CPU, memory, storage and pods first, as kubectl lists them.
fn order(name: &str) -> u8 {
    match name {
        "cpu" => 0,
        "memory" => 1,
        "ephemeral-storage" => 2,
        "pods" => 3,
        _ => 4,
    }
}

/// A total as Kubernetes writes a quantity: CPU in cores or thousandths,
/// anything else in the largest binary unit it is a whole of.
fn show(name: &str, quantity: Quantity) -> String {
    if name == "cpu" {
        let milli = quantity.milli();
        return if milli % 1000 == 0 {
            (milli / 1000).to_string()
        } else {
            format!("{milli}m")
        };
    }
    let value = quantity.value();
    for (suffix, unit) in [
        ("Ei", 1i128 << 60),
        ("Pi", 1 << 50),
        ("Ti", 1 << 40),
        ("Gi", 1 << 30),
        ("Mi", 1 << 20),
        ("Ki", 1 << 10),
    ] {
        if value != 0 && value % unit == 0 {
            return format!("{}{suffix}", value / unit);
        }
    }
    value.to_string()
}

/// Each running pod with what it requests and may use at most, against
/// what the node allocates, as kubectl's non-terminated pods table.
fn pod_resources(node: &Value, pods: &[&Value]) -> Option<Section> {
    let allocatable = &node["status"]["allocatable"];
    let share = |totals: &BTreeMap<String, Quantity>, name: &str| -> Shown {
        let total = totals.get(name).copied().unwrap_or(Quantity::ZERO);
        let percent = allocatable[name]
            .as_str()
            .and_then(Quantity::parse)
            .filter(|of| of.milli() > 0)
            .map_or(0, |of| total.milli() * 100 / of.milli());
        plain(format!("{} ({percent}%)", show(name, total)))
    };
    let mut pods: Vec<&&Value> = pods.iter().collect();
    pods.sort_by_key(|pod| {
        (
            pod["metadata"]["namespace"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            pod["metadata"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        )
    });
    let rows: Vec<Vec<Shown>> = pods
        .into_iter()
        .map(|pod| {
            let namespace = pod["metadata"]["namespace"].as_str();
            let name = pod["metadata"]["name"].as_str().unwrap_or_default();
            let requests = pod_requests(pod);
            let limits = pod_limits(pod);
            vec![
                plain(namespace.unwrap_or_default()),
                link(POD, namespace, name, name),
                share(&requests, "cpu"),
                share(&limits, "cpu"),
                share(&requests, "memory"),
                share(&limits, "memory"),
            ]
        })
        .collect();
    (!rows.is_empty()).then(|| Section {
        id: "core.podresources".to_owned(),
        title: "Pod resources".to_owned(),
        blocks: vec![Block::Table {
            columns: [
                "Namespace",
                "Pod",
                "CPU requests",
                "CPU limits",
                "Memory requests",
                "Memory limits",
            ]
            .map(str::to_owned)
            .to_vec(),
            rows,
        }],
    })
}

fn add(totals: &mut BTreeMap<String, Quantity>, more: BTreeMap<String, Quantity>) {
    for (name, quantity) in more {
        let total = totals.entry(name).or_insert(Quantity::ZERO);
        *total = *total + quantity;
    }
}

fn largest(totals: &mut BTreeMap<String, Quantity>, other: BTreeMap<String, Quantity>) {
    for (name, quantity) in other {
        let total = totals.entry(name).or_insert(quantity);
        *total = (*total).max(quantity);
    }
}

fn quantities(map: &Value) -> BTreeMap<String, Quantity> {
    map.as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, value)| Some((name.clone(), Quantity::parse(value.as_str()?)?)))
        .collect()
}

fn status_of<'a>(pod: &'a Value, name: &str) -> Option<&'a Value> {
    ["containerStatuses", "initContainerStatuses"]
        .iter()
        .flat_map(|key| pod["status"][*key].as_array().into_iter().flatten())
        .find(|status| status["name"] == name)
}

/// A pod's containers summed as the scheduler sums them
/// (k8s.io/component-helpers v0.37.0, `aggregateContainerResourcesByFn`):
/// regular containers and sidecars add up, and each other init container
/// counts with the sidecars started before it, as the most any of them
/// needs at once.
fn aggregate(
    pod: &Value,
    read: impl Fn(&Value, Option<&Value>) -> BTreeMap<String, Quantity>,
) -> BTreeMap<String, Quantity> {
    let spec = &pod["spec"];
    let mut result = BTreeMap::new();
    for container in spec["containers"].as_array().into_iter().flatten() {
        let name = container["name"].as_str().unwrap_or_default();
        add(&mut result, read(container, status_of(pod, name)));
    }
    let mut sidecars = BTreeMap::new();
    let mut init = BTreeMap::new();
    for container in spec["initContainers"].as_array().into_iter().flatten() {
        let name = container["name"].as_str().unwrap_or_default();
        let resources = read(container, status_of(pod, name));
        let combined = if container["restartPolicy"] == "Always" {
            add(&mut result, resources.clone());
            add(&mut sidecars, resources);
            sidecars.clone()
        } else {
            let mut combined = resources;
            add(&mut combined, sidecars.clone());
            combined
        };
        largest(&mut init, combined);
    }
    largest(&mut result, init);
    result
}

/// What a pod requests (k8s.io/component-helpers v0.37.0, `PodRequests`
/// with status resources): the most of its spec's, its allocated and its
/// actuated requests, pod-level requests in their place, and overhead.
pub(crate) fn pod_requests(pod: &Value) -> BTreeMap<String, Quantity> {
    let spec =
        |container: &Value, _: Option<&Value>| quantities(&container["resources"]["requests"]);
    let allocated = |container: &Value, status: Option<&Value>| match status {
        Some(status) if status["allocatedResources"].is_object() => {
            quantities(&status["allocatedResources"])
        }
        _ => quantities(&container["resources"]["requests"]),
    };
    let actuated = |container: &Value, status: Option<&Value>| match status {
        Some(status) if status["resources"]["requests"].is_object() => {
            quantities(&status["resources"]["requests"])
        }
        _ => quantities(&container["resources"]["requests"]),
    };
    let mut requests = aggregate(pod, spec);
    largest(&mut requests, aggregate(pod, allocated));
    largest(&mut requests, aggregate(pod, actuated));
    pod_level(&mut requests, &pod["spec"]["resources"]["requests"]);
    add(&mut requests, quantities(&pod["spec"]["overhead"]));
    requests
}

/// What a pod may use at most (`PodLimits` with status resources).
pub(crate) fn pod_limits(pod: &Value) -> BTreeMap<String, Quantity> {
    let spec = |container: &Value, _: Option<&Value>| quantities(&container["resources"]["limits"]);
    let actuated = |container: &Value, status: Option<&Value>| match status {
        Some(status) if status["resources"]["limits"].is_object() => {
            quantities(&status["resources"]["limits"])
        }
        _ => quantities(&container["resources"]["limits"]),
    };
    let mut limits = aggregate(pod, spec);
    largest(&mut limits, aggregate(pod, actuated));
    pod_level(&mut limits, &pod["spec"]["resources"]["limits"]);
    for (name, overhead) in quantities(&pod["spec"]["overhead"]) {
        if let Some(limit) = limits.get_mut(&name)
            && limit.milli() != 0
        {
            *limit = *limit + overhead;
        }
    }
    limits
}

/// Pod-level resources replace the containers' sum for CPU, memory and
/// huge pages, the kinds a pod may set (`IsSupportedPodLevelResource`).
fn pod_level(totals: &mut BTreeMap<String, Quantity>, pod: &Value) {
    for (name, quantity) in quantities(pod) {
        if name == "cpu" || name == "memory" || name.starts_with("hugepages-") {
            totals.insert(name, quantity);
        }
    }
}

/// A node that is not ready, under pressure, without a network, or
/// cordoned.
fn findings(node: &Value) -> Vec<Finding> {
    let mut findings = Vec::new();
    let conditions: Vec<&Value> = node["status"]["conditions"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    for condition in &conditions {
        let kind = condition["type"].as_str().unwrap_or_default();
        let status = condition["status"].as_str().unwrap_or_default();
        let (tone, title) = match (kind, status) {
            ("Ready", "False") => (Tone::Danger, "The node is not ready".to_owned()),
            ("Ready", "Unknown") => (Tone::Danger, "The node stopped reporting".to_owned()),
            ("MemoryPressure", "True") => (Tone::Warning, "The node is short of memory".to_owned()),
            ("DiskPressure", "True") => (Tone::Warning, "The node is short of disk".to_owned()),
            ("PIDPressure", "True") => {
                (Tone::Warning, "The node is short of process IDs".to_owned())
            }
            ("NetworkUnavailable", "True") => (Tone::Danger, "The node has no network".to_owned()),
            _ => continue,
        };
        let detail = match text(&condition["lastTransitionTime"]) {
            Some(at) => vec![
                Span::Text {
                    text: "Since ".to_owned(),
                },
                Span::Ago { at },
                Span::Text {
                    text: ".".to_owned(),
                },
            ],
            None => Vec::new(),
        };
        findings.push(Finding {
            tone,
            title,
            detail,
            message: crate::message(&condition["message"]),
        });
    }
    if node["spec"]["unschedulable"].as_bool() == Some(true) {
        findings.push(Finding {
            tone: Tone::Warning,
            title: "The node is cordoned".to_owned(),
            detail: vec![Span::Text {
                text: "New pods are not scheduled on it.".to_owned(),
            }],
            message: None,
        });
    }
    findings.sort_by_key(|finding| finding.tone != Tone::Danger);
    findings
}
