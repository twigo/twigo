//! Reads the recorded releases as the core reads them, and compares what
//! the mock backend answers with it: `packages/protocol/src/mock/helm.json`
//! for the list and the release's editor, and `helm-revealed.json` beside it
//! for each Reveal, which `TWIGO_UPDATE_HELM=1` rewrites.

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use common::secret;
use serde::Serialize;
use serde_json::Value;
use twigo_helm::{Page, Release, compared, line, overview, page};
use twigo_ipc::{
    ComparedPart, ComparedRevisions, HelmPart, IpcError, Overview, Printed, ReleaseManifest,
    ReleaseValues, RevisionLine, Scrubbed, ValueStep,
};
use twigo_policy::redact::is_mask;

/// The releases of the mock, by the namespace of their Secrets: an upgrade
/// with a password in its values, a Secret in its manifest, notes and a test
/// hook; an upgrade that failed while its first revision stays deployed; one
/// name in two namespaces; an uninstall that kept its history; an upgrade
/// left pending; and a revision that cannot be read.
const RELEASES: [(&str, &str, &[u32]); 6] = [
    ("fmt-a", "alpha", &[1, 2]),
    ("fmt-a", "epsilon", &[1, 2]),
    ("fmt-b", "alpha", &[1]),
    ("fmt-b", "beta", &[1, 2]),
    ("fmt-d", "stuck", &[1, 2]),
    ("fmt-d", "trunc", &[1]),
];

/// What the mock answers for a release.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Mocked {
    namespace: String,
    name: String,
    /// Its latest revision's facts, from which the mock builds its row.
    latest: Latest,
    revisions: Vec<Revision>,
    /// Every pair of its revisions that can be read, the older first.
    compared: Vec<Compared>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Latest {
    name: String,
    revision: u32,
    /// The label's, as the list reads it before decoding.
    status: String,
    chart: Option<String>,
    app_version: Option<String>,
    last_deployed: Option<String>,
    /// The wire name of what keeps it from being read.
    problem: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Revision {
    revision: u32,
    problem: Option<IpcError>,
    overview: Option<Overview>,
    notes: Option<Scrubbed>,
    description: Option<Scrubbed>,
    values: Option<ReleaseValues>,
    manifest: Option<ReleaseManifest>,
    line: RevisionLine,
}

#[derive(Serialize)]
struct Compared {
    from: u32,
    to: u32,
    values: ComparedRevisions,
    defaults: ComparedRevisions,
    manifest: ComparedRevisions,
}

#[derive(Serialize)]
struct Revealed {
    part: HelmPart,
    value: String,
    binary: bool,
}

struct Read {
    revision: u32,
    status: String,
    page: Result<Page, IpcError>,
}

fn read(namespace: &str, name: &str, revisions: &[u32]) -> Vec<Read> {
    revisions
        .iter()
        .map(|&revision| {
            let recorded = secret(&format!(
                "{namespace}.sh.helm.release.v1.{name}.v{revision}"
            ));
            Read {
                revision,
                status: recorded.labels["status"].clone(),
                page: page(&recorded.stored()),
            }
        })
        .collect()
}

fn mocked(namespace: &str, name: &str, read: &[Read]) -> Mocked {
    let newest = read.last().unwrap();
    let summary = newest.page.as_ref().ok().map(Page::summary);
    let latest = Latest {
        name: name.to_owned(),
        revision: newest.revision,
        status: newest.status.clone(),
        chart: summary.and_then(|summary| summary.chart()),
        app_version: summary.and_then(|summary| summary.app_version().map(str::to_owned)),
        last_deployed: summary
            .and_then(|summary| summary.last_deployed())
            .map(|at| at.to_string()),
        problem: newest.page.as_ref().err().map(|error| error.code.wire()),
    };
    let printed: Vec<Printed> = [
        ("Name", Some(latest.name.clone())),
        ("Revision", Some(latest.revision.to_string())),
        ("Status", Some(latest.status.clone())),
        ("Chart", latest.chart.clone()),
        ("App Version", latest.app_version.clone()),
        ("Problem", latest.problem.map(str::to_owned)),
    ]
    .into_iter()
    .map(|(column, value)| Printed {
        column: column.to_owned(),
        value: value.unwrap_or_default(),
    })
    .collect();
    let deployed = read
        .iter()
        .rev()
        .find(|read| read.status == "deployed")
        .map(|read| read.revision);
    let release = Release {
        printed: &printed,
        deployed,
    };
    let revisions = read
        .iter()
        .map(|read| match &read.page {
            Ok(page) => Revision {
                revision: read.revision,
                problem: None,
                overview: Some(overview(page, &release)),
                notes: Some(page.notes()),
                description: Some(page.description()),
                values: Some(page.values()),
                manifest: Some(page.manifest()),
                line: line(page.summary(), Some(page.description())),
            },
            Err(error) => Revision {
                revision: read.revision,
                problem: Some(error.clone()),
                overview: None,
                notes: None,
                description: None,
                values: None,
                manifest: None,
                line: RevisionLine {
                    revision: read.revision,
                    status: read.status.clone(),
                    updated: None,
                    chart: None,
                    app_version: None,
                    description: None,
                    rollback_of: None,
                    problem: Some(error.clone()),
                },
            },
        })
        .collect();
    let pages: Vec<(u32, &Page)> = read
        .iter()
        .filter_map(|read| read.page.as_ref().ok().map(|page| (read.revision, page)))
        .collect();
    let mut pairs = Vec::new();
    for (index, (from, older)) in pages.iter().enumerate() {
        for (to, newer) in &pages[index + 1..] {
            pairs.push(Compared {
                from: *from,
                to: *to,
                values: compared(older, newer, ComparedPart::Values),
                defaults: compared(older, newer, ComparedPart::Defaults),
                manifest: compared(older, newer, ComparedPart::Manifest),
            });
        }
    }
    Mocked {
        namespace: namespace.to_owned(),
        name: name.to_owned(),
        latest,
        revisions,
        compared: pairs,
    }
}

fn places(page: &Page) -> Vec<HelmPart> {
    let mut parts = Vec::new();
    for defaults in [false, true] {
        let whole = HelmPart::Values {
            defaults,
            path: Vec::new(),
        };
        let (text, _) = page.revealed(&whole).unwrap();
        paths(
            &serde_json::from_str(&text).unwrap(),
            &mut Vec::new(),
            &mut |path| {
                parts.push(HelmPart::Values {
                    defaults,
                    path: path.to_vec(),
                });
            },
        );
    }
    let manifest = page.manifest();
    for secret in &manifest.secrets {
        for entry in &secret.entries {
            parts.push(HelmPart::Secret {
                document: secret.document,
                items: secret.items.clone(),
                key: entry.key.clone(),
            });
        }
    }
    for unread in &manifest.unread {
        parts.push(HelmPart::Document {
            document: unread.document,
        });
    }
    parts.extend([HelmPart::Notes, HelmPart::Description]);
    parts
}

fn paths(value: &Value, path: &mut Vec<ValueStep>, each: &mut impl FnMut(&[ValueStep])) {
    each(path);
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                path.push(ValueStep::Key(key.clone()));
                paths(value, path, each);
                path.pop();
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(ValueStep::Index(index as u32));
                paths(item, path, each);
                path.pop();
            }
        }
        _ => {}
    }
}

fn recorded_as(path: &str, json: &str) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path);
    if std::env::var_os("TWIGO_UPDATE_HELM").is_some() {
        std::fs::write(&file, json).unwrap();
    }
    assert!(
        std::fs::read_to_string(&file).is_ok_and(|current| current == json),
        "run TWIGO_UPDATE_HELM=1 cargo test -p twigo-helm --test mock"
    );
}

/// `value` in base64 in each of the three alignments a longer text can give
/// it, but for the characters its neighbours share.
fn base64_forms(value: &[u8]) -> Vec<String> {
    (0..3)
        .filter_map(|offset| {
            let mut padded = vec![0; offset];
            padded.extend_from_slice(value);
            let encoded = STANDARD.encode(&padded);
            let (start, end) = (offset.div_ceil(3) * 4, (offset + value.len()) / 3 * 4);
            (end > start).then(|| encoded[start..end].to_owned())
        })
        .collect()
}

fn masked_only(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            is_mask(text)
                || text
                    .strip_suffix(", changed>")
                    .is_some_and(|size| is_mask(&format!("{size}>")))
        }
        Value::Number(_) => false,
        Value::Array(items) => items.iter().all(masked_only),
        Value::Object(map) => map.values().all(masked_only),
        Value::Bool(_) | Value::Null => true,
    }
}

#[test]
fn the_mock_answers_with_the_recorded_releases_and_none_of_their_secrets() {
    let mut releases = Vec::new();
    let mut revealed: BTreeMap<String, BTreeMap<u32, Vec<Revealed>>> = BTreeMap::new();
    let mut secrets = Vec::new();
    for (namespace, name, revisions) in RELEASES {
        let read = read(namespace, name, revisions);
        for read in &read {
            let Ok(page) = &read.page else { continue };
            let mut answers = Vec::new();
            for part in places(page) {
                let Ok((value, binary)) = page.revealed(&part) else {
                    continue;
                };
                let scrubbed = match part {
                    HelmPart::Notes => Some(page.notes().hidden),
                    HelmPart::Description => Some(page.description().hidden),
                    HelmPart::Secret { .. } | HelmPart::Document { .. } => Some(true),
                    HelmPart::Values { .. } => None,
                };
                if scrubbed == Some(true) {
                    secrets.push(value.clone());
                }
                answers.push(Revealed {
                    part,
                    value,
                    binary,
                });
            }
            revealed
                .entry(format!("{namespace}/{name}"))
                .or_default()
                .insert(read.revision, answers);
        }
        releases.push(mocked(namespace, name, &read));
    }
    let json =
        serde_json::to_string_pretty(&serde_json::json!({ "releases": releases })).unwrap() + "\n";
    recorded_as("packages/protocol/src/mock/helm.json", &json);
    let answers = serde_json::to_string_pretty(&revealed).unwrap() + "\n";
    recorded_as("packages/protocol/src/mock/helm-revealed.json", &answers);

    assert!(!json.contains("H4sI"), "a release's payload in the mock");
    assert!(secrets.len() >= 8, "{} values searched", secrets.len());
    for secret in &secrets {
        let escaped = serde_json::to_string(secret).unwrap();
        let mut forms = vec![escaped.trim_matches('"').to_owned()];
        forms.extend(base64_forms(secret.as_bytes()));
        for form in forms {
            assert!(!json.contains(&form), "{form} in the mock's releases");
        }
    }
    let mock: Value = serde_json::from_str(&json).unwrap();
    for release in mock["releases"].as_array().unwrap() {
        let revisions = release["revisions"].as_array().unwrap();
        let shown = revisions
            .iter()
            .filter_map(|revision| revision["values"].as_object());
        let compared = release["compared"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|pair| [&pair["values"], &pair["defaults"]]);
        for text in shown
            .flat_map(|values| [&values["user"], &values["defaults"]])
            .chain(compared.flat_map(|pair| [&pair["from"], &pair["to"]]))
        {
            let values: Value = serde_json::from_str(text.as_str().unwrap()).unwrap();
            assert!(masked_only(&values), "{values}");
        }
    }
}
