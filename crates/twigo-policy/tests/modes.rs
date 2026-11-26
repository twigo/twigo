use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::SignedDuration;
use twigo_ipc::{BlockReason, Environment, Friction, Lock, LockSource, Mode, ModeSource};
use twigo_policy::friction::friction;
use twigo_policy::{
    Actor, Attributes, Audit, Change, Choices, Gate, Metadata, Policy, PolicyFile, ProviderLock,
    Refused, TypeLock,
};

const NOTHING: Metadata = Metadata {
    read_only: false,
    provider: None,
    environment: None,
    connection: 0,
    revision: 0,
};

/// The person marked `c` Local, so it is `read-write` while nothing locks
/// it.
fn local() -> Choices {
    Choices {
        environments: [("c".to_owned(), Some(Environment::Local))].into(),
        ..Choices::default()
    }
}

fn file(text: &str) -> (tempfile::TempDir, PolicyFile) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("policy.json");
    std::fs::write(&path, text).unwrap();
    let file = PolicyFile::read(&path);
    (dir, file)
}

fn entries(contexts: &str) -> (tempfile::TempDir, PolicyFile) {
    file(&format!(r#"{{"contexts": {{{contexts}}}}}"#))
}

fn with_metadata(metadata: Metadata) -> Arc<Policy> {
    Policy::new(
        PolicyFile::default(),
        move |_| Some(metadata),
        Choices::default(),
        Audit::off(),
    )
}

fn write() -> Attributes {
    Attributes::action("create", "configmaps", None, Some("a"), None)
}

fn posted() -> http::Request<()> {
    http::Request::post("/api/v1/namespaces/a/configmaps")
        .body(())
        .unwrap()
}

fn got() -> http::Request<()> {
    http::Request::get("/api/v1/pods").body(()).unwrap()
}

fn through(gate: &Gate, request: http::Request<()>) -> Result<(), (Mode, ModeSource)> {
    use tower::{Layer, ServiceExt};

    let service = gate
        .layer()
        .layer(tower::service_fn(|_: http::Request<()>| async {
            Ok::<_, std::convert::Infallible>(())
        }));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(service.oneshot(request)).map_err(|error| {
        let blocked = error.downcast_ref::<twigo_ipc::Blocked>().unwrap();
        (blocked.mode, blocked.source.clone())
    })
}

#[test]
fn the_open_policy_has_every_context_read_write_as_a_local_one() {
    let access = Policy::open().access("prod-eu");
    assert_eq!(access.mode, Mode::ReadWrite);
    assert_eq!(
        access.source,
        ModeSource::Environment {
            environment: Environment::Local
        }
    );
}

#[test]
fn an_environment_type_sets_the_default_mode() {
    let policy = with_metadata(NOTHING);
    for (environment, mode) in [
        (Environment::Production, Mode::ReadOnly),
        (Environment::Staging, Mode::Guarded),
        (Environment::Development, Mode::ReadWrite),
        (Environment::Local, Mode::ReadWrite),
    ] {
        policy.set_environment("c", Some(environment)).unwrap();
        let access = policy.access("c");
        assert_eq!(access.mode, mode);
        assert_eq!(access.source, ModeSource::Environment { environment });
        assert_eq!(access.environment, Some(environment));
    }
    policy.set_environment("c", None).unwrap();
    assert_eq!(policy.access("c").source, ModeSource::Unmarked);
    assert_eq!(policy.access("c").environment, None);
}

#[test]
fn no_type_holds_over_the_kubeconfig_s_mark_and_leaves_the_context_unmarked() {
    let policy = with_metadata(Metadata {
        environment: Some(TypeLock::Production),
        ..NOTHING
    });
    policy.set_environment("c", None).unwrap();
    let access = policy.access("c");
    assert_eq!(access.environment, None);
    assert_eq!(access.mode, Mode::Guarded);
    assert_eq!(access.source, ModeSource::Unmarked);
}

#[test]
fn a_new_type_ends_an_unlock_so_marking_it_again_does_not_bring_it_back() {
    let policy = Policy::open();
    policy
        .set_environment("c", Some(Environment::Production))
        .unwrap();
    policy.unlock("c").unwrap();
    assert_eq!(policy.access("c").mode, Mode::Guarded);
    policy
        .set_environment("c", Some(Environment::Development))
        .unwrap();
    policy
        .set_environment("c", Some(Environment::Production))
        .unwrap();
    let access = policy.access("c");
    assert_eq!(access.mode, Mode::ReadOnly);
    assert_eq!(access.unlocked_until, None);
}

#[test]
fn a_mark_in_the_kubeconfig_counts_until_a_person_marks_otherwise() {
    let policy = with_metadata(Metadata {
        environment: Some(TypeLock::Production),
        ..NOTHING
    });
    assert_eq!(policy.access("c").mode, Mode::ReadOnly);
    policy
        .set_environment("c", Some(Environment::Local))
        .unwrap();
    assert_eq!(policy.access("c").mode, Mode::ReadWrite);
    assert_eq!(policy.access("c").environment, Some(Environment::Local));
}

#[test]
fn the_policy_file_comes_before_the_person_s_choice_and_that_before_any_lock() {
    let (_dir, entries) = file(r#"{"contexts": {"prod-*": "read-write"}}"#);
    let locked = Metadata {
        read_only: true,
        environment: Some(TypeLock::Production),
        ..NOTHING
    };
    let policy = Policy::new(
        entries,
        move |_| Some(locked),
        Choices::default(),
        Audit::off(),
    );
    let by_file = policy.access("prod-eu");
    assert_eq!(
        by_file.mode,
        Mode::ReadWrite,
        "the admin's file may open it"
    );
    assert!(
        matches!(&by_file.source, ModeSource::PolicyFile { pattern: Some(p), .. } if p == "prod-*"),
        "{by_file:?}"
    );

    let kubeconfig = Lock {
        mode: Mode::ReadOnly,
        source: LockSource::Kubeconfig,
    };
    for (mode, overrides) in [
        (Mode::ReadWrite, Some(kubeconfig.clone())),
        (Mode::Guarded, Some(kubeconfig)),
        (Mode::ReadOnly, None),
    ] {
        policy.set_mode("c", Some(mode)).unwrap();
        let access = policy.access("c");
        assert_eq!(access.mode, mode);
        assert_eq!(access.source, ModeSource::User { overrides }, "{mode:?}");
    }
    policy.set_mode("c", None).unwrap();
    assert_eq!(policy.access("c").source, ModeSource::Kubeconfig);

    let staging = with_metadata(Metadata {
        environment: Some(TypeLock::Staging),
        ..NOTHING
    });
    staging.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    assert_eq!(
        staging.access("c").source,
        ModeSource::User { overrides: None },
        "a choice stricter than the locks sets none aside"
    );
}

#[test]
fn the_strictest_lock_wins_and_of_equal_ones_the_kubeconfig_s_then_the_provider_s() {
    let (production, staging) = (Some(TypeLock::Production), Some(TypeLock::Staging));
    let environment = |environment| ModeSource::Environment { environment };
    let cases = [
        (true, None, None, Mode::ReadOnly, ModeSource::Kubeconfig),
        (
            false,
            Some(ProviderLock::Guarded),
            None,
            Mode::Guarded,
            ModeSource::Provider,
        ),
        (
            false,
            Some(ProviderLock::Guarded),
            production,
            Mode::ReadOnly,
            environment(Environment::Production),
        ),
        (
            false,
            Some(ProviderLock::Guarded),
            staging,
            Mode::Guarded,
            ModeSource::Provider,
        ),
        (
            false,
            Some(ProviderLock::ReadOnly),
            production,
            Mode::ReadOnly,
            ModeSource::Provider,
        ),
        (
            true,
            Some(ProviderLock::ReadOnly),
            production,
            Mode::ReadOnly,
            ModeSource::Kubeconfig,
        ),
        (true, None, staging, Mode::ReadOnly, ModeSource::Kubeconfig),
        (
            false,
            None,
            staging,
            Mode::Guarded,
            environment(Environment::Staging),
        ),
        (false, None, None, Mode::Guarded, ModeSource::Unmarked),
    ];
    for (read_only, provider, environment, mode, source) in cases {
        let policy = with_metadata(Metadata {
            read_only,
            provider,
            environment,
            ..NOTHING
        });
        let access = policy.access("c");
        assert_eq!(
            (access.mode, &access.source),
            (mode, &source),
            "{read_only} {provider:?} {environment:?}"
        );
    }
}

#[test]
fn the_catalog_is_read_anew_for_every_request() {
    let metadata = Arc::new(Mutex::new(NOTHING));
    let policy = {
        let metadata = Arc::clone(&metadata);
        Policy::new(
            PolicyFile::default(),
            move |_| Some(*metadata.lock().unwrap()),
            local(),
            Audit::off(),
        )
    };
    let gate = write();
    policy.authorize("c", &gate, Actor::Ui).unwrap();
    metadata.lock().unwrap().read_only = true;
    assert!(policy.authorize("c", &gate, Actor::Ui).is_err());
}

#[test]
fn of_several_matching_entries_the_strictest_wins_and_globs_cross_slashes() {
    let (_dir, entries) = file(
        r#"{"contexts": {
            "*": "read-write",
            "prod-*": "guarded",
            "prod-eu*": "read-only",
            "arn:aws:eks:*:cluster/prod": "read-only"
        }}"#,
    );
    let policy = Policy::new(entries, |_| Some(NOTHING), Choices::default(), Audit::off());
    assert_eq!(policy.access("dev").mode, Mode::ReadWrite);
    assert_eq!(policy.access("prod-us").mode, Mode::Guarded);
    assert_eq!(policy.access("prod-eu-1").mode, Mode::ReadOnly);
    assert_eq!(
        policy.access("arn:aws:eks:eu-west-1:1:cluster/prod").mode,
        Mode::ReadOnly
    );
}

#[test]
fn a_policy_file_that_cannot_be_read_locks_every_context_and_says_so() {
    for text in [
        "not json",
        r#"{"context": {"prod-*": "read-only"}}"#,
        r#"{"contexts": {"prod-*": "readonly"}}"#,
        r#"{"contexts": {"[": "read-only"}}"#,
        r#"{"readOnly": {"allowPortforward": true}}"#,
        r#"{"terminal": {"usePolicyproxy": ["prod-*"]}}"#,
        r#"{"terminal": {"usePolicyProxy": ["["]}}"#,
        r#"{"terminal": {"usePolicyProxy": "prod-*"}}"#,
    ] {
        let (_dir, unreadable) = file(text);
        let policy = Policy::new(
            unreadable,
            |_| Some(NOTHING),
            Choices::default(),
            Audit::off(),
        );
        let access = policy.access("anything");
        assert_eq!(access.mode, Mode::ReadOnly, "{text}");
        assert!(
            matches!(access.source, ModeSource::PolicyFile { pattern: None, .. }),
            "{text}"
        );
        assert!(matches!(
            policy.set_mode("anything", Some(Mode::ReadWrite)),
            Err(Refused::PolicyFileUnreadable(_))
        ));
        assert!(policy.unlock("anything").is_err(), "{text}");
        assert!(policy.uses_policy_proxy("anything"), "{text}");
        let forward =
            Attributes::action("create", "pods", Some("portforward"), Some("a"), Some("p"));
        assert!(policy.authorize("anything", &forward, Actor::Ui).is_err());
    }
}

fn reason_of(file: PolicyFile) -> String {
    let policy = Policy::new(file, |_| Some(NOTHING), Choices::default(), Audit::off());
    match policy.access("anything").source {
        ModeSource::PolicyFile {
            pattern: None,
            reason: Some(reason),
            ..
        } => reason,
        other => panic!("a file that cannot be read says why: {other:?}"),
    }
}

#[test]
fn a_policy_file_that_cannot_be_read_says_why_by_its_place_and_quotes_none_of_its_words() {
    let (_dir, truncated) = file(r#"{"contexts": {"prod-*": "read-only""#);
    assert_eq!(
        reason_of(truncated),
        "it ends too early at line 1, column 35"
    );
    let (_dir, unknown) = file("{\n  \"confidential-name\": true\n}");
    let said = reason_of(unknown);
    assert_eq!(
        said,
        "it says something the policy file does not at line 2, column 21"
    );
    let (_dir, glob) = file(r#"{"contexts": {"prod-[": "read-only"}}"#);
    assert_eq!(
        reason_of(glob),
        "a context pattern is not a glob, near its character 5"
    );
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(reason_of(PolicyFile::read(dir.path())), "is a directory");
}

#[test]
fn the_policy_file_has_terminals_of_the_contexts_it_names_use_the_proxy() {
    let (_dir, proxied) = file(r#"{"terminal": {"usePolicyProxy": ["prod-*", "arn:aws:eks:*"]}}"#);
    let policy = Policy::new(proxied, |_| Some(NOTHING), Choices::default(), Audit::off());
    assert!(policy.uses_policy_proxy("prod-eu"));
    assert!(policy.uses_policy_proxy("arn:aws:eks:eu-west-1:1:cluster/a"));
    assert!(!policy.uses_policy_proxy("staging-eu"));
    assert_eq!(policy.access("prod-eu").source, ModeSource::Unmarked);
}

#[test]
fn a_missing_policy_file_sets_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let policy = Policy::new(
        PolicyFile::read(&dir.path().join("absent.json")),
        |_| Some(NOTHING),
        Choices::default(),
        Audit::off(),
    );
    assert_eq!(policy.access("c").source, ModeSource::Unmarked);
    assert!(!policy.uses_policy_proxy("c"));
}

#[test]
fn a_policy_file_entry_refuses_a_mode_and_an_unlock_and_holds_its_mode_under_a_type() {
    let (_dir, entries) = file(r#"{"contexts": {"prod-*": "read-only"}}"#);
    let policy = Policy::new(entries, |_| Some(NOTHING), Choices::default(), Audit::off());
    let by_file = |refused: Refused| matches!(&refused, Refused::PolicyFile(pattern, _) if pattern == "prod-*");
    for change in [
        Change::Mode {
            mode: Some(Mode::ReadWrite),
        },
        Change::Unlock,
    ] {
        assert!(
            by_file(policy.plan("prod-eu", change).unwrap_err()),
            "{change:?}"
        );
    }
    assert!(by_file(
        policy
            .set_mode("prod-eu", Some(Mode::ReadWrite))
            .unwrap_err()
    ));
    assert!(policy.unlock("prod-eu").is_err());

    let local = Change::Type {
        environment: Some(Environment::Local),
    };
    let planned = policy.plan("prod-eu", local).unwrap();
    assert_eq!(planned.after.mode, Mode::ReadOnly);
    assert_eq!(planned.after.source, planned.before.source);
    let typed = friction(&planned.risk(), "prod-eu", &planned.before);
    policy.change("prod-eu", &planned, &typed).unwrap();
    let access = policy.access("prod-eu");
    assert_eq!(access.environment, Some(Environment::Local));
    assert_eq!(access.mode, Mode::ReadOnly);
    assert_eq!(access.unlocked_until, None);
    assert!(policy.authorize("prod-eu", &write(), Actor::Ui).is_err());
}

#[test]
fn only_a_read_only_context_unlocks() {
    let policy = Policy::open();
    assert!(matches!(
        policy.unlock("c"),
        Err(Refused::NotLocked(_, "read-write"))
    ));
    policy.set_mode("c", Some(Mode::Guarded)).unwrap();
    assert!(matches!(
        policy.unlock("c"),
        Err(Refused::NotLocked(_, "guarded"))
    ));
}

#[test]
fn an_unlock_is_guarded_for_a_quarter_of_an_hour_and_a_relock_ends_it() {
    let policy = Policy::open();
    policy
        .set_environment("c", Some(Environment::Production))
        .unwrap();
    assert!(policy.authorize("c", &write(), Actor::Ui).is_err());
    policy.unlock("c").unwrap();

    let access = policy.access("c");
    assert_eq!(access.mode, Mode::Guarded);
    assert_eq!(
        access.source,
        ModeSource::Environment {
            environment: Environment::Production
        },
        "what it relocks to"
    );
    let left = access.unlocked_until.unwrap() - jiff::Timestamp::now().as_millisecond();
    assert!((14 * 60_000..=15 * 60_000).contains(&left), "{left} ms");
    policy.authorize("c", &write(), Actor::Ui).unwrap();
    let terminal = policy
        .authorize("c", &write(), Actor::Terminal)
        .unwrap_err();
    assert_eq!(terminal.reason, BlockReason::NoApproval);

    policy.relock("c");
    assert_eq!(policy.access("c").mode, Mode::ReadOnly);
    assert_eq!(policy.access("c").unlocked_until, None);
    assert!(policy.authorize("c", &write(), Actor::Ui).is_err());
}

#[test]
fn an_unlock_does_not_touch_another_context() {
    let policy = Policy::open();
    policy.set_mode("a", Some(Mode::ReadOnly)).unwrap();
    policy.set_mode("b", Some(Mode::ReadOnly)).unwrap();
    policy.unlock("a").unwrap();
    assert_eq!(policy.access("a").mode, Mode::Guarded);
    assert_eq!(policy.access("b").mode, Mode::ReadOnly);
}

#[test]
fn a_new_choice_ends_an_unlock() {
    let policy = Policy::open();
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    policy.unlock("c").unwrap();
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    assert_eq!(policy.access("c").mode, Mode::ReadOnly);
    assert_eq!(policy.access("c").unlocked_until, None);
}

#[test]
fn an_unlock_holds_only_for_what_it_was_given_on() {
    let metadata = Arc::new(Mutex::new(Metadata {
        read_only: true,
        ..NOTHING
    }));
    let policy = {
        let metadata = Arc::clone(&metadata);
        Policy::new(
            PolicyFile::default(),
            move |_| Some(*metadata.lock().unwrap()),
            local(),
            Audit::off(),
        )
    };
    policy.unlock("c").unwrap();
    assert_eq!(policy.access("c").mode, Mode::Guarded);

    // Its kubeconfig opens the context and locks it again, or moves it to
    // another cluster and back: another fingerprint, then the same again.
    *metadata.lock().unwrap() = Metadata {
        connection: 1,
        ..NOTHING
    };
    let open = policy.access("c");
    assert_eq!((open.mode, open.unlocked_until), (Mode::ReadWrite, None));
    *metadata.lock().unwrap() = Metadata {
        read_only: true,
        connection: 0,
        ..NOTHING
    };
    let locked = policy.access("c");
    assert_eq!((locked.mode, locked.unlocked_until), (Mode::ReadOnly, None));
}

#[test]
fn a_context_no_source_lists_lets_no_write_through_whatever_was_chosen() {
    for entry in [
        "",
        r#""gone": "guarded""#,
        r#""gone": "read-write""#,
        r#""gone": "read-only""#,
    ] {
        let (_dir, filed) = entries(entry);
        let listed = Arc::new(Mutex::new(Some(NOTHING)));
        let policy = {
            let listed = Arc::clone(&listed);
            Policy::new(
                filed,
                move |_| *listed.lock().unwrap(),
                Choices::default(),
                Audit::off(),
            )
        };
        let built = policy.gate("gone", Actor::Ui);
        *listed.lock().unwrap() = None;
        let access = policy.access("gone");
        assert_eq!(access.mode, Mode::ReadOnly, "{entry}");
        assert_eq!(access.source, ModeSource::Unlisted, "{entry}");
        assert_eq!(
            through(&built, posted()),
            Err((Mode::ReadOnly, ModeSource::Unlisted)),
            "{entry}"
        );
        assert_eq!(through(&built, got()), Ok(()), "{entry}");
        assert!(policy.authorize("gone", &write(), Actor::Ui).is_err());
        assert!(
            policy
                .authorize(
                    "gone",
                    &Attributes::action("get", "pods", None, None, None),
                    Actor::Ui
                )
                .is_ok()
        );
        for change in [Change::Mode { mode: None }, Change::Unlock] {
            assert!(
                matches!(policy.plan("gone", change), Err(Refused::Unlisted(_))),
                "{entry}: {change:?}"
            );
        }
        assert!(
            matches!(policy.unlock("gone"), Err(Refused::Unlisted(_))),
            "{entry}"
        );
        assert!(
            matches!(
                policy.set_mode("gone", Some(Mode::ReadWrite)),
                Err(Refused::Unlisted(_))
            ),
            "{entry}"
        );
        assert_eq!(policy.access("gone").mode, Mode::ReadOnly);
    }
}

#[test]
fn a_choice_that_does_not_read_back_costs_that_choice_only() {
    let text = r#"{
        "modes": {"prod": "read-only", "typo": "readonly"},
        "environments": {"prod": "production", "none": null, "typo": "moon"}
    }"#;
    let read: Choices = serde_json::from_str(text).unwrap();
    assert_eq!(read.modes.get("prod"), Some(&Mode::ReadOnly));
    assert!(!read.modes.contains_key("typo"));
    assert_eq!(
        read.environments.get("prod"),
        Some(&Some(Environment::Production))
    );
    assert_eq!(read.environments.get("none"), Some(&None));
    assert!(!read.environments.contains_key("typo"));
}

#[tokio::test]
async fn it_relocks_by_itself_and_says_so() {
    let policy = Policy::open();
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    let follower = {
        let policy = Arc::clone(&policy);
        tokio::spawn(async move { policy.follow_unlocks().await })
    };
    let mut changes = policy.changes();
    policy
        .unlock_for("c", SignedDuration::from_millis(50))
        .unwrap();
    assert_eq!(policy.access("c").mode, Mode::Guarded);
    changes.borrow_and_update();

    let relocked = async {
        while policy.access("c").mode != Mode::ReadOnly || changes.has_changed().unwrap() {
            changes.changed().await.unwrap();
            changes.borrow_and_update();
        }
    };
    tokio::time::timeout(Duration::from_secs(5), relocked)
        .await
        .expect("the unlock ended, and the policy said so");
    assert_eq!(policy.access("c").unlocked_until, None);
    follower.abort();
}

#[test]
fn every_change_ticks() {
    let policy = Policy::open();
    let mut changes = policy.changes();
    let mut ticked = move || {
        let ticked = changes.has_changed().unwrap();
        changes.borrow_and_update();
        ticked
    };
    assert!(!ticked());
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    assert!(ticked());
    policy
        .set_environment("c", Some(Environment::Staging))
        .unwrap();
    assert!(ticked());
    policy.unlock("c").unwrap();
    assert!(ticked());
    policy.relock("c");
    assert!(ticked());
    policy.relock("c");
    assert!(!ticked(), "nothing to end");
}

#[tokio::test]
async fn each_change_of_a_context_counts_for_it_alone_and_never_goes_back() {
    let policy = Policy::open();
    let follower = {
        let policy = Arc::clone(&policy);
        tokio::spawn(async move { policy.follow_unlocks().await })
    };
    let mut counted = 0;
    let mut changed = |policy: &Policy| {
        let now = policy.changes_of("c");
        let moved = now > counted;
        counted = now;
        moved
    };
    assert!(!changed(&policy));
    policy.set_mode("c", Some(Mode::Guarded)).unwrap();
    assert!(changed(&policy));
    policy.set_mode("c", Some(Mode::ReadWrite)).unwrap();
    policy.set_mode("c", Some(Mode::Guarded)).unwrap();
    assert!(changed(&policy), "back to what it was is still a change");
    policy
        .set_environment("c", Some(Environment::Staging))
        .unwrap();
    assert!(changed(&policy));
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    assert!(changed(&policy));
    policy.unlock("c").unwrap();
    assert!(changed(&policy));
    policy.relock("c");
    assert!(changed(&policy));
    policy.relock("c");
    assert!(!changed(&policy), "nothing to end");
    policy.set_mode("other", Some(Mode::ReadOnly)).unwrap();
    policy.unlock("other").unwrap();
    assert!(!changed(&policy), "another context's");

    policy
        .unlock_for("c", SignedDuration::from_millis(20))
        .unwrap();
    assert!(changed(&policy));
    let relocked = async {
        while policy.changes_of("c") == counted {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), relocked)
        .await
        .expect("an unlock's end counts");
    follower.abort();
}

#[test]
fn the_blocked_error_names_the_rule() {
    let policy = Policy::open();
    policy.set_mode("prod-eu", Some(Mode::ReadOnly)).unwrap();
    let exec = Attributes::action("create", "pods", Some("exec"), Some("a"), Some("web-1"));
    let blocked = policy.authorize("prod-eu", &exec, Actor::Ui).unwrap_err();
    assert_eq!(blocked.mode, Mode::ReadOnly);
    assert_eq!(blocked.source, ModeSource::User { overrides: None });
    assert_eq!(blocked.reason, BlockReason::Mode);
    assert_eq!(
        blocked.to_string(),
        "prod-eu is read-only by your choice, so Twigo did not send create pods/web-1/exec in a"
    );

    let (_dir, entries) = file(r#"{"contexts": {"prod-*": "read-only"}}"#);
    let by_file = Policy::new(entries, |_| Some(NOTHING), Choices::default(), Audit::off());
    let message = by_file
        .authorize("prod-eu", &exec, Actor::Ui)
        .unwrap_err()
        .to_string();
    assert!(message.contains("by prod-* in "), "{message}");
    assert!(message.contains("policy.json"), "{message}");
}

#[test]
fn choices_round_trip_as_a_person_left_them() {
    let policy = Policy::open();
    let choices = policy.set_mode("a", Some(Mode::Guarded)).unwrap();
    let text = serde_json::to_string(&choices).unwrap();
    assert_eq!(text, r#"{"modes":{"a":"guarded"},"environments":{}}"#);
    let back: Choices = serde_json::from_str(&text).unwrap();
    let reopened = Policy::new(PolicyFile::default(), |_| Some(NOTHING), back, Audit::off());
    assert_eq!(reopened.access("a").mode, Mode::Guarded);
}

#[test]
fn a_gate_holds_its_clients_to_what_they_were_built_for() {
    let cases = [
        ("", [Ok(()), Ok(())]),
        (r#""c": "guarded""#, [Ok(()), Err(Mode::Guarded)]),
        (r#""c": "read-write""#, [Ok(()), Ok(())]),
        (
            r#""c": "read-only""#,
            [Err(Mode::ReadOnly), Err(Mode::ReadOnly)],
        ),
    ];
    for (entry, answers) in cases {
        let (dir, filed) = entries(entry);
        let by_file = ModeSource::PolicyFile {
            file: dir.path().join("policy.json").display().to_string(),
            pattern: Some("c".to_owned()),
            reason: None,
        };
        let answers = answers.map(|answer| answer.map_err(|mode| (mode, by_file.clone())));
        let metadata = Arc::new(Mutex::new(Metadata {
            connection: 1,
            ..NOTHING
        }));
        let policy = {
            let metadata = Arc::clone(&metadata);
            Policy::new(
                filed,
                move |_| Some(*metadata.lock().unwrap()),
                local(),
                Audit::off(),
            )
        };
        let gates = || [Actor::Ui, Actor::Terminal].map(|actor| policy.gate("c", actor));
        let built = gates();
        assert_eq!(
            built.each_ref().map(|gate| through(gate, posted())),
            answers,
            "{entry}"
        );

        metadata.lock().unwrap().connection = 2;
        for gate in &built {
            assert_eq!(
                through(gate, posted()),
                Err((Mode::ReadOnly, ModeSource::Moved)),
                "{entry}"
            );
            assert_eq!(through(gate, got()), Ok(()), "{entry}");
        }
        assert_eq!(
            gates().each_ref().map(|gate| through(gate, posted())),
            answers,
            "{entry}"
        );
    }
}

fn audited(path: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn audited_policy(metadata: Metadata) -> (tempfile::TempDir, std::path::PathBuf, Arc<Policy>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("audit.jsonl");
    let policy = Policy::new(
        PolicyFile::default(),
        move |_| Some(metadata),
        Choices::default(),
        Audit::open(&path),
    );
    (dir, path, policy)
}

#[test]
fn a_planned_change_says_what_it_leaves_and_the_log_records_it_once_with_its_friction() {
    let (_dir, path, policy) = audited_policy(Metadata {
        read_only: true,
        ..NOTHING
    });
    let change = Change::Mode {
        mode: Some(Mode::ReadWrite),
    };
    let planned = policy.plan("c", change).unwrap();
    assert_eq!(planned.before.mode, Mode::ReadOnly);
    assert_eq!(planned.before.source, ModeSource::Kubeconfig);
    let kubeconfig = Lock {
        mode: Mode::ReadOnly,
        source: LockSource::Kubeconfig,
    };
    assert_eq!(planned.after.mode, Mode::ReadWrite);
    assert_eq!(
        planned.after.source,
        ModeSource::User {
            overrides: Some(kubeconfig)
        }
    );
    assert_eq!(policy.access("c"), planned.before, "a plan changes nothing");
    assert!(audited(&path).is_empty());

    let typed = Friction::Typed {
        text: "c".to_owned(),
    };
    let choices = policy.change("c", &planned, &typed).unwrap();
    assert_eq!(choices.modes.get("c"), Some(&Mode::ReadWrite));
    assert_eq!(policy.access("c"), planned.after);
    let lines = audited(&path);
    assert_eq!(lines.len(), 1, "{lines:?}");
    let line = &lines[0];
    assert_eq!(line["event"], "protection");
    assert_eq!(line["context"], "c");
    assert_eq!(
        line["change"],
        serde_json::json!({"kind": "mode", "mode": "read-write"})
    );
    assert_eq!(
        line["before"]["source"],
        serde_json::json!({"kind": "kubeconfig"})
    );
    assert_eq!(
        line["after"]["source"],
        serde_json::json!({
            "kind": "user",
            "overrides": {"mode": "read-only", "source": {"kind": "kubeconfig"}},
        })
    );
    assert_eq!(
        line["by"],
        serde_json::json!({"kind": "plan", "friction": {"kind": "typed", "text": "c"}})
    );
}

#[test]
fn a_lasting_change_asks_for_the_name_where_any_set_of_the_locks_that_can_go_shows_it_lowering() {
    let (_dir, file) = file(r#"{"contexts": {"filed": "guarded", "filed-locked": "read-only"}}"#);
    let policy = Policy::new(
        file,
        |context| {
            Some(match context {
                "provided" => Metadata {
                    provider: Some(ProviderLock::Guarded),
                    ..NOTHING
                },
                "production" => Metadata {
                    environment: Some(TypeLock::Production),
                    ..NOTHING
                },
                "staging" => Metadata {
                    environment: Some(TypeLock::Staging),
                    ..NOTHING
                },
                "locked-production" => Metadata {
                    read_only: true,
                    environment: Some(TypeLock::Production),
                    ..NOTHING
                },
                "locked" | "filed-locked" => Metadata {
                    read_only: true,
                    ..NOTHING
                },
                _ => NOTHING,
            })
        },
        Choices::default(),
        Audit::off(),
    );
    policy.set_mode("production", Some(Mode::Guarded)).unwrap();
    policy.set_mode("staging", Some(Mode::Guarded)).unwrap();
    policy.set_mode("locked", Some(Mode::ReadOnly)).unwrap();
    policy
        .set_environment("locked", Some(Environment::Development))
        .unwrap();
    policy
        .set_environment("filed", Some(Environment::Staging))
        .unwrap();
    let mark = |environment| Change::Type {
        environment: Some(environment),
    };
    let clear_mode = Change::Mode { mode: None };
    let clear_type = Change::Type { environment: None };
    let asks = [
        ("provided", mark(Environment::Development), true),
        ("provided", mark(Environment::Staging), false),
        ("locked-production", mark(Environment::Staging), true),
        ("locked-production", mark(Environment::Production), false),
        ("production", clear_mode, true),
        ("staging", clear_mode, true),
        ("locked", clear_mode, true),
        ("locked", mark(Environment::Local), false),
        ("filed", clear_type, true),
        ("filed", mark(Environment::Production), false),
        ("filed-locked", mark(Environment::Development), true),
        ("filed-locked", mark(Environment::Production), false),
    ];
    for (context, change, typed) in asks {
        let planned = policy.plan(context, change).unwrap();
        let expected = if typed {
            Friction::Typed {
                text: context.to_owned(),
            }
        } else {
            Friction::AtOnce
        };
        assert_eq!(
            friction(&planned.risk(), context, &planned.before),
            expected,
            "{context}: {change:?}"
        );
    }
}

#[test]
fn a_plan_holds_only_while_the_context_stands_as_it_was_planned() {
    let metadata = Arc::new(Mutex::new(Metadata {
        environment: Some(TypeLock::Production),
        ..NOTHING
    }));
    let policy = {
        let metadata = Arc::clone(&metadata);
        Policy::new(
            PolicyFile::default(),
            move |_| Some(*metadata.lock().unwrap()),
            Choices::default(),
            Audit::off(),
        )
    };
    let lower = Change::Mode {
        mode: Some(Mode::ReadWrite),
    };
    let typed = Friction::Typed {
        text: "c".to_owned(),
    };
    let refused_after = |what: &str, meanwhile: &dyn Fn()| {
        let planned = policy.plan("c", lower).unwrap();
        meanwhile();
        let before = policy.access("c");
        assert_eq!(
            policy.change("c", &planned, &typed).unwrap_err(),
            Refused::Changed("c".to_owned()),
            "{what}"
        );
        assert_eq!(policy.access("c"), before, "{what}: nothing changed");
        policy.relock("c");
    };
    refused_after("a choice that went back", &|| {
        policy.set_mode("c", Some(Mode::Guarded)).unwrap();
        policy.set_mode("c", None).unwrap();
    });
    refused_after("an unlock", &|| policy.unlock("c").unwrap());
    refused_after("an unlock that ended", &|| {
        policy.unlock("c").unwrap();
        policy.relock("c");
    });
    refused_after("what the catalog says of it", &|| {
        metadata.lock().unwrap().revision += 1;
    });
    let planned = policy.plan("c", lower).unwrap();
    policy.change("c", &planned, &typed).unwrap();
    assert_eq!(policy.access("c").mode, Mode::ReadWrite);
    assert_eq!(
        policy.change("c", &planned, &typed).unwrap_err(),
        Refused::Changed("c".to_owned()),
        "a plan runs once"
    );
}

#[test]
fn a_plan_made_under_an_unlock_is_refused_once_the_unlock_ran_out_before_anything_ended_it() {
    let policy = with_metadata(Metadata {
        read_only: true,
        ..NOTHING
    });
    policy
        .unlock_for("c", SignedDuration::from_millis(20))
        .unwrap();
    let lower = Change::Mode {
        mode: Some(Mode::ReadWrite),
    };
    let planned = policy.plan("c", lower).unwrap();
    assert_eq!(planned.before.mode, Mode::Guarded);
    std::thread::sleep(Duration::from_millis(40));
    let typed = Friction::Typed {
        text: "c".to_owned(),
    };
    assert_eq!(
        policy.change("c", &planned, &typed).unwrap_err(),
        Refused::Changed("c".to_owned())
    );
    assert_eq!(policy.access("c").mode, Mode::ReadOnly);
}

#[test]
fn an_unlock_is_planned_only_for_a_read_only_context() {
    let policy = Policy::open();
    assert!(matches!(
        policy.plan("c", Change::Unlock),
        Err(Refused::NotLocked(_, "read-write"))
    ));
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    let planned = policy.plan("c", Change::Unlock).unwrap();
    assert_eq!(planned.after.mode, Mode::Guarded);
    assert!(planned.after.unlocked_until.is_some());
    policy.change("c", &planned, &Friction::Confirm).unwrap();
    assert_eq!(policy.access("c").mode, Mode::Guarded);
}

#[test]
fn a_process_s_answer_marks_only_a_context_still_unmarked_on_the_same_cluster() {
    let (_dir, path, policy) = audited_policy(Metadata {
        connection: 7,
        ..NOTHING
    });
    assert_eq!(
        policy
            .mark(
                "c",
                8,
                Environment::Development,
                Actor::Terminal,
                "Terminal 2"
            )
            .unwrap_err(),
        Refused::Changed("c".to_owned()),
        "another cluster"
    );
    policy
        .mark("c", 7, Environment::Staging, Actor::Terminal, "Terminal 2")
        .unwrap();
    let access = policy.access("c");
    assert_eq!(access.mode, Mode::Guarded);
    assert_eq!(access.environment, Some(Environment::Staging));
    assert_eq!(
        policy
            .mark(
                "c",
                7,
                Environment::Development,
                Actor::Terminal,
                "Terminal 3"
            )
            .unwrap_err(),
        Refused::Changed("c".to_owned()),
        "marked meanwhile"
    );
    assert_eq!(policy.access("c"), access);
    let lines = audited(&path);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(
        lines[0]["change"],
        serde_json::json!({"kind": "type", "environment": "staging"})
    );
    assert_eq!(lines[0]["before"]["source"]["kind"], "unmarked");
    assert_eq!(
        lines[0]["by"],
        serde_json::json!({"kind": "ask", "actor": "terminal", "process": "Terminal 2"})
    );
}

#[tokio::test]
async fn the_log_records_each_unlock_s_end_and_why() {
    let metadata = Arc::new(Mutex::new(Some(Metadata {
        read_only: true,
        connection: 1,
        ..NOTHING
    })));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("audit.jsonl");
    let policy = {
        let metadata = Arc::clone(&metadata);
        Policy::new(
            PolicyFile::default(),
            move |_| *metadata.lock().unwrap(),
            Choices::default(),
            Audit::open(&path),
        )
    };
    let follower = {
        let policy = Arc::clone(&policy);
        tokio::spawn(async move { policy.follow_unlocks().await })
    };
    policy.relock("c");
    assert!(audited(&path).is_empty(), "nothing ended");

    policy.unlock("c").unwrap();
    policy.relock("c");
    policy
        .unlock_for("c", SignedDuration::from_millis(20))
        .unwrap();
    let expired = async {
        while audited(&path).len() < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), expired)
        .await
        .expect("the unlock ran out");
    policy.unlock("c").unwrap();
    metadata.lock().unwrap().as_mut().unwrap().connection = 2;
    assert_eq!(policy.access("c").mode, Mode::ReadOnly);
    policy.unlock("c").unwrap();
    *metadata.lock().unwrap() = None;
    policy.access("c");
    follower.abort();

    let ended: Vec<_> = audited(&path)
        .iter()
        .map(|line| (line["event"].clone(), line["by"].clone()))
        .collect();
    assert_eq!(
        ended,
        [
            ("relocked", "command"),
            ("relocked", "time"),
            ("relocked", "moved"),
            ("relocked", "unlisted")
        ]
        .map(|(event, by)| (event.into(), by.into()))
    );
}

#[test]
fn the_fatal_path_ends_every_unlock_at_once_and_the_log_says_so() {
    let (_dir, path, policy) = audited_policy(Metadata {
        read_only: true,
        ..NOTHING
    });
    policy.unlock("c").unwrap();
    policy.unlock("d").unwrap();
    let mut changes = policy.changes();
    changes.borrow_and_update();

    policy.end_unlocks();
    assert_eq!(policy.access("c").mode, Mode::ReadOnly);
    assert_eq!(policy.access("d").mode, Mode::ReadOnly);
    assert!(changes.has_changed().unwrap());
    let mut ended: Vec<_> = audited(&path)
        .iter()
        .filter(|line| line["event"] == "relocked")
        .map(|line| (line["context"].clone(), line["by"].clone()))
        .collect();
    ended.sort_by_key(|(context, _)| context.to_string());
    assert_eq!(
        ended,
        [("c", "fatal"), ("d", "fatal")].map(|(context, by)| (context.into(), by.into()))
    );
}

#[test]
fn the_log_records_what_a_change_of_the_catalog_did_to_a_context_s_access_once() {
    let locked = Metadata {
        read_only: true,
        connection: 1,
        ..NOTHING
    };
    let (_filed, filed) = entries(r#""e": "guarded""#);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("audit.jsonl");
    let policy = Policy::new(
        filed,
        move |_| Some(locked),
        Choices::default(),
        Audit::open(&path),
    );
    let open = Metadata {
        connection: 1,
        ..NOTHING
    };
    policy.catalog_changed("c", Some(locked), Some(open));
    let elsewhere = Metadata {
        connection: 2,
        ..NOTHING
    };
    policy.catalog_changed("c", Some(open), Some(elsewhere));
    policy.unlock("c").unwrap();
    let moved = Metadata {
        connection: 2,
        ..locked
    };
    policy.catalog_changed("c", Some(locked), Some(moved));
    policy.set_mode("d", Some(Mode::ReadWrite)).unwrap();
    policy.catalog_changed("d", None, Some(locked));
    policy.catalog_changed("e", Some(open), None);

    let lines: Vec<_> = audited(&path)
        .iter()
        .map(|line| {
            (
                line["event"].clone(),
                line["context"].clone(),
                line["before"]["source"]["kind"].clone(),
                line["after"]["source"]["kind"].clone(),
                line["by"].clone(),
            )
        })
        .collect();
    let null = serde_json::Value::Null;
    assert_eq!(
        lines,
        [
            (
                "catalog",
                "c",
                "kubeconfig".into(),
                "unmarked".into(),
                null.clone()
            ),
            ("relocked", "c", null.clone(), null.clone(), "moved".into()),
            (
                "catalog",
                "d",
                "unlisted".into(),
                "user".into(),
                null.clone()
            ),
            ("catalog", "e", "policyFile".into(), "unlisted".into(), null),
        ]
        .map(|(event, context, before, after, by)| (
            event.into(),
            context.into(),
            before,
            after,
            by
        ))
    );
    let line = &audited(&path)[0];
    assert_eq!(line["before"]["mode"], "read-only");
    assert_eq!(line["after"]["mode"], "guarded");
}
