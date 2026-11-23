use serde_json::json;
use twigo_cache::fake::Fake;
use twigo_ipc::{
    ContextAccess, ErrorCode, Friction, HelmPart, Mode, ModeSource, OperationEvent, PlanRequest,
    ReleaseParts, ValueStep,
};

use crate::helm::testing::{self, Over};

const OVERVIEW: ReleaseParts = ReleaseParts {
    overview: true,
    values: false,
    manifest: false,
    history: false,
};

fn key(key: &str) -> ValueStep {
    ValueStep::Key(key.to_owned())
}

/// Revision `version` of `a/db`, with a string, a number and a list among
/// the person's values, and a Secret and two documents Twigo cannot read,
/// one with its source and one without, in its manifest.
fn revision(fake: &Fake, version: u32, status: &str) {
    let mut release = testing::release("a", "db", version, status);
    release["config"] = json!({
        "auth": { "password": format!("pass-{version}"), "port": 5432 },
        "hosts": ["one", "two"],
    });
    let manifest = release["manifest"].as_str().unwrap().to_owned()
        + "---\n# Source: demo/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: db-auth\nstringData:\n  token: tok-en\n"
        + "---\n# Source: demo/templates/broken.yaml\nkind: Secret\nstringData: {broken: one\n"
        + "---\nkind: Secret\nstringData: {broken: two\n";
    release["manifest"] = json!(manifest);
    testing::put(fake, &release, status);
}

#[tokio::test(start_paused = true)]
async fn a_reveal_names_its_place_and_prints_helm_s_command_only_where_it_prints_that_part() {
    let fake = Fake::default();
    revision(&fake, 1, "superseded");
    revision(&fake, 2, "deployed");
    let dir = tempfile::tempdir().unwrap();
    let over = Over::new(&fake, dir.path());
    let (id, mut watched) = over.open("a", "db", None, OVERVIEW).await;
    watched
        .until(over.ack(id), "revision 2", |shown| shown.overview.is_some())
        .await;

    let leaf = HelmPart::Values {
        defaults: false,
        path: vec![key("auth"), key("password")],
    };
    let cases = [
        (
            leaf.clone(),
            "Reveal auth.password of release db (revision 2) in a from kind-test?",
            "values auth.password",
            Some(
                "helm get all db -n a --kube-context kind-test --revision 2 --template '{{index .Release.Config \"auth\" \"password\"}}'",
            ),
            "\"pass-2\"",
        ),
        (
            HelmPart::Values {
                defaults: false,
                path: Vec::new(),
            },
            "Reveal the values of release db (revision 2) in a from kind-test?",
            "values",
            Some("helm get values db -n a --kube-context kind-test --revision 2 -o json"),
            r#"{"auth":{"password":"pass-2","port":5432},"hosts":["one","two"]}"#,
        ),
        (
            HelmPart::Values {
                defaults: false,
                path: vec![key("hosts"), ValueStep::Index(1)],
            },
            "Reveal hosts[1] of release db (revision 2) in a from kind-test?",
            "values hosts[1]",
            Some(
                "helm get all db -n a --kube-context kind-test --revision 2 --template '{{index .Release.Config \"hosts\" 1}}'",
            ),
            "\"two\"",
        ),
        (
            HelmPart::Values {
                defaults: false,
                path: vec![key("auth"), key("port")],
            },
            "Reveal auth.port of release db (revision 2) in a from kind-test?",
            "values auth.port",
            None,
            "5432",
        ),
        (
            HelmPart::Values {
                defaults: false,
                path: vec![key("auth")],
            },
            "Reveal auth of release db (revision 2) in a from kind-test?",
            "values auth",
            None,
            r#"{"password":"pass-2","port":5432}"#,
        ),
        (
            HelmPart::Values {
                defaults: true,
                path: vec![key("replicas")],
            },
            "Reveal the default replicas of release db (revision 2) in a from kind-test?",
            "defaults replicas",
            None,
            "1",
        ),
        (
            HelmPart::Secret {
                document: 1,
                items: Vec::new(),
                key: "token".to_owned(),
            },
            "Reveal token of secret db-auth in the manifest of release db (revision 2) in a from kind-test?",
            "manifest secrets/db-auth key token",
            None,
            "tok-en",
        ),
        (
            HelmPart::Document { document: 2 },
            "Reveal the document demo/templates/broken.yaml in the manifest of release db (revision 2) in a from kind-test?",
            "manifest document 2",
            None,
            "# Source: demo/templates/broken.yaml\nkind: Secret\nstringData: {broken: one",
        ),
        (
            HelmPart::Document { document: 3 },
            "Reveal document 4 in the manifest of release db (revision 2) in a from kind-test?",
            "manifest document 3",
            None,
            "kind: Secret\nstringData: {broken: two",
        ),
        (
            HelmPart::Notes,
            "Reveal the notes of release db (revision 2) in a from kind-test?",
            "notes",
            None,
            "Revision 2 of db",
        ),
    ];
    for (part, question, place, line, value) in cases {
        let request = PlanRequest::RevealHelm {
            release: id,
            revision: 2,
            part,
        };
        let plan = over.core.command_plan("main", request).await.unwrap();
        assert_eq!(plan.question, question);
        assert_eq!(plan.command_line.as_deref(), line, "{question}");
        let told = over.run(&plan).await;
        assert_eq!(
            told,
            [OperationEvent::Revealed {
                value: value.to_owned(),
                binary: false
            }],
            "{question}"
        );
        let audit = std::fs::read_to_string(dir.path().join("audit.jsonl")).unwrap();
        let target = format!("release db in a, revision 2, {place}");
        assert!(
            audit.contains(&format!("\"target\":\"{target}\"")),
            "{target}"
        );
    }
    let audit = std::fs::read_to_string(dir.path().join("audit.jsonl")).unwrap();
    for value in ["pass-2", "tok-en", "5432"] {
        assert!(!audit.contains(value), "a value in the audit log");
    }
}

#[tokio::test(start_paused = true)]
async fn a_reveal_asks_for_a_confirmation_outside_read_write() {
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    let dir = tempfile::tempdir().unwrap();
    let over = Over::new(&fake, dir.path());
    let (id, mut watched) = over.open("a", "db", None, OVERVIEW).await;
    watched
        .until(over.ack(id), "revision 1", |shown| shown.overview.is_some())
        .await;

    for (mode, friction) in [
        (Mode::Guarded, Friction::Confirm),
        (Mode::ReadOnly, Friction::Confirm),
        (Mode::ReadWrite, Friction::AtOnce),
    ] {
        let planned = super::reveal_helm(&over.core, "main", id, 1, HelmPart::Notes).unwrap();
        let access = ContextAccess {
            mode,
            source: ModeSource::User { overrides: None },
            environment: None,
            unlocked_until: None,
        };
        let ticket = over.core.bus.ticket("main");
        let plan = over.core.bus.keep(ticket, planned, &access).unwrap();
        assert_eq!(plan.friction, friction, "{mode:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_reveal_of_a_revision_the_release_no_longer_shows_is_refused() {
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    let dir = tempfile::tempdir().unwrap();
    let over = Over::new(&fake, dir.path());
    let (id, mut watched) = over.open("a", "db", None, OVERVIEW).await;
    watched
        .until(over.ack(id), "revision 1", |shown| shown.overview.is_some())
        .await;
    let reveal = |revision, path: Vec<ValueStep>| PlanRequest::RevealHelm {
        release: id,
        revision,
        part: HelmPart::Values {
            defaults: false,
            path,
        },
    };

    let other = over.core.command_plan("main", reveal(3, Vec::new())).await;
    assert_eq!(other.unwrap_err().code, ErrorCode::ActionObjectChanged);
    let nothing = over
        .core
        .command_plan("main", reveal(1, vec![key("nope")]))
        .await;
    assert_eq!(nothing.unwrap_err().code, ErrorCode::HelmNoValue);

    let plan = over
        .core
        .command_plan("main", reveal(1, vec![key("auth"), key("password")]))
        .await
        .unwrap();
    revision(&fake, 2, "deployed");
    watched
        .until(over.ack(id), "revision 2", |shown| {
            shown.revision == Some(2)
        })
        .await;
    let told = over.run(&plan).await;
    let [OperationEvent::Failed { error }] = told.as_slice() else {
        panic!("the run went on: {told:?}");
    };
    assert_eq!(error.code, ErrorCode::ActionObjectChanged);
}
