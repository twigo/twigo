//! Each recorded revision of `alpha` (helm v4.3.2) and `beta` (helm v3.22.1)
//! against what `helm get` and `helm history` of helm v4.3.2 printed for it:
//! the manifest, the notes and the hooks byte for byte, but for the Secrets
//! Twigo masks, and the values as JSON.

mod common;

use common::{secret, text};
use serde_json::Value;
use twigo_helm::{Page, line, page};
use twigo_ipc::{HelmPart, Scrubbed};
use twigo_policy::redact::is_mask;

const REVISIONS: [(&str, &str, u32); 4] = [
    ("fmt-a", "alpha", 1),
    ("fmt-a", "alpha", 2),
    ("fmt-b", "beta", 1),
    ("fmt-b", "beta", 2),
];

fn revisions() -> impl Iterator<Item = (String, Page)> {
    REVISIONS.into_iter().map(|(namespace, release, revision)| {
        let recorded = secret(&format!(
            "{namespace}.sh.helm.release.v1.{release}.v{revision}"
        ));
        let page = page(&recorded.stored()).ok().unwrap();
        (format!("{release}.r{revision}.v4"), page)
    })
}

fn documents(manifest: &str) -> Vec<&str> {
    manifest
        .split("\n---\n")
        .filter(|document| !document.trim().is_empty())
        .collect()
}

#[test]
fn the_manifest_is_helm_s_but_for_its_secrets() {
    for (printed, page) in revisions() {
        let helm = text(&format!("get/{printed}.manifest.txt"));
        let manifest = page.manifest();
        let (ours, theirs) = (documents(&manifest.text), documents(&helm));
        assert_eq!(ours.len(), theirs.len(), "{printed}");
        let secrets: Vec<usize> = manifest
            .secrets
            .iter()
            .map(|secret| secret.document as usize)
            .collect();
        for (index, (ours, theirs)) in ours.iter().zip(&theirs).enumerate() {
            if secrets.contains(&index) {
                assert_ne!(ours, theirs, "{printed} document {index}");
                for value in [
                    "db.example",
                    "user-password-r",
                    "dG9rZW4t",
                    "token-for-alpha",
                ] {
                    assert!(!ours.contains(value), "{printed}: {value} in {ours}");
                }
            } else {
                assert_eq!(ours, theirs, "{printed} document {index}");
            }
        }
        if secrets.is_empty() {
            assert_eq!(manifest.text, helm, "{printed}");
        }
        assert_eq!(
            secrets.is_empty(),
            printed.starts_with("beta"),
            "alpha's chart renders a Secret, beta's none"
        );
    }
}

#[test]
fn the_notes_and_hooks_are_helm_s() {
    for (printed, page) in revisions() {
        let notes = page.notes();
        assert!(!notes.hidden, "{printed}");
        let shown = if notes.text.is_empty() {
            String::new()
        } else {
            format!("NOTES:\n{}\n", notes.text)
        };
        assert_eq!(
            shown,
            text(&format!("get/{printed}.notes.txt")),
            "{printed}"
        );
        assert_eq!(
            page.hooks(),
            text(&format!("get/{printed}.hooks.txt")),
            "{printed}"
        );
    }
}

#[test]
fn the_values_are_helm_s_once_revealed_and_masked_until_then() {
    for (printed, page) in revisions() {
        let helm: Value =
            serde_json::from_str(&text(&format!("get/{printed}.values.json"))).unwrap();
        let whole = HelmPart::Values {
            defaults: false,
            path: Vec::new(),
        };
        let (revealed, binary) = page.revealed(&whole).unwrap();
        assert!(!binary);
        assert_eq!(
            serde_json::from_str::<Value>(&revealed).unwrap(),
            helm,
            "{printed}"
        );
        let values = page.values();
        for masked in [&values.user, &values.defaults] {
            let masked: Value = serde_json::from_str(masked).unwrap();
            assert_only_masks(&masked, &printed);
        }
    }
}

fn assert_only_masks(value: &Value, printed: &str) {
    match value {
        Value::String(text) => assert!(is_mask(text), "{printed}: {text}"),
        Value::Number(number) => panic!("{printed}: a number {number} in clear"),
        Value::Array(items) => items
            .iter()
            .for_each(|item| assert_only_masks(item, printed)),
        Value::Object(map) => map
            .values()
            .for_each(|item| assert_only_masks(item, printed)),
        Value::Bool(_) | Value::Null => {}
    }
}

#[test]
fn the_summary_is_what_helm_get_metadata_says() {
    for (printed, page) in revisions() {
        let helm: Value =
            serde_json::from_str(&text(&format!("get/{printed}.metadata.json"))).unwrap();
        let summary = page.summary();
        assert_eq!(summary.name(), helm["name"], "{printed}");
        assert_eq!(
            summary.chart().unwrap(),
            format!(
                "{}-{}",
                helm["chart"].as_str().unwrap(),
                helm["version"].as_str().unwrap()
            )
        );
        assert_eq!(summary.app_version().unwrap(), helm["appVersion"]);
        assert_eq!(summary.namespace(), helm["namespace"]);
        assert_eq!(u64::from(summary.revision()), helm["revision"]);
        assert_eq!(summary.status().word(), helm["status"]);
        let deployed = summary
            .last_deployed()
            .unwrap()
            .strftime("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        assert_eq!(deployed, helm["deployedAt"], "{printed}");
    }
}

#[test]
fn a_history_line_is_what_helm_history_prints() {
    for release in ["alpha", "beta"] {
        let helm: Vec<Value> =
            serde_json::from_str(&text(&format!("get/{release}.v4.history.json"))).unwrap();
        let ours: Vec<Value> = revisions()
            .filter(|(printed, _)| printed.starts_with(release))
            .map(|(_, page)| {
                let line = line(page.summary(), Some(page.description()));
                let description = line
                    .description
                    .as_ref()
                    .map(|Scrubbed { text, .. }| text.clone());
                serde_json::json!({
                    "revision": line.revision,
                    "updated": line.updated,
                    "status": line.status,
                    "chart": line.chart,
                    "app_version": line.app_version,
                    "description": description,
                })
            })
            .collect();
        assert_eq!(ours, helm, "{release}");
    }
}

#[test]
fn the_values_keep_the_order_helm_stored_them_in() {
    let order = page(&secret("fmt-c.sh.helm.release.v1.order.v1").stored())
        .ok()
        .unwrap();
    assert_eq!(
        order.values().user,
        r#"{"-dash":"<1 bytes>","10":"<1 bytes>","9":"<1 bytes>","Zeta":"<1 bytes>","_under":"<1 bytes>","a.b":"<1 bytes>","alpha":"<1 bytes>","big":"<20 bytes>","date":"<10 bytes>","empty":"<0 bytes>","float":"<3 bytes>","item10":"<1 bytes>","item9":"<1 bytes>","multi":"<18 bytes>","nested":{"list":[{"name":"<1 bytes>","value":"<1 bytes>"},{"name":true}]},"true":true}"#
    );
}
