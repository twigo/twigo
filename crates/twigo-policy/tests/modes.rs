use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::SignedDuration;
use twigo_ipc::{BlockReason, Environment, Mode, ModeSource};
use twigo_policy::{Actor, Attributes, Audit, Choices, Metadata, Policy, PolicyFile, Refused};

const NOTHING: Metadata = Metadata {
    read_only: None,
    provider: None,
    environment: None,
    connection: 0,
    revision: 0,
};

fn file(text: &str) -> (tempfile::TempDir, PolicyFile) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("policy.json");
    std::fs::write(&path, text).unwrap();
    let file = PolicyFile::read(&path);
    (dir, file)
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

#[test]
fn a_context_nobody_marked_is_read_write_with_no_type() {
    let access = Policy::open().access("prod-eu");
    assert_eq!(access.mode, Mode::ReadWrite);
    assert_eq!(access.source, ModeSource::Default);
    assert_eq!(access.environment, None);
    assert_eq!(access.unlocked_until, None);
}

#[test]
fn an_environment_type_sets_the_default_mode() {
    let policy = Policy::open();
    for (environment, mode) in [
        (Environment::Production, Mode::ReadOnly),
        (Environment::Staging, Mode::Guarded),
        (Environment::Development, Mode::ReadWrite),
        (Environment::Local, Mode::ReadWrite),
    ] {
        policy.set_environment("c", Some(environment));
        let access = policy.access("c");
        assert_eq!(access.mode, mode);
        assert_eq!(access.source, ModeSource::Environment { environment });
        assert_eq!(access.environment, Some(environment));
    }
    policy.set_environment("c", None);
    assert_eq!(policy.access("c").mode, Mode::ReadWrite);
    assert_eq!(policy.access("c").environment, None);
}

#[test]
fn no_type_holds_over_the_kubeconfig_s_mark() {
    let policy = with_metadata(Metadata {
        environment: Some(Environment::Production),
        ..NOTHING
    });
    policy.set_environment("c", None);
    let access = policy.access("c");
    assert_eq!(access.environment, None);
    assert_eq!(access.mode, Mode::ReadWrite);
    assert_eq!(access.source, ModeSource::Default);
}

#[test]
fn a_new_type_ends_an_unlock_so_marking_it_again_does_not_bring_it_back() {
    let policy = Policy::open();
    policy.set_environment("c", Some(Environment::Production));
    policy.unlock("c").unwrap();
    assert_eq!(policy.access("c").mode, Mode::Guarded);
    policy.set_environment("c", Some(Environment::Development));
    policy.set_environment("c", Some(Environment::Production));
    let access = policy.access("c");
    assert_eq!(access.mode, Mode::ReadOnly);
    assert_eq!(access.unlocked_until, None);
}

#[test]
fn a_mark_in_the_kubeconfig_counts_until_a_person_marks_otherwise() {
    let policy = with_metadata(Metadata {
        environment: Some(Environment::Production),
        ..NOTHING
    });
    assert_eq!(policy.access("c").mode, Mode::ReadOnly);
    policy.set_environment("c", Some(Environment::Local));
    assert_eq!(policy.access("c").mode, Mode::ReadWrite);
    assert_eq!(policy.access("c").environment, Some(Environment::Local));
}

#[test]
fn the_sources_rank_as_the_architecture_lists_them() {
    let (_dir, entries) = file(r#"{"contexts": {"prod-*": "read-only"}}"#);
    let all = Metadata {
        read_only: Some(false),
        provider: Some(Mode::Guarded),
        environment: Some(Environment::Production),
        ..NOTHING
    };
    let policy = Policy::new(
        entries.clone(),
        move |_| Some(all),
        Choices::default(),
        Audit::off(),
    );
    let source = |context: &str| policy.access(context).source;

    // The kubeconfig's word comes before the provider's and the type's.
    assert_eq!(source("c"), ModeSource::Kubeconfig);
    assert_eq!(policy.access("c").mode, Mode::ReadWrite);

    policy.set_mode("c", Some(Mode::Guarded)).unwrap();
    assert_eq!(source("c"), ModeSource::User, "the person's choice is next");
    policy.set_mode("c", None).unwrap();
    assert_eq!(source("c"), ModeSource::Kubeconfig);

    let policy_file = source("prod-eu");
    assert!(
        matches!(&policy_file, ModeSource::PolicyFile { pattern: Some(p), .. } if p == "prod-*"),
        "{policy_file:?}"
    );

    let provider = Policy::new(
        PolicyFile::default(),
        |_| {
            Some(Metadata {
                provider: Some(Mode::Guarded),
                environment: Some(Environment::Production),
                ..NOTHING
            })
        },
        Choices::default(),
        Audit::off(),
    );
    assert_eq!(provider.access("c").source, ModeSource::Provider);
    assert_eq!(provider.access("c").mode, Mode::Guarded);

    let kubeconfig = with_metadata(Metadata {
        read_only: Some(true),
        ..NOTHING
    });
    assert_eq!(kubeconfig.access("c").mode, Mode::ReadOnly);
}

#[test]
fn the_catalog_is_read_anew_for_every_request() {
    let metadata = Arc::new(Mutex::new(NOTHING));
    let policy = {
        let metadata = Arc::clone(&metadata);
        Policy::new(
            PolicyFile::default(),
            move |_| Some(*metadata.lock().unwrap()),
            Choices::default(),
            Audit::off(),
        )
    };
    let gate = write();
    policy.authorize("c", &gate, Actor::Ui).unwrap();
    metadata.lock().unwrap().read_only = Some(true);
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

#[test]
fn the_policy_file_has_terminals_of_the_contexts_it_names_use_the_proxy() {
    let (_dir, proxied) = file(r#"{"terminal": {"usePolicyProxy": ["prod-*", "arn:aws:eks:*"]}}"#);
    let policy = Policy::new(proxied, |_| Some(NOTHING), Choices::default(), Audit::off());
    assert!(policy.uses_policy_proxy("prod-eu"));
    assert!(policy.uses_policy_proxy("arn:aws:eks:eu-west-1:1:cluster/a"));
    assert!(!policy.uses_policy_proxy("staging-eu"));
    assert_eq!(policy.access("prod-eu").mode, Mode::ReadWrite);
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
    assert_eq!(policy.access("c").mode, Mode::ReadWrite);
    assert!(!policy.uses_policy_proxy("c"));
}

#[test]
fn a_policy_file_entry_cannot_be_changed_or_unlocked() {
    let (_dir, entries) = file(r#"{"contexts": {"prod-*": "read-only"}}"#);
    let policy = Policy::new(entries, |_| Some(NOTHING), Choices::default(), Audit::off());
    let refused = policy
        .set_mode("prod-eu", Some(Mode::ReadWrite))
        .unwrap_err();
    assert!(matches!(&refused, Refused::PolicyFile(pattern, _) if pattern == "prod-*"));
    assert!(policy.unlock("prod-eu").is_err());
    assert_eq!(policy.access("prod-eu").mode, Mode::ReadOnly);
    assert_eq!(policy.access("prod-eu").unlocked_until, None);
    assert!(
        policy.authorize("prod-eu", &write(), Actor::Ui).is_err(),
        "a type a person marks does not open it either"
    );
    policy.set_environment("prod-eu", Some(Environment::Local));
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
    policy.set_environment("c", Some(Environment::Production));
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
        read_only: Some(true),
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
    policy.unlock("c").unwrap();
    assert_eq!(policy.access("c").mode, Mode::Guarded);

    // Its kubeconfig opens the context and locks it again, or moves it to
    // another cluster and back: another fingerprint, then the same again.
    *metadata.lock().unwrap() = Metadata {
        read_only: Some(false),
        connection: 1,
        ..NOTHING
    };
    let open = policy.access("c");
    assert_eq!((open.mode, open.unlocked_until), (Mode::ReadWrite, None));
    *metadata.lock().unwrap() = Metadata {
        read_only: Some(true),
        connection: 0,
        ..NOTHING
    };
    let locked = policy.access("c");
    assert_eq!((locked.mode, locked.unlocked_until), (Mode::ReadOnly, None));
}

#[test]
fn a_context_no_source_lists_lets_no_write_through_whatever_was_chosen() {
    let policy = Policy::new(
        PolicyFile::default(),
        |_| None,
        Choices::default(),
        Audit::off(),
    );
    let access = policy.access("gone");
    assert_eq!(access.mode, Mode::ReadOnly);
    assert_eq!(access.source, ModeSource::Unlisted);
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
    assert!(matches!(
        policy.unlock("gone"),
        Err(Refused::NotLocked(_, "listed by no source"))
    ));

    policy.set_mode("gone", Some(Mode::ReadWrite)).unwrap();
    assert_eq!(policy.access("gone").mode, Mode::ReadOnly);
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
    policy.set_environment("c", Some(Environment::Staging));
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
    policy.set_environment("c", Some(Environment::Staging));
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
    assert_eq!(blocked.source, ModeSource::User);
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
    use http::Request;
    use tower::{Layer, Service, ServiceExt};

    let metadata = Arc::new(Mutex::new(Metadata {
        connection: 1,
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
    let gate = policy.gate("c", Actor::Ui);
    let mut service = gate
        .layer()
        .layer(tower::service_fn(|_: Request<()>| async {
            Ok::<_, std::convert::Infallible>(())
        }));
    let write = || {
        Request::post("/api/v1/namespaces/a/configmaps")
            .body(())
            .unwrap()
    };
    let read = || Request::get("/api/v1/pods").body(()).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        service.ready().await.unwrap().call(write()).await.unwrap();

        metadata.lock().unwrap().connection = 2;
        let error = service
            .ready()
            .await
            .unwrap()
            .call(write())
            .await
            .unwrap_err();
        let blocked = error.downcast_ref::<twigo_ipc::Blocked>().unwrap();
        assert_eq!(blocked.source, ModeSource::Moved);
        assert_eq!(blocked.mode, Mode::ReadOnly);
        service.ready().await.unwrap().call(read()).await.unwrap();

        // Clients built now reach the new one.
        let mut rebuilt =
            policy
                .gate("c", Actor::Ui)
                .layer()
                .layer(tower::service_fn(|_: Request<()>| async {
                    Ok::<_, std::convert::Infallible>(())
                }));
        rebuilt.ready().await.unwrap().call(write()).await.unwrap();
    });
}
