use std::path::{Path, PathBuf};
use std::sync::Arc;

use twigo_ipc::{BlockReason, ContextAccess, Environment, Friction, Mode, ModeSource};
use twigo_policy::friction::{self, Risk};
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
        Audit::open(&dir.join("audit.jsonl")),
    )
}

fn audited(dir: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(dir.join("audit.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| {
            let mut line: serde_json::Value = serde_json::from_str(line).unwrap();
            line.as_object_mut().unwrap().remove("at");
            line
        })
        .collect()
}

fn aside(path: &Path) -> PathBuf {
    path.with_extension("json.unreadable")
}

fn unread(access: &ContextAccess) -> bool {
    matches!(access.source, ModeSource::ProtectionUnreadable { .. })
}

fn typed() -> Friction {
    friction::start_over("protection.json")
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
    assert_eq!(planned.aside, Some(aside(&path).display().to_string()));
    assert!(!planned.reason.is_empty());
    policy.start_over(&typed()).unwrap();

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
        policy.start_over(&typed()),
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
        policy.start_over(&typed()),
        Err(Refused::ProtectionReadable(_))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), held);
    assert!(!aside(&path).exists());
    assert_eq!(
        policy.access("kind-a").source,
        ModeSource::User { overrides: None }
    );
}

#[test]
fn a_file_restored_by_hand_refuses_a_start_over_at_plan_and_at_run_and_reads_at_the_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("protection.json");
    std::fs::write(&path, UNREADABLE).unwrap();
    let policy = opened(dir.path(), &path);
    let mut changes = policy.changes();
    changes.borrow_and_update();
    let restored = r#"{"version": 1, "modes": {"kind-a": "read-only"}, "environments": {}}"#;

    std::fs::write(&path, restored).unwrap();
    assert!(matches!(
        policy.plan_start_over(),
        Err(Refused::Restored(_))
    ));
    std::fs::write(&path, UNREADABLE).unwrap();
    policy.plan_start_over().unwrap();
    std::fs::write(&path, restored).unwrap();
    assert!(matches!(
        policy.start_over(&typed()),
        Err(Refused::Restored(_))
    ));

    assert_eq!(std::fs::read_to_string(&path).unwrap(), restored);
    assert!(!aside(&path).exists());
    assert!(!changes.has_changed().unwrap());
    assert!(unread(&policy.access("kind-a")));
    assert!(audited(dir.path()).is_empty());
    let started = opened(dir.path(), &path).access("kind-a");
    assert_eq!(
        (started.mode, started.source),
        (Mode::ReadOnly, ModeSource::User { overrides: None })
    );
}

#[test]
fn a_file_removed_by_hand_is_started_over_from_with_nothing_moved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("protection.json");
    std::fs::write(&path, UNREADABLE).unwrap();
    let policy = opened(dir.path(), &path);
    let mut changes = policy.changes();
    changes.borrow_and_update();
    let reason = match policy.access("kind-a").source {
        ModeSource::ProtectionUnreadable { reason, .. } => reason,
        source => panic!("{source:?}"),
    };

    std::fs::remove_file(&path).unwrap();
    let planned = policy.plan_start_over().unwrap();
    assert_eq!(planned.aside, None);
    assert_eq!(planned.reason, reason);
    policy.start_over(&typed()).unwrap();

    assert!(!path.exists());
    assert!(!aside(&path).exists());
    assert!(changes.has_changed().unwrap());
    let a = policy.access("kind-a");
    assert_eq!((a.mode, &a.source), (Mode::Guarded, &ModeSource::Unmarked));
    assert_eq!(
        audited(dir.path()),
        [serde_json::json!({
            "event": "startedOver",
            "file": path.display().to_string(),
            "reason": reason,
            "aside": null,
            "friction": { "kind": "typed", "text": "protection.json" },
        })]
    );
    let planned = policy.plan("kind-a", marked()).unwrap();
    policy
        .change("kind-a", &planned, &Friction::AtOnce)
        .unwrap();
    assert!(path.exists());
}

#[test]
fn a_file_removed_between_the_plan_and_the_run_is_started_over_from_with_nothing_moved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("protection.json");
    std::fs::write(&path, UNREADABLE).unwrap();
    let policy = opened(dir.path(), &path);

    assert!(policy.plan_start_over().unwrap().aside.is_some());
    std::fs::remove_file(&path).unwrap();
    policy.start_over(&typed()).unwrap();

    assert!(!aside(&path).exists());
    assert!(!unread(&policy.access("kind-a")));
    assert_eq!(audited(dir.path())[0]["aside"], serde_json::Value::Null);
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
    let refused = policy.start_over(&typed());
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

fn write() -> Attributes {
    Attributes::action("delete", "configmaps", None, Some("a"), Some("m"))
}

fn exec() -> Attributes {
    Attributes::action("create", "pods", Some("exec"), Some("a"), Some("p"))
}

fn unasked(policy: &Policy, actor: Actor, risk: &Risk) -> bool {
    let attributes = match risk {
        Risk::Shell => exec(),
        _ => write(),
    };
    if policy.authorize("kind-a", &attributes, actor).is_err() {
        return false;
    }
    actor != Actor::Ui
        || matches!(
            friction::friction(risk, "kind-a", &policy.access("kind-a")),
            Friction::AtOnce | Friction::Countdown { .. }
        )
}

const ACTORS: [Actor; 6] = [
    Actor::Ui,
    Actor::Terminal,
    Actor::Helm,
    Actor::Mcp,
    Actor::Extension { secrets: true },
    Actor::Agent,
];

#[test]
fn after_a_start_over_only_an_admin_s_entry_leaves_a_context_read_write_and_no_write_or_exec_passes_unasked_that_did_not()
 {
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
    let (mut checked, mut read_write, mut unmarked) = (0, 0, 0);
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
                        ACTORS
                            .iter()
                            .flat_map(|actor| {
                                risks.iter().map(|risk| unasked(policy, *actor, risk))
                            })
                            .collect::<Vec<_>>()
                    };
                    let before = verdicts(&policy);
                    policy.start_over(&typed()).unwrap();
                    let after = verdicts(&policy);
                    let access = policy.access("kind-a");
                    let case = format!("{index} {metadata:?}: {access:?}");
                    assert!(!unread(&access), "{case}");
                    for (before, after) in before.iter().zip(&after) {
                        assert!(!after || *before, "{case}");
                    }
                    if access.mode == Mode::ReadWrite {
                        assert!(
                            matches!(
                                access.source,
                                ModeSource::PolicyFile {
                                    pattern: Some(_),
                                    ..
                                }
                            ),
                            "{case}"
                        );
                        read_write += 1;
                    }
                    if access.source == ModeSource::Unmarked {
                        for actor in ACTORS {
                            for attributes in [write(), exec()] {
                                let refused =
                                    policy.authorize("kind-a", &attributes, actor).unwrap_err();
                                assert_eq!(refused.reason, BlockReason::Unmarked, "{case}");
                            }
                        }
                        unmarked += 1;
                    }
                    checked += 1;
                }
            }
        }
    }
    assert_eq!((checked, read_write, unmarked), (5 * 2 * 3 * 3, 18, 1));
}

#[test]
fn a_forward_that_read_only_refused_under_an_admin_s_allow_port_forward_false_passes_after_a_start_over_where_the_context_is_unmarked_or_guarded()
 {
    let dir = tempfile::tempdir().unwrap();
    let admin = dir.path().join("policy.json");
    std::fs::write(&admin, r#"{"readOnly": {"allowPortForward": false}}"#).unwrap();
    let path = dir.path().join("protection.json");
    std::fs::write(&path, UNREADABLE).unwrap();
    let policy = Policy::new(
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
        Protection::read(&path),
        Audit::off(),
    );
    let forward = Attributes::action("create", "pods", Some("portforward"), Some("a"), Some("p"));
    let passes = |context: &str| {
        ACTORS
            .iter()
            .map(|actor| policy.authorize(context, &forward, *actor).is_ok())
            .collect::<Vec<_>>()
    };
    for context in ["kind-a", "kind-typed", "kind-locked"] {
        assert_eq!(passes(context), [false; 6], "{context}");
    }

    policy.start_over(&typed()).unwrap();

    assert_eq!(policy.access("kind-a").source, ModeSource::Unmarked);
    assert_eq!(passes("kind-a"), [true; 6]);
    assert_eq!(policy.access("kind-typed").mode, Mode::Guarded);
    assert_eq!(passes("kind-typed"), [true; 6]);
    assert_eq!(passes("kind-locked"), [false; 6]);
}
