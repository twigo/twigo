//! The canary test (ARCHITECTURE 3.6): a distinct value in every place of
//! two revisions that can hold a secret, none of which may leave Rust in an
//! answer or a batch of the Helm commands before a Reveal, in clear, as
//! base64 in any of its three alignments, or as a raw release (`H4sI`, the
//! base64 of a gzip header); then each one a Reveal can show, revealed
//! through the bus, alone and with the rest of the manifest's, which shows
//! that the search finds what it looks for.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use twigo_cache::fake::Fake;
use twigo_ipc::{
    Ack, CompareRevisions, ComparedPart, HelmPart, ListBatch, OperationEvent, PlanRequest,
    ReleaseListQuery, ReleaseParts, ReleaseRef, SetWindow, ValueStep,
};

use super::testing::{self, Over};

const ALL: ReleaseParts = ReleaseParts {
    overview: true,
    values: true,
    manifest: true,
    history: true,
};

/// Each place of a revision that holds a canary, and how a Reveal reaches
/// it, if one can: the hook's Secret and the chart's files are shown by no
/// view of this step.
#[derive(Clone, Copy)]
enum Place {
    UserString,
    UserNumber,
    Default,
    Data,
    StringData,
    Listed,
    NotBase64,
    Hook,
    Unparsed,
    Notes,
    Description,
    File,
}

const PLACES: [Place; 12] = [
    Place::UserString,
    Place::UserNumber,
    Place::Default,
    Place::Data,
    Place::StringData,
    Place::Listed,
    Place::NotBase64,
    Place::Hook,
    Place::Unparsed,
    Place::Notes,
    Place::Description,
    Place::File,
];

impl Place {
    fn name(self) -> &'static str {
        match self {
            Place::UserString => "a string of the values",
            Place::UserNumber => "a number of the values",
            Place::Default => "a default of the chart",
            Place::Data => "a Secret's data",
            Place::StringData => "a Secret's stringData",
            Place::Listed => "a Secret in a List",
            Place::NotBase64 => "a data value that is no base64",
            Place::Hook => "a hook's Secret",
            Place::Unparsed => "a document that does not parse",
            Place::Notes => "the notes",
            Place::Description => "the description",
            Place::File => "a chart file",
        }
    }

    /// The canary of revision `version`: a word only this test writes.
    fn canary(self, version: u32) -> String {
        match self {
            Place::UserNumber => format!("{}", 739_182_460 + version),
            _ => format!(
                "cnry{}x{version}q{}",
                self as u8,
                "z".repeat(self as usize % 3)
            ),
        }
    }

    fn reveal(self) -> Option<HelmPart> {
        let secret = |document, items: &[u32], key: &str| HelmPart::Secret {
            document,
            items: items.to_vec(),
            key: key.to_owned(),
        };
        let path = |keys: &[&str]| {
            keys.iter()
                .map(|key| ValueStep::Key((*key).to_owned()))
                .collect()
        };
        Some(match self {
            Place::UserString => HelmPart::Values {
                defaults: false,
                path: path(&["auth", "password"]),
            },
            Place::UserNumber => HelmPart::Values {
                defaults: false,
                path: path(&["port"]),
            },
            Place::Default => HelmPart::Values {
                defaults: true,
                path: path(&["adminPassword"]),
            },
            Place::Data => secret(0, &[], "token"),
            Place::StringData => secret(0, &[], "password"),
            Place::Listed => secret(1, &[0], "listed"),
            Place::NotBase64 => secret(0, &[], "raw"),
            Place::Unparsed => HelmPart::Document { document: 2 },
            Place::Notes => HelmPart::Notes,
            Place::Description => HelmPart::Description,
            Place::Hook | Place::File => return None,
        })
    }

    /// Whether the whole manifest's Reveal shows it.
    fn in_manifest(self) -> bool {
        matches!(
            self,
            Place::Data
                | Place::StringData
                | Place::Listed
                | Place::NotBase64
                | Place::Unparsed
                | Place::Notes
                | Place::Description
        )
    }
}

/// Revision `version` of `a/app` with a canary in every place; its notes and
/// its description print values its Secret holds, as Q4's scrubbing takes.
fn revision(version: u32, status: &str) -> Value {
    let canary = |place: Place| place.canary(version);
    let manifest = format!(
        "---\n# Source: demo/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: app\ndata:\n  token: {}\n  raw: {}-\nstringData:\n  password: {}\n  notes: {}\n  description: {}\n---\n# Source: demo/templates/list.yaml\napiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  metadata:\n    name: listed\n  stringData:\n    listed: {}\n---\n# Source: demo/templates/broken.yaml\nkey: [unclosed {}\n",
        STANDARD.encode(canary(Place::Data)),
        canary(Place::NotBase64),
        canary(Place::StringData),
        canary(Place::Notes),
        canary(Place::Description),
        canary(Place::Listed),
        canary(Place::Unparsed),
    );
    json!({
        "name": "app",
        "namespace": "a",
        "version": version,
        "info": {
            "first_deployed": "2026-11-01T10:00:00Z",
            "last_deployed": format!("2026-11-0{version}T10:00:00Z"),
            "status": status,
            "description": format!("Upgrade failed: the server refused {}", canary(Place::Description)),
            "notes": format!("Log in with {}.", canary(Place::Notes)),
        },
        "chart": {
            "metadata": { "name": "demo", "version": format!("1.{version}.0"), "appVersion": "2.0" },
            "values": { "adminPassword": canary(Place::Default) },
            "files": [{ "name": "files/key.txt", "data": STANDARD.encode(canary(Place::File)) }],
        },
        "config": {
            "auth": { "password": canary(Place::UserString) },
            "port": 739_182_460 + version,
        },
        "manifest": manifest,
        "hooks": [{
            "name": "app-hook",
            "kind": "Secret",
            "path": "demo/templates/hook.yaml",
            "manifest": format!("apiVersion: v1\nkind: Secret\nmetadata:\n  name: app-hook\nstringData:\n  hooked: {}\n", canary(Place::Hook)),
            "events": ["pre-install"],
            "weight": 0,
            "last_run": { "phase": "Succeeded" },
        }],
    })
}

/// The texts of `canary` that a search looks for: itself, and its base64 at
/// each of the three offsets a longer text can give it, cut to the
/// characters that its bytes alone decide.
fn forms(canary: &str) -> Vec<String> {
    let mut forms = vec![canary.to_owned()];
    for offset in 0..3 {
        let mut bytes = vec![0; offset];
        bytes.extend_from_slice(canary.as_bytes());
        let encoded = STANDARD.encode(&bytes);
        let (from, to) = ((offset * 8).div_ceil(6), (offset + canary.len()) * 8 / 6);
        forms.push(encoded[from..to].to_owned());
    }
    forms
}

/// Whether `text` holds `canary` in any of its forms.
fn found(text: &str, canary: &str) -> bool {
    forms(canary)
        .iter()
        .any(|form| text.contains(form.as_str()))
}

#[tokio::test(start_paused = true)]
async fn no_canary_leaves_rust_before_a_reveal_and_each_reveal_answers_its_own() {
    let fake = Fake::default();
    testing::put(&fake, &revision(1, "superseded"), "superseded");
    testing::put(&fake, &revision(2, "deployed"), "deployed");
    let dir = tempfile::tempdir().unwrap();
    let over = Over::new(&fake, dir.path());
    let core = &over.core;
    let mut sent: Vec<(String, String)> = Vec::new();

    let (sender, mut batches) = mpsc::unbounded_channel::<ListBatch>();
    let query = ReleaseListQuery {
        space: over.space.clone(),
        namespaces: vec!["a".to_owned()],
        text: None,
        columns: None,
        sort: None,
        count_by: None,
        group_by: None,
        values: None,
    };
    let list = core
        .helm_list_subscribe("main", query, move |batch| sender.send(batch).is_ok())
        .await
        .unwrap();
    let window = SetWindow {
        id: list,
        start: 0,
        end: 10,
        metrics: false,
    };
    core.list_set_window("main", window).unwrap();
    loop {
        let batch = batches.recv().await.unwrap();
        core.list_ack(
            "main",
            Ack {
                id: list,
                seq: batch.seq,
            },
        )
        .unwrap();
        let text = serde_json::to_string(&batch).unwrap();
        let decoded = text.contains("demo-1.2.0");
        sent.push(("a list batch".to_owned(), text));
        if decoded {
            break;
        }
    }

    let (id, mut watched) = over.open("a", "app", None, ALL).await;
    for version in [2, 1, 2] {
        core.helm_release_set_view(
            "main",
            twigo_ipc::SetReleaseView {
                id,
                revision: Some(version),
                parts: ALL,
            },
        )
        .unwrap();
        watched
            .until(over.ack(id), "every part", |shown| {
                shown.revision == Some(version)
                    && shown.overview.is_some()
                    && shown.values.is_some()
                    && shown.manifest.is_some()
                    && shown.history.as_ref().is_some_and(|lines| {
                        lines.len() == 2 && lines.iter().all(|line| line.chart.is_some())
                    })
            })
            .await;
        let parts = PLACES.iter().filter_map(|place| place.reveal());
        for part in parts.chain([HelmPart::Manifest]) {
            let request = PlanRequest::RevealHelm {
                release: id,
                revision: version,
                part,
            };
            let plan = core.command_plan("main", request).await.unwrap();
            sent.push((
                format!("the plan of a Reveal of revision {version}"),
                serde_json::to_string(&plan).unwrap(),
            ));
        }
    }
    for batch in &watched.sent {
        sent.push((
            "a release batch".to_owned(),
            serde_json::to_string(batch).unwrap(),
        ));
    }
    for part in [
        ComparedPart::Values,
        ComparedPart::Defaults,
        ComparedPart::Manifest,
    ] {
        let request = CompareRevisions {
            release: ReleaseRef {
                space: over.space.clone(),
                namespace: "a".to_owned(),
                name: "app".to_owned(),
            },
            from: 1,
            to: 2,
            part,
        };
        let compared = core.helm_compare(request).await.unwrap();
        sent.push((
            "a comparison".to_owned(),
            serde_json::to_string(&compared).unwrap(),
        ));
    }
    for (what, text) in &sent {
        assert!(!text.contains("H4sI"), "a raw release in {what}");
        for version in [1, 2] {
            for place in PLACES {
                assert!(
                    !found(text, &place.canary(version)),
                    "{} of revision {version} in {what}",
                    place.name()
                );
            }
        }
    }

    for version in [2, 1] {
        core.helm_release_set_view(
            "main",
            twigo_ipc::SetReleaseView {
                id,
                revision: Some(version),
                parts: ALL,
            },
        )
        .unwrap();
        watched
            .until(over.ack(id), "the revision", |shown| {
                shown.revision == Some(version) && shown.overview.is_some()
            })
            .await;
        for place in PLACES {
            let Some(part) = place.reveal() else {
                continue;
            };
            let request = PlanRequest::RevealHelm {
                release: id,
                revision: version,
                part,
            };
            let plan = core.command_plan("main", request).await.unwrap();
            let told = over.run(&plan).await;
            let [OperationEvent::Revealed { value, binary }] = told.as_slice() else {
                panic!("{} of revision {version} was not revealed", place.name());
            };
            assert!(!binary);
            let canary = place.canary(version);
            let revealed = match place {
                Place::UserString | Place::Default => {
                    serde_json::from_str::<String>(value).unwrap()
                }
                Place::NotBase64 => value.trim_end_matches('-').to_owned(),
                _ => value.clone(),
            };
            match place {
                Place::Unparsed | Place::Notes | Place::Description => {
                    assert!(
                        revealed.contains(&canary),
                        "{} of revision {version}",
                        place.name()
                    );
                }
                _ => assert!(revealed == canary, "{} of revision {version}", place.name()),
            }
            assert!(found(value, &canary), "the search finds {}", place.name());
        }
        let request = PlanRequest::RevealHelm {
            release: id,
            revision: version,
            part: HelmPart::Manifest,
        };
        let plan = core.command_plan("main", request).await.unwrap();
        let told = over.run(&plan).await;
        let [OperationEvent::Revealed { value, binary }] = told.as_slice() else {
            panic!("the manifest of revision {version} was not revealed");
        };
        assert!(!binary);
        for place in PLACES {
            assert_eq!(
                found(value, &place.canary(version)),
                place.in_manifest(),
                "{} of revision {version} in the whole manifest",
                place.name()
            );
        }
    }
    let audit = std::fs::read_to_string(dir.path().join("audit.jsonl")).unwrap();
    assert!(audit.contains("\"event\":\"confirmed\""));
    for version in [1, 2] {
        for place in PLACES {
            assert!(
                !found(&audit, &place.canary(version)),
                "{} of revision {version} in the audit log",
                place.name()
            );
        }
    }
}
