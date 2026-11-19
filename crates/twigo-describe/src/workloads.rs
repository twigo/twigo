//! Deployments, StatefulSets and DaemonSets: what kubectl describe prints
//! of them (kubectl v1.37.1, `describeDeployment`, `describeStatefulSet`,
//! `describeDaemonSet`), their rollout and their pods as a live list.

use serde_json::Value;
use twigo_ipc::{Block, Finding, Section, Span, Tone, Value as Shown, Vital};

use crate::show::{
    Fields, REPLICA_SET, SERVICE, Summary, code, counted, link, list, plain, said, section, toned,
};
use crate::template::{self, PODS};
use crate::{Described, Fact, Found, Input, Need, text};

/// The label a Deployment's controller adds to the templates of its
/// ReplicaSets, which their comparison with its own template ignores.
const TEMPLATE_HASH: &str = "pod-template-hash";

const ROLLOUT: &str = "core.rollout";
const PODS_SECTION: &str = "core.pods";
const REVISION: &str = "deployment.kubernetes.io/revision";

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

/// Pods that are ready or updated against the ones wanted, short of them
/// toned when `short_is_wrong`.
fn count(label: &str, have: u64, want: u64, short_is_wrong: bool) -> Vital {
    let shown = format!("{have}/{want}");
    Vital {
        label: label.to_owned(),
        value: if short_is_wrong && have < want {
            toned(shown, Tone::Warning)
        } else {
            plain(shown)
        },
        note: Vec::new(),
    }
}

pub(crate) fn deployment(input: &Input<'_>) -> Described {
    let object = input.object;
    let spec = &object["spec"];
    let status = &object["status"];
    let namespace = text(&object["metadata"]["namespace"]);
    let uid = text(&object["metadata"]["uid"]).unwrap_or_default();
    let desired = spec["replicas"].as_u64().unwrap_or(1);
    let number = |key: &str| status[key].as_u64().unwrap_or_default();
    let (ready, updated, total) = (
        number("readyReplicas"),
        number("updatedReplicas"),
        number("replicas"),
    );
    let revision = text(&object["metadata"]["annotations"][REVISION]);
    let mut fields = Fields::default();
    let unavailable = number("unavailableReplicas");
    let replicas = format!(
        "{desired} desired | {updated} updated | {total} total | {} available | {unavailable} unavailable",
        number("availableReplicas"),
    );
    fields.add("Replicas", plain(replicas));
    fields.maybe("Revision", revision.clone().map(plain));
    let found = fact(input.facts, &replica_sets(object)[0]);
    let owned: Option<Vec<&Value>> = match found {
        Some(Found::Listed { objects }) => Some(controlled(objects, &uid)),
        _ => None,
    };
    let new = owned
        .as_deref()
        .and_then(|owned| new_replica_set(object, owned));
    let findings = deployment_findings(object);
    let about = |id: &str| {
        findings
            .iter()
            .find_map(|(finding, subject)| (*subject == id).then_some(finding))
    };
    let paused = spec["paused"] == true;
    let rolling = updated < desired || total > updated;
    let (summary, tone) = said(about(ROLLOUT), || {
        if paused {
            Summary::default()
                .part("paused")
                .part(format!("{updated}/{desired} updated"))
                .done()
        } else if rolling {
            Summary::default()
                .part(format!("{updated}/{desired} updated"))
                .done()
        } else {
            revision_line(Summary::default(), revision.as_deref(), new).done()
        }
    });
    let mut sections = vec![Section {
        summary,
        tone,
        ..rollout(
            fields,
            found,
            owned.as_deref().unwrap_or_default(),
            new,
            namespace.as_deref(),
        )
    }];
    if let Some(owned) = &owned {
        sections.push(pods(
            namespace.as_deref(),
            owned
                .iter()
                .filter_map(|rs| text(&rs["metadata"]["uid"]))
                .collect(),
            ready,
            desired,
            about(PODS_SECTION),
        ));
    }
    sections.push(template::section(&spec["template"], namespace.as_deref()));
    let mut strategy = Fields::default();
    strategy.maybe(
        "Selector",
        crate::show::selector(&spec["selector"]).map(code),
    );
    strategy.maybe("Strategy", strategy_of(&spec["strategy"]).map(plain));
    strategy.scalar("Min ready seconds", &spec["minReadySeconds"]);
    strategy.maybe(
        "Progress deadline",
        spec["progressDeadlineSeconds"]
            .as_i64()
            .map(|seconds| plain(format!("{seconds} s"))),
    );
    strategy.scalar("Revision history limit", &spec["revisionHistoryLimit"]);
    strategy.flag("Paused", &spec["paused"]);
    sections.push(strategy_section(
        strategy,
        text(&spec["strategy"]["type"]),
        Some(desired),
        paused,
    ));
    let sentence = if paused {
        let at = match &revision {
            Some(revision) => format!("Paused at revision {revision}"),
            None => "Paused".to_owned(),
        };
        Summary::default()
            .part(format!("{at}: {updated}/{desired} updated"))
            .done()
    } else if rolling {
        let rolling = match &revision {
            Some(revision) => format!("Rolling out revision {revision}"),
            None => "Rolling out".to_owned(),
        };
        Summary::default()
            .part(format!(
                "{rolling}: {updated}/{desired} updated, {ready}/{desired} ready"
            ))
            .done()
    } else {
        revision_line(
            Summary::default().part(format!("{ready}/{desired} ready")),
            revision.as_deref(),
            new,
        )
        .done()
    };
    let mut revision_vital = Vital {
        label: "Revision".to_owned(),
        value: plain(revision.clone().unwrap_or_default()),
        note: Vec::new(),
    };
    if let Some(tag) = single_tag(&spec["template"]["spec"]) {
        revision_vital.note = vec![Span::Text { text: tag }];
    }
    let mut vitals = vec![
        count("Ready", ready, desired, true),
        count("Updated", updated, desired, false),
    ];
    if revision.is_some() {
        vitals.push(revision_vital);
    }
    Described {
        findings: findings.into_iter().map(|(finding, _)| finding).collect(),
        sections,
        sentence,
        vitals,
        ..Described::default()
    }
}

/// `revision 12, 3d ago`: the revision the Deployment is at and when its
/// ReplicaSet was made; the time is left out where that ReplicaSet is not
/// listed.
fn revision_line(summary: Summary, revision: Option<&str>, new: Option<&Value>) -> Summary {
    let Some(revision) = revision else {
        return summary;
    };
    match new.and_then(|new| text(&new["metadata"]["creationTimestamp"])) {
        Some(at) => summary.ago(&format!("revision {revision}, "), at),
        None => summary.part(format!("revision {revision}")),
    }
}

/// The tag of the one container's image, which says what revision it is.
fn single_tag(pod: &Value) -> Option<String> {
    let [container] = pod["containers"].as_array()?.as_slice() else {
        return None;
    };
    let image = container["image"].as_str()?;
    let (reference, _) = image.split_once('@').unwrap_or((image, ""));
    let (_, tag) = reference.rsplit('/').next()?.split_once(':')?;
    Some(tag.to_owned())
}

/// `RollingUpdate, 0 max unavailable, 25% max surge`, or the type alone.
fn strategy_of(strategy: &Value) -> Option<String> {
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

/// How it updates and how many it runs: `RollingUpdate · 3 replicas`, and
/// `paused` while its updates are held.
fn strategy_section(
    fields: Fields,
    kind: Option<String>,
    replicas: Option<u64>,
    paused: bool,
) -> Section {
    let summary = Summary::default().part(kind.unwrap_or_default());
    let summary = match replicas {
        Some(replicas) => summary.part(counted(replicas as usize, "replica")),
        None => summary,
    };
    Section {
        summary: summary.part(if paused { "paused" } else { "" }).done(),
        ..section(
            "core.strategy",
            "Strategy and scaling",
            vec![Block::Fields { fields: fields.0 }],
        )
    }
}

/// The live list of what a workload controls: `2/3 ready`, or the finding
/// about it.
fn pods(
    namespace: Option<&str>,
    owners: Vec<String>,
    ready: u64,
    desired: u64,
    finding: Option<&Finding>,
) -> Section {
    let (summary, tone) = said(finding, || {
        Summary::default()
            .part(format!("{ready}/{desired} ready"))
            .done()
    });
    Section {
        summary,
        tone,
        ..template::owned_list(PODS_SECTION, "Pods", PODS, namespace, owners)
    }
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

/// The ReplicaSet whose template is the Deployment's.
fn new_replica_set<'a>(deployment: &Value, owned: &[&'a Value]) -> Option<&'a Value> {
    owned
        .iter()
        .find(|rs| same_template(&rs["spec"]["template"], &deployment["spec"]["template"]))
        .copied()
}

/// What the Deployment's rollout is at: `fields` first, then the new
/// ReplicaSet, the old ones that still have replicas, as kubectl names
/// them, and every revision with its images.
fn rollout(
    mut fields: Fields,
    found: Option<&Found>,
    owned: &[&Value],
    new: Option<&Value>,
    namespace: Option<&str>,
) -> Section {
    let mut table = None;
    if let Some(Found::Unavailable { message }) = found {
        fields.add("ReplicaSets", plain(message.clone()));
    }
    let replicas = |rs: &Value| {
        format!(
            "{}/{} replicas created",
            rs["status"]["replicas"].as_u64().unwrap_or_default(),
            rs["spec"]["replicas"].as_u64().unwrap_or_default()
        )
    };
    let linked = |rs: &Value| {
        let name = rs["metadata"]["name"].as_str().unwrap_or_default();
        link(
            REPLICA_SET,
            namespace,
            name,
            format!("{name} ({})", replicas(rs)),
        )
    };
    if matches!(found, Some(Found::Listed { .. })) {
        fields.add("New ReplicaSet", new.map_or_else(|| plain("none"), linked));
        let old: Vec<Shown> = owned
            .iter()
            .filter(|rs| {
                new.is_none_or(|new| new["metadata"]["uid"] != rs["metadata"]["uid"])
                    && rs["spec"]["replicas"].as_u64() != Some(0)
            })
            .map(|rs| linked(rs))
            .collect();
        fields.add(
            "Old ReplicaSets",
            list(old).unwrap_or_else(|| plain("none")),
        );
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
            table = Some(Block::Table {
                columns: ["Revision", "ReplicaSet", "Images", "Ready", "Created"]
                    .map(str::to_owned)
                    .to_vec(),
                rows,
            });
        }
    }
    let mut blocks = vec![Block::Fields { fields: fields.0 }];
    blocks.extend(table);
    section(ROLLOUT, "Rollout", blocks)
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
    replica_set["metadata"]["annotations"][REVISION]
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
/// fewer available pods than the Deployment needs, each with the section it
/// is about.
fn deployment_findings(deployment: &Value) -> Vec<(Finding, &'static str)> {
    let mut findings = Vec::new();
    if let Some(progressing) = condition(deployment, "Progressing")
        && progressing["status"] == "False"
    {
        findings.push((
            Finding {
                logs: None,
                tone: Tone::Danger,
                title: "The rollout is stuck".to_owned(),
                detail: since(progressing, "Not progressing since "),
                message: crate::message(&progressing["message"]),
            },
            ROLLOUT,
        ));
    }
    if let Some(failure) = condition(deployment, "ReplicaFailure")
        && failure["status"] == "True"
    {
        findings.push((
            Finding {
                logs: None,
                tone: Tone::Danger,
                title: "Its ReplicaSet cannot create pods".to_owned(),
                detail: since(failure, "Failing since "),
                message: crate::message(&failure["message"]),
            },
            ROLLOUT,
        ));
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
        findings.push((
            Finding {
                logs: None,
                tone: Tone::Warning,
                title: "Fewer pods are available than it needs".to_owned(),
                detail,
                message: crate::message(&available["message"]),
            },
            PODS_SECTION,
        ));
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
    let number = |key: &str| status[key].as_u64().unwrap_or_default();
    let (ready, updated) = (number("readyReplicas"), number("updatedReplicas"));
    let mut rollout = Fields::default();
    rollout.add(
        "Replicas",
        plain(format!("{desired} desired | {} total", number("replicas"))),
    );
    rollout.add("Ready", plain(format!("{ready}/{desired}")));
    rollout.text("Current revision", &status["currentRevision"]);
    rollout.text("Update revision", &status["updateRevision"]);
    let mut strategy = Fields::default();
    strategy.maybe(
        "Selector",
        crate::show::selector(&spec["selector"]).map(code),
    );
    strategy.maybe(
        "Service",
        text(&spec["serviceName"])
            .map(|name| link(SERVICE, namespace.as_deref(), &name, name.clone())),
    );
    strategy.maybe(
        "Update strategy",
        strategy_of(&spec["updateStrategy"]).map(plain),
    );
    strategy.text("Pod management", &spec["podManagementPolicy"]);
    if spec["persistentVolumeClaimRetentionPolicy"].is_object() {
        let policy = &spec["persistentVolumeClaimRetentionPolicy"];
        strategy.add(
            "Claim retention",
            plain(format!(
                "{} when deleted, {} when scaled",
                policy["whenDeleted"].as_str().unwrap_or("Retain"),
                policy["whenScaled"].as_str().unwrap_or("Retain")
            )),
        );
    }
    strategy.scalar("Ordinals start", &spec["ordinals"]["start"]);
    strategy.scalar("Min ready seconds", &spec["minReadySeconds"]);
    let findings: Vec<Finding> = short(ready, desired).into_iter().collect();
    let mut sections = vec![
        Section {
            summary: Summary::default()
                .part(format!("{updated}/{desired} updated"))
                .done(),
            ..section(
                ROLLOUT,
                "Rollout",
                vec![Block::Fields { fields: rollout.0 }],
            )
        },
        pods(
            namespace.as_deref(),
            vec![uid],
            ready,
            desired,
            findings.first(),
        ),
        template::section(&spec["template"], namespace.as_deref()),
    ];
    sections.extend(claim_templates(&spec["volumeClaimTemplates"]));
    sections.push(strategy_section(
        strategy,
        text(&spec["updateStrategy"]["type"]),
        Some(desired),
        false,
    ));
    Described {
        findings,
        sections,
        vitals: vec![
            count("Ready", ready, desired, true),
            count("Updated", updated, desired, false),
        ],
        ..Described::default()
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
    let count = rows.len();
    (!rows.is_empty()).then(|| Section {
        summary: Summary::default().count(count, "claim").done(),
        ..section(
            "core.claims",
            "Volume claims",
            vec![Block::Table {
                columns: ["Name", "Storage class", "Capacity", "Access modes"]
                    .map(str::to_owned)
                    .to_vec(),
                rows,
            }],
        )
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
    let updated = number("updatedNumberScheduled");
    let misscheduled = number("numberMisscheduled");
    let mut rollout = Fields::default();
    let nodes = format!(
        "{desired} desired | {} current | {ready} ready | {updated} up-to-date | {} available",
        number("currentNumberScheduled"),
        number("numberAvailable"),
    );
    rollout.add("Nodes", plain(nodes));
    if misscheduled > 0 {
        rollout.add(
            "Misscheduled",
            toned(misscheduled.to_string(), Tone::Warning),
        );
    }
    let mut strategy = Fields::default();
    strategy.maybe(
        "Selector",
        crate::show::selector(&spec["selector"]).map(code),
    );
    strategy.maybe(
        "Update strategy",
        strategy_of(&spec["updateStrategy"]).map(plain),
    );
    strategy.scalar("Min ready seconds", &spec["minReadySeconds"]);
    strategy.scalar("Revision history limit", &spec["revisionHistoryLimit"]);
    let mut findings: Vec<Finding> = short(ready, desired).into_iter().collect();
    let unready = findings.len();
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
    let (summary, tone) = said(findings.get(unready), || {
        Summary::default()
            .part(format!("{updated}/{desired} updated"))
            .done()
    });
    let sections = vec![
        Section {
            summary,
            tone,
            ..section(
                ROLLOUT,
                "Rollout",
                vec![Block::Fields { fields: rollout.0 }],
            )
        },
        pods(
            namespace.as_deref(),
            vec![uid],
            ready,
            desired,
            findings.first().filter(|_| unready > 0),
        ),
        template::section(&spec["template"], namespace.as_deref()),
        strategy_section(strategy, text(&spec["updateStrategy"]["type"]), None, false),
    ];
    Described {
        findings,
        sections,
        vitals: vec![
            count("Ready", ready, desired, true),
            count("Updated", updated, desired, false),
        ],
        ..Described::default()
    }
}
