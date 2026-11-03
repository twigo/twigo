//! Describes the objects recorded from kind (`cargo run -p twigo-core
//! --example record_objects`) and compares the documents, with the objects
//! as views show them, with the mock backend's, which
//! `TWIGO_UPDATE_OBJECTS=1` rewrites.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use twigo_describe::{Fact, Found, Input, Printed, describe};
use twigo_ipc::{
    Block, Container, EmbeddedList, EventList, Field, Finding, ObjectEvent, Overview, Section,
    Span, Tone, Value as Shown,
};

#[derive(Deserialize)]
struct Recorded {
    object: Value,
    printed: Vec<Printed>,
    events: Vec<ObjectEvent>,
    facts: Vec<Fact>,
}

fn recorded() -> BTreeMap<String, Recorded> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let recorded = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            (name, recorded)
        })
        .collect()
}

fn described() -> BTreeMap<String, Overview> {
    recorded()
        .into_iter()
        .map(|(name, recorded)| {
            let overview = describe(Input {
                object: &recorded.object,
                printed: &recorded.printed,
                events: &EventList {
                    events: recorded.events.clone(),
                    unavailable: None,
                },
                facts: &recorded.facts,
            });
            (name, overview)
        })
        .collect()
}

fn ids(overview: &Overview) -> Vec<&str> {
    overview
        .sections
        .iter()
        .map(|section| section.id.as_str())
        .collect()
}

/// What the mock backend answers for an object.
#[derive(Serialize)]
struct Mocked {
    overview: Overview,
    manifest: String,
}

#[test]
fn the_mock_answers_with_the_recorded_objects() {
    let mut described = described();
    let mocked: BTreeMap<String, Mocked> = recorded()
        .into_iter()
        .map(|(name, recorded)| {
            let overview = described.remove(&name).unwrap();
            let manifest = twigo_policy::redact::for_view(recorded.object).to_string();
            (name, Mocked { overview, manifest })
        })
        .collect();
    let file =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/src/mock/objects.json");
    let json = serde_json::to_string_pretty(&mocked).unwrap() + "\n";
    if std::env::var_os("TWIGO_UPDATE_OBJECTS").is_some() {
        std::fs::write(&file, &json).unwrap();
    }
    assert!(
        std::fs::read_to_string(&file).is_ok_and(|current| current == json),
        "run TWIGO_UPDATE_OBJECTS=1 cargo test -p twigo-describe --test overviews"
    );
    for value in ["test-password", "dGVzdC1wYXNzd29yZA", "MIIBCgKCAQEA"] {
        assert!(!json.contains(value), "{value} in the mock's objects");
    }
}

#[test]
fn a_kind_without_a_describer_shows_its_printed_cells_spec_and_status() {
    let described = described();
    assert_eq!(
        ids(&described["replicaset"]),
        [
            "core.summary",
            "core.spec",
            "core.status",
            "core.metadata",
            "core.events"
        ]
    );
    assert_eq!(
        ids(&described["stage"]),
        ["core.spec", "core.metadata", "core.events"],
        "a CRD without printer columns or status"
    );
}

#[test]
fn a_secret_shows_its_keys_and_sizes_and_no_value() {
    let described = described();
    let secret = &described["secret"];
    assert_eq!(ids(secret), ["core.data", "core.metadata", "core.events"]);
    let Block::Data {
        entries,
        readable: false,
    } = &secret.sections[0].blocks[1]
    else {
        panic!("the data block: {:?}", secret.sections[0].blocks);
    };
    let entries: Vec<(&str, u64, bool)> = entries
        .iter()
        .map(|entry| (entry.key.as_str(), entry.bytes, entry.binary))
        .collect();
    assert_eq!(entries, [("key.der", 10, true), ("password", 13, false)]);
    let sent = serde_json::to_string(secret).unwrap();
    for value in ["test-password", "dGVzdC1wYXNzd29yZA", "MIIBCgKCAQEA"] {
        assert!(!sent.contains(value), "{value} in {sent}");
    }
}

#[test]
fn a_config_map_lists_text_and_binary_keys_with_their_sizes() {
    let described = described();
    let Block::Data {
        entries,
        readable: true,
    } = &described["configmap"].sections[0].blocks[0]
    else {
        panic!("the data block");
    };
    let entries: Vec<(&str, u64, bool)> = entries
        .iter()
        .map(|entry| (entry.key.as_str(), entry.bytes, entry.binary))
        .collect();
    assert_eq!(
        entries,
        [
            ("app.yaml", 23, false),
            ("logo.png", 8, true),
            ("mode", 4, false)
        ]
    );
}

#[test]
fn a_pod_names_its_controller_and_its_events() {
    let described = described();
    let pod = &described["pod"];
    let fields = fields(pod, "core.metadata");
    let controller = fields
        .iter()
        .find(|field| field.label == "Controlled by")
        .expect("a ReplicaSet controls it");
    let twigo_ipc::Value::Link { target, .. } = &controller.value else {
        panic!("a link: {:?}", controller.value);
    };
    assert_eq!(
        (target.group.as_str(), target.kind.as_str()),
        ("apps", "ReplicaSet")
    );
    let Some(Block::Events(EventList { events, .. })) =
        pod.sections.last().and_then(|s| s.blocks.first())
    else {
        panic!("the events last");
    };
    assert!(events.iter().any(|event| event.reason == "Scheduled"));
}

fn section<'a>(overview: &'a Overview, id: &str) -> &'a Section {
    overview
        .sections
        .iter()
        .find(|section| section.id == id)
        .unwrap_or_else(|| panic!("no {id} in {:?}", ids(overview)))
}

fn fields<'a>(overview: &'a Overview, id: &str) -> &'a [Field] {
    section(overview, id)
        .blocks
        .iter()
        .find_map(|block| match block {
            Block::Fields { fields } => Some(&fields[..]),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no fields in {id}"))
}

fn field<'a>(fields: &'a [Field], label: &str) -> &'a Shown {
    &fields
        .iter()
        .find(|field| field.label == label)
        .unwrap_or_else(|| panic!("no {label} in {fields:?}"))
        .value
}

/// A value as one line of text, a link by its text.
fn shown(value: &Shown) -> String {
    match value {
        Shown::Text { text } | Shown::Code { text } | Shown::Toned { text, .. } => text.clone(),
        Shown::Link { text, .. } => text.clone(),
        Shown::Time { at } => at.clone(),
        Shown::Labels { labels } => labels
            .iter()
            .map(|label| format!("{}={}", label.key, label.value))
            .collect::<Vec<_>>()
            .join(" "),
        Shown::List { items } => items.iter().map(shown).collect::<Vec<_>>().join(" | "),
    }
}

fn findings(overview: &Overview) -> &[Finding] {
    match &overview.sections[0].blocks[..] {
        [Block::Diagnostics { findings }] => findings,
        _ => &[],
    }
}

fn table<'a>(overview: &'a Overview, id: &str) -> (&'a [String], Vec<Vec<String>>) {
    section(overview, id)
        .blocks
        .iter()
        .find_map(|block| match block {
            Block::Table { columns, rows } => Some((
                &columns[..],
                rows.iter()
                    .map(|row| row.iter().map(shown).collect())
                    .collect(),
            )),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no table in {id}"))
}

fn list<'a>(overview: &'a Overview, id: &str) -> &'a EmbeddedList {
    match &section(overview, id).blocks[..] {
        [Block::List(list)] => list,
        blocks => panic!("no list in {id}: {blocks:?}"),
    }
}

fn containers<'a>(overview: &'a Overview, id: &str) -> &'a [Container] {
    section(overview, id)
        .blocks
        .iter()
        .find_map(|block| match block {
            Block::Containers { containers } => Some(&containers[..]),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no containers in {id}"))
}

fn recorded_object(name: &str) -> Value {
    recorded().remove(name).unwrap().object
}

#[test]
fn a_crashing_container_says_how_it_ended_and_when_it_starts_again() {
    let described = described();
    let overview = &described["pod-crashing"];
    assert_eq!(
        ids(overview)[..4],
        [
            "core.diagnostics",
            "core.pod",
            "core.conditions",
            "core.containers"
        ]
    );
    assert_eq!(
        ids(overview)[ids(overview).len() - 2..],
        ["core.metadata", "core.events"]
    );
    let [finding] = findings(overview) else {
        panic!("one finding: {:?}", findings(overview));
    };
    assert_eq!(
        (finding.tone, finding.title.as_str()),
        (Tone::Danger, "Container api keeps crashing")
    );
    let pod = recorded_object("pod-crashing");
    let status = &pod["status"]["containerStatuses"][0];
    let finished: jiff::Timestamp = status["lastState"]["terminated"]["finishedAt"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let message = status["state"]["waiting"]["message"].as_str().unwrap();
    let backoff: jiff::SignedDuration = message
        .strip_prefix("back-off ")
        .and_then(|rest| rest.split(' ').next())
        .unwrap()
        .parse()
        .unwrap();
    let next = (finished + backoff).to_string();
    assert!(
        finding.detail.contains(&Span::Until { at: next.clone() }),
        "next start {next} in {:?}",
        finding.detail
    );
    let restarts = status["restartCount"].as_u64().unwrap();
    assert!(finding.detail.contains(&Span::Text {
        text: format!(", {restarts} restarts")
    }));
    assert_eq!(
        finding.message.as_deref(),
        Some("panic: dial tcp 10.96.0.20:5432: connect: connection refused")
    );
    let [api] = containers(overview, "core.containers") else {
        panic!("one container");
    };
    let state = api.state.as_ref().unwrap();
    assert_eq!(
        (state.text.as_str(), state.tone, state.restarts),
        ("Waiting · CrashLoopBackOff", Tone::Danger, restarts as u32)
    );
    assert_eq!(
        shown(field(&api.fields, "Last state")),
        "Terminated · Error · exit code 1"
    );
}

#[test]
fn a_pod_that_cannot_pull_schedule_or_get_ready_says_why() {
    let described = described();
    let titles = |name: &str| -> Vec<(Tone, String, Option<String>)> {
        findings(&described[name])
            .iter()
            .map(|finding| (finding.tone, finding.title.clone(), finding.message.clone()))
            .collect()
    };
    let [(tone, title, Some(message))] = &titles("pod-pulling")[..] else {
        panic!("{:?}", titles("pod-pulling"));
    };
    assert_eq!(
        (*tone, title.as_str()),
        (Tone::Danger, "The image of container api cannot be pulled")
    );
    assert!(
        message.contains("registry.invalid/twigo/api:1.0"),
        "{message}"
    );
    let [(tone, title, Some(message))] = &titles("pod-pending")[..] else {
        panic!("{:?}", titles("pod-pending"));
    };
    assert_eq!(
        (*tone, title.as_str()),
        (Tone::Danger, "The pod cannot be scheduled")
    );
    assert!(
        message.contains("didn't match Pod's node affinity/selector"),
        "{message}"
    );
    let [(tone, title, Some(message))] = &titles("pod-unready")[..] else {
        panic!("{:?}", titles("pod-unready"));
    };
    assert_eq!(
        (*tone, title.as_str()),
        (Tone::Warning, "Container api is not ready")
    );
    assert!(
        message.starts_with("Readiness probe failed: dial tcp"),
        "{message}"
    );
    assert!(findings(&described["pod"]).is_empty());
}

#[test]
fn a_pods_environment_names_its_sources_and_reads_no_secret() {
    let described = described();
    let overview = &described["pod"];
    let [app] = containers(overview, "core.containers") else {
        panic!("one container");
    };
    let pod = recorded_object("pod");
    let ip = pod["status"]["podIP"].as_str().unwrap();
    let env: Vec<(&str, String)> = app
        .env
        .iter()
        .map(|field| (field.label.as_str(), shown(&field.value)))
        .collect();
    assert_eq!(
        env,
        [
            ("MODE", "key mode of config map settings".to_owned()),
            ("PASSWORD", "key password of secret credentials".to_owned()),
            ("POD_IP", format!("{ip} (from status.podIP)")),
            ("MEMORY_MI", "64 (from limits.memory)".to_owned()),
            ("From", "Config map settings with prefix APP_".to_owned()),
        ]
    );
    let Shown::Link { target, .. } = &app.env[1].value else {
        panic!("a link to the Secret");
    };
    assert_eq!(
        (target.kind.as_str(), target.name.as_str()),
        ("Secret", "credentials")
    );
    assert_eq!(shown(&app.mounts[0].value), "settings (ro)");
    assert_eq!(
        shown(field(fields(overview, "core.pod"), "Pod IP")),
        ip.to_owned()
    );
}

#[test]
fn a_deployment_shows_its_rollout_and_lists_the_pods_of_its_replica_sets() {
    let described = described();
    let overview = &described["deployment"];
    let pod = recorded_object("pod");
    let new = pod["metadata"]["ownerReferences"][0]["name"]
        .as_str()
        .unwrap();
    let rollout = fields(overview, "core.rollout");
    assert_eq!(
        shown(field(rollout, "New ReplicaSet")),
        format!("{new} (2/2 replicas created)")
    );
    assert_eq!(shown(field(rollout, "Old ReplicaSets")), "none");
    let (columns, rows) = table(overview, "core.rollout");
    assert_eq!(
        columns,
        ["Revision", "ReplicaSet", "Images", "Ready", "Created"]
    );
    let revisions: Vec<(&str, &str)> = rows
        .iter()
        .map(|row| (row[0].as_str(), row[3].as_str()))
        .collect();
    assert_eq!(revisions, [("2", "2/2"), ("1", "0/0")]);
    assert_eq!(rows[0][1], new);
    let recorded = recorded().remove("deployment").unwrap();
    let Found::Listed { objects } = &recorded.facts[0].found else {
        panic!("listed ReplicaSets");
    };
    let deployment = recorded.object["metadata"]["uid"].as_str().unwrap();
    let mut uids: Vec<&str> = objects
        .iter()
        .filter(|rs| rs["metadata"]["ownerReferences"][0]["uid"] == deployment)
        .map(|rs| rs["metadata"]["uid"].as_str().unwrap())
        .collect();
    uids.sort_unstable();
    let pods = list(overview, "core.pods");
    let mut owners: Vec<&str> = pods.owners.iter().flatten().map(String::as_str).collect();
    owners.sort_unstable();
    assert_eq!((pods.gvr.resource.as_str(), owners), ("pods", uids));
    assert!(findings(overview).is_empty());
    let template = containers(overview, "core.template");
    assert!(template[0].state.is_none(), "a template has no state");
}

#[test]
fn a_deployment_whose_replica_sets_are_still_coming_shows_no_rollout_yet() {
    let recorded = recorded().remove("deployment").unwrap();
    let overview = describe(Input {
        object: &recorded.object,
        printed: &recorded.printed,
        events: &EventList::default(),
        facts: &[],
    });
    let shown = ids(&overview);
    assert!(
        !shown.contains(&"core.rollout") && !shown.contains(&"core.pods"),
        "{shown:?}"
    );
}

#[test]
fn workloads_list_the_pods_and_jobs_they_control() {
    let described = described();
    for (name, id, resource) in [
        ("statefulset", "core.pods", "pods"),
        ("daemonset", "core.pods", "pods"),
        ("job", "core.pods", "pods"),
        ("cronjob", "core.jobs", "jobs"),
    ] {
        let uid = recorded_object(name)["metadata"]["uid"]
            .as_str()
            .unwrap()
            .to_owned();
        let embedded = list(&described[name], id);
        assert_eq!(
            (embedded.gvr.resource.as_str(), embedded.owners.as_deref()),
            (resource, Some(&[uid][..])),
            "{name}"
        );
        assert_eq!(embedded.namespace.as_deref(), Some("overview"), "{name}");
    }
    let (columns, rows) = table(&described["statefulset"], "core.claims");
    assert_eq!(
        columns,
        ["Name", "Storage class", "Capacity", "Access modes"]
    );
    assert_eq!(rows, [["data", "default", "1Gi", "ReadWriteOnce"]]);
    assert_eq!(
        shown(field(fields(&described["job"], "core.job"), "Pods")),
        "0 active (0 ready) | 1 succeeded | 0 failed"
    );
    assert_eq!(
        shown(field(
            fields(&described["daemonset"], "core.daemonset"),
            "Nodes"
        )),
        "1 desired | 1 current | 1 ready | 1 up-to-date | 1 available"
    );
    let cron = recorded_object("cronjob");
    assert_eq!(
        shown(field(
            fields(&described["cronjob"], "core.cronjob"),
            "Last success"
        )),
        cron["status"]["lastSuccessfulTime"].as_str().unwrap()
    );
}

/// The ready endpoints of the recorded slices of `service`, `ip:port`.
fn ready_endpoints(fixture: &str, service: &str) -> Vec<String> {
    let recorded = recorded().remove(fixture).unwrap();
    let slices = recorded
        .facts
        .iter()
        .find(|fact| fact.need.resource == "endpointslices")
        .unwrap();
    let Found::Listed { objects } = &slices.found else {
        panic!("listed slices");
    };
    let mut endpoints = Vec::new();
    for slice in objects
        .iter()
        .filter(|slice| slice["metadata"]["labels"]["kubernetes.io/service-name"] == service)
    {
        let port = slice["ports"][0]["port"].as_i64().unwrap();
        for endpoint in slice["endpoints"].as_array().unwrap() {
            if endpoint["conditions"]["ready"] != false {
                endpoints.push(format!(
                    "{}:{port}",
                    endpoint["addresses"][0].as_str().unwrap()
                ));
            }
        }
    }
    endpoints
}

#[test]
fn a_service_and_an_ingress_show_the_endpoints_behind_them() {
    let described = described();
    let endpoints = ready_endpoints("service", "web");
    assert_eq!(endpoints.len(), 2, "the deployment's two pods");
    let (columns, rows) = table(&described["service"], "core.ports");
    assert_eq!(columns[5], "Endpoints");
    assert_eq!(rows[0][5], endpoints.join(", "));
    let (_, rows) = table(&described["service"], "core.endpoints");
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .all(|row| row[1] == "ready" && row[3].starts_with("web-"))
    );
    assert!(findings(&described["service"]).is_empty());

    let ingress = &described["ingress"];
    let (_, rules) = table(ingress, "core.rules");
    assert_eq!(rules[0][3], "web:http");
    assert_eq!(rules[0][4], ready_endpoints("ingress", "web").join(", "));
    assert_eq!(rules[1][4], "no such service");
    let titles: Vec<&str> = findings(ingress)
        .iter()
        .map(|finding| finding.title.as_str())
        .collect();
    assert_eq!(titles, ["Service reports does not exist"]);
}

#[test]
fn a_node_adds_up_what_its_running_pods_request() {
    let described = described();
    let overview = &described["node"];
    let recorded = recorded().remove("node").unwrap();
    let Found::Listed { objects } = &recorded.facts[0].found else {
        panic!("listed pods");
    };
    let running = objects
        .iter()
        .filter(|pod| {
            !matches!(
                pod["status"]["phase"].as_str(),
                Some("Succeeded" | "Failed")
            )
        })
        .count();
    let (columns, rows) = table(overview, "core.resources");
    assert_eq!(
        columns,
        ["Resource", "Capacity", "Allocatable", "Requests", "Limits"]
    );
    let row = |name: &str| rows.iter().find(|row| row[0] == name).unwrap().clone();
    assert_eq!(row("cpu")[3..], ["970m (6%)", "0 (0%)"]);
    assert_eq!(row("memory")[3..], ["322Mi (2%)", "468Mi (2%)"]);
    assert_eq!(row("pods")[3..], [running.to_string(), String::new()]);
    let name = recorded.object["metadata"]["name"].as_str().unwrap();
    let pods = list(overview, "core.pods");
    assert_eq!(
        (
            pods.namespace.as_deref(),
            pods.field_selector.clone(),
            pods.owners.as_ref()
        ),
        (None, Some(format!("spec.nodeName={name}")), None)
    );
    let node = fields(overview, "core.node");
    assert_eq!(shown(field(node, "Roles")), "control-plane");
    assert_eq!(shown(field(node, "Lease holder")), name);
    assert!(findings(overview).is_empty());
}

#[test]
fn a_claim_names_the_pods_that_use_it() {
    let described = described();
    let claim = fields(&described["pvc"], "core.claim");
    assert_eq!(shown(field(claim, "Status")), "Bound");
    assert_eq!(shown(field(claim, "Used by")), "db-0");
    assert_eq!(shown(field(claim, "Capacity")), "1Gi");
}
