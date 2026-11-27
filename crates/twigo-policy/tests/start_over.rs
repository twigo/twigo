use std::path::{Path, PathBuf};
use std::sync::Arc;

use twigo_ipc::{ContextAccess, Environment, Friction, Mode, ModeSource};
use twigo_policy::friction::{Risk, friction};
use twigo_policy::{
    Actor, Attributes, Audit, Change, Metadata, Policy, PolicyFile, Protection, ProviderLock,
    Refused, TypeLock,
};

const UNREADABLE: &str = r#"{"version": 1, "modes": {"kind-a": "read-write"}, "environments": {"kind-typed": "development"}, "unlocks": {}}"#;

fn opened(dir: &Path, protection: &Path) -> Arc<Policy> {
    let admin = dir.join("policy.json");
    std::fs::write(&admin, r#"{"contexts": {"kind-admin": "read-write"}}"#).unwrap();
    Policy::new(
        PolicyFile::read(&admin),
        |context| match context {
            "kind-typed" => Some(Metadata {
                environment: Some(TypeLock::Staging),
                ..Metadata::default()
            }),
            "kind-locked" => Some(Metadata {
                read_only: true,
                ..Metadata::default()
            }),
            _ => Some(Metadata::default()),
        },
        Protection::read(protection),
        Audit::off(),
    )
}

fn aside(path: &Path) -> PathBuf {
    path.with_extension("json.unreadable")
}

fn unread(access: &ContextAccess) -> bool {
    matches!(access.source, ModeSource::ProtectionUnreadable { .. })
}

fn marked() -> Change {
    Change::Type {
        environment: Some(Environment::Production),
    }
}

#[test]
fn starting_over_moves_the_file_aside_with_its_bytes_and_the_policy_holds_no_choice_and_reads_open()
{
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("protection.json");
    std::fs::write(&path, UNREADABLE).unwrap();
    std::fs::write(aside(&path), "what an earlier start over left").unwrap();
    let policy = opened(dir.path(), &path);
    let mut changes = policy.changes();
    changes.borrow_and_update();

    let planned = policy.plan_start_over().unwrap();
    assert_eq!(planned.file, path.display().to_string());
    assert_eq!(planned.aside, aside(&path).display().to_string());
    assert!(!planned.reason.is_empty());
    policy.start_over(&Friction::Confirm).unwrap();

    assert!(!path.exists());
    assert_eq!(std::fs::read_to_string(aside(&path)).unwrap(), UNREADABLE);
    assert!(changes.has_changed().unwrap());
    let a = policy.access("kind-a");
    assert_eq!((a.mode, &a.source), (Mode::Guarded, &ModeSource::Unmarked));
    let typed = policy.access("kind-typed");
    assert_eq!(typed.mode, Mode::Guarded);
    assert_eq!(
        typed.source,
        ModeSource::Environment {
            environment: Environment::Staging
        }
    );
    let locked = policy.access("kind-locked");
    assert_eq!(
        (locked.mode, &locked.source),
        (Mode::ReadOnly, &ModeSource::Kubeconfig)
    );
    assert!(matches!(
        policy.access("kind-admin").source,
        ModeSource::PolicyFile {
            pattern: Some(_),
            ..
        }
    ));

    let planned = policy.plan("kind-a", marked()).unwrap();
    policy
        .change("kind-a", &planned, &Friction::AtOnce)
        .unwrap();
    let written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        written,
        serde_json::json!({
            "version": 1,
            "modes": {},
            "environments": { "kind-a": "production" },
        })
    );
    assert_eq!(std::fs::read_to_string(aside(&path)).unwrap(), UNREADABLE);
    assert!(matches!(
        policy.plan_start_over(),
        Err(Refused::ProtectionReadable(_))
    ));
}

#[test]
fn starting_over_is_refused_while_the_file_can_be_read_or_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.json");
    let policy = opened(dir.path(), &missing);
    let mut changes = policy.changes();
    changes.borrow_and_update();
    assert!(matches!(
        policy.plan_start_over(),
        Err(Refused::ProtectionReadable(_))
    ));
    assert!(matches!(
        policy.start_over(&Friction::Confirm),
        Err(Refused::ProtectionReadable(_))
    ));
    assert!(!missing.exists());
    assert!(!aside(&missing).exists());
    assert!(!changes.has_changed().unwrap());

    let path = dir.path().join("protection.json");
    opened(dir.path(), &path)
        .set_mode("kind-a", Some(Mode::ReadOnly))
        .unwrap();
    let held = std::fs::read(&path).unwrap();
    let policy = opened(dir.path(), &path);
    assert!(matches!(
        policy.start_over(&Friction::Confirm),
        Err(Refused::ProtectionReadable(_))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), held);
    assert!(!aside(&path).exists());
    assert_eq!(
        policy.access("kind-a").source,
        ModeSource::User { overrides: None }
    );
}

#[cfg(unix)]
#[test]
fn a_start_over_whose_move_fails_is_refused_and_changes_nothing() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join("kept");
    std::fs::create_dir(&kept).unwrap();
    let path = kept.join("protection.json");
    std::fs::write(&path, UNREADABLE).unwrap();
    let policy = opened(dir.path(), &path);
    let before = policy.access("kind-a");
    let mut changes = policy.changes();
    changes.borrow_and_update();

    std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o500)).unwrap();
    let refused = policy.start_over(&Friction::Confirm);
    std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(refused, Err(Refused::Unmoved(..))), "{refused:?}");

    assert_eq!(std::fs::read_to_string(&path).unwrap(), UNREADABLE);
    assert!(!aside(&path).exists());
    assert!(!changes.has_changed().unwrap());
    assert_eq!(policy.access("kind-a"), before);
    assert!(unread(&before));
    assert!(matches!(
        policy.plan("kind-a", marked()),
        Err(Refused::ProtectionUnreadable(_))
    ));
    assert!(policy.plan_start_over().is_ok());
}

fn unasked(policy: &Policy, actor: Actor, risk: &Risk) -> bool {
    let attributes = match risk {
        Risk::Shell => Attributes::action("create", "pods", Some("exec"), Some("a"), Some("p")),
        _ => Attributes::action("delete", "configmaps", None, Some("a"), Some("m")),
    };
    if policy.authorize("kind-a", &attributes, actor).is_err() {
        return false;
    }
    actor != Actor::Ui
        || matches!(
            friction(risk, Some(("kind-a", &policy.access("kind-a")))),
            Friction::AtOnce | Friction::Countdown { .. }
        )
}

#[test]
fn after_a_start_over_no_context_lets_a_write_through_without_an_answer_that_it_did_not_before() {
    let dir = tempfile::tempdir().unwrap();
    let mut files = vec![PolicyFile::default()];
    for (name, text) in [
        ("read-write", r#"{"contexts": {"kind-a": "read-write"}}"#),
        ("guarded", r#"{"contexts": {"kind-a": "guarded"}}"#),
        ("read-only", r#"{"contexts": {"kind-a": "read-only"}}"#),
        ("unreadable", r#"{"contexts": "#),
    ] {
        let path = dir.path().join(name);
        std::fs::write(&path, text).unwrap();
        files.push(PolicyFile::read(&path));
    }
    let actors = [
        Actor::Ui,
        Actor::Terminal,
        Actor::Helm,
        Actor::Mcp,
        Actor::Extension { secrets: true },
        Actor::Agent,
    ];
    let risks = [
        Risk::Reversible,
        Risk::Replaced,
        Risk::Lasting,
        Risk::Wide {
            name: "a".to_owned(),
        },
        Risk::Reviewed,
        Risk::Shell,
    ];
    let mut checked = 0;
    for (index, file) in files.iter().enumerate() {
        for read_only in [false, true] {
            for provider in [
                None,
                Some(ProviderLock::Guarded),
                Some(ProviderLock::ReadOnly),
            ] {
                for environment in [None, Some(TypeLock::Production), Some(TypeLock::Staging)] {
                    let metadata = Metadata {
                        read_only,
                        provider,
                        environment,
                        ..Metadata::default()
                    };
                    let path = dir
                        .path()
                        .join(format!("protection-{index}-{checked}.json"));
                    std::fs::write(&path, UNREADABLE).unwrap();
                    let policy = Policy::new(
                        file.clone(),
                        move |_| Some(metadata),
                        Protection::read(&path),
                        Audit::off(),
                    );
                    let verdicts = |policy: &Policy| {
                        actors
                            .iter()
                            .flat_map(|actor| {
                                risks.iter().map(|risk| unasked(policy, *actor, risk))
                            })
                            .collect::<Vec<_>>()
                    };
                    let before = verdicts(&policy);
                    policy.start_over(&Friction::Confirm).unwrap();
                    let after = verdicts(&policy);
                    let case = format!("{index} {metadata:?}: {:?}", policy.access("kind-a"));
                    assert!(!unread(&policy.access("kind-a")), "{case}");
                    for (before, after) in before.iter().zip(&after) {
                        assert!(!after || *before, "{case}");
                    }
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 5 * 2 * 3 * 3);
}
