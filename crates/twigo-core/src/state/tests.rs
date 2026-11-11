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
        let state = State::open(path.clone());
        assert!(state.snapshot().app.is_empty());
        assert!(!path.exists());
        let aside = dir.path().join("state.json.unreadable");
        assert_eq!(std::fs::read_to_string(aside).unwrap(), content);
    }
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

#[test]
fn the_webview_cannot_write_the_contexts_modes() {
    let dir = tempfile::tempdir().unwrap();
    let state = State::open(dir.path().join("state.json"));
    let refused = state
        .set(vec![StateEntry {
            space: None,
            key: CHOICES.to_owned(),
            value: r#"{"modes": {"prod": "read-write"}}"#.to_owned(),
        }])
        .unwrap_err();
    assert!(matches!(refused, Error::Reserved(_)));
    assert_eq!(state.choices().modes.len(), 0);

    let mut choices = Choices::default();
    choices
        .modes
        .insert("prod".to_owned(), twigo_ipc::Mode::ReadOnly);
    state.set_choices(&choices);
    state.flush().unwrap();
    let reopened = State::open(dir.path().join("state.json"));
    assert_eq!(
        reopened.choices().modes.get("prod"),
        Some(&twigo_ipc::Mode::ReadOnly)
    );
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
        local: 8080,
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
