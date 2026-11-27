use std::path::{Path, PathBuf};
use std::sync::Arc;

use twigo_ipc::{Environment, ErrorCode, Friction, Mode, ModeSource};
use twigo_log::problems;
use twigo_policy::{
    Actor, Attributes, Audit, Change, Metadata, Policy, PolicyFile, Protection, Refused, TypeLock,
};

fn opened(dir: &Path, protection: &Path) -> Arc<Policy> {
    let admin = dir.join("policy.json");
    std::fs::write(&admin, r#"{"contexts": {"kind-admin": "read-write"}}"#).unwrap();
    Policy::new(
        PolicyFile::read(&admin),
        |context| match context {
            "kind-gone" => None,
            "kind-typed" => Some(Metadata {
                environment: Some(TypeLock::Staging),
                ..Metadata::default()
            }),
            _ => Some(Metadata::default()),
        },
        Protection::read(protection),
        Audit::off(),
    )
}

fn write() -> Attributes {
    Attributes::action("create", "configmaps", None, Some("a"), None)
}

fn unreadable(access: &twigo_ipc::ContextAccess, path: &Path) -> String {
    assert_eq!(access.mode, Mode::ReadOnly, "{access:?}");
    match &access.source {
        ModeSource::ProtectionUnreadable { file, reason } => {
            assert_eq!(file, &path.display().to_string());
            reason.clone()
        }
        other => panic!("{other:?}"),
    }
}

fn unread(refused: Result<impl std::fmt::Debug, Refused>) -> bool {
    matches!(refused, Err(Refused::ProtectionUnreadable(_)))
}

#[test]
fn a_protection_file_that_cannot_be_read_keeps_every_context_read_only_and_takes_no_change() {
    let cases: [(&str, Option<&str>); 5] = [
        ("an I/O error", None),
        (
            "not JSON",
            Some(r#"{"version": 1, "modes": {"kind-chosen": read-write}}"#),
        ),
        (
            "an unknown key",
            Some(
                r#"{"version": 1, "modes": {"kind-chosen": "read-write"}, "environments": {"kind-typed": "development"}, "unlocks": {}}"#,
            ),
        ),
        (
            "a bad value",
            Some(
                r#"{"version": 1, "modes": {"kind-chosen": "read-write", "kind-typed": "readonly"}, "environments": {}}"#,
            ),
        ),
        (
            "an unknown version",
            Some(
                r#"{"version": 2, "modes": {"kind-chosen": "read-write"}, "environments": {"kind-typed": "development"}}"#,
            ),
        ),
    ];
    for (case, text) in cases {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("protection.json");
        match text {
            Some(text) => std::fs::write(&path, text).unwrap(),
            None => std::fs::create_dir(&path).unwrap(),
        }
        problems::clear(ErrorCode::ProtectionUnreadable);
        let policy = opened(dir.path(), &path);
        assert!(
            problems::watch()
                .borrow()
                .iter()
                .any(|problem| problem.code == ErrorCode::ProtectionUnreadable),
            "{case}"
        );

        let reason = unreadable(&policy.access("kind-chosen"), &path);
        assert!(!reason.is_empty(), "{case}");
        for quoted in ["kind-chosen", "kind-typed", "read-write", "readonly"] {
            assert!(!reason.contains(quoted), "{case}: {reason}");
        }
        let typed = policy.access("kind-typed");
        unreadable(&typed, &path);
        assert_eq!(typed.environment, Some(Environment::Staging), "{case}");
        let admin = policy.access("kind-admin");
        assert_eq!(admin.mode, Mode::ReadWrite, "{case}");
        assert!(
            matches!(
                admin.source,
                ModeSource::PolicyFile {
                    pattern: Some(_),
                    ..
                }
            ),
            "{case}"
        );
        assert_eq!(policy.access("kind-gone").source, ModeSource::Unlisted);
        let blocked = policy
            .authorize("kind-chosen", &write(), Actor::Ui)
            .unwrap_err();
        assert!(
            matches!(blocked.source, ModeSource::ProtectionUnreadable { .. }),
            "{case}"
        );

        let changes = [
            Change::Mode {
                mode: Some(Mode::ReadWrite),
            },
            Change::Mode { mode: None },
            Change::Type {
                environment: Some(Environment::Development),
            },
            Change::Type { environment: None },
            Change::Unlock,
        ];
        for change in changes {
            assert!(
                unread(policy.plan("kind-chosen", change)),
                "{case}: {change:?}"
            );
        }
        let marked = Change::Type {
            environment: Some(Environment::Local),
        };
        assert!(unread(policy.plan("kind-admin", marked)), "{case}");
        assert!(unread(
            policy.set_mode("kind-chosen", Some(Mode::ReadWrite))
        ));
        assert!(unread(policy.set_environment("kind-typed", None)));
        assert!(unread(policy.unlock("kind-chosen")));
        let mark = policy.mark(
            "kind-chosen",
            0,
            Environment::Development,
            Actor::Terminal,
            "Terminal 1",
        );
        assert!(unread(mark), "{case}");
        unreadable(&policy.access("kind-chosen"), &path);

        match text {
            Some(text) => assert_eq!(std::fs::read_to_string(&path).unwrap(), text, "{case}"),
            None => assert!(path.is_dir(), "{case}"),
        }
    }
}

#[test]
fn a_missing_protection_file_holds_no_choice_and_the_first_choice_writes_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("protection.json");
    let policy = opened(dir.path(), &path);
    assert_eq!(policy.access("kind-a").source, ModeSource::Unmarked);
    assert!(!path.exists());

    let planned = policy
        .plan(
            "kind-a",
            Change::Type {
                environment: Some(Environment::Production),
            },
        )
        .unwrap();
    policy
        .change("kind-a", &planned, &Friction::AtOnce)
        .unwrap();
    assert!(path.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    let reopened = opened(dir.path(), &path);
    let access = reopened.access("kind-a");
    assert_eq!(access.mode, Mode::ReadOnly);
    assert_eq!(access.environment, Some(Environment::Production));
}

#[test]
fn a_choice_that_cannot_be_saved_is_refused_and_not_held() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("a-file");
    let path: PathBuf = blocked.join("protection.json");
    let policy = opened(dir.path(), &path);
    std::fs::write(&blocked, "").unwrap();
    let before = policy.access("kind-a");

    let planned = policy
        .plan(
            "kind-a",
            Change::Type {
                environment: Some(Environment::Development),
            },
        )
        .unwrap();
    let refused = policy.change("kind-a", &planned, &Friction::AtOnce);
    assert!(matches!(refused, Err(Refused::Unsaved(..))), "{refused:?}");
    assert!(matches!(
        policy.set_mode("kind-a", Some(Mode::ReadWrite)),
        Err(Refused::Unsaved(..))
    ));
    let mark = policy.mark(
        "kind-a",
        0,
        Environment::Development,
        Actor::Terminal,
        "Terminal 1",
    );
    assert!(matches!(mark, Err(Refused::Unsaved(..))), "{mark:?}");
    assert_eq!(policy.access("kind-a"), before);
    assert!(policy.authorize("kind-a", &write(), Actor::Ui).is_err());
}

const KEPT: &str = include_str!("kept/protection.json");

fn kept(path: &Path) -> Arc<Policy> {
    Policy::new(
        PolicyFile::default(),
        |context| {
            Some(Metadata {
                environment: (context == "kind-cleared").then_some(TypeLock::Production),
                ..Metadata::default()
            })
        },
        Protection::read(path),
        Audit::off(),
    )
}

#[test]
fn the_kept_protection_reads_to_its_choices_and_writes_back_to_its_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let read = dir.path().join("read.json");
    std::fs::write(&read, KEPT).unwrap();
    let policy = kept(&read);
    let chosen = ModeSource::User { overrides: None };
    let local = ModeSource::Environment {
        environment: Environment::Local,
    };
    let cases = [
        (
            "kind-dev",
            Mode::ReadWrite,
            &chosen,
            Some(Environment::Development),
        ),
        (
            "kind-prod",
            Mode::ReadOnly,
            &chosen,
            Some(Environment::Production),
        ),
        (
            "kind-stage",
            Mode::Guarded,
            &chosen,
            Some(Environment::Staging),
        ),
        (
            "kind-local",
            Mode::ReadWrite,
            &local,
            Some(Environment::Local),
        ),
        ("kind-cleared", Mode::Guarded, &ModeSource::Unmarked, None),
    ];
    for (context, mode, source, environment) in cases {
        let access = policy.access(context);
        assert_eq!(
            (access.mode, &access.source, access.environment),
            (mode, source, environment),
            "{context}"
        );
    }

    let written = dir.path().join("written.json");
    let policy = kept(&written);
    for (context, mode) in [
        ("kind-dev", Mode::ReadWrite),
        ("kind-prod", Mode::ReadOnly),
        ("kind-stage", Mode::Guarded),
    ] {
        policy.set_mode(context, Some(mode)).unwrap();
    }
    for (context, environment) in [
        ("kind-cleared", None),
        ("kind-dev", Some(Environment::Development)),
        ("kind-local", Some(Environment::Local)),
        ("kind-prod", Some(Environment::Production)),
        ("kind-stage", Some(Environment::Staging)),
    ] {
        policy.set_environment(context, environment).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&written).unwrap(), KEPT);
}
