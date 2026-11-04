//! Deployments, StatefulSets and DaemonSets: what kubectl describe prints
//! of them (kubectl v1.37.1, `describeDeployment`, `describeStatefulSet`,
//! `describeDaemonSet`), their rollout and their pods as a live list.

use serde_json::Value;
use twigo_ipc::{Block, Finding, Section, Span, Tone, Value as Shown};

use crate::show::{Fields, REPLICA_SET, SERVICE, code, link, list, plain, toned};
use crate::template::{self, PODS};
use crate::{Described, Fact, Found, Input, Need, text};

/// The label a Deployment's controller adds to the templates of its
/// ReplicaSets, which their comparison with its own template ignores.
const TEMPLATE_HASH: &str = "pod-template-hash";

/// The ReplicaSets of a Deployment's namespace, to find its own.
fn replica_sets(object: &Value) -> Vec<Need> {
    vec![Need {
        group: "apps".to_owned(),
        version: "v1".to_owned(),
        resource: "replicasets".to_owned(),
        namespaced: true,
        namespace: text(&object["metadata"]["namespace"]),
        field_selector: None,
    }]
}

pub(crate) fn deployment_needs(object: &Value) -> Vec<Need> {
    replica_sets(object)
}

pub(crate) fn deployment(input: &Input<'_>) -> Described {
    let object = input.object;
    let spec = &object["spec"];
    let status = &object["status"];
    let namespace = text(&object["metadata"]["namespace"]);
    let uid = text(&object["metadata"]["uid"]).unwrap_or_default();
    let desired = spec["replicas"].as_u64().unwrap_or(1);
    let number = |key: &str| status[key].as_u64().unwrap_or_default();
    let mut fields = Fields::default();
    let unavailable = number("unavailableReplicas");
    let replicas = format!(
        "{desired} desired | {} updated | {} total | {} available | {unavailable} unavailable",
        number("updatedReplicas"),
        number("replicas"),
        number("availableReplicas"),
    );
    fields.add(
        "Replicas",
        if unavailable > 0 {
            toned(replicas, Tone::Warning)
        } else {
            plain(replicas)
        },
    );
    fields.maybe(
        "Selector",
        crate::show::selector(&spec["selector"]).map(code),
    );
    fields.maybe("Strategy", strategy(&spec["strategy"]).map(plain));
    fields.scalar("Min ready seconds", &spec["minReadySeconds"]);
    fields.maybe(
        "Progress deadline",
        spec["progressDeadlineSeconds"]
            .as_i64()
            .map(|seconds| plain(format!("{seconds} s"))),
    );
    fields.scalar("Revision history limit", &spec["revisionHistoryLimit"]);
    fields.flag("Paused", &spec["paused"]);
    fields.text(
        "Revision",
        &object["metadata"]["annotations"]["deployment.kubernetes.io/revision"],
    );

    let mut sections = vec![Section {
        id: "core.deployment".to_owned(),
        title: "Deployment".to_owned(),
        blocks: vec![Block::Fields { fields: fields.0 }],
    }];
    let found = fact(input.facts, &replica_sets(object)[0]);
    let owned: Option<Vec<&Value>> = match found {
        Some(Found::Listed { objects }) => Some(controlled(objects, &uid)),
        _ => None,
    };
    if let Some(found) = found {
        sections.push(rollout(
            object,
            found,
            owned.as_deref().unwrap_or_default(),
            namespace.as_deref(),
        ));
    }
    if let Some(owned) = &owned {
        sections.push(template::owned_list(
            "core.pods",
            "Pods",
            PODS,
            namespace.as_deref(),
            owned
                .iter()
                .filter_map(|rs| text(&rs["metadata"]["uid"]))
                .collect(),
        ));
    }
    sections.push(template::section(&spec["template"], namespace.as_deref()));
    Described {
        findings: deployment_findings(object),
        sections,
    }
}

/// `RollingUpdate, 0 max unavailable, 25% max surge`, or the type alone.
fn strategy(strategy: &Value) -> Option<String> {
    let kind = text(&strategy["type"])?;
    let rolling = &strategy["rollingUpdate"];
    Some(if rolling.is_object() {
        let mut parts = vec![kind];
        if let Some(unavailable) = crate::show::scalar(&rolling["maxUnavailable"]) {
            parts.push(format!("{unavailable} max unavailable"));
        }
        if let Some(surge) = crate::show::scalar(&rolling["maxSurge"]) {
            parts.push(format!("{surge} max surge"));
        }
        if let Some(partition) = rolling["partition"]
            .as_i64()
            .filter(|partition| *partition > 0)
        {
            parts.push(format!("partition {partition}"));
        }
        parts.join(", ")
    } else {
        kind
    })
}

pub(crate) fn fact<'a>(facts: &'a [Fact], need: &Need) -> Option<&'a Found> {
    facts
        .iter()
        .find(|fact| &fact.need == need)
        .map(|fact| &fact.found)
}

/// The objects that `uid` controls, oldest first, by name between equals.
pub(crate) fn controlled<'a>(objects: &'a [Value], uid: &str) -> Vec<&'a Value> {
    let mut owned: Vec<&Value> = objects
        .iter()
        .filter(|object| {
            object["metadata"]["ownerReferences"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|owner| owner["uid"] == uid && owner["controller"] == true)
        })
        .collect();
    owned.sort_by(|a, b| {
        let key = |object: &&Value| {
            (
                object["metadata"]["creationTimestamp"]
                    .as_str()
                    .and_then(|at| at.parse::<jiff::Timestamp>().ok()),
                object["metadata"]["name"].as_str().map(str::to_owned),
            )
        };
        key(a).cmp(&key(b))
    });
    owned
}

/// The new ReplicaSet, the old ones that still have replicas, as kubectl
/// names them, and every revision with its images.
fn rollout(
    deployment: &Value,
    found: &Found,
    owned: &[&Value],
    namespace: Option<&str>,
) -> Section {
    let mut blocks = Vec::new();
    if let Found::Unavailable { message } = found {
        blocks.push(Block::Fields {
            fields: vec![twigo_ipc::Field {
                label: "ReplicaSets".to_owned(),
                value: plain(message.clone()),
            }],
        });
    }
    let new = owned
        .iter()
        .find(|rs| same_template(&rs["spec"]["template"], &deployment["spec"]["template"]))
        .copied();
    let replicas = |rs: &Value| {
        format!(
            "{}/{} replicas created",
            rs["status"]["replicas"].as_u64().unwrap_or_default(),
            rs["spec"]["replicas"].as_u64().unwrap_or_default()
        )
    };
    let named = |rs: &Value| {
        let name = rs["metadata"]["name"].as_str().unwrap_or_default();
        link(
            REPLICA_SET,
            namespace,
            name,
            format!("{name} ({})", replicas(rs)),
        )
    };
    if matches!(found, Found::Listed { .. }) {
        let mut fields = Fields::default();
        fields.add("New ReplicaSet", new.map_or_else(|| plain("none"), named));
        let old: Vec<Shown> = owned
            .iter()
            .filter(|rs| {
                new.is_none_or(|new| new["metadata"]["uid"] != rs["metadata"]["uid"])
                    && rs["spec"]["replicas"].as_u64() != Some(0)
            })
            .map(|rs| named(rs))
            .collect();
        fields.add(
            "Old ReplicaSets",
            list(old).unwrap_or_else(|| plain("none")),
        );
        blocks.push(Block::Fields { fields: fields.0 });
        let mut history: Vec<&Value> = owned.to_vec();
        history.sort_by_key(|rs| std::cmp::Reverse(revision(rs)));
        let rows: Vec<Vec<Shown>> = history
            .into_iter()
            .map(|rs| {
                let name = rs["metadata"]["name"].as_str().unwrap_or_default();
                let ready = format!(
                    "{}/{}",
                    rs["status"]["readyReplicas"].as_u64().unwrap_or_default(),
                    rs["spec"]["replicas"].as_u64().unwrap_or_default()
                );
                vec![
                    plain(revision(rs).map_or_else(String::new, |revision| revision.to_string())),
                    link(REPLICA_SET, namespace, name, name),
                    code(images(&rs["spec"]["template"]["spec"])),
                    plain(ready),
                    text(&rs["metadata"]["creationTimestamp"])
                        .map_or_else(|| plain(""), |at| Shown::Time { at }),
                ]
            })
            .collect();
        if !rows.is_empty() {
            blocks.push(Block::Table {
                columns: ["Revision", "ReplicaSet", "Images", "Ready", "Created"]
                    .map(str::to_owned)
                    .to_vec(),
                rows,
            });
        }
    }
    Section {
        id: "core.rollout".to_owned(),
        title: "Rollout".to_owned(),
        blocks,
    }
}

/// Whether a ReplicaSet's template is the Deployment's, its hash label
/// aside, as kubectl's `equalIgnoreHash` compares them.
fn same_template(replica_set: &Value, deployment: &Value) -> bool {
    let mut replica_set = replica_set.clone();
    if let Some(labels) = replica_set["metadata"]["labels"].as_object_mut() {
        labels.remove(TEMPLATE_HASH);
        if labels.is_empty() {
            replica_set["metadata"]
                .as_object_mut()
                .map(|metadata| metadata.remove("labels"));
        }
    }
    &replica_set == deployment
}

fn revision(replica_set: &Value) -> Option<u64> {
    replica_set["metadata"]["annotations"]["deployment.kubernetes.io/revision"]
        .as_str()?
        .parse()
        .ok()
}

/// The images of a pod spec's containers, init containers first.
fn images(spec: &Value) -> String {
    ["initContainers", "containers"]
        .iter()
        .flat_map(|key| spec[*key].as_array().into_iter().flatten())
        .filter_map(|container| container["image"].as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn span(text: &str) -> Span {
    Span::Text {
        text: text.to_owned(),
    }
}

fn condition<'a>(object: &'a Value, kind: &str) -> Option<&'a Value> {
    object["status"]["conditions"]
        .as_array()?
        .iter()
        .find(|condition| condition["type"] == kind)
}

/// A rollout past its deadline, pods the ReplicaSet cannot create, or
/// fewer available pods than the Deployment needs.
fn deployment_findings(deployment: &Value) -> Vec<Finding> {
    let mut findings = Vec::new();
    if let Some(progressing) = condition(deployment, "Progressing")
        && progressing["status"] == "False"
    {
        findings.push(Finding {
            logs: None,
            tone: Tone::Danger,
            title: "The rollout is stuck".to_owned(),
            detail: since(progressing, "Not progressing since "),
            message: crate::message(&progressing["message"]),
        });
    }
    if let Some(failure) = condition(deployment, "ReplicaFailure")
        && failure["status"] == "True"
    {
        findings.push(Finding {
            logs: None,
            tone: Tone::Danger,
            title: "Its ReplicaSet cannot create pods".to_owned(),
            detail: since(failure, "Failing since "),
            message: crate::message(&failure["message"]),
        });
    }
    if let Some(available) = condition(deployment, "Available")
        && available["status"] == "False"
    {
        let desired = deployment["spec"]["replicas"].as_u64().unwrap_or(1);
        let ready = deployment["status"]["availableReplicas"]
            .as_u64()
            .unwrap_or_default();
        let mut detail = vec![span(&format!("{ready} of {desired} pods are available"))];
        if let Some(at) = text(&available["lastTransitionTime"]) {
            detail.push(span(", since "));
            detail.push(Span::Ago { at });
        }
        detail.push(span("."));
        findings.push(Finding {
            logs: None,
            tone: Tone::Warning,
            title: "Fewer pods are available than it needs".to_owned(),
            detail,
            message: crate::message(&available["message"]),
        });
    }
    findings
}

fn since(condition: &Value, words: &str) -> Vec<Span> {
    match text(&condition["lastTransitionTime"]) {
        Some(at) => vec![span(words), Span::Ago { at }, span(".")],
        None => Vec::new(),
    }
}

/// Ready pods short of the replicas a controller wants.
fn short(ready: u64, desired: u64) -> Option<Finding> {
    (ready < desired).then(|| Finding {
        logs: None,
        tone: Tone::Warning,
        title: "Not every pod is ready".to_owned(),
        detail: vec![span(&format!("{ready} of {desired} pods are ready."))],
        message: None,
    })
}

pub(crate) fn stateful_set(input: &Input<'_>) -> Described {
    let object = input.object;
    let spec = &object["spec"];
    let status = &object["status"];
    let namespace = text(&object["metadata"]["namespace"]);
    let uid = text(&object["metadata"]["uid"]).unwrap_or_default();
    let desired = spec["replicas"].as_u64().unwrap_or(1);
    let ready = status["readyReplicas"].as_u64().unwrap_or_default();
    let mut fields = Fields::default();
    fields.add(
        "Replicas",
        plain(format!(
            "{desired} desired | {} total",
            status["replicas"].as_u64().unwrap_or_default()
        )),
    );
    fields.add(
        "Ready",
        if ready < desired {
            toned(format!("{ready}/{desired}"), Tone::Warning)
        } else {
            plain(format!("{ready}/{desired}"))
        },
    );
    fields.maybe(
        "Selector",
        crate::show::selector(&spec["selector"]).map(code),
    );
    fields.maybe(
        "Service",
        text(&spec["serviceName"])
            .map(|name| link(SERVICE, namespace.as_deref(), &name, name.clone())),
    );
    fields.maybe(
        "Update strategy",
        strategy(&spec["updateStrategy"]).map(plain),
    );
    fields.text("Pod management", &spec["podManagementPolicy"]);
    if spec["persistentVolumeClaimRetentionPolicy"].is_object() {
        let policy = &spec["persistentVolumeClaimRetentionPolicy"];
        fields.add(
            "Claim retention",
            plain(format!(
                "{} when deleted, {} when scaled",
                policy["whenDeleted"].as_str().unwrap_or("Retain"),
                policy["whenScaled"].as_str().unwrap_or("Retain")
            )),
        );
    }
    fields.scalar("Ordinals start", &spec["ordinals"]["start"]);
    fields.scalar("Min ready seconds", &spec["minReadySeconds"]);
    fields.text("Current revision", &status["currentRevision"]);
    fields.text("Update revision", &status["updateRevision"]);
    let mut sections = vec![Section {
        id: "core.statefulset".to_owned(),
        title: "StatefulSet".to_owned(),
        blocks: vec![Block::Fields { fields: fields.0 }],
    }];
    sections.extend(claim_templates(&spec["volumeClaimTemplates"]));
    sections.push(template::owned_list(
        "core.pods",
        "Pods",
        PODS,
        namespace.as_deref(),
        vec![uid],
    ));
    sections.push(template::section(&spec["template"], namespace.as_deref()));
    Described {
        findings: short(ready, desired).into_iter().collect(),
        sections,
    }
}

/// A StatefulSet's claim templates, as kubectl's
/// `describeVolumeClaimTemplates` prints them.
fn claim_templates(templates: &Value) -> Option<Section> {
    let rows: Vec<Vec<Shown>> = templates
        .as_array()?
        .iter()
        .map(|claim| {
            let spec = &claim["spec"];
            let modes: Vec<&str> = spec["accessModes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            vec![
                plain(claim["metadata"]["name"].as_str().unwrap_or_default()),
                plain(text(&spec["storageClassName"]).unwrap_or_else(|| "default".to_owned())),
                plain(
                    text(&spec["resources"]["requests"]["storage"])
                        .unwrap_or_else(|| "default".to_owned()),
                ),
                plain(modes.join(",")),
            ]
        })
        .collect();
    (!rows.is_empty()).then(|| Section {
        id: "core.claims".to_owned(),
        title: "Volume claims".to_owned(),
        blocks: vec![Block::Table {
            columns: ["Name", "Storage class", "Capacity", "Access modes"]
                .map(str::to_owned)
                .to_vec(),
            rows,
        }],
    })
}

pub(crate) fn daemon_set(input: &Input<'_>) -> Described {
    let object = input.object;
    let spec = &object["spec"];
    let status = &object["status"];
    let namespace = text(&object["metadata"]["namespace"]);
    let uid = text(&object["metadata"]["uid"]).unwrap_or_default();
    let number = |key: &str| status[key].as_u64().unwrap_or_default();
    let desired = number("desiredNumberScheduled");
    let ready = number("numberReady");
    let misscheduled = number("numberMisscheduled");
    let mut fields = Fields::default();
    let nodes = format!(
        "{desired} desired | {} current | {ready} ready | {} up-to-date | {} available",
        number("currentNumberScheduled"),
        number("updatedNumberScheduled"),
        number("numberAvailable"),
    );
    fields.add(
        "Nodes",
        if ready < desired {
            toned(nodes, Tone::Warning)
        } else {
            plain(nodes)
        },
    );
    if misscheduled > 0 {
        fields.add(
            "Misscheduled",
            toned(misscheduled.to_string(), Tone::Warning),
        );
    }
    fields.maybe(
        "Selector",
        crate::show::selector(&spec["selector"]).map(code),
    );
    fields.maybe(
        "Update strategy",
        strategy(&spec["updateStrategy"]).map(plain),
    );
    fields.scalar("Min ready seconds", &spec["minReadySeconds"]);
    fields.scalar("Revision history limit", &spec["revisionHistoryLimit"]);
    let mut findings: Vec<Finding> = short(ready, desired).into_iter().collect();
    if misscheduled > 0 {
        findings.push(Finding {
            logs: None,
            tone: Tone::Warning,
            title: "Some of its pods run where they should not".to_owned(),
            detail: vec![span(&format!(
                "{misscheduled} nodes run a pod that its node selector or tolerations exclude."
            ))],
            message: None,
        });
    }
    Described {
        findings,
        sections: vec![
            Section {
                id: "core.daemonset".to_owned(),
                title: "DaemonSet".to_owned(),
                blocks: vec![Block::Fields { fields: fields.0 }],
            },
            template::owned_list("core.pods", "Pods", PODS, namespace.as_deref(), vec![uid]),
            template::section(&spec["template"], namespace.as_deref()),
        ],
    }
}
