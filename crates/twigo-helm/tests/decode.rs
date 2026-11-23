//! What a decoder meets in the wild: the recorded releases of helm v4.3.2
//! and v3.22.1, and the Secrets crafted from them, on Kubernetes 1.37.

mod common;

use common::{Recorded, recorded, secret};
use twigo_helm::{Status, page, summary};
use twigo_ipc::{ErrorCode, HelmPart};

fn config_map(file: &str) -> Recorded {
    recorded(&format!("configmaps/{file}.json"), |text| {
        text.as_bytes().to_vec()
    })
}

#[test]
fn a_v4_release_and_a_v3_one_read_alike() {
    let alpha = summary(&secret("fmt-a.sh.helm.release.v1.alpha.v2").stored()).unwrap();
    assert_eq!(
        (
            alpha.name(),
            alpha.revision(),
            alpha.namespace(),
            alpha.status()
        ),
        ("alpha", 2, "fmt-a", &Status::Deployed)
    );
    assert_eq!(alpha.chart().as_deref(), Some("demo-0.1.0"));
    assert_eq!(alpha.app_version(), Some("1.0.0"));
    assert_eq!(
        alpha.last_deployed().unwrap().to_string(),
        "2026-11-22T20:14:04.369027Z"
    );
    let beta = summary(&secret("fmt-b.sh.helm.release.v1.beta.v2").stored()).unwrap();
    assert_eq!(
        (beta.name(), beta.revision(), beta.status()),
        ("beta", 2, &Status::Uninstalled)
    );
    assert_eq!(beta.chart().as_deref(), Some("plain-2.3.4"));
    assert_eq!(
        beta.first_deployed().unwrap().to_string(),
        "2026-11-22T20:14:04.534311Z"
    );
}

#[test]
fn a_time_in_another_offset_is_the_same_instant() {
    let delta = summary(&secret("fmt-c.sh.helm.release.v1.delta.v1").stored()).unwrap();
    assert_eq!(
        delta.last_deployed().unwrap().to_string(),
        "2026-11-22T20:17:12.521221Z"
    );
}

#[test]
fn a_release_with_no_values_of_the_person_s_has_null() {
    let delta = page(&secret("fmt-c.sh.helm.release.v1.delta.v1").stored()).unwrap();
    assert_eq!(delta.values().user, "null");
    let whole = HelmPart::Values {
        defaults: false,
        path: Vec::new(),
    };
    assert_eq!(delta.revealed(&whole).unwrap(), ("null".to_owned(), false));
}

#[test]
fn a_release_stored_without_gzip_or_in_a_config_map_reads_as_any_other() {
    let plain = summary(&secret("fmt-d.sh.helm.release.v1.nogzip.v1").stored()).unwrap();
    assert_eq!((plain.name(), plain.revision()), ("nogzip", 1));
    let gamma = summary(&config_map("fmt-c.sh.helm.release.v1.gamma.v1").stored()).unwrap();
    assert_eq!(
        (gamma.name(), gamma.status()),
        ("gamma", &Status::Superseded)
    );
}

#[test]
fn a_release_whose_base64_is_broken_into_lines_reads_as_helm_reads_it() {
    let mut alpha = secret("fmt-a.sh.helm.release.v1.alpha.v1");
    let lines: Vec<&[u8]> = alpha.release.as_deref().unwrap().chunks(76).collect();
    let mut wrapped = lines.join(&b'\n');
    wrapped.extend_from_slice(b"\r\n");
    alpha.release = Some(wrapped);
    let read = summary(&alpha.stored()).unwrap();
    assert_eq!(
        (read.name(), read.revision(), read.status()),
        ("alpha", 1, &Status::Superseded)
    );
}

#[test]
fn a_type_helm_never_wrote_is_read_and_named_when_it_fails() {
    let mut future = secret("fmt-d.sh.helm.release.v1.future.v1");
    assert_eq!(future.kind, "helm.sh/release.v2");
    assert!(summary(&future.stored()).is_ok());
    future.release = Some(b"!!".to_vec());
    let refused = summary(&future.stored()).unwrap_err();
    assert_eq!(refused.code, ErrorCode::HelmNotARelease);
    assert!(
        refused.message.contains("helm.sh/release.v2"),
        "{}",
        refused.message
    );
    let mut alpha = secret("fmt-a.sh.helm.release.v1.alpha.v2");
    alpha.release = Some(b"!!".to_vec());
    let refused = summary(&alpha.stored()).unwrap_err();
    assert!(!refused.message.contains("type"), "{}", refused.message);
}

#[test]
fn a_secret_that_holds_no_release_says_why_by_its_code() {
    for (file, code) in [
        (
            "fmt-d.sh.helm.release.v1.trunc.v1",
            ErrorCode::HelmTruncated,
        ),
        (
            "fmt-d.sh.helm.release.v1.badb64.v1",
            ErrorCode::HelmNotARelease,
        ),
        (
            "fmt-d.sh.helm.release.v1.badjson.v1",
            ErrorCode::HelmNotARelease,
        ),
        (
            "fmt-d.sh.helm.release.v1.nokey.v1",
            ErrorCode::HelmNotARelease,
        ),
    ] {
        let recorded = secret(file);
        for refused in [
            summary(&recorded.stored()).unwrap_err(),
            page(&recorded.stored()).err().unwrap(),
        ] {
            assert_eq!(refused.code, code, "{file}: {}", refused.message);
        }
    }
}

#[test]
fn a_release_that_is_not_one_is_placed_by_line_and_column_and_never_quoted() {
    let refused = summary(&secret("fmt-d.sh.helm.release.v1.badjson.v1").stored()).unwrap_err();
    assert!(
        refused.message.contains("line 1, column 9"),
        "{}",
        refused.message
    );
    assert!(
        !refused.message.contains("invalid type"),
        "{}",
        refused.message
    );
}

#[test]
fn the_labels_name_the_revision_and_a_payload_that_disagrees_is_refused() {
    let mismatch = summary(&secret("fmt-d.sh.helm.release.v1.mismatch.v1").stored()).unwrap();
    assert_eq!(
        mismatch.status(),
        &Status::Failed,
        "the payload's status wins, as Helm prints it"
    );
    let mut alpha = secret("fmt-a.sh.helm.release.v1.alpha.v2");
    alpha.labels.insert("version".to_owned(), "3".to_owned());
    let refused = summary(&alpha.stored()).unwrap_err();
    assert_eq!(refused.code, ErrorCode::HelmNotARelease);
    alpha.labels.insert("version".to_owned(), "2".to_owned());
    alpha.labels.insert("name".to_owned(), "beta".to_owned());
    assert_eq!(
        summary(&alpha.stored()).unwrap_err().code,
        ErrorCode::HelmNotARelease
    );
    alpha.labels.retain(|key, _| key == "owner");
    assert_eq!(
        summary(&alpha.stored()).unwrap_err().code,
        ErrorCode::HelmNotARelease,
        "a Secret with Helm's owner label alone"
    );
}
