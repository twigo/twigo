//! A release's editor over the recorded revisions: its overview, its notes
//! and descriptions scrubbed, its Reveals and its comparisons.

mod common;

use common::{secret, text};
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::io::Write;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use flate2::Compression;
use flate2::write::GzEncoder;
use twigo_helm::{Page, Release, Stored, compared, line, overview, page};
use twigo_ipc::{
    Block, ComparedPart, ErrorCode, Fold, HelmPart, Printed, Span, Tone, Value, ValueStep,
};

fn opened(file: &str) -> Page {
    page(&secret(file).stored()).ok().unwrap()
}

fn shown(release: &Page, deployed: Option<u32>) -> twigo_ipc::Overview {
    let printed = [Printed {
        column: "Status".to_owned(),
        value: release.summary().status().word().to_owned(),
    }];
    overview(
        release,
        &Release {
            printed: &printed,
            deployed,
        },
    )
}

fn ids(overview: &twigo_ipc::Overview) -> Vec<&str> {
    overview
        .sections
        .iter()
        .map(|section| section.id.as_str())
        .collect()
}

fn words(spans: &[Span]) -> String {
    spans
        .iter()
        .map(|span| match span {
            Span::Text { text } => text.as_str(),
            Span::Ago { .. } | Span::Until { .. } => "<time>",
        })
        .collect()
}

fn field<'a>(overview: &'a twigo_ipc::Overview, section: &str, label: &str) -> Option<&'a Value> {
    let section = overview.sections.iter().find(|shown| shown.id == section)?;
    section.blocks.iter().find_map(|block| match block {
        Block::Fields { fields } => fields
            .iter()
            .find(|field| field.label == label)
            .map(|field| &field.value),
        _ => None,
    })
}

#[test]
fn a_healthy_release_says_nothing_is_wrong_and_each_fact_once() {
    let alpha = shown(&opened("fmt-a.sh.helm.release.v1.alpha.v2"), Some(2));
    assert!(alpha.header.sentence.is_empty());
    assert_eq!(
        alpha.header.created.as_deref(),
        Some("2026-11-22T20:14:04.369027Z")
    );
    assert_eq!(
        ids(&alpha),
        ["helm.objects", "helm.hooks", "helm.chart", "helm.metadata"]
    );
    let vitals: Vec<(&str, &Value)> = alpha
        .header
        .vitals
        .iter()
        .map(|vital| (vital.label.as_str(), &vital.value))
        .collect();
    let plain = |text: &str| Value::Text {
        text: text.to_owned(),
    };
    assert_eq!(
        vitals,
        [
            ("Revision", &plain("2")),
            ("Chart version", &plain("0.1.0")),
            ("App version", &plain("1.0.0")),
        ]
    );
    assert!(
        alpha
            .header
            .vitals
            .iter()
            .all(|vital| vital.note.is_empty())
    );
    let Block::Table { rows, .. } = &alpha.sections[0].blocks[0] else {
        panic!("the objects' table");
    };
    let links: Vec<(&str, &str)> = rows
        .iter()
        .map(|row| match &row[1] {
            Value::Link { target, text } => (target.kind.as_str(), text.as_str()),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        links,
        [
            ("Secret", "alpha-db"),
            ("ConfigMap", "alpha-sub"),
            ("ConfigMap", "alpha-config"),
            ("Service", "alpha-svc"),
        ]
    );
    assert_eq!(alpha.sections[0].fold, Fold::Open);
    assert!(
        field(&alpha, "helm.chart", "Version").is_none(),
        "the vitals hold it"
    );
    assert_eq!(
        field(&alpha, "helm.metadata", "Apply method"),
        Some(&plain("Server-side apply"))
    );
    assert!(field(&alpha, "helm.metadata", "Target namespace").is_none());
    let Some(Value::Labels { labels }) = field(&alpha, "helm.metadata", "Labels") else {
        panic!("the release's own labels");
    };
    assert_eq!(
        labels
            .iter()
            .map(|label| (label.key.as_str(), label.value.as_str()))
            .collect::<Vec<_>>(),
        [("team", "fixtures")]
    );
}

#[test]
fn a_failed_upgrade_says_which_revision_is_deployed() {
    let epsilon = shown(&opened("fmt-a.sh.helm.release.v1.epsilon.v2"), Some(1));
    assert_eq!(epsilon.sections[0].id, "helm.diagnostics");
    assert_eq!(epsilon.sections[0].tone, Some(Tone::Danger));
    let Block::Diagnostics { findings } = &epsilon.sections[0].blocks[0] else {
        panic!("the findings");
    };
    assert_eq!(findings[0].title, "Revision 2 failed");
    assert_eq!(words(&findings[0].detail), "Revision 1 is deployed.");
    assert_eq!(words(&epsilon.header.sentence), "Revision 2 failed");
    assert_eq!(words(&epsilon.header.vitals[0].note), "r1 deployed");
    assert_eq!(
        field(&epsilon, "helm.metadata", "Apply method"),
        Some(&Value::Text {
            text: "Client-side apply".to_owned()
        })
    );
    let deployed = shown(&opened("fmt-a.sh.helm.release.v1.epsilon.v1"), Some(1));
    assert!(!ids(&deployed).contains(&"helm.diagnostics"));
}

#[test]
fn a_stuck_upgrade_says_since_when_and_what_helm_refuses() {
    let stuck = shown(&opened("fmt-d.sh.helm.release.v1.stuck.v2"), Some(1));
    let Block::Diagnostics { findings } = &stuck.sections[0].blocks[0] else {
        panic!("the findings");
    };
    assert_eq!(findings[0].tone, Tone::Warning);
    assert_eq!(findings[0].title, "The upgrade of revision 2 has not ended");
    assert_eq!(
        words(&findings[0].detail),
        "It started <time>. Helm refuses to upgrade the release until it ends."
    );
    assert!(findings[0].detail.contains(&Span::Ago {
        at: "2026-11-22T20:20:00Z".to_owned()
    }));
}

#[test]
fn a_release_stored_away_from_its_objects_names_their_namespace() {
    let moved = shown(&opened("fmt-store.sh.helm.release.v1.alpha.v2"), Some(2));
    let Some(Value::Link { text, .. }) = field(&moved, "helm.metadata", "Target namespace") else {
        panic!("the target namespace");
    };
    assert_eq!(text, "fmt-a");
    assert!(
        !ids(&moved).contains(&"helm.diagnostics"),
        "a field, not a finding"
    );
}

#[test]
fn notes_and_a_description_that_print_a_secret_s_value_are_scrubbed() {
    let epsilon = opened("fmt-a.sh.helm.release.v1.epsilon.v2");
    let notes = epsilon.notes();
    assert!(notes.hidden);
    assert_eq!(notes.text, "Log in as admin with the password <hidden>.\n");
    let description = epsilon.description();
    assert!(description.hidden);
    for value in [
        "epsilon-password-r2",
        "ZXBzaWxvbi1wYXNzd29yZC1yMg",
        "not base64!",
    ] {
        assert!(!description.text.contains(value), "{}", description.text);
    }
    assert!(
        description
            .text
            .contains("patch: Invalid value: <hidden>: illegal base64")
    );
    let history: Vec<Json> = serde_json::from_str(&text("get/epsilon.v4.history.json")).unwrap();
    let (stored, _) = epsilon.revealed(&HelmPart::Description).unwrap();
    assert_eq!(stored, history[1]["description"]);
    let (stored, _) = epsilon.revealed(&HelmPart::Notes).unwrap();
    assert_eq!(
        format!("NOTES:\n{stored}\n"),
        text("get/epsilon.r2.v4.notes.txt")
    );
    let line = line(epsilon.summary(), Some(description.clone()));
    assert_eq!((line.revision, line.status.as_str()), (2, "failed"));
    assert_eq!(line.description, Some(description));
}

#[test]
fn each_reveal_answers_its_value_and_an_address_that_names_nothing_is_refused() {
    let alpha = opened("fmt-a.sh.helm.release.v1.alpha.v2");
    let key = |key: &str| ValueStep::Key(key.to_owned());
    let values = |defaults, path: Vec<ValueStep>| HelmPart::Values { defaults, path };
    let secret = |key: &str| HelmPart::Secret {
        document: 0,
        items: Vec::new(),
        key: key.to_owned(),
    };
    for (part, value) in [
        (
            values(false, vec![key("database"), key("password")]),
            "\"user-password-r2\"",
        ),
        (
            values(true, vec![key("database"), key("password")]),
            "\"chart-default-password\"",
        ),
        (values(true, vec![key("fromSub"), key("answer")]), "42"),
        (secret("password"), "user-password-r2"),
        (secret("token"), "token-for-alpha"),
    ] {
        assert_eq!(
            alpha.revealed(&part).unwrap(),
            (value.to_owned(), false),
            "{part:?}"
        );
    }
    let epsilon = opened("fmt-a.sh.helm.release.v1.epsilon.v2");
    assert_eq!(
        epsilon.revealed(&secret("extra")).unwrap(),
        ("not base64!".to_owned(), false)
    );
    let beta = opened("fmt-b.sh.helm.release.v1.beta.v2");
    for part in [
        values(false, vec![key("database")]),
        secret("password"),
        HelmPart::Document { document: 0 },
        HelmPart::Notes,
    ] {
        assert_eq!(
            beta.revealed(&part).unwrap_err().code,
            ErrorCode::HelmNoValue,
            "{part:?}"
        );
    }
    assert_eq!(
        alpha
            .revealed(&HelmPart::Secret {
                document: 1,
                items: Vec::new(),
                key: "greeting".to_owned(),
            })
            .unwrap_err()
            .code,
        ErrorCode::HelmNoValue,
        "a ConfigMap is not revealed"
    );
}

#[test]
fn two_revisions_compare_with_what_changed_marked() {
    let (first, second) = (
        opened("fmt-a.sh.helm.release.v1.alpha.v1"),
        opened("fmt-a.sh.helm.release.v1.alpha.v2"),
    );
    let values = compared(&first, &second, ComparedPart::Values);
    let (from, to): (Json, Json) = (
        serde_json::from_str(&values.from).unwrap(),
        serde_json::from_str(&values.to).unwrap(),
    );
    assert_eq!(from["database"]["password"], "<16 bytes, changed>");
    assert_eq!(to["database"]["password"], "<16 bytes, changed>");
    assert_eq!(from["zz"], "<24 bytes>", "only in the first");
    let defaults = compared(&first, &second, ComparedPart::Defaults);
    assert_eq!(defaults.from, defaults.to, "the chart did not change");
    let manifest = compared(&first, &second, ComparedPart::Manifest);
    assert!(
        manifest.from.contains("password: <16 bytes, changed>"),
        "{}",
        manifest.from
    );
    assert!(
        manifest.to.contains("password: <16 bytes, changed>"),
        "{}",
        manifest.to
    );
    assert!(
        manifest.to.contains("token: <15 bytes>\n"),
        "{}",
        manifest.to
    );
    for text in [&manifest.from, &manifest.to, &values.from, &values.to] {
        assert!(!text.contains("user-password-r"), "{text}");
    }
}

fn built(release: &Json) -> Page {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::best());
    gzip.write_all(release.to_string().as_bytes()).unwrap();
    let encoded = STANDARD.encode(gzip.finish().unwrap()).into_bytes();
    let name = release["name"].as_str().unwrap();
    let labels: BTreeMap<String, String> = [("owner", "helm"), ("name", name), ("version", "1")]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
    page(&Stored {
        name: &format!("sh.helm.release.v1.{name}.v1"),
        namespace: "default",
        kind: "helm.sh/release.v1",
        labels: &labels,
        release: Some(&encoded),
    })
    .ok()
    .unwrap()
}

#[test]
fn an_object_whose_document_writes_an_empty_namespace_links_to_the_release_s() {
    let release = serde_json::json!({
        "name": "spread",
        "namespace": "payments",
        "version": 1,
        "info": { "status": "deployed" },
        "manifest": "---\nkind: ConfigMap\napiVersion: v1\nmetadata: {name: empty, namespace: \"\"}\n---\nkind: ConfigMap\napiVersion: v1\nmetadata: {name: none}\n---\nkind: ConfigMap\napiVersion: v1\nmetadata: {name: elsewhere, namespace: other}\n",
    });
    let overview = shown(&built(&release), Some(1));
    let objects = overview
        .sections
        .iter()
        .find(|section| section.id == "helm.objects")
        .expect("the objects");
    let Block::Table { rows, .. } = &objects.blocks[0] else {
        panic!("the table");
    };
    let linked: Vec<(&str, Option<&str>)> = rows
        .iter()
        .map(|row| match &row[1] {
            Value::Link { target, text } => (text.as_str(), target.namespace.as_deref()),
            other => panic!("a link: {other:?}"),
        })
        .collect();
    assert_eq!(
        linked,
        [
            ("empty", Some("payments")),
            ("none", Some("payments")),
            ("elsewhere", Some("other"))
        ]
    );
}

#[test]
fn the_objects_say_the_namespace_they_live_in_where_the_manifest_or_the_kind_tells_it() {
    let release = serde_json::json!({
        "name": "spread",
        "namespace": "payments",
        "version": 1,
        "info": { "status": "deployed" },
        "manifest": "---\nkind: ConfigMap\napiVersion: v1\nmetadata: {name: none}\n---\nkind: ConfigMap\napiVersion: v1\nmetadata: {name: empty, namespace: \"\"}\n---\nkind: ConfigMap\napiVersion: v1\nmetadata: {name: elsewhere, namespace: other}\n---\nkind: Deployment\napiVersion: apps/v1\nmetadata: {name: web}\n---\nkind: ClusterRole\napiVersion: rbac.authorization.k8s.io/v1\nmetadata: {name: reader}\n---\nkind: ServiceMonitor\napiVersion: monitoring.coreos.com/v1\nmetadata: {name: scrape}\n",
    });
    let overview = shown(&built(&release), Some(1));
    let objects = overview
        .sections
        .iter()
        .find(|section| section.id == "helm.objects")
        .expect("the objects");
    let Block::Table { rows, .. } = &objects.blocks[0] else {
        panic!("the table");
    };
    let lives: Vec<(&str, &str)> = rows
        .iter()
        .map(|row| match (&row[1], &row[2]) {
            (Value::Link { text, .. }, Value::Text { text: namespace }) => {
                (text.as_str(), namespace.as_str())
            }
            other => panic!("a link and a text: {other:?}"),
        })
        .collect();
    assert_eq!(
        lives,
        [
            ("none", "payments"),
            ("empty", "payments"),
            ("elsewhere", "other"),
            ("web", "payments"),
            ("reader", ""),
            ("scrape", ""),
        ]
    );
}

#[test]
fn an_uninstall_that_has_not_ended_says_so() {
    let release = serde_json::json!({
        "name": "leaving",
        "version": 1,
        "info": { "status": "uninstalling", "description": "Deletion in progress (or silently failed)" },
    });
    let leaving = shown(&built(&release), None);
    let Block::Diagnostics { findings } = &leaving.sections[0].blocks[0] else {
        panic!("the findings");
    };
    assert_eq!(
        (findings[0].tone, findings[0].title.as_str()),
        (Tone::Warning, "The uninstall has not ended")
    );
}

#[test]
fn a_hook_s_secret_is_masked_and_scrubbed_from_the_notes() {
    let release = serde_json::json!({
        "name": "hooked",
        "version": 1,
        "info": { "status": "deployed", "notes": "The key is fernet-key-canary." },
        "manifest": "",
        "hooks": [{
            "name": "hooked-key",
            "kind": "Secret",
            "path": "hooked/templates/key.yaml",
            "manifest": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: hooked-key\nstringData:\n  key: fernet-key-canary\n",
            "events": ["pre-install"],
            "last_run": { "phase": "Succeeded" },
        }],
    });
    let hooked = built(&release);
    assert_eq!(hooked.notes().text, "The key is <hidden>.");
    assert_eq!(
        hooked.hooks(),
        "---\n# Source: hooked/templates/key.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: hooked-key\nstringData:\n  key: <17 bytes>\n\n"
    );
}
