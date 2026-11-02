//! Describes the objects recorded from kind (`cargo run -p twigo-core
//! --example record_objects`) and compares the documents, with the objects
//! as views show them, with the mock backend's, which
//! `TWIGO_UPDATE_OBJECTS=1` rewrites.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use twigo_describe::{Input, Printed, describe};
use twigo_ipc::{Block, ObjectEvent, Overview};

#[derive(Deserialize)]
struct Recorded {
    object: Value,
    printed: Vec<Printed>,
    events: Vec<ObjectEvent>,
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
                events: &recorded.events,
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
        ids(&described["deployment"]),
        [
            "core.metadata",
            "core.summary",
            "core.spec",
            "core.status",
            "core.conditions",
            "core.events"
        ]
    );
    assert_eq!(
        ids(&described["stage"]),
        ["core.metadata", "core.spec", "core.events"],
        "a CRD without printer columns or status"
    );
}

#[test]
fn a_secret_shows_its_keys_and_sizes_and_no_value() {
    let described = described();
    let secret = &described["secret"];
    assert_eq!(ids(secret), ["core.metadata", "core.data", "core.events"]);
    let Block::Data { entries } = &secret.sections[1].blocks[1] else {
        panic!("the data block: {:?}", secret.sections[1].blocks);
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
    let Block::Data { entries } = &described["configmap"].sections[1].blocks[0] else {
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
fn a_pod_names_its_controller_and_its_events_newest_first() {
    let described = described();
    let pod = &described["pod"];
    let Block::Fields { fields } = &pod.sections[0].blocks[0] else {
        panic!("the metadata fields");
    };
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
    let Some(Block::Events { events }) = pod.sections.last().and_then(|s| s.blocks.first()) else {
        panic!("the events last");
    };
    assert!(events.iter().any(|event| event.reason == "Scheduled"));
    assert!(events.is_sorted_by(|a, b| a.last >= b.last));
}
