use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::*;

fn entry(space: Option<&str>, key: &str, value: &str) -> StateEntry {
    StateEntry {
        space: space.map(str::to_owned),
        key: key.into(),
        value: value.into(),
    }
}

fn store(dir: &tempfile::TempDir) -> (PathBuf, State) {
    let path = dir.path().join("state.json");
    let state = State::open_with(path.clone(), Duration::from_secs(3600));
    (path, state)
}

#[test]
fn values_come_back_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (path, state) = store(&dir);
    assert_eq!(state.open_space("kind-b").id, "kind-b");
    state.open_space("kind-a");
    state
        .set(vec![
            entry(None, "parts.sizes", r#"{"sidebar":300}"#),
            entry(Some("kind-a"), "namespaces", r#"["default"]"#),
        ])
        .unwrap();
    state.flush().unwrap();
    drop(state);

    let reopened = State::open(path);
    let snapshot = reopened.snapshot();
    assert_eq!(snapshot.app["parts.sizes"], r#"{"sidebar":300}"#);
    assert_eq!(snapshot.spaces["kind-a"]["namespaces"], r#"["default"]"#);
    assert!(snapshot.spaces["kind-b"].is_empty());
    let ids: Vec<String> = reopened.spaces().into_iter().map(|s| s.id).collect();
    assert_eq!(ids, ["kind-b", "kind-a"], "the rail's order");
}

#[test]
fn a_set_stores_all_its_entries_or_none() {
    let dir = tempfile::tempdir().unwrap();
    let (_, state) = store(&dir);
    state.open_space("kind-a");
    let not_json = state.set(vec![
        entry(None, "good", "1"),
        entry(None, "bad", "{not json"),
    ]);
    assert!(matches!(not_json, Err(Error::NotJson { key, .. }) if key == "bad"));
    let no_space = state.set(vec![
        entry(Some("kind-a"), "good", "1"),
        entry(Some("gone"), "lost", "1"),
    ]);
    assert!(matches!(no_space, Err(Error::NoSpace(id)) if id == "gone"));
    let snapshot = state.snapshot();
    assert!(snapshot.app.is_empty());
    assert!(snapshot.spaces["kind-a"].is_empty());
}

#[test]
fn opening_a_context_twice_gives_one_space() {
    let dir = tempfile::tempdir().unwrap();
    let (_, state) = store(&dir);
    let first = state.open_space("kind-a");
    assert_eq!(state.open_space("kind-a"), first);
    assert_eq!(state.spaces(), [first]);
}

#[test]
fn the_writer_saves_a_moment_after_a_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("state.json");
    let state = State::open_with(path.clone(), Duration::from_millis(200));
    state.set(vec![entry(None, "key", "1")]).unwrap();
    assert!(!path.exists(), "not before the delay");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(State::open(path).snapshot().app["key"], "1");
}

#[cfg(unix)]
#[test]
fn only_the_user_reads_the_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let (path, state) = store(&dir);
    state.set(vec![entry(None, "key", "1")]).unwrap();
    state.flush().unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn an_unreadable_file_is_set_aside() {
    for content in ["{ not json", r#"{"version":99,"app":{},"spaces":[]}"#] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, content).unwrap();
        problems::clear(ErrorCode::StateSetAside);
        let state = State::open(path.clone());
        assert!(state.snapshot().app.is_empty());
        assert!(!path.exists());
        assert!(
            listed(ErrorCode::StateSetAside),
            "the spaces the person had are gone, which the window says"
        );
        let aside = dir.path().join("state.json.unreadable");
        assert_eq!(std::fs::read_to_string(aside).unwrap(), content);
    }
}

fn listed(code: ErrorCode) -> bool {
    problems::watch()
        .borrow()
        .iter()
        .any(|problem| problem.code == code)
}

fn within_five_seconds(what: &str, mut holds: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !holds() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_state_that_cannot_be_saved_is_a_problem_until_a_save_works() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("blocked");
    std::fs::write(&blocked, "").unwrap();
    let state = State::open_with(blocked.join("state.json"), Duration::from_millis(10));
    problems::clear(ErrorCode::StateUnsaved);
    state.set(vec![entry(None, "key", "1")]).unwrap();
    within_five_seconds("the save never failed", || listed(ErrorCode::StateUnsaved));

    std::fs::remove_file(&blocked).unwrap();
    state.set(vec![entry(None, "key", "2")]).unwrap();
    within_five_seconds("the save never worked", || !listed(ErrorCode::StateUnsaved));
}

#[test]
fn a_space_missing_for_ninety_days_of_readings_is_dropped_as_the_store_opens() {
    let dir = tempfile::tempdir().unwrap();
    let (path, state) = store(&dir);
    for context in ["kind-kept", "kind-back", "kind-gone"] {
        state.open_space(context);
    }
    let listed = |names: &[&str]| -> HashSet<String> { names.iter().map(|&n| n.into()).collect() };
    let start = Timestamp::now();
    let day = |n: i64| start + SignedDuration::from_hours(n * 24);
    state.saw(&listed(&["kind-kept"]), start);
    state.saw(&listed(&["kind-kept", "kind-back"]), day(10));
    state.saw(&listed(&["kind-kept"]), day(20));
    state.saw(&listed(&["kind-kept"]), day(100));
    state.flush().unwrap();
    drop(state);

    let reopen = || State::open_with(path.clone(), Duration::from_secs(3600));
    let ids = |state: &State| -> Vec<String> { state.spaces().into_iter().map(|s| s.id).collect() };
    let reopened = reopen();
    assert_eq!(ids(&reopened), ["kind-kept", "kind-back"]);
    reopened.saw(&listed(&["kind-kept"]), day(111));
    reopened.flush().unwrap();
    drop(reopened);
    assert_eq!(ids(&reopen()), ["kind-kept"]);
}

fn forward(id: u32) -> crate::forward::SavedForward {
    crate::forward::SavedForward {
        id: twigo_ipc::ForwardId(id),
        target: twigo_ipc::ForwardTarget {
            space: "kind-a".to_owned(),
            gvr: twigo_ipc::Gvr {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
            },
            namespace: "shop".to_owned(),
            name: "api".to_owned(),
        },
        kind: "Pod".to_owned(),
        port: 8080,
        port_name: None,
        app_protocol: None,
        local: 8080,
        detour: false,
        runs: true,
    }
}

#[test]
fn the_webview_cannot_write_the_forwards_and_they_go_with_their_space() {
    let dir = tempfile::tempdir().unwrap();
    let (path, state) = store(&dir);
    state.open_space("kind-a");
    for entry in [
        entry(Some("kind-a"), FORWARDS, "{}"),
        entry(None, LAST_FORWARD, "7"),
    ] {
        let refused = state.set(vec![entry]).unwrap_err();
        assert!(matches!(refused, Error::Reserved(_)), "{refused:?}");
    }
    assert!(state.forwards("kind-a").forwards.is_empty());
    let refused = state
        .set_forwards("kind-absent", &crate::forward::Saved::default())
        .unwrap_err();
    assert!(matches!(refused, Error::NoSpace(_)));

    let saved = crate::forward::Saved {
        forwards: vec![forward(3)],
        ports: Vec::new(),
    };
    state.set_forwards("kind-a", &saved).unwrap();
    state.flush().unwrap();
    drop(state);
    let reopened = State::open_with(path.clone(), Duration::from_secs(3600));
    let kept = reopened.forwards("kind-a");
    assert_eq!(kept.forwards.len(), 1);
    assert_eq!(kept.forwards[0].id, twigo_ipc::ForwardId(3));
    assert!(
        !reopened.snapshot().spaces["kind-a"][FORWARDS].is_empty(),
        "the webview reads them"
    );

    let start = Timestamp::now();
    reopened.saw(&HashSet::new(), start);
    reopened.saw(
        &HashSet::new(),
        start + SignedDuration::from_hours(100 * 24),
    );
    reopened.flush().unwrap();
    drop(reopened);
    let dropped = State::open_with(path, Duration::from_secs(3600));
    assert!(dropped.spaces().is_empty());
    assert!(dropped.forwards("kind-a").forwards.is_empty());
}

#[test]
fn a_forward_id_is_never_given_twice_across_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let (path, state) = store(&dir);
    assert_eq!(state.next_forward_id(0), twigo_ipc::ForwardId(1));
    assert_eq!(state.next_forward_id(0), twigo_ipc::ForwardId(2));
    assert_eq!(
        state.next_forward_id(9),
        twigo_ipc::ForwardId(10),
        "past the ids the store holds"
    );
    state.flush().unwrap();
    drop(state);
    let reopened = State::open_with(path, Duration::from_secs(3600));
    assert_eq!(reopened.next_forward_id(0), twigo_ipc::ForwardId(11));
}

const KEPT: &str = include_str!("../../tests/kept/state.json");

fn target(resource: &str, group: &str, name: &str) -> twigo_ipc::ForwardTarget {
    twigo_ipc::ForwardTarget {
        space: "kind-a".to_owned(),
        gvr: twigo_ipc::Gvr {
            group: group.to_owned(),
            version: "v1".to_owned(),
            resource: resource.to_owned(),
        },
        namespace: "shop".to_owned(),
        name: name.to_owned(),
    }
}

fn kept_forwards() -> crate::forward::Saved {
    crate::forward::Saved {
        forwards: vec![crate::forward::SavedForward {
            id: twigo_ipc::ForwardId(3),
            target: target("deployments", "apps", "api"),
            kind: "Deployment".to_owned(),
            port: 8080,
            port_name: Some("http".to_owned()),
            app_protocol: None,
            local: 8080,
            detour: false,
            runs: true,
        }],
        ports: vec![crate::forward::Remembered {
            target: target("services", "", "web"),
            port: 80,
            local: 8081,
        }],
    }
}

const RECENT_API: &str = r#"[{"uri":"k8s://kind-b/apps/v1/deployments/shop/api","title":"api"}]"#;

#[test]
fn the_kept_state_reads_to_its_values_and_writes_back_to_its_bytes() {
    let saw: Timestamp = "2026-11-20T10:00:00Z".parse().unwrap();
    let since: Timestamp = "2026-11-01T08:00:00Z".parse().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("read.json");
    std::fs::write(&path, KEPT).unwrap();
    let read = State::open_with(path, Duration::from_secs(3600));
    let snapshot = read.snapshot();
    assert_eq!(snapshot.app["parts/sizes"], r#"{"sidebar":300}"#);
    assert_eq!(snapshot.app["window/zoom"], "1.1");
    assert_eq!(snapshot.spaces["kind-a"]["namespaces"], r#"["shop"]"#);
    assert_eq!(snapshot.spaces["kind-b"]["recent"], RECENT_API);
    let ids: Vec<String> = read.spaces().into_iter().map(|s| s.id).collect();
    assert_eq!(ids, ["kind-a", "kind-b"]);
    {
        let data = read.inner.lock();
        assert_eq!(data.file.saw, Some(saw));
        let missing: Vec<_> = data.file.spaces.iter().map(|s| s.missing_since).collect();
        assert_eq!(missing, [None, Some(since)]);
    }
    assert_eq!(read.forwards("kind-a"), kept_forwards());
    assert_eq!(read.next_forward_id(0), twigo_ipc::ForwardId(8));

    let path = dir.path().join("written.json");
    let written = State::open_with(path.clone(), Duration::from_secs(3600));
    written.open_space("kind-a");
    written.open_space("kind-b");
    written
        .set(vec![
            entry(None, "parts/sizes", r#"{"sidebar":300}"#),
            entry(None, "window/zoom", "1.1"),
            entry(Some("kind-a"), "namespaces", r#"["shop"]"#),
            entry(Some("kind-b"), "recent", RECENT_API),
        ])
        .unwrap();
    written.set_forwards("kind-a", &kept_forwards()).unwrap();
    assert_eq!(written.next_forward_id(6), twigo_ipc::ForwardId(7));
    let listed: HashSet<String> = HashSet::from(["kind-a".to_owned()]);
    written.saw(&listed, since);
    written.saw(&listed, saw);
    written.flush().unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), KEPT);
}
