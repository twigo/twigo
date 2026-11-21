//! Describes the objects recorded from kind (`cargo run -p twigo-core
//! --example record_objects`) and compares the documents, with the objects
//! as views show them and what a Reveal of each Secret's keys answers, with
//! the mock backend's, which `TWIGO_UPDATE_OBJECTS=1` rewrites.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use twigo_describe::{Fact, Found, Input, Printed, describe};
use twigo_ipc::{
    Block, Condition, Container, EmbeddedList, ErrorCode, EventList, Field, Finding, Fold,
    IpcError, ObjectEvent, Overview, Section, Span, Tone, Value as Shown, Vital,
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
                    listed: true,
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

/// What a Reveal answers for a key, apart from the objects, which hold no
/// value.
#[derive(Serialize)]
struct Revealed {
    value: String,
    binary: bool,
}

/// Compares `json` with the file at `path` from the repository's root, which
/// `TWIGO_UPDATE_OBJECTS=1` rewrites.
fn recorded_as(path: &str, json: &str) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path);
    if std::env::var_os("TWIGO_UPDATE_OBJECTS").is_some() {
        std::fs::write(&file, json).unwrap();
    }
    assert!(
        std::fs::read_to_string(&file).is_ok_and(|current| current == json),
        "run TWIGO_UPDATE_OBJECTS=1 cargo test -p twigo-describe --test overviews"
    );
}

#[test]
fn the_mock_reveals_the_recorded_secrets_values_as_rust_does() {
    let revealed: BTreeMap<String, BTreeMap<String, Revealed>> = recorded()
        .into_iter()
        .filter(|(_, recorded)| recorded.object["kind"] == "Secret")
        .map(|(name, recorded)| {
            let keys = recorded.object["data"].as_object().unwrap().keys();
            let values = keys
                .map(|key| {
                    let (value, binary) =
                        twigo_policy::redact::secret_value(&recorded.object, key).unwrap();
                    (key.clone(), Revealed { value, binary })
                })
                .collect();
            (name, values)
        })
        .collect();
    assert!(!revealed.is_empty());
    let json = serde_json::to_string_pretty(&revealed).unwrap() + "\n";
    recorded_as("packages/protocol/src/mock/revealed.json", &json);
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
    let json = serde_json::to_string_pretty(&mocked).unwrap() + "\n";
    recorded_as("packages/protocol/src/mock/objects.json", &json);
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
            "core.events",
            "core.metadata"
        ]
    );
    assert_eq!(
        ids(&described["stage"]),
        ["core.spec", "core.events", "core.metadata"],
        "a CRD without printer columns or status"
    );
}

#[test]
fn a_secret_shows_its_keys_and_sizes_and_no_value() {
    let described = described();
    let secret = &described["secret"];
    assert_eq!(ids(secret), ["core.data", "core.events", "core.metadata"]);
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
    let Some(Block::Events(EventList { events, .. })) = section(pod, "core.events").blocks.first()
    else {
        panic!("the events");
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
        Shown::Spans { spans } => spans
            .iter()
            .map(|span| match span {
                Span::Text { text } => text.clone(),
                Span::Ago { at } | Span::Until { at } => at.clone(),
            })
            .collect(),
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
        (
            state.text.as_str(),
            state.tone,
            state.running,
            state.restarts
        ),
        (
            "Waiting · CrashLoopBackOff",
            Tone::Danger,
            false,
            restarts as u32
        )
    );
    assert_eq!(
        shown(field(&api.fields, "Last exit")),
        format!("code 1 (Error) · {finished}")
    );
    let labels: Vec<&str> = api
        .fields
        .iter()
        .map(|field| field.label.as_str())
        .collect();
    assert_eq!(labels, ["Last exit"], "the block's rows say one thing once");
    let details: Vec<&str> = api
        .details
        .iter()
        .map(|field| field.label.as_str())
        .collect();
    assert_eq!(details[0], "Last message");
}

#[test]
fn a_running_container_says_when_it_started_in_its_details_and_has_no_row_of_its_own() {
    let described = described();
    let [app] = containers(&described["pod"], "core.containers") else {
        panic!("one container");
    };
    assert!(app.fields.is_empty(), "{:?}", app.fields);
    let started =
        recorded_object("pod")["status"]["containerStatuses"][0]["state"]["running"]["startedAt"]
            .as_str()
            .unwrap()
            .to_owned();
    assert_eq!(shown(field(&app.details, "Started")), started);
    assert!(app.details.iter().any(|field| field.label == "Requests"));
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
    let [api] = containers(&described["pod-unready"], "core.containers") else {
        panic!("one container");
    };
    let state = api.state.as_ref().unwrap();
    assert_eq!((state.ready, state.running), (false, true));
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
        shown(field(fields(overview, "core.placement"), "Pod IP")),
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
fn a_deployment_whose_replica_sets_are_still_coming_names_none_yet() {
    let recorded = recorded().remove("deployment").unwrap();
    let overview = describe(Input {
        object: &recorded.object,
        printed: &recorded.printed,
        events: &EventList::default(),
        facts: &[],
    });
    let shown = ids(&overview);
    assert!(!shown.contains(&"core.pods"), "{shown:?}");
    let labels: Vec<&str> = fields(&overview, "core.rollout")
        .iter()
        .map(|field| field.label.as_str())
        .collect();
    assert_eq!(
        labels,
        ["Replicas", "Revision"],
        "no ReplicaSet to name yet"
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
            fields(&described["daemonset"], "core.rollout"),
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
    assert_eq!(row("cpu")[3..], ["1070m (6%)", "0 (0%)"]);
    assert_eq!(row("memory")[3..], ["522Mi (3%)", "468Mi (2%)"]);
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
    assert_eq!(
        shown(field(fields(overview, "core.taints"), "Roles")),
        "control-plane"
    );
    assert_eq!(
        shown(field(fields(overview, "core.system"), "Lease holder")),
        name
    );
    assert!(findings(overview).is_empty());
}

#[test]
fn a_claim_names_the_pods_that_use_it() {
    let described = described();
    let claim = fields(&described["pvc"], "core.claim");
    assert_eq!(shown(field(claim, "Status")), "Bound");
    assert_eq!(shown(field(claim, "Used by")), "db-0");
    assert_eq!(shown(field(claim, "Capacity")), "1Gi");
    let conditions = section(&described["pvc"], "core.conditions");
    let [Block::Conditions { conditions }] = &conditions.blocks[..] else {
        panic!("the conditions");
    };
    let unused = conditions.iter().find(|c| c.kind == "Unused").unwrap();
    assert_eq!(
        (unused.status.as_str(), unused.tone),
        ("False", Tone::Neutral),
        "in use is no warning"
    );
}

fn edited(name: &str, edit: impl FnOnce(&mut Recorded)) -> Overview {
    let mut recorded = recorded().remove(name).unwrap();
    edit(&mut recorded);
    describe(Input {
        object: &recorded.object,
        printed: &recorded.printed,
        events: &EventList {
            events: recorded.events.clone(),
            listed: true,
            unavailable: None,
        },
        facts: &recorded.facts,
    })
}

fn warning(reason: &str, message: &str) -> ObjectEvent {
    ObjectEvent {
        kind: "Warning".to_owned(),
        reason: reason.to_owned(),
        message: message.to_owned(),
        source: "test".to_owned(),
        count: 3,
        first: Some("2026-11-03T10:00:00Z".to_owned()),
        last: Some("2026-11-03T10:05:00Z".to_owned()),
        field_path: None,
    }
}

fn unavailable(recorded: &mut Recorded) {
    for fact in &mut recorded.facts {
        fact.found = Found::Unavailable {
            message: "You may not list them.".to_owned(),
        };
    }
}

fn titles(overview: &Overview) -> Vec<(Tone, &str)> {
    findings(overview)
        .iter()
        .map(|finding| (finding.tone, finding.title.as_str()))
        .collect()
}

#[test]
fn what_cannot_be_listed_says_so_and_lists_no_pods() {
    let deployment = edited("deployment", unavailable);
    assert!(
        !ids(&deployment).contains(&"core.pods"),
        "{:?}",
        ids(&deployment)
    );
    assert_eq!(
        shown(field(fields(&deployment, "core.rollout"), "ReplicaSets")),
        "You may not list them."
    );
    let service = edited("service", unavailable);
    let (_, rows) = table(&service, "core.ports");
    assert_eq!(rows[0][5], "You may not list them.");
    assert!(findings(&service).is_empty());
    let ingress = edited("ingress", unavailable);
    let (_, rows) = table(&ingress, "core.rules");
    assert_eq!(rows[0][4], "You may not list them.");
}

#[test]
fn an_ingress_backend_no_ready_pod_serves_is_a_finding() {
    let ingress = edited("ingress", |recorded| {
        for fact in &mut recorded.facts {
            if let Found::Listed { objects } = &mut fact.found {
                for slice in objects.iter_mut() {
                    for endpoint in slice["endpoints"].as_array_mut().into_iter().flatten() {
                        endpoint["conditions"]["ready"] = Value::Bool(false);
                    }
                }
            }
        }
        recorded.object["spec"]["defaultBackend"] =
            serde_json::json!({ "service": { "name": "web", "port": { "number": 80 } } });
    });
    assert_eq!(
        titles(&ingress),
        [
            (Tone::Warning, "Service reports does not exist"),
            (Tone::Warning, "No ready pod serves Service web")
        ]
    );
    let default = field(fields(&ingress, "core.ingress"), "Default backend");
    assert_eq!(shown(default), "web:80 | none");
    let own = section(&ingress, "core.ingress");
    assert_eq!(
        (own.tone, text(&own.summary)),
        (
            Some(Tone::Warning),
            "No ready pod serves Service web".to_owned()
        ),
        "the default backend is the Ingress's own"
    );
    let rules = section(&ingress, "core.rules");
    assert_eq!(
        (rules.tone, text(&rules.summary)),
        (
            Some(Tone::Warning),
            "Service reports does not exist".to_owned()
        ),
        "a rule's backend is Rules'"
    );

    let only_default = edited("ingress", |recorded| {
        recorded.object["spec"]["defaultBackend"] =
            serde_json::json!({ "service": { "name": "ghost", "port": { "number": 80 } } });
        recorded.object["spec"]["rules"][0]["http"]["paths"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
    });
    assert_eq!(
        toned_ids(&only_default),
        ["core.diagnostics", "core.ingress"]
    );
    assert_eq!(
        summary(&only_default, "core.ingress"),
        "Service ghost does not exist"
    );
}

#[test]
fn an_ingress_whose_default_backend_alone_is_unserved_tones_its_own_section() {
    let unserved = edited("ingress", |recorded| {
        recorded.object["spec"]["rules"][0]["http"]["paths"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        recorded.object["spec"]["defaultBackend"] =
            serde_json::json!({ "service": { "name": "api", "port": { "number": 80 } } });
        for fact in &mut recorded.facts {
            if let Found::Listed { objects } = &mut fact.found
                && objects.iter().any(|object| object["kind"] == "Service")
            {
                let mut api = objects[0].clone();
                api["metadata"]["name"] = "api".into();
                api["spec"]["ports"] = serde_json::json!([{ "port": 80 }]);
                objects.push(api);
            }
        }
    });
    assert_eq!(
        titles(&unserved),
        [(Tone::Warning, "No ready pod serves Service api")]
    );
    assert_eq!(
        toned_ids(&unserved),
        ["core.diagnostics", "core.ingress"],
        "Rules, whose backend is served, stays plain"
    );
    assert_eq!(
        summary(&unserved, "core.ingress"),
        "No ready pod serves Service api"
    );
}

#[test]
fn a_claim_that_waits_for_its_pod_is_fine_and_any_other_pending_one_says_why() {
    let pending = |event: Option<ObjectEvent>| {
        edited("pvc", move |recorded| {
            recorded.object["status"] = serde_json::json!({ "phase": "Pending" });
            recorded.object["spec"]
                .as_object_mut()
                .unwrap()
                .remove("volumeName");
            recorded.events = event.into_iter().collect();
        })
    };
    let normal = |reason: &str, message: &str| ObjectEvent {
        kind: "Normal".to_owned(),
        ..warning(reason, message)
    };
    for reason in ["WaitForFirstConsumer", "WaitForPodScheduled"] {
        assert!(
            findings(&pending(Some(normal(reason, "waiting")))).is_empty(),
            "{reason}"
        );
    }
    let provisioning = pending(Some(normal(
        "ExternalProvisioning",
        "Waiting for a volume to be created either by the external provisioner 'ebs.csi.aws.com'",
    )));
    assert_eq!(
        titles(&provisioning),
        [(Tone::Warning, "The claim is not bound")]
    );
    assert!(
        findings(&provisioning)[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains("external provisioner"))
    );
    let failing = edited("pvc", |recorded| {
        recorded.object["status"] = serde_json::json!({ "phase": "Pending" });
        recorded.events = vec![
            ObjectEvent {
                kind: "Normal".to_owned(),
                ..warning("ExternalProvisioning", "Waiting for a volume to be created")
            },
            warning("ProvisioningFailed", "rpc error: volume quota exceeded"),
        ];
    });
    assert_eq!(
        findings(&failing)[0].message.as_deref(),
        Some("rpc error: volume quota exceeded"),
        "the warning, under the provisioner's repeated Normal event"
    );
    assert!(
        findings(&pending(None)).is_empty(),
        "without events a waiting claim cannot be told from a stuck one"
    );
    let named = edited("pvc", |recorded| {
        recorded.object["status"] = serde_json::json!({ "phase": "Pending" });
        recorded.events = Vec::new();
    });
    assert_eq!(titles(&named), [(Tone::Warning, "The claim is not bound")]);
}

#[test]
fn a_cron_job_whose_last_run_failed_and_a_job_about_to_fail_say_so() {
    let cron = edited("cronjob", |recorded| {
        let status = &mut recorded.object["status"];
        status["lastScheduleTime"] = "2026-11-03T12:00:00Z".into();
        status["lastSuccessfulTime"] = "2026-11-03T11:00:00Z".into();
        status["active"] = Value::Null;
    });
    assert_eq!(
        titles(&cron),
        [(Tone::Warning, "Its last run did not succeed")]
    );
    let running = edited("cronjob", |recorded| {
        let status = &mut recorded.object["status"];
        status["lastScheduleTime"] = "2026-11-03T12:00:00Z".into();
        status["lastSuccessfulTime"] = "2026-11-03T11:00:00Z".into();
        status["active"] = serde_json::json!([{ "name": "report-1" }]);
    });
    assert!(findings(&running).is_empty());
    let job = edited("job", |recorded| {
        recorded.object["status"]["conditions"] = serde_json::json!([{
            "type": "FailureTarget",
            "status": "True",
            "reason": "BackoffLimitExceeded",
            "message": "Job has reached the specified backoff limit",
        }]);
    });
    assert_eq!(
        titles(&job),
        [(Tone::Danger, "The job failed too many times")]
    );
}

#[test]
fn a_pod_that_stops_or_cannot_mount_or_inspect_says_why() {
    let stopping = edited("pod", |recorded| {
        recorded.object["metadata"]["deletionTimestamp"] = "2026-11-03T12:00:30Z".into();
        recorded.object["metadata"]["deletionGracePeriodSeconds"] = 30.into();
    });
    assert_eq!(
        titles(&stopping),
        [(Tone::Warning, "The pod is terminating")]
    );
    assert!(findings(&stopping)[0].detail.contains(&Span::Ago {
        at: "2026-11-03T12:00:00Z".to_owned()
    }));
    assert_eq!(
        stopping.header.sentence,
        [Span::Text {
            text: "The pod is terminating".to_owned()
        }]
    );
    let mount_failed = || {
        warning(
            "FailedMount",
            "MountVolume.SetUp failed for volume \"settings\" : configmap \"settings\" not found",
        )
    };
    let sandbox_failed = || {
        warning(
            "FailedCreatePodSandBox",
            "failed to create pod sandbox: network not ready",
        )
    };
    let mounting = edited("pod", |recorded| {
        no_sandbox(&mut recorded.object);
        recorded.object["status"]["containerStatuses"][0]["state"] =
            serde_json::json!({ "waiting": { "reason": "ContainerCreating" } });
        recorded.events = vec![mount_failed()];
    });
    assert_eq!(
        titles(&mounting),
        [(Tone::Danger, "A volume of the pod cannot be mounted")]
    );
    let pulling = edited("pod", |recorded| {
        no_sandbox(&mut recorded.object);
        recorded.events = vec![
            ObjectEvent {
                kind: "Normal".to_owned(),
                ..warning("Pulling", "Pulling image")
            },
            mount_failed(),
        ];
    });
    assert!(findings(&pulling).is_empty(), "a warning that passed");
    let rebooted = edited("pod", |recorded| {
        no_sandbox(&mut recorded.object);
        recorded.object["status"]["containerStatuses"][0]["state"] =
            serde_json::json!({ "terminated": { "reason": "Unknown", "exitCode": 255 } });
        recorded.object["status"]["initContainerStatuses"] = serde_json::json!([{
            "name": "migrate",
            "state": { "terminated": { "reason": "Completed", "exitCode": 0 } },
        }]);
        recorded.events = vec![sandbox_failed()];
    });
    assert!(
        titles(&rebooted).contains(&(Tone::Danger, "The pod's sandbox cannot be created")),
        "containers containerd restores as exited after a reboot: {:?}",
        titles(&rebooted)
    );
    let remounting = edited("pod", |recorded| {
        recorded.events = vec![mount_failed()];
    });
    assert!(
        findings(&remounting).is_empty(),
        "a remount that failed in a pod that runs"
    );
    let finished_remounting = edited("pod", |recorded| {
        no_sandbox(&mut recorded.object);
        recorded.object["status"]["phase"] = "Succeeded".into();
        recorded.object["status"]["containerStatuses"][0]["state"] =
            serde_json::json!({ "terminated": { "reason": "Completed", "exitCode": 0 } });
        recorded.events = vec![mount_failed()];
    });
    assert!(
        findings(&finished_remounting).is_empty(),
        "a remount that failed in a pod that finished"
    );
    let crash_remounting = edited("pod-crashing", |recorded| {
        recorded.events.insert(0, mount_failed());
    });
    assert_eq!(
        titles(&crash_remounting),
        [(Tone::Danger, "Container api keeps crashing")],
        "a remount that failed in a pod that crash-loops"
    );
    let init_remounting = edited("pod", |recorded| {
        let status = &mut recorded.object["status"];
        status["containerStatuses"][0]["state"] =
            serde_json::json!({ "waiting": { "reason": "PodInitializing" } });
        status["initContainerStatuses"] = serde_json::json!([{
            "name": "migrate",
            "state": { "waiting": { "reason": "CrashLoopBackOff" } },
            "lastState": { "terminated": { "reason": "Error", "exitCode": 1 } },
            "restartCount": 3,
        }]);
        recorded.object["spec"]["initContainers"] =
            serde_json::json!([{ "name": "migrate", "image": "busybox" }]);
        recorded.events = vec![mount_failed(), warning("BackOff", "Back-off restarting")];
    });
    assert_eq!(
        titles(&init_remounting),
        [(Tone::Danger, "Init container migrate keeps crashing")],
        "a remount that failed while an init container crash-loops"
    );
    let inspecting = edited("pod-pulling", |recorded| {
        recorded.object["status"]["containerStatuses"][0]["state"]["waiting"]["reason"] =
            "ImageInspectError".into();
    });
    assert_eq!(
        titles(&inspecting),
        [(Tone::Danger, "The image of container api cannot be pulled")]
    );
}

#[test]
fn workloads_short_of_ready_pods_say_so() {
    let stateful = edited("statefulset", |recorded| {
        recorded.object["status"]["readyReplicas"] = 0.into();
    });
    assert_eq!(
        titles(&stateful),
        [(Tone::Warning, "Not every pod is ready")]
    );
    let daemon = edited("daemonset", |recorded| {
        recorded.object["status"]["numberReady"] = 0.into();
    });
    assert_eq!(titles(&daemon), [(Tone::Warning, "Not every pod is ready")]);
}

#[test]
fn a_backend_no_pod_is_meant_to_serve_is_no_finding() {
    let ingress = edited("ingress", |recorded| {
        for fact in &mut recorded.facts {
            if let Found::Listed { objects } = &mut fact.found {
                for object in objects.iter_mut() {
                    if object["kind"] == "Service" || object["metadata"]["name"] == "web" {
                        object["spec"]["type"] = "ExternalName".into();
                        object["spec"]["externalName"] = "web.example.test".into();
                    }
                    for endpoint in object["endpoints"].as_array_mut().into_iter().flatten() {
                        endpoint["conditions"]["ready"] = Value::Bool(false);
                    }
                }
            }
        }
        recorded.object["spec"]["rules"][0]["http"]["paths"][0]
            .as_object_mut()
            .unwrap()
            .remove("path");
    });
    assert_eq!(
        titles(&ingress),
        [(Tone::Warning, "Service reports does not exist")]
    );
    let (_, rules) = table(&ingress, "core.rules");
    assert_eq!(rules[0][1], "");
}

#[test]
fn a_node_counts_its_resource_slices_and_says_what_its_lease_holds() {
    let slices = edited("node", |recorded| {
        let fact = recorded
            .facts
            .iter_mut()
            .find(|fact| fact.need.resource == "resourceslices")
            .unwrap();
        fact.found = Found::Listed {
            objects: (0..12)
                .flat_map(|pool| {
                    (0..2).map(move |_| {
                        serde_json::json!({ "spec": {
                            "driver": "gpu.example.com",
                            "pool": { "name": format!("pool-{pool:02}") },
                            "devices": [{ "name": "a" }, { "name": "b" }, { "name": "c" }],
                        } })
                    })
                })
                .collect(),
        };
        recorded.object["status"]["conditions"][0]["lastHeartbeatTime"] =
            "2026-11-03T10:00:00Z".into();
    });
    let (columns, rows) = table(&slices, "core.resourceslices");
    assert_eq!(columns, ["Driver", "Pool", "Slices", "Devices"]);
    assert_eq!(rows.len(), 11);
    assert_eq!(rows[0], ["gpu.example.com", "pool-00", "2", "6"]);
    assert_eq!(rows[10][0], "and 2 more pools");
    let conditions = section(&slices, "core.conditions");
    let [Block::Conditions { conditions }] = &conditions.blocks[..] else {
        panic!("the conditions");
    };
    assert_eq!(
        conditions[0].last_heartbeat.as_deref(),
        Some("2026-11-03T10:00:00Z")
    );
    let lease = |found: Found| {
        edited("node", move |recorded| {
            recorded
                .facts
                .iter_mut()
                .find(|fact| fact.need.resource == "leases")
                .unwrap()
                .found = found;
        })
    };
    let node = fields(&described()["node"], "core.system").to_vec();
    assert_eq!(shown(field(&node, "Lease acquired")), "unset");
    assert!(shown(field(&node, "Lease renewed")).starts_with("2026-"));
    let none = lease(Found::Listed {
        objects: Vec::new(),
    });
    assert_eq!(shown(field(fields(&none, "core.system"), "Lease")), "none");
    let refused = lease(Found::Unavailable {
        message: "You may not list them.".to_owned(),
    });
    assert_eq!(
        shown(field(fields(&refused, "core.system"), "Lease")),
        "You may not list them."
    );
    let unset = lease(Found::Listed {
        objects: vec![serde_json::json!({ "spec": {} })],
    });
    assert_eq!(
        shown(field(fields(&unset, "core.system"), "Lease holder")),
        "unset"
    );
}

#[test]
fn a_pod_names_its_scheduling_group() {
    let grouped = edited("pod", |recorded| {
        recorded.object["spec"]["schedulingGroup"] =
            serde_json::json!({ "podGroupName": "training" });
    });
    assert_eq!(
        shown(field(
            fields(&grouped, "core.placement"),
            "Scheduling group"
        )),
        "training"
    );
}

fn no_sandbox(pod: &mut Value) {
    for condition in pod["status"]["conditions"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        if condition["type"] == "PodReadyToStartContainers" {
            condition["status"] = "False".into();
        }
    }
}

fn text(spans: &[Span]) -> String {
    spans
        .iter()
        .map(|span| match span {
            Span::Text { text } => text.as_str(),
            Span::Ago { .. } => "<ago>",
            Span::Until { .. } => "<until>",
        })
        .collect()
}

fn summary(overview: &Overview, id: &str) -> String {
    text(&section(overview, id).summary)
}

fn vital<'a>(overview: &'a Overview, label: &str) -> &'a Vital {
    overview
        .header
        .vitals
        .iter()
        .find(|vital| vital.label == label)
        .unwrap_or_else(|| panic!("no {label} in {:?}", overview.header.vitals))
}

fn vitals(overview: &Overview) -> Vec<(&str, String, Option<Tone>)> {
    overview
        .header
        .vitals
        .iter()
        .map(|vital| {
            let tone = match &vital.value {
                Shown::Toned { tone, .. } => Some(*tone),
                _ => None,
            };
            (vital.label.as_str(), shown(&vital.value), tone)
        })
        .collect()
}

fn foldings(overview: &Overview) -> Vec<(&str, Option<Tone>, Fold)> {
    overview
        .sections
        .iter()
        .map(|section| (section.id.as_str(), section.tone, section.fold))
        .collect()
}

#[test]
fn sections_come_in_the_order_a_triage_asks_its_questions() {
    let described = described();
    assert_eq!(
        ids(&described["pod"]),
        [
            "core.containers",
            "core.events",
            "core.conditions",
            "core.placement",
            "core.volumes",
            "core.configuration",
            "core.metadata"
        ]
    );
    assert_eq!(
        ids(&described["pod-crashing"]),
        [
            "core.diagnostics",
            "core.containers",
            "core.events",
            "core.conditions",
            "core.placement",
            "core.volumes",
            "core.configuration",
            "core.metadata"
        ]
    );
    assert_eq!(
        ids(&described["deployment"]),
        [
            "core.rollout",
            "core.pods",
            "core.events",
            "core.conditions",
            "core.template",
            "core.strategy",
            "core.metadata"
        ]
    );
    assert_eq!(
        ids(&described["statefulset"]),
        [
            "core.rollout",
            "core.pods",
            "core.events",
            "core.template",
            "core.claims",
            "core.strategy",
            "core.metadata"
        ]
    );
    assert_eq!(
        ids(&described["daemonset"]),
        [
            "core.rollout",
            "core.pods",
            "core.events",
            "core.template",
            "core.strategy",
            "core.metadata"
        ]
    );
    assert_eq!(
        ids(&described["node"]),
        [
            "core.resources",
            "core.conditions",
            "core.pods",
            "core.podresources",
            "core.events",
            "core.taints",
            "core.system",
            "core.metadata"
        ]
    );
    assert_eq!(
        ids(&described["service"]),
        [
            "core.service",
            "core.ports",
            "core.endpoints",
            "core.events",
            "core.metadata"
        ],
        "another kind keeps its sections, then events and metadata last"
    );
    assert_eq!(
        ids(&described["job"]),
        [
            "core.job",
            "core.conditions",
            "core.pods",
            "core.template",
            "core.events",
            "core.metadata"
        ]
    );
}

#[test]
fn a_pods_rows_sit_in_the_section_whose_name_says_what_is_inside() {
    let described = described();
    let pod = &described["pod"];
    let labels = |id: &str| -> Vec<&str> {
        fields(pod, id)
            .iter()
            .map(|field| field.label.as_str())
            .collect()
    };
    assert_eq!(
        labels("core.placement"),
        [
            "Node",
            "Host IP",
            "Pod IP",
            "QoS class",
            "Priority",
            "Node selector",
            "Tolerations"
        ]
    );
    assert_eq!(
        labels("core.configuration"),
        [
            "Service account",
            "Restart policy",
            "DNS policy",
            "Termination grace",
            "Scheduler"
        ]
    );
    assert_eq!(
        labels("core.metadata")[..4],
        ["Name", "Namespace", "Created", "Started"]
    );
    let namespace = recorded_object("pod")["metadata"]["namespace"].clone();
    let Shown::Link { target, .. } = field(fields(pod, "core.configuration"), "Service account")
    else {
        panic!("a link to the service account");
    };
    assert_eq!(
        (target.kind.as_str(), target.namespace.as_deref()),
        ("ServiceAccount", namespace.as_str()),
        "a service account belongs to the namespace of the pod that names it"
    );
    for section in &pod.sections {
        for block in &section.blocks {
            if let Block::Fields { fields } = block {
                assert!(
                    fields
                        .iter()
                        .all(|field| field.label != "Phase" && field.label != "Ready"),
                    "{} says what the vitals and the status word say",
                    section.id
                );
            }
        }
    }
    let node_labels = fields(&described["node"], "core.metadata")
        .iter()
        .any(|field| field.label == "Labels");
    assert!(
        !node_labels
            && fields(&described["node"], "core.taints")
                .iter()
                .any(|f| f.label == "Labels"),
        "a node's labels are in Taints and labels, once"
    );
}

#[test]
fn what_is_the_clusters_default_is_marked_and_counted() {
    let defaults = |overview: &Overview, id: &str| -> Vec<String> {
        fields(overview, id)
            .iter()
            .filter(|field| field.default)
            .map(|field| field.label.clone())
            .collect()
    };
    let described = described();
    let pod = &described["pod"];
    assert_eq!(
        defaults(pod, "core.configuration"),
        [
            "Service account",
            "Restart policy",
            "DNS policy",
            "Termination grace",
            "Scheduler"
        ]
    );
    assert_eq!(defaults(pod, "core.placement"), ["Priority"]);
    assert_eq!(summary(pod, "core.configuration"), "5 defaults");
    let set = edited("pod", |recorded| {
        let spec = &mut recorded.object["spec"];
        spec["serviceAccountName"] = "build-bot".into();
        spec["restartPolicy"] = "OnFailure".into();
        spec["terminationGracePeriodSeconds"] = 5.into();
        spec["schedulerName"] = "gang".into();
        spec["priority"] = 1000.into();
    });
    assert_eq!(defaults(&set, "core.configuration"), ["DNS policy"]);
    assert!(defaults(&set, "core.placement").is_empty());
    assert_eq!(
        summary(&set, "core.configuration"),
        "service account build-bot · 1 default"
    );
}

#[test]
fn an_image_pull_policy_is_the_default_the_api_server_gives_that_image() {
    let policy = |image: &str, policy: &str| {
        let overview = edited("pod", |recorded| {
            let container = &mut recorded.object["spec"]["containers"][0];
            container["image"] = image.into();
            container["imagePullPolicy"] = policy.into();
        });
        containers(&overview, "core.containers")[0]
            .details
            .iter()
            .find(|field| field.label == "Image pull policy")
            .map(|field| field.default)
    };
    assert_eq!(policy("busybox:1.37", "IfNotPresent"), Some(true));
    assert_eq!(policy("busybox:1.37", "Always"), Some(false));
    assert_eq!(policy("busybox:latest", "Always"), Some(true));
    assert_eq!(policy("busybox", "Always"), Some(true));
    assert_eq!(policy("busybox", "IfNotPresent"), Some(false));
    assert_eq!(
        policy("registry.test:5000/busybox@sha256:abc", "IfNotPresent"),
        Some(true),
        "a digest without a tag"
    );
    assert_eq!(policy("registry.test:5000/busybox", "Always"), Some(true));
}

#[test]
fn each_section_answers_the_commonest_question_while_it_is_folded() {
    let described = described();
    let recorded = recorded().remove("pod").unwrap();
    let pod = &described["pod"];
    let ip = recorded.object["status"]["podIP"].as_str().unwrap();
    let node = recorded.object["spec"]["nodeName"].as_str().unwrap();
    assert_eq!(summary(pod, "core.containers"), "1 running");
    assert_eq!(summary(pod, "core.conditions"), "5 of 5 ok");
    assert_eq!(summary(pod, "core.placement"), format!("{node} · {ip}"));
    let volumes = recorded.object["spec"]["volumes"].as_array().unwrap().len();
    assert_eq!(summary(pod, "core.volumes"), format!("{volumes} volumes"));
    assert_eq!(
        summary(pod, "core.events"),
        format!("{} events · <ago>", recorded.events.len())
    );
    let labels = recorded.object["metadata"]["labels"]
        .as_object()
        .unwrap()
        .len();
    assert_eq!(
        summary(pod, "core.metadata"),
        format!("{labels} labels · 1 annotation")
    );

    let crashing = &described["pod-crashing"];
    assert_eq!(summary(crashing, "core.containers"), "1 · 1 failing");
    assert_eq!(summary(crashing, "core.conditions"), "3 of 5 ok");
    let backoff = recorded_events("pod-crashing")
        .into_iter()
        .find(|event| event.kind == "Warning")
        .unwrap();
    assert_eq!(
        summary(crashing, "core.events"),
        format!("1 warning · {} ×{}", backoff.reason, backoff.count)
    );
    assert_eq!(
        summary(&described["pod-unready"], "core.containers"),
        "1 · 1 not ready"
    );
    let two = edited("pod", |recorded| {
        let mut sidecar = recorded.object["spec"]["containers"][0].clone();
        sidecar["name"] = "sidecar".into();
        recorded.object["spec"]["containers"]
            .as_array_mut()
            .unwrap()
            .push(sidecar);
        let mut status = recorded.object["status"]["containerStatuses"][0].clone();
        status["name"] = "sidecar".into();
        recorded.object["status"]["containerStatuses"]
            .as_array_mut()
            .unwrap()
            .push(status);
    });
    assert_eq!(summary(&two, "core.containers"), "2 running");

    let claimed = edited("pod", |recorded| {
        recorded.object["spec"]["volumes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "name": "data",
                "persistentVolumeClaim": { "claimName": "data-db-0" },
            }));
        recorded.events.clear();
    });
    assert_eq!(
        summary(&claimed, "core.volumes"),
        format!("{} volumes · 1 claim", volumes + 1)
    );
    assert_eq!(summary(&claimed, "core.events"), "none");

    let annotated = edited("pod", |recorded| {
        recorded.object["metadata"]["annotations"] = serde_json::json!({ "a": "1", "kubectl.kubernetes.io/last-applied-configuration": "{}" });
    });
    assert_eq!(
        summary(&annotated, "core.metadata"),
        format!("{labels} labels · 1 annotation"),
        "the annotation that no view shows is not counted"
    );
    let bare = edited("pod", |recorded| {
        recorded.object["metadata"]["labels"] = Value::Null;
        recorded.object["metadata"]["annotations"] = Value::Null;
    });
    assert_eq!(summary(&bare, "core.metadata"), "created <ago>");

    let deployment = &described["deployment"];
    assert_eq!(summary(deployment, "core.rollout"), "revision 2, <ago>");
    assert_eq!(summary(deployment, "core.pods"), "2/2 ready");
    assert_eq!(summary(deployment, "core.template"), "pause:3.10");
    assert_eq!(
        summary(deployment, "core.strategy"),
        "RollingUpdate · 2 replicas"
    );
    assert_eq!(summary(deployment, "core.conditions"), "2 of 2 ok");
    assert_eq!(summary(&described["statefulset"], "core.claims"), "1 claim");
    assert_eq!(
        summary(&described["statefulset"], "core.rollout"),
        "1/1 updated"
    );

    let node = &described["node"];
    let resources = table(node, "core.resources").1;
    let share = |name: &str| {
        let cell = &resources.iter().find(|row| row[0] == name).unwrap()[3];
        let open = cell.find('(').unwrap();
        cell[open + 1..cell.len() - 2].to_owned()
    };
    assert_eq!(
        summary(node, "core.resources"),
        format!(
            "cpu {}% · memory {}% requested",
            share("cpu"),
            share("memory")
        )
    );
    assert_eq!(summary(node, "core.conditions"), "4 of 4 ok");
    assert_eq!(
        summary(&described["pvc"], "core.conditions"),
        "",
        "a state that a claim is in tells nothing of its health"
    );
}

fn recorded_events(name: &str) -> Vec<ObjectEvent> {
    recorded().remove(name).unwrap().events
}

#[test]
fn a_section_holding_a_finding_names_it_and_a_fold_opens_over_what_diagnostics_do_not_explain() {
    let described = described();
    let crashing = &described["pod-crashing"];
    assert_eq!(
        foldings(crashing),
        [
            ("core.diagnostics", Some(Tone::Danger), Fold::Open),
            ("core.containers", Some(Tone::Danger), Fold::Open),
            ("core.events", Some(Tone::Warning), Fold::Open),
            ("core.conditions", Some(Tone::Warning), Fold::Folded),
            ("core.placement", None, Fold::Folded),
            ("core.volumes", None, Fold::Folded),
            ("core.configuration", None, Fold::Folded),
            ("core.metadata", None, Fold::Folded),
        ],
        "Ready and ContainersReady are what the crash says"
    );
    let healthy = foldings(&described["pod"]);
    assert_eq!(
        healthy
            .iter()
            .map(|(id, tone, fold)| (*id, *tone, *fold))
            .collect::<Vec<_>>(),
        [
            ("core.containers", None, Fold::Open),
            ("core.events", None, Fold::Folded),
            ("core.conditions", None, Fold::Folded),
            ("core.placement", None, Fold::Folded),
            ("core.volumes", None, Fold::Folded),
            ("core.configuration", None, Fold::Folded),
            ("core.metadata", None, Fold::Folded),
        ]
    );

    let pending = &described["pod-pending"];
    let placement = section(pending, "core.placement");
    assert_eq!(
        (placement.tone, placement.fold, text(&placement.summary)),
        (
            Some(Tone::Danger),
            Fold::Folded,
            "The pod cannot be scheduled".to_owned()
        )
    );

    let gated = edited("pod-crashing", |recorded| {
        recorded.object["status"]["conditions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "type": "example.com/warm", "status": "False", "reason": "Cold",
            }));
    });
    let conditions = section(&gated, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (
            Some(Tone::Warning),
            Fold::Finding,
            "example.com/warm is False · 3 of 6 ok".to_owned()
        ),
        "a condition that no finding explains names itself"
    );

    let mounting = edited("pod", |recorded| {
        for condition in recorded.object["status"]["conditions"]
            .as_array_mut()
            .unwrap()
        {
            if condition["type"] == "PodReadyToStartContainers" {
                condition["status"] = "False".into();
            }
        }
        recorded.events = vec![warning(
            "FailedMount",
            "MountVolume.SetUp failed for volume \"settings\"",
        )];
    });
    let storage = section(&mounting, "core.volumes");
    assert_eq!(
        (storage.tone, text(&storage.summary)),
        (
            Some(Tone::Danger),
            "A volume of the pod cannot be mounted".to_owned()
        )
    );

    let stuck = edited("deployment", |recorded| {
        recorded.object["status"]["conditions"] = serde_json::json!([
            { "type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded" },
        ]);
    });
    let rollout = section(&stuck, "core.rollout");
    assert_eq!(
        (rollout.tone, text(&rollout.summary)),
        (Some(Tone::Danger), "The rollout is stuck".to_owned())
    );
    assert_eq!(section(&stuck, "core.conditions").fold, Fold::Folded);

    let cordoned = edited("node", |recorded| {
        recorded.object["spec"]["unschedulable"] = true.into();
    });
    let taints = section(&cordoned, "core.taints");
    assert_eq!(
        (taints.tone, taints.fold, text(&taints.summary)),
        (
            Some(Tone::Warning),
            Fold::Folded,
            "The node is cordoned".to_owned()
        )
    );
    assert_eq!(section(&cordoned, "core.resources").fold, Fold::Open);

    let ingress = &described["ingress"];
    let rules = section(ingress, "core.rules");
    assert_eq!(
        (rules.tone, rules.fold),
        (Some(Tone::Warning), Fold::Folded),
        "the rule whose backend is missing is what the finding says"
    );
    let unserved = edited("service", |recorded| {
        for fact in &mut recorded.facts {
            if let Found::Listed { objects } = &mut fact.found {
                for slice in objects.iter_mut() {
                    for endpoint in slice["endpoints"].as_array_mut().into_iter().flatten() {
                        endpoint["conditions"]["ready"] = Value::Bool(false);
                    }
                }
            }
        }
    });
    let endpoints = section(&unserved, "core.endpoints");
    assert_eq!(
        (endpoints.tone, endpoints.fold),
        (Some(Tone::Warning), Fold::Folded)
    );

    let job = edited("job", |recorded| {
        recorded.object["status"]["conditions"] = serde_json::json!([{
            "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded",
        }]);
    });
    assert_eq!(
        foldings(&job)[..3],
        [
            ("core.diagnostics", Some(Tone::Danger), Fold::Open),
            ("core.job", Some(Tone::Danger), Fold::Open),
            ("core.conditions", Some(Tone::Danger), Fold::Folded),
        ],
        "another kind opens its first section, and its failed condition is what its finding says"
    );
}

#[test]
fn a_condition_says_whether_a_finding_already_states_why_it_is_wrong() {
    let described = described();
    let conditions = |overview: &Overview| -> Vec<(String, bool)> {
        let [Block::Conditions { conditions }] = &section(overview, "core.conditions").blocks[..]
        else {
            panic!("conditions");
        };
        conditions
            .iter()
            .map(|condition| (condition.kind.clone(), condition.explained))
            .collect()
    };
    let crashing = conditions(&described["pod-crashing"]);
    let explained: Vec<&str> = crashing
        .iter()
        .filter(|(_, explained)| *explained)
        .map(|(kind, _)| kind.as_str())
        .collect();
    assert_eq!(explained, ["Ready", "ContainersReady"]);
    assert!(
        conditions(&described["pod"])
            .iter()
            .all(|(_, explained)| !explained),
        "nothing is wrong, so nothing needs explaining"
    );
}

#[test]
fn a_pod_names_the_controller_at_the_top_of_its_owners() {
    let described = described();
    let recorded = recorded().remove("pod").unwrap();
    let deployment = recorded_object("deployment");
    let name = deployment["metadata"]["name"].as_str().unwrap();
    let owner = described["pod"].header.owner.as_ref().unwrap();
    assert_eq!(
        (
            owner.group.as_str(),
            owner.version.as_str(),
            owner.kind.as_str(),
            owner.namespace.as_deref(),
            owner.name.as_str()
        ),
        ("apps", "v1", "Deployment", Some("overview"), name)
    );

    let replica_set = recorded.object["metadata"]["ownerReferences"][0]["name"]
        .as_str()
        .unwrap();
    let [need] = &twigo_describe::needs(&recorded.object)[..] else {
        panic!("one need");
    };
    assert_eq!(
        (need.resource.as_str(), need.field_selector.as_deref()),
        (
            "replicasets",
            Some(format!("metadata.name={replica_set}")).as_deref()
        )
    );

    let direct = |facts: Vec<Fact>| {
        let overview = describe(Input {
            object: &recorded.object,
            printed: &recorded.printed,
            events: &EventList::default(),
            facts: &facts,
        });
        let owner = overview.header.owner.unwrap();
        (owner.kind, owner.name)
    };
    assert_eq!(
        direct(Vec::new()),
        ("ReplicaSet".to_owned(), replica_set.to_owned()),
        "its ReplicaSet is not listed yet"
    );
    assert_eq!(
        direct(vec![Fact {
            need: need.clone(),
            found: Found::Unavailable {
                message: "You may not list them.".to_owned()
            }
        }]),
        ("ReplicaSet".to_owned(), replica_set.to_owned()),
        "or may not be"
    );
    assert_eq!(
        direct(vec![Fact {
            need: need.clone(),
            found: Found::Listed {
                objects: vec![serde_json::json!({ "metadata": { "name": replica_set } })]
            }
        }]),
        ("ReplicaSet".to_owned(), replica_set.to_owned()),
        "a ReplicaSet that nothing controls is the top"
    );

    assert!(
        described["pod-pending"].header.owner.is_none(),
        "a pod that nothing controls"
    );
    assert!(twigo_describe::needs(&recorded_object("pod-pending")).is_empty());
    let replica = described["replicaset"].header.owner.as_ref().unwrap();
    assert_eq!(
        (replica.kind.as_str(), replica.name.as_str()),
        ("Deployment", name)
    );
    assert!(described["deployment"].header.owner.is_none());
}

#[test]
fn a_pod_of_a_job_names_the_cron_job_above_it() {
    let mut recorded = recorded().remove("pod").unwrap();
    recorded.object["metadata"]["ownerReferences"] = serde_json::json!([{
        "apiVersion": "batch/v1", "kind": "Job", "name": "report-29",
        "uid": "job-uid", "controller": true,
    }]);
    let [need] = &twigo_describe::needs(&recorded.object)[..] else {
        panic!("one need");
    };
    assert_eq!(
        (
            need.group.as_str(),
            need.resource.as_str(),
            need.field_selector.as_deref()
        ),
        ("batch", "jobs", Some("metadata.name=report-29"))
    );
    let facts = vec![Fact {
        need: need.clone(),
        found: Found::Listed {
            objects: vec![serde_json::json!({
                "metadata": {
                    "name": "report-29",
                    "ownerReferences": [{
                        "apiVersion": "batch/v1", "kind": "CronJob", "name": "report",
                        "uid": "cron-uid", "controller": true,
                    }],
                },
            })],
        },
    }];
    let overview = describe(Input {
        object: &recorded.object,
        printed: &recorded.printed,
        events: &EventList::default(),
        facts: &facts,
    });
    let owner = overview.header.owner.unwrap();
    assert_eq!(
        (
            owner.group.as_str(),
            owner.kind.as_str(),
            owner.name.as_str()
        ),
        ("batch", "CronJob", "report")
    );
}

#[test]
fn only_a_bound_pod_has_a_node() {
    let described = described();
    let recorded = recorded().remove("pod").unwrap();
    assert_eq!(
        described["pod"].header.node.as_deref(),
        recorded.object["spec"]["nodeName"].as_str()
    );
    assert_eq!(described["pod-pending"].header.node, None);
    assert_eq!(described["deployment"].header.node, None);
    assert_eq!(described["node"].header.node, None);
}

fn sentence(overview: &Overview) -> String {
    text(&overview.header.sentence)
}

#[test]
fn the_sentence_is_the_first_finding_else_the_vitals_in_words() {
    let described = described();
    assert_eq!(sentence(&described["pod"]), "1/1 ready · no restarts");
    assert_eq!(
        sentence(&described["pod-crashing"]),
        "Container api keeps crashing"
    );
    assert_eq!(
        sentence(&described["pod-pending"]),
        "The pod cannot be scheduled"
    );
    let restarted = edited("pod", |recorded| {
        recorded.object["status"]["containerStatuses"][0]["restartCount"] = 3.into();
        recorded.object["status"]["containerStatuses"][0]["lastState"] = serde_json::json!({
            "terminated": { "exitCode": 1, "finishedAt": "2026-11-03T10:05:00Z" },
        });
    });
    assert_eq!(
        restarted.header.sentence,
        [
            Span::Text {
                text: "1/1 ready · 3 restarts, last ".to_owned()
            },
            Span::Ago {
                at: "2026-11-03T10:05:00Z".to_owned()
            }
        ],
        "a time is a span, never printed text"
    );
    let finished = edited("pod", |recorded| {
        recorded.object["status"]["phase"] = "Succeeded".into();
        recorded.object["status"]["containerStatuses"][0]["state"] = serde_json::json!({
            "terminated": { "exitCode": 0, "finishedAt": "2026-11-03T10:06:00Z" },
        });
    });
    assert_eq!(
        finished.header.sentence,
        [
            Span::Text {
                text: "Finished ".to_owned()
            },
            Span::Ago {
                at: "2026-11-03T10:06:00Z".to_owned()
            }
        ]
    );

    let deployment = &described["deployment"];
    assert_eq!(sentence(deployment), "2/2 ready · revision 2, <ago>");
    let created = recorded()["deployment"].facts[0].found.clone();
    let Found::Listed { objects } = created else {
        panic!("listed");
    };
    let new = recorded_object("pod")["metadata"]["ownerReferences"][0]["name"].clone();
    let at = objects
        .iter()
        .find(|rs| rs["metadata"]["name"] == new)
        .unwrap()["metadata"]["creationTimestamp"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        deployment.header.sentence.last(),
        Some(&Span::Ago { at }),
        "the revision's age is its ReplicaSet's"
    );
    let rolling = edited("deployment", |recorded| {
        recorded.object["status"]["updatedReplicas"] = 1.into();
        recorded.object["status"]["readyReplicas"] = 1.into();
    });
    assert_eq!(
        sentence(&rolling),
        "Rolling out revision 2: 1/2 updated, 1/2 ready"
    );
    let unlisted = edited("deployment", |recorded| recorded.facts.clear());
    assert_eq!(sentence(&unlisted), "2/2 ready · revision 2");

    let node = &described["node"];
    let pods = recorded()["node"].facts[0].found.clone();
    let Found::Listed { objects } = pods else {
        panic!("listed");
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
    assert_eq!(sentence(node), format!("Schedulable · {running}/110 pods"));
    let cordoned = edited("node", |recorded| {
        recorded.object["spec"]["unschedulable"] = true.into();
    });
    assert_eq!(sentence(&cordoned), "The node is cordoned");
    let unlisted = edited("node", |recorded| recorded.facts.clear());
    assert_eq!(sentence(&unlisted), "Schedulable");

    for name in [
        "statefulset",
        "daemonset",
        "service",
        "job",
        "secret",
        "replicaset",
    ] {
        assert!(
            described[name].header.sentence.is_empty(),
            "{name}: the table names no sentence for it"
        );
    }
}

#[test]
fn each_kinds_vitals_are_toned_only_where_abnormal() {
    let described = described();
    assert_eq!(
        vitals(&described["pod"]),
        [
            ("Ready", "1/1".to_owned(), None),
            ("Restarts", "0".to_owned(), None)
        ]
    );
    assert!(vital(&described["pod"], "Restarts").note.is_empty());
    let crashing = &described["pod-crashing"];
    let pod = recorded_object("pod-crashing");
    let status = &pod["status"]["containerStatuses"][0];
    assert_eq!(
        vitals(crashing),
        [
            ("Ready", "0/1".to_owned(), Some(Tone::Warning)),
            (
                "Restarts",
                status["restartCount"].to_string(),
                Some(Tone::Warning)
            )
        ]
    );
    assert_eq!(
        vital(crashing, "Restarts").note,
        [Span::Ago {
            at: status["lastState"]["terminated"]["finishedAt"]
                .as_str()
                .unwrap()
                .to_owned()
        }]
    );
    let calm = edited("pod", |recorded| {
        recorded.object["status"]["containerStatuses"][0]["restartCount"] = 2.into();
    });
    assert_eq!(
        vitals(&calm)[1],
        ("Restarts", "2".to_owned(), None),
        "restarts that left nothing wrong"
    );
    assert!(
        vital(&calm, "Restarts").note.is_empty(),
        "no time without one to say"
    );
    let done = edited("pod", |recorded| {
        recorded.printed = vec![Printed {
            column: "Ready".to_owned(),
            value: "0/1".to_owned(),
        }];
        recorded.object["status"]["phase"] = "Succeeded".into();
    });
    assert_eq!(
        vitals(&done)[0],
        ("Ready", "0/1".to_owned(), None),
        "a pod that finished is not short of containers"
    );

    assert_eq!(
        vitals(&described["deployment"]),
        [
            ("Ready", "2/2".to_owned(), None),
            ("Updated", "2/2".to_owned(), None),
            ("Revision", "2".to_owned(), None)
        ]
    );
    assert_eq!(
        vital(&described["deployment"], "Revision").note,
        [Span::Text {
            text: "3.10".to_owned()
        }],
        "the one container's image tag"
    );
    let short = edited("deployment", |recorded| {
        recorded.object["status"]["readyReplicas"] = 1.into();
    });
    assert_eq!(
        vitals(&short)[0],
        ("Ready", "1/2".to_owned(), Some(Tone::Warning))
    );
    assert_eq!(
        vitals(&described["statefulset"]),
        [
            ("Ready", "1/1".to_owned(), None),
            ("Updated", "1/1".to_owned(), None)
        ]
    );
    assert_eq!(
        vitals(&described["daemonset"]),
        [
            ("Ready", "1/1".to_owned(), None),
            ("Updated", "1/1".to_owned(), None)
        ]
    );
    for name in [
        "service",
        "job",
        "cronjob",
        "secret",
        "pvc",
        "replicaset",
        "stage",
    ] {
        assert!(described[name].header.vitals.is_empty(), "{name}");
    }

    let node = &described["node"];
    let node_object = recorded_object("node");
    let kubelet = node_object["status"]["nodeInfo"]["kubeletVersion"]
        .as_str()
        .unwrap();
    let table = table(node, "core.resources").1;
    let share = |name: &str| {
        let cell = &table.iter().find(|row| row[0] == name).unwrap()[3];
        let open = cell.find('(').unwrap();
        cell[open + 1..cell.len() - 1].to_owned()
    };
    let labels: Vec<&str> = vitals(node).iter().map(|(label, _, _)| *label).collect();
    assert_eq!(
        labels,
        ["Pods", "CPU requested", "Memory requested", "Kubelet"]
    );
    let values: Vec<String> = vitals(node)
        .into_iter()
        .map(|(_, value, _)| value)
        .collect();
    assert!(values[0].ends_with("/110"), "{values:?}");
    assert_eq!(
        values[1..],
        [share("cpu"), share("memory"), kubelet.to_owned()]
    );
    let full = edited("node", |recorded| {
        recorded.object["status"]["allocatable"]["cpu"] = "500m".into();
    });
    assert_eq!(
        vitals(&full)[1].2,
        Some(Tone::Warning),
        "requests over what it allocates"
    );
    let unlisted = edited("node", |recorded| recorded.facts.clear());
    assert_eq!(
        vitals(&unlisted)
            .iter()
            .map(|(_, value, _)| value.as_str())
            .collect::<Vec<_>>(),
        ["–", "–", "–", kubelet],
        "a dash until its pods are listed"
    );
}

fn conditions_of(overview: &Overview) -> &[Condition] {
    match &section(overview, "core.conditions").blocks[..] {
        [Block::Conditions { conditions }] => conditions,
        blocks => panic!("conditions: {blocks:?}"),
    }
}

fn condition<'a>(overview: &'a Overview, kind: &str) -> &'a Condition {
    conditions_of(overview)
        .iter()
        .find(|condition| condition.kind == kind)
        .unwrap_or_else(|| panic!("no {kind}"))
}

fn set_condition(recorded: &mut Recorded, kind: &str, status: &str, reason: &str) {
    for condition in recorded.object["status"]["conditions"]
        .as_array_mut()
        .unwrap()
    {
        if condition["type"] == kind {
            condition["status"] = status.into();
            condition["reason"] = reason.into();
        }
    }
}

const FOLLOW: [&str; 3] = ["Ready", "ContainersReady", "PodReadyToStartContainers"];

fn toned_ids(overview: &Overview) -> Vec<&str> {
    overview
        .sections
        .iter()
        .filter(|section| section.tone.is_some())
        .map(|section| section.id.as_str())
        .collect()
}

#[test]
fn a_finished_pods_readiness_is_a_state_and_a_running_pods_follows_its_containers() {
    for phase in ["Succeeded", "Failed"] {
        let done = edited("pod", |recorded| {
            recorded.object["status"]["phase"] = phase.into();
            for kind in FOLLOW {
                set_condition(recorded, kind, "False", "PodCompleted");
            }
        });
        for kind in FOLLOW.into_iter().chain(["Initialized"]) {
            let condition = condition(&done, kind);
            assert_eq!(
                (condition.tone, condition.explained),
                (Tone::Neutral, false),
                "{phase}: {kind}"
            );
        }
        assert_eq!(condition(&done, "Initialized").status, "True");
        let conditions = section(&done, "core.conditions");
        assert_eq!(
            (conditions.tone, conditions.fold, text(&conditions.summary)),
            (None, Fold::Folded, "1 of 1 ok".to_owned()),
            "{phase}: a state is neither toned nor counted, whatever its status"
        );
    }

    let starting = edited("pod", |recorded| {
        for kind in ["Ready", "ContainersReady"] {
            set_condition(recorded, kind, "False", "ContainersNotReady");
        }
    });
    assert!(findings(&starting).is_empty());
    let conditions = section(&starting, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (Some(Tone::Warning), Fold::Folded, "3 of 5 ok".to_owned()),
        "what the containers do tones the header and never opens it"
    );

    let gated = edited("pod", |recorded| {
        for kind in ["Ready", "ContainersReady"] {
            set_condition(recorded, kind, "False", "ContainersNotReady");
        }
        recorded.object["status"]["conditions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "type": "example.com/warm", "status": "False" }));
    });
    let conditions = section(&gated, "core.conditions");
    assert_eq!(
        (conditions.fold, text(&conditions.summary)),
        (
            Fold::Finding,
            "example.com/warm is False · 3 of 6 ok".to_owned()
        ),
        "only another bad condition opens it"
    );
}

#[test]
fn an_evicted_pods_disruption_is_what_its_finding_says_and_its_reason_is_no_row() {
    let evicted = edited("pod", |recorded| {
        let status = &mut recorded.object["status"];
        status["phase"] = "Failed".into();
        status["reason"] = "Evicted".into();
        status["message"] = "The node was low on resource: memory.".into();
        status["conditions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "type": "DisruptionTarget", "status": "True", "reason": "TerminationByKubelet",
            }));
        for kind in FOLLOW {
            set_condition(recorded, kind, "False", "PodFailed");
        }
    });
    assert_eq!(titles(&evicted), [(Tone::Danger, "The pod was evicted")]);
    assert_eq!(
        findings(&evicted)[0].message.as_deref(),
        Some("The node was low on resource: memory."),
        "the finding carries the reason and the message"
    );
    assert!(condition(&evicted, "DisruptionTarget").explained);
    let conditions = section(&evicted, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (Some(Tone::Danger), Fold::Folded, "1 of 2 ok".to_owned()),
        "the finding states the disruption, and the summary says ok as it does for any pod"
    );
    let metadata = fields(&evicted, "core.metadata");
    assert!(
        metadata
            .iter()
            .all(|field| field.label != "Reason" && field.label != "Message"),
        "{metadata:?}"
    );
}

#[test]
fn a_failed_pod_with_no_message_takes_its_disruptions_reason_and_message() {
    let orphaned = edited("pod", |recorded| {
        recorded.object["status"]["phase"] = "Failed".into();
        for kind in FOLLOW {
            set_condition(recorded, kind, "False", "PodFailed");
        }
        recorded.object["status"]["conditions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "type": "DisruptionTarget", "status": "True",
                "reason": "DeletionByPodGC", "message": "PodGC: node no longer exists",
            }));
    });
    assert_eq!(titles(&orphaned), [(Tone::Danger, "The pod failed")]);
    let finding = &findings(&orphaned)[0];
    assert_eq!(text(&finding.detail), "DisruptionTarget: DeletionByPodGC.");
    assert_eq!(
        finding.message.as_deref(),
        Some("PodGC: node no longer exists")
    );
    assert!(condition(&orphaned, "DisruptionTarget").explained);
    let conditions = section(&orphaned, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold),
        (Some(Tone::Danger), Fold::Folded),
        "the finding states the disruption, so it opens nothing"
    );

    let own = edited("pod", |recorded| {
        let status = &mut recorded.object["status"];
        status["phase"] = "Failed".into();
        status["message"] = "The node was low on resource: memory.".into();
        status["conditions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "type": "DisruptionTarget", "status": "True",
                "reason": "TerminationByKubelet", "message": "The disruption's own.",
            }));
    });
    let finding = &findings(&own)[0];
    assert_eq!(
        (text(&finding.detail), finding.message.as_deref()),
        (String::new(), Some("The node was low on resource: memory.")),
        "the pod's own message is the finding's"
    );
}

#[test]
fn a_failed_pods_disruption_is_its_reason_only_if_it_came_before_its_containers_finished() {
    let disrupted = |at: &str| {
        edited("pod", |recorded| {
            let status = &mut recorded.object["status"];
            status["phase"] = "Failed".into();
            status["containerStatuses"][0]["state"] = serde_json::json!({
                "terminated": { "exitCode": 1, "reason": "Error", "finishedAt": "2026-11-03T10:05:00Z" },
            });
            status["conditions"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "type": "DisruptionTarget", "status": "True",
                    "reason": "EvictionByEvictionAPI", "message": "Eviction API: evicting",
                    "lastTransitionTime": at,
                }));
            for kind in FOLLOW {
                set_condition(recorded, kind, "False", "PodFailed");
            }
        })
    };

    let before = disrupted("2026-11-03T10:04:59Z");
    let finding = &findings(&before)[0];
    assert_eq!(
        text(&finding.detail),
        "DisruptionTarget: EvictionByEvictionAPI."
    );
    assert_eq!(finding.message.as_deref(), Some("Eviction API: evicting"));
    assert!(condition(&before, "DisruptionTarget").explained);

    let together = disrupted("2026-11-03T10:05:00Z");
    assert!(condition(&together, "DisruptionTarget").explained);

    let after = disrupted("2026-11-03T10:05:01Z");
    let finding = &findings(&after)[0];
    assert_eq!(
        (text(&finding.detail), finding.message.as_deref()),
        (String::new(), None),
        "the pod failed on its own, and a drain came after"
    );
    assert!(!condition(&after, "DisruptionTarget").explained);
    assert_eq!(
        text(&section(&after, "core.conditions").summary),
        "DisruptionTarget is True · 1 of 2 ok"
    );
}

#[test]
fn a_condition_whose_status_is_unknown_is_not_ok() {
    let silent = edited("node", |recorded| {
        for condition in recorded.object["status"]["conditions"]
            .as_array_mut()
            .unwrap()
        {
            condition["status"] = "Unknown".into();
        }
    });
    let conditions = section(&silent, "core.conditions");
    assert_eq!(
        (conditions.tone, text(&conditions.summary)),
        (Some(Tone::Warning), "0 of 4 ok".to_owned())
    );
    assert_eq!(
        titles(&silent),
        [(Tone::Danger, "The node stopped reporting")]
    );
}

#[test]
fn a_paused_deployment_says_it_is_paused() {
    let paused = edited("deployment", |recorded| {
        recorded.object["spec"]["paused"] = true.into();
        recorded.object["status"]["updatedReplicas"] = 1.into();
        set_condition(recorded, "Progressing", "Unknown", "DeploymentPaused");
    });
    assert_eq!(sentence(&paused), "Paused at revision 2: 1/2 updated");
    assert_eq!(summary(&paused, "core.rollout"), "paused · 1/2 updated");
    assert_eq!(
        summary(&paused, "core.strategy"),
        "RollingUpdate · 2 replicas · paused"
    );
    let conditions = section(&paused, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (None, Fold::Folded, "1 of 1 ok".to_owned()),
        "its Progressing is Unknown on purpose"
    );
}

#[test]
fn a_deployment_that_was_resumed_is_in_a_state_as_one_paused_is() {
    let resumed = edited("deployment", |recorded| {
        set_condition(recorded, "Progressing", "Unknown", "DeploymentResumed");
    });
    let conditions = section(&resumed, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (None, Fold::Folded, "1 of 1 ok".to_owned())
    );
}

#[test]
fn a_status_of_unknown_is_a_warning_only_where_the_kubelet_stopped_reporting() {
    let reconciling = edited("stage", |recorded| {
        recorded.object["status"] = serde_json::json!({
            "conditions": [{ "type": "Ready", "status": "Unknown", "reason": "Progressing" }],
        });
    });
    assert_eq!(condition(&reconciling, "Ready").tone, Tone::Neutral);
    let conditions = section(&reconciling, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (None, Fold::Folded, String::new()),
        "a controller that has not decided yet opens nothing and counts for nothing"
    );

    let silent = edited("pod", |recorded| {
        recorded.object["status"]["conditions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "type": "example.com/warm", "status": "Unknown" }));
    });
    assert_eq!(condition(&silent, "example.com/warm").tone, Tone::Warning);
    let conditions = section(&silent, "core.conditions");
    assert_eq!(
        (conditions.fold, text(&conditions.summary)),
        (
            Fold::Finding,
            "example.com/warm is Unknown · 5 of 6 ok".to_owned()
        )
    );
}

fn with_init(recorded: &mut Recorded, state: Value) {
    for kind in ["Ready", "ContainersReady"] {
        set_condition(recorded, kind, "False", "ContainersNotReady");
    }
    set_condition(recorded, "Initialized", "False", "ContainersNotInitialized");
    recorded.object["spec"]["initContainers"] =
        serde_json::json!([{ "name": "setup", "image": "busybox" }]);
    recorded.object["status"]["initContainerStatuses"] = serde_json::json!([{
        "name": "setup", "ready": false, "restartCount": 0, "state": state,
    }]);
    recorded.object["status"]["containerStatuses"][0]["ready"] = false.into();
    recorded.object["status"]["containerStatuses"][0]["state"] =
        serde_json::json!({ "waiting": { "reason": "PodInitializing" } });
}

#[test]
fn a_pod_whose_init_containers_run_has_its_conditions_folded_and_one_that_crashes_keeps_its_finding()
 {
    let starting = edited("pod", |recorded| {
        with_init(
            recorded,
            serde_json::json!({ "running": { "startedAt": "2026-11-03T10:01:00Z" } }),
        );
    });
    assert!(findings(&starting).is_empty());
    let conditions = section(&starting, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (Some(Tone::Warning), Fold::Folded, "2 of 5 ok".to_owned()),
        "what the init containers do tones the header and never opens it"
    );

    let crashing = edited("pod", |recorded| {
        with_init(
            recorded,
            serde_json::json!({ "waiting": { "reason": "CrashLoopBackOff" } }),
        );
        recorded.object["status"]["initContainerStatuses"][0]["restartCount"] = 3.into();
        recorded.object["status"]["initContainerStatuses"][0]["lastState"] = serde_json::json!({ "terminated": { "exitCode": 1, "finishedAt": "2026-11-03T10:00:00Z" } });
    });
    assert_eq!(
        titles(&crashing),
        [(Tone::Danger, "Init container setup keeps crashing")]
    );
    assert!(condition(&crashing, "Initialized").explained);
    let conditions = section(&crashing, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold),
        (Some(Tone::Warning), Fold::Folded)
    );
    assert_eq!(
        vitals(&crashing)[1],
        ("Restarts", "3".to_owned(), Some(Tone::Warning)),
        "an init container's crash loop is what its restarts led to"
    );
    assert_eq!(vitals(&starting)[1], ("Restarts", "0".to_owned(), None));
}

#[test]
fn a_node_condition_that_ends_in_healthy_is_good_news_while_it_is_true() {
    let monitored = |health: &str, unhealthy: &str| {
        edited("node", |recorded| {
            recorded.object["status"]["conditions"]
                .as_array_mut()
                .unwrap()
                .extend([
                    serde_json::json!({ "type": "kubernetes.azure.com/NodeHealthy", "status": health }),
                    serde_json::json!({ "type": "KubeletUnhealthy", "status": unhealthy }),
                ]);
        })
    };
    let well = monitored("True", "False");
    assert_eq!(
        [
            condition(&well, "Ready").tone,
            condition(&well, "kubernetes.azure.com/NodeHealthy").tone,
            condition(&well, "KubeletUnhealthy").tone,
        ],
        [Tone::Success; 3]
    );
    let conditions = section(&well, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (None, Fold::Folded, "6 of 6 ok".to_owned())
    );

    let ill = monitored("False", "True");
    assert_eq!(
        [
            condition(&ill, "kubernetes.azure.com/NodeHealthy").tone,
            condition(&ill, "KubeletUnhealthy").tone,
        ],
        [Tone::Warning, Tone::Danger]
    );
}

#[test]
fn a_node_condition_a_detector_adds_is_good_news_while_it_is_false() {
    let healthy = edited("node", |recorded| {
        recorded.object["status"]["conditions"]
            .as_array_mut()
            .unwrap()
            .extend([
                serde_json::json!({ "type": "KernelDeadlock", "status": "False" }),
                serde_json::json!({ "type": "ReadonlyFilesystem", "status": "False" }),
            ]);
    });
    for kind in ["KernelDeadlock", "ReadonlyFilesystem", "Ready"] {
        assert_eq!(condition(&healthy, kind).tone, Tone::Success, "{kind}");
    }
    let conditions = section(&healthy, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (None, Fold::Folded, "6 of 6 ok".to_owned())
    );

    let monitored = |status: &str| {
        edited("node", |recorded| {
            recorded.object["status"]["conditions"]
                .as_array_mut()
                .unwrap()
                .extend(
                    [
                        "KernelReady",
                        "NetworkingReady",
                        "StorageReady",
                        "ContainerRuntimeReady",
                    ]
                    .map(|kind| serde_json::json!({ "type": kind, "status": status })),
                );
            recorded.object["status"]["conditions"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({ "type": "KernelDeadlock", "status": "False" }));
        })
    };
    let agent = monitored("True");
    for kind in ["KernelReady", "NetworkingReady", "StorageReady"] {
        assert_eq!(condition(&agent, kind).tone, Tone::Success, "{kind}");
    }
    let conditions = section(&agent, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (None, Fold::Folded, "9 of 9 ok".to_owned()),
        "a type that ends in Ready is good news while it is True"
    );
    let stalled = monitored("False");
    assert_eq!(condition(&stalled, "KernelReady").tone, Tone::Warning);
    assert_eq!(condition(&stalled, "KernelDeadlock").tone, Tone::Success);
    let conditions = section(&stalled, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (
            Some(Tone::Warning),
            Fold::Finding,
            "KernelReady is False and 3 more · 5 of 9 ok".to_owned()
        )
    );

    let deadlocked = edited("node", |recorded| {
        recorded.object["status"]["conditions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "type": "KernelDeadlock", "status": "True" }));
    });
    assert_eq!(condition(&deadlocked, "KernelDeadlock").tone, Tone::Danger);
    let conditions = section(&deadlocked, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (
            Some(Tone::Danger),
            Fold::Finding,
            "KernelDeadlock is True · 4 of 5 ok".to_owned()
        )
    );
}

#[test]
fn a_draining_pod_says_why_it_is_disrupted_and_only_that_explains_the_condition() {
    let draining = |reason: Option<&str>, message: Option<&str>| {
        edited("pod", |recorded| {
            recorded.object["metadata"]["deletionTimestamp"] = "2026-11-03T12:00:30Z".into();
            recorded.object["metadata"]["deletionGracePeriodSeconds"] = 30.into();
            let mut target = serde_json::json!({ "type": "DisruptionTarget", "status": "True" });
            target["reason"] = reason.into();
            target["message"] = message.into();
            recorded.object["status"]["conditions"]
                .as_array_mut()
                .unwrap()
                .push(target);
        })
    };
    for (reason, message) in [
        ("EvictionByEvictionAPI", "Eviction API: evicting"),
        (
            "DeletionByTaintManager",
            "Taint manager: deleting due to NoExecute taint",
        ),
        (
            "PreemptionByScheduler",
            "Preempted by a higher priority pod",
        ),
    ] {
        let overview = draining(Some(reason), Some(message));
        assert_eq!(
            titles(&overview),
            [(Tone::Warning, "The pod is terminating")]
        );
        let finding = &findings(&overview)[0];
        assert_eq!(
            text(&finding.detail),
            format!(
                "Asked to stop <ago>, with a grace period of 30 s. DisruptionTarget: {reason}."
            )
        );
        assert_eq!(finding.message.as_deref(), Some(message));
        assert!(
            condition(&overview, "DisruptionTarget").explained,
            "{reason}"
        );
        assert_eq!(section(&overview, "core.conditions").fold, Fold::Folded);
    }

    let held = edited("pod", |recorded| {
        recorded.object["metadata"]["finalizers"] = serde_json::json!(["example.com/hold"]);
        recorded.object["metadata"]["deletionTimestamp"] = "2026-11-03T12:00:30Z".into();
        recorded.object["metadata"]["deletionGracePeriodSeconds"] = 30.into();
        recorded.object["status"]["conditions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "type": "DisruptionTarget", "status": "True", "message": "Eviction API: evicting",
            }));
    });
    assert_eq!(
        findings(&held)[0].message.as_deref(),
        Some("Eviction API: evicting\nFinalizers: example.com/hold")
    );

    let unsaid = draining(None, None);
    assert_eq!(findings(&unsaid)[0].message, None);
    assert!(
        !condition(&unsaid, "DisruptionTarget").explained,
        "a finding that does not say why states nothing"
    );
    let conditions = section(&unsaid, "core.conditions");
    assert_eq!(
        (conditions.tone, conditions.fold, text(&conditions.summary)),
        (
            Some(Tone::Danger),
            Fold::Finding,
            "DisruptionTarget is True · 5 of 6 ok".to_owned()
        )
    );
}

fn restarts_of(overview: &Overview) -> (String, Vec<Span>) {
    let vital = vital(overview, "Restarts");
    (shown(&vital.value), vital.note.clone())
}

#[test]
fn restarts_are_the_lists_count_and_its_last_time() {
    let described = described();
    let recorded = recorded();
    for name in [
        "pod",
        "pod-crashing",
        "pod-pulling",
        "pod-pending",
        "pod-unready",
    ] {
        let cell = &recorded[name]
            .printed
            .iter()
            .find(|cell| cell.column == "Restarts")
            .unwrap()
            .value;
        assert_eq!(
            restarts_of(&described[name]).0,
            cell.split(' ').next().unwrap(),
            "{name}"
        );
    }

    let ended = |at: &str| serde_json::json!({ "terminated": { "exitCode": 1, "finishedAt": at } });
    let print = |recorded: &mut Recorded, value: &str| {
        for cell in &mut recorded.printed {
            if cell.column == "Restarts" {
                cell.value = value.to_owned();
            }
        }
    };

    let completed = edited("pod", |recorded| {
        print(recorded, "0");
        recorded.object["spec"]["initContainers"] =
            serde_json::json!([{ "name": "setup", "image": "busybox" }]);
        recorded.object["status"]["initContainerStatuses"] = serde_json::json!([{
            "name": "setup",
            "restartCount": 2,
            "lastState": ended("2026-11-03T09:59:00Z"),
            "state": { "terminated": { "exitCode": 0, "reason": "Completed", "finishedAt": "2026-11-03T10:00:00Z" } },
        }]);
    });
    assert_eq!(
        restarts_of(&completed),
        ("0".to_owned(), Vec::new()),
        "an init container that failed twice and completed is left behind"
    );
    assert_eq!(sentence(&completed), "1/1 ready · no restarts");

    let starting = edited("pod", |recorded| {
        print(recorded, "3 (5m ago)");
        set_condition(recorded, "Initialized", "False", "ContainersNotInitialized");
        recorded.object["spec"]["initContainers"] =
            serde_json::json!([{ "name": "setup", "image": "busybox" }]);
        recorded.object["status"]["initContainerStatuses"] = serde_json::json!([{
            "name": "setup",
            "restartCount": 3,
            "lastState": ended("2026-11-03T10:00:00Z"),
            "state": { "running": { "startedAt": "2026-11-03T10:01:00Z" } },
        }]);
        recorded.object["status"]["containerStatuses"][0]["restartCount"] = 7.into();
    });
    assert_eq!(
        restarts_of(&starting),
        (
            "3".to_owned(),
            vec![Span::Ago {
                at: "2026-11-03T10:00:00Z".to_owned()
            }]
        ),
        "while it initializes, its init containers' restarts, and its containers' wait"
    );

    let sidecar = edited("pod", |recorded| {
        print(recorded, "3 (2m ago)");
        recorded.object["spec"]["initContainers"] = serde_json::json!([
            { "name": "setup", "image": "busybox" },
            { "name": "proxy", "image": "busybox", "restartPolicy": "Always" },
        ]);
        recorded.object["status"]["initContainerStatuses"] = serde_json::json!([
            {
                "name": "setup", "restartCount": 5,
                "lastState": ended("2026-11-03T10:09:00Z"),
                "state": { "terminated": { "exitCode": 0, "finishedAt": "2026-11-03T10:10:00Z" } },
            },
            {
                "name": "proxy", "restartCount": 1, "started": true,
                "lastState": ended("2026-11-03T10:07:00Z"),
                "state": { "running": { "startedAt": "2026-11-03T10:08:00Z" } },
            },
        ]);
        let app = &mut recorded.object["status"]["containerStatuses"][0];
        app["restartCount"] = 2.into();
        app["lastState"] = ended("2026-11-03T10:05:00Z");
    });
    assert_eq!(
        restarts_of(&sidecar),
        (
            "3".to_owned(),
            vec![Span::Ago {
                at: "2026-11-03T10:07:00Z".to_owned()
            }]
        ),
        "after it initialized, the sidecars' restarts and the containers', the newest end among them"
    );
}

#[test]
fn restarts_are_toned_only_where_a_container_crashes_or_failed() {
    let terminating = edited("pod", |recorded| {
        recorded.object["metadata"]["deletionTimestamp"] = "2026-11-03T10:00:30Z".into();
        recorded.object["metadata"]["deletionGracePeriodSeconds"] = 30.into();
        let app = &mut recorded.object["status"]["containerStatuses"][0];
        app["restartCount"] = 1.into();
        app["lastState"] = serde_json::json!({
            "terminated": { "exitCode": 1, "finishedAt": "2026-10-03T10:00:00Z" },
        });
    });
    assert_eq!(
        titles(&terminating),
        [(Tone::Warning, "The pod is terminating")]
    );
    assert_eq!(
        vitals(&terminating)[1],
        ("Restarts", "1".to_owned(), None),
        "a restart a month ago, under a pod that is going away"
    );
    assert_eq!(
        vitals(&described()["pod-crashing"])[1].2,
        Some(Tone::Warning),
        "the crash loop is what the restarts led to"
    );

    let month_ago = serde_json::json!({
        "terminated": { "exitCode": 1, "finishedAt": "2026-10-03T10:00:00Z" },
    });
    let unready = edited("pod", |recorded| {
        let app = &mut recorded.object["status"]["containerStatuses"][0];
        app["ready"] = false.into();
        app["restartCount"] = 1.into();
        app["lastState"] = month_ago.clone();
    });
    assert_eq!(
        titles(&unready),
        [(Tone::Warning, "Container app is not ready")]
    );
    assert_eq!(
        vitals(&unready)[1],
        ("Restarts", "1".to_owned(), None),
        "one restart a month ago under a container that is not ready"
    );

    let failed = edited("pod", |recorded| {
        let app = &mut recorded.object["status"]["containerStatuses"][0];
        app["restartCount"] = 2.into();
        app["state"] = month_ago.clone();
    });
    assert_eq!(titles(&failed), [(Tone::Danger, "Container app failed")]);
    assert_eq!(
        vitals(&failed)[1].2,
        Some(Tone::Warning),
        "a container that failed after restarts"
    );
}

#[test]
fn a_finding_tones_the_section_that_holds_what_it_says_and_no_other() {
    let described = described();
    assert_eq!(
        toned_ids(&described["ingress"]),
        ["core.diagnostics", "core.rules"],
        "its own section holds the rule, so the first one is not toned too"
    );
    assert_eq!(
        summary(&described["ingress"], "core.rules"),
        "Service reports does not exist"
    );

    let unserved = edited("service", |recorded| {
        for fact in &mut recorded.facts {
            if let Found::Listed { objects } = &mut fact.found {
                for slice in objects.iter_mut() {
                    for endpoint in slice["endpoints"].as_array_mut().into_iter().flatten() {
                        endpoint["conditions"]["ready"] = Value::Bool(false);
                    }
                }
            }
        }
    });
    assert_eq!(
        toned_ids(&unserved),
        ["core.diagnostics", "core.endpoints"],
        "the endpoints are what no ready pod serves"
    );
    assert_eq!(
        summary(&unserved, "core.endpoints"),
        "No ready pod serves it"
    );
    let bare = edited("service", |recorded| {
        for fact in &mut recorded.facts {
            fact.found = Found::Listed {
                objects: Vec::new(),
            };
        }
    });
    assert_eq!(
        toned_ids(&bare),
        ["core.diagnostics", "core.service"],
        "with no endpoints to hold it, the first section does"
    );
    assert_eq!(summary(&bare, "core.service"), "No ready pod serves it");

    let short = edited("deployment", |recorded| {
        let status = &mut recorded.object["status"];
        status["readyReplicas"] = 1.into();
        status["availableReplicas"] = 1.into();
        status["unavailableReplicas"] = 1.into();
        set_condition(recorded, "Available", "False", "MinimumReplicasUnavailable");
    });
    assert_eq!(
        titles(&short),
        [(Tone::Warning, "Fewer pods are available than it needs")]
    );
    assert_eq!(
        foldings(&short)[..3],
        [
            ("core.diagnostics", Some(Tone::Warning), Fold::Open),
            ("core.rollout", None, Fold::Open),
            ("core.pods", Some(Tone::Warning), Fold::Open),
        ]
    );
    assert_eq!(
        summary(&short, "core.pods"),
        "Fewer pods are available than it needs"
    );
    let stuck = edited("deployment", |recorded| {
        set_condition(recorded, "Progressing", "False", "ProgressDeadlineExceeded");
    });
    assert_eq!(
        foldings(&stuck)[..3],
        [
            ("core.diagnostics", Some(Tone::Danger), Fold::Open),
            ("core.rollout", Some(Tone::Danger), Fold::Open),
            ("core.pods", None, Fold::Open),
        ],
        "a stuck rollout is the rollout's"
    );

    let set = edited("statefulset", |recorded| {
        let status = &mut recorded.object["status"];
        status["readyReplicas"] = 0.into();
        status["availableReplicas"] = 0.into();
    });
    let daemons = edited("daemonset", |recorded| {
        let status = &mut recorded.object["status"];
        status["numberReady"] = 0.into();
        status["numberAvailable"] = 0.into();
        status["numberUnavailable"] = 1.into();
    });
    for (kind, overview) in [("StatefulSet", &set), ("DaemonSet", &daemons)] {
        let pods = section(overview, "core.pods");
        assert_eq!(
            (pods.tone, text(&pods.summary)),
            (Some(Tone::Warning), "Not every pod is ready".to_owned()),
            "{kind}"
        );
        assert_eq!(
            summary(overview, "core.rollout"),
            "1/1 updated",
            "{kind}: its rollout is not what the finding is about"
        );
    }
    for (kind, overview) in [
        ("Deployment", &short),
        ("StatefulSet", &set),
        ("DaemonSet", &daemons),
    ] {
        assert_eq!(
            foldings(overview)[..3],
            [
                ("core.diagnostics", Some(Tone::Warning), Fold::Open),
                ("core.rollout", None, Fold::Open),
                ("core.pods", Some(Tone::Warning), Fold::Open),
            ],
            "{kind}: its counting rows hold no tone, the Pods section and the finding do"
        );
    }

    let rolling = edited("deployment", |recorded| {
        let status = &mut recorded.object["status"];
        status["replicas"] = 3.into();
        status["updatedReplicas"] = 1.into();
        status["readyReplicas"] = 2.into();
        status["availableReplicas"] = 2.into();
        status["unavailableReplicas"] = 1.into();
    });
    assert!(findings(&rolling).is_empty());
    assert_eq!(
        foldings(&rolling)[..2],
        [
            ("core.rollout", None, Fold::Open),
            ("core.pods", None, Fold::Open)
        ],
        "a normal rolling update is no finding"
    );

    let misplaced = edited("daemonset", |recorded| {
        recorded.object["status"]["numberMisscheduled"] = 1.into();
    });
    assert_eq!(
        foldings(&misplaced)[..3],
        [
            ("core.diagnostics", Some(Tone::Warning), Fold::Open),
            ("core.rollout", Some(Tone::Warning), Fold::Open),
            ("core.pods", None, Fold::Open),
        ],
        "a pod that runs where it should not is the rollout's"
    );
}

#[test]
fn the_other_kinds_summarise_their_own_section() {
    let described = described();
    let job = &described["job"];
    assert_eq!(summary(job, "core.job"), "complete <ago>");
    assert_eq!(summary(job, "core.pods"), "1 succeeded");
    let running = edited("job", |recorded| {
        let status = recorded.object["status"].as_object_mut().unwrap();
        status.remove("completionTime");
        status.remove("succeeded");
        status.insert("active".to_owned(), 1.into());
        status.insert("failed".to_owned(), 2.into());
        status.insert("conditions".to_owned(), serde_json::json!([]));
    });
    assert_eq!(summary(&running, "core.job"), "0/1 completions");
    assert_eq!(summary(&running, "core.pods"), "1 active · 2 failed");
    let failed = edited("job", |recorded| {
        recorded.object["status"]["conditions"] = serde_json::json!([{
            "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded",
        }]);
    });
    assert_eq!(
        summary(&failed, "core.job"),
        "The job failed too many times",
        "a finding is what the section says"
    );

    let cron = &described["cronjob"];
    assert_eq!(
        summary(cron, "core.cronjob"),
        "*/1 * * * * · last run <ago>"
    );
    assert_eq!(summary(cron, "core.jobs"), "");
    let idle = edited("cronjob", |recorded| {
        recorded.object["status"] = serde_json::json!({
            "active": [{ "name": "report-1" }, { "name": "report-2" }],
        });
    });
    assert_eq!(summary(&idle, "core.cronjob"), "*/1 * * * *");
    assert_eq!(summary(&idle, "core.jobs"), "2 active");

    let service = recorded_object("service");
    assert_eq!(
        summary(&described["service"], "core.service"),
        format!(
            "ClusterIP · {}",
            service["spec"]["clusterIP"].as_str().unwrap()
        )
    );
    assert_eq!(summary(&described["ingress"], "core.ingress"), "nginx");
    assert_eq!(summary(&described["pvc"], "core.claim"), "Bound · 1Gi");
    let unbound = edited("pvc", |recorded| {
        recorded.object["status"] = serde_json::json!({ "phase": "Bound" });
    });
    assert_eq!(summary(&unbound, "core.claim"), "Bound");
}

#[test]
fn events_say_none_only_once_they_are_listed() {
    let say = |events: EventList| {
        let recorded = recorded().remove("pod").unwrap();
        let overview = describe(Input {
            object: &recorded.object,
            printed: &recorded.printed,
            events: &events,
            facts: &recorded.facts,
        });
        summary(&overview, "core.events")
    };
    assert_eq!(
        say(EventList {
            listed: false,
            ..EventList::default()
        }),
        "",
        "still coming"
    );
    assert_eq!(
        say(EventList {
            listed: true,
            ..EventList::default()
        }),
        "none"
    );
    assert_eq!(
        say(EventList {
            listed: true,
            unavailable: Some(IpcError::new(
                ErrorCode::ServerForbidden,
                "You may not list events."
            )),
            ..EventList::default()
        }),
        "unavailable"
    );
}

#[test]
fn the_header_holds_the_creation_time_of_the_object() {
    for (name, overview) in described() {
        let object = recorded_object(&name);
        assert!(
            object["metadata"]["creationTimestamp"].is_string(),
            "{name}"
        );
        assert_eq!(
            overview.header.created.as_deref(),
            object["metadata"]["creationTimestamp"].as_str(),
            "{name}"
        );
    }
}

#[test]
fn a_command_and_its_arguments_are_lists_of_their_elements() {
    let code = |text: &str| Shown::Code {
        text: text.to_owned(),
    };
    let overview = edited("pod", |recorded| {
        let container = &mut recorded.object["spec"]["containers"][0];
        container["command"] = serde_json::json!(["sh", "-c", "echo a\necho b"]);
        container["args"] = serde_json::json!(["--flag"]);
    });
    let details = &containers(&overview, "core.containers")[0].details;
    assert_eq!(
        field(details, "Command"),
        &Shown::List {
            items: vec![code("sh"), code("-c"), code("echo a\necho b")]
        },
        "an element keeps its line end"
    );
    assert_eq!(
        field(details, "Args"),
        &Shown::List {
            items: vec![code("--flag")]
        },
        "one element is a list too"
    );
}
