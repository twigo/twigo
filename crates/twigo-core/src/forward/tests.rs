use std::ffi::OsString;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use tokio::net::TcpStream;
use twigo_env::ShellEnv;
use twigo_ipc::{Gvr, Mode, SetContextMode};

use super::*;
use crate::state::State;

const KUBECONFIG: &str = "
clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]
users: [{ name: u, user: {} }]
contexts:
- name: kind-plain
  context: { cluster: c, user: u }
";

fn forward_of(id: u32, port: u16, local: u16, runs: bool) -> SavedForward {
    SavedForward {
        id: ForwardId(id),
        target: target("kind-plain", "api"),
        kind: "Pod".to_owned(),
        port,
        port_name: None,
        local,
        runs,
    }
}

fn target(space: &str, name: &str) -> ForwardTarget {
    ForwardTarget {
        space: space.to_owned(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
        },
        namespace: "shop".to_owned(),
        name: name.to_owned(),
    }
}

fn free() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn keep(dir: &Path, saved: &Saved) {
    let state = State::open(dir.join("state.json"));
    state.open_space("kind-plain");
    state.set_forwards("kind-plain", saved).unwrap();
    state.flush().unwrap();
}

fn running(dir: &Path) -> Arc<Core> {
    let kubeconfig = dir.join("config");
    std::fs::write(&kubeconfig, KUBECONFIG).unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let (_status, followed) = watch::channel(twigo_env::Status::Resolved(Arc::new(
        ShellEnv::from_iter(std::iter::empty::<(OsString, OsString)>()),
    )));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.run(followed, Some(kubeconfig)).await }
    });
    core
}

fn listed(core: &Core) -> Vec<Forward> {
    core.follow_forwards("poll", |_| false)
}

async fn until<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let waited = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(found) = check() {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    waited
        .await
        .unwrap_or_else(|_| panic!("{what} within 10 s"))
}

async fn forward_state(core: &Core, id: u32) -> ForwardState {
    until("the forward is listed", || {
        listed(core)
            .into_iter()
            .find(|forward| forward.id == ForwardId(id))
            .map(|forward| forward.state)
    })
    .await
}

#[tokio::test]
async fn forwards_that_ran_listen_again_at_a_start_and_wait_for_their_first_connection() {
    let dir = tempfile::tempdir().unwrap();
    let (running_port, stopped_port) = (free(), free());
    let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let held_port = held.local_addr().unwrap().port();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![
                forward_of(1, 8080, running_port, true),
                forward_of(2, 9090, stopped_port, false),
                forward_of(3, 7070, held_port, true),
            ],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());

    forward_state(&core, 3).await;
    let forwards = listed(&core);
    assert_eq!(forwards.len(), 3);
    assert_eq!(forwards[0].state, ForwardState::Restored);
    assert_eq!(forwards[0].addresses[0], "127.0.0.1");
    assert_eq!(forwards[1].state, ForwardState::Stopped);
    assert_eq!(
        forwards[2].state,
        ForwardState::Failed {
            error: IpcError::new(
                ErrorKind::Conflict,
                format!("port {held_port} is held by another process")
            )
        }
    );
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", stopped_port)).is_ok(),
        "a stopped forward does not listen"
    );

    let _client = TcpStream::connect(("127.0.0.1", running_port))
        .await
        .expect("it listens");
    until("the first connection starts it", || {
        let now = listed(&core)[0].state.clone();
        (now != ForwardState::Restored).then_some(now)
    })
    .await;
}

#[tokio::test]
async fn the_clients_of_a_forwards_context_start_it_over() {
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    assert_eq!(forward_state(&core, 1).await, ForwardState::Restored);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        forward_state(&core, 1).await,
        ForwardState::Restored,
        "nothing asks for clients"
    );

    core.catalog.contexts().await;
    core.clients("kind-plain").await.unwrap();
    until("making the clients starts it", || {
        let now = listed(&core)[0].state.clone();
        (now != ForwardState::Restored).then_some(now)
    })
    .await;
}

#[tokio::test]
async fn a_forward_of_a_context_the_catalog_lacks_fails_naming_it() {
    let dir = tempfile::tempdir().unwrap();
    let state = State::open(dir.path().join("state.json"));
    state.open_space("kind-gone");
    let mut saved = forward_of(1, 8080, free(), true);
    saved.target = target("kind-gone", "api");
    state
        .set_forwards(
            "kind-gone",
            &Saved {
                forwards: vec![saved],
                ports: Vec::new(),
            },
        )
        .unwrap();
    state.flush().unwrap();
    drop(state);
    let core = running(dir.path());
    core.catalog.contexts().await;
    let failed = until("the forward fails", || {
        let now = listed(&core).first()?.state.clone();
        matches!(now, ForwardState::Failed { .. }).then_some(now)
    })
    .await;
    let ForwardState::Failed { error } = failed else {
        unreachable!("waited for");
    };
    assert_eq!(error.kind, ErrorKind::NotFound);
    assert_eq!(error.message, "no source lists the context \"kind-gone\"");
}

#[tokio::test]
async fn a_busy_port_answers_with_a_free_one_and_keeps_nothing() {
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running(dir.path());
    core.catalog.contexts().await;
    let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let held = taken.local_addr().unwrap().port();

    let answer = core
        .forward_start(StartForward {
            target: target("kind-plain", "api"),
            port: 8080,
            local: Some(held),
        })
        .await
        .unwrap();
    let ForwardStarted::Busy { local, why, free } = answer else {
        panic!("a port another process holds is busy: {answer:?}");
    };
    assert_eq!((local, why), (held, BusyWhy::InUse));
    assert!(free > held);
    assert!(std::net::TcpListener::bind(("127.0.0.1", free)).is_ok());
    assert!(listed(&core).is_empty());
    assert!(core.state.forwards("kind-plain").forwards.is_empty());
}

#[tokio::test]
async fn a_mode_that_refuses_forwards_refuses_a_start_before_it_binds_and_fails_the_running() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        r#"{"contexts": {"kind-other": "read-only"}, "readOnly": {"allowPortForward": false}}"#,
    )
    .unwrap();
    let local = free();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, local, true)],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    core.catalog.contexts().await;
    assert_eq!(forward_state(&core, 1).await, ForwardState::Restored);

    core.set_context_mode(SetContextMode {
        context: "kind-plain".to_owned(),
        mode: Some(Mode::ReadOnly),
    })
    .await
    .unwrap();
    let failed = until("the mode fails the forward", || {
        let now = listed(&core)[0].state.clone();
        matches!(now, ForwardState::Failed { .. }).then_some(now)
    })
    .await;
    let ForwardState::Failed { error } = failed else {
        unreachable!("waited for");
    };
    assert_eq!(error.kind, ErrorKind::Permissions);
    assert!(error.blocked.is_some());
    assert!(
        TcpStream::connect(("127.0.0.1", local)).await.is_ok(),
        "it keeps listening"
    );

    let free_port = free();
    let refused = core
        .forward_start(StartForward {
            target: target("kind-plain", "other"),
            port: 8080,
            local: Some(free_port),
        })
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Permissions);
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", free_port)).is_ok(),
        "nothing bound its port"
    );
    let refused = core
        .forward_resume(ResumeForward {
            id: ForwardId(1),
            local: None,
        })
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Permissions);

    core.set_context_mode(SetContextMode {
        context: "kind-plain".to_owned(),
        mode: Some(Mode::ReadWrite),
    })
    .await
    .unwrap();
    until("the mode lets it start over", || {
        let now = listed(&core)[0].state.clone();
        (!matches!(&now, ForwardState::Failed { error } if error.kind == ErrorKind::Permissions))
            .then_some(now)
    })
    .await;
}

#[tokio::test]
async fn a_stop_keeps_a_forward_a_remove_forgets_it_and_a_quit_changes_what_ran_in_neither() {
    let dir = tempfile::tempdir().unwrap();
    let (first, second) = (free(), free());
    let remembered = Remembered {
        target: target("kind-plain", "api"),
        port: 8080,
        local: 18080,
    };
    keep(
        dir.path(),
        &Saved {
            forwards: vec![
                forward_of(1, 8080, first, true),
                forward_of(2, 9090, second, true),
            ],
            ports: vec![remembered],
        },
    );
    let core = running(dir.path());
    assert_eq!(forward_state(&core, 1).await, ForwardState::Restored);
    let (events, seen) = mpsc::channel();
    let before = core.follow_forwards("main", move |event| events.send(event).is_ok());
    assert_eq!(before.len(), 2);

    core.forward_stop(ForwardId(1)).unwrap();
    let ForwardEvent::Changed { forward } = seen.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("a stop changes the forward");
    };
    assert_eq!(
        (forward.id, forward.state),
        (ForwardId(1), ForwardState::Stopped)
    );
    until("the port is released", || {
        std::net::TcpListener::bind(("127.0.0.1", first)).ok()
    })
    .await;
    assert!(!core.state.forwards("kind-plain").forwards[0].runs);

    core.forward_remove(ForwardId(1)).unwrap();
    let event = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(event, ForwardEvent::Removed { id } if id == ForwardId(1)));
    let kept = core.state.forwards("kind-plain");
    assert_eq!(kept.forwards.len(), 1);
    assert_eq!(kept.ports.len(), 1, "the port stays remembered");
    assert!(core.forward_stop(ForwardId(1)).is_err());

    core.shutdown();
    until("the port is released", || {
        std::net::TcpListener::bind(("127.0.0.1", second)).ok()
    })
    .await;
    assert!(core.state.forwards("kind-plain").forwards[0].runs);
    core.state.flush().unwrap();
    drop(core);
    let reopened = running(dir.path());
    assert_eq!(forward_state(&reopened, 2).await, ForwardState::Restored);
}

#[tokio::test]
async fn a_port_that_has_a_forward_answers_with_it_started_again_and_moved_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    let (first, second) = (free(), free());
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, first, false)],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    core.catalog.contexts().await;
    assert_eq!(forward_state(&core, 1).await, ForwardState::Stopped);
    let start = |local| StartForward {
        target: target("kind-plain", "api"),
        port: 8080,
        local,
    };

    let ForwardStarted::Started { forward } = core.forward_start(start(None)).await.unwrap() else {
        panic!("a stopped forward starts again");
    };
    assert_eq!((forward.id, forward.local), (ForwardId(1), first));
    assert!(TcpStream::connect(("127.0.0.1", first)).await.is_ok());
    assert_eq!(listed(&core).len(), 1, "no second forward");
    assert!(core.state.forwards("kind-plain").forwards[0].runs);

    let ForwardStarted::Started { forward } =
        core.forward_start(start(Some(second))).await.unwrap()
    else {
        panic!("a forward moves");
    };
    assert_eq!((forward.id, forward.local), (ForwardId(1), second));
    assert!(TcpStream::connect(("127.0.0.1", second)).await.is_ok());
    until("the first port is released", || {
        std::net::TcpListener::bind(("127.0.0.1", first)).ok()
    })
    .await;
    assert_eq!(core.state.forwards("kind-plain").forwards[0].local, second);
    assert_eq!(
        core.state.forwards("kind-plain").ports[0].local,
        second,
        "the port it ended on is the one remembered"
    );

    let _held = std::net::TcpListener::bind(("127.0.0.1", first)).unwrap();
    let busy = core.forward_start(start(Some(first))).await.unwrap();
    assert!(matches!(
        busy,
        ForwardStarted::Busy {
            why: BusyWhy::InUse,
            ..
        }
    ));
    assert_eq!(listed(&core)[0].local, second, "it stays where it was");
}

#[tokio::test]
async fn a_later_follower_of_a_window_replaces_the_earlier() {
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    assert_eq!(forward_state(&core, 1).await, ForwardState::Restored);
    let (earlier, earlier_sees) = mpsc::channel();
    let (later, later_sees) = mpsc::channel();
    core.follow_forwards("main", move |event| earlier.send(event).is_ok());
    let current = core.follow_forwards("main", move |event| later.send(event).is_ok());
    assert_eq!(current.len(), 1);

    core.forward_stop(ForwardId(1)).unwrap();
    assert!(matches!(
        later_sees.recv_timeout(Duration::from_secs(5)).unwrap(),
        ForwardEvent::Changed { .. }
    ));
    assert!(earlier_sees.try_recv().is_err());

    core.drop_window("main");
    core.forward_remove(ForwardId(1)).unwrap();
    assert!(later_sees.recv_timeout(Duration::from_millis(200)).is_err());
}

#[test]
fn a_detour_is_not_remembered_and_any_other_start_is() {
    let mut table = Table::default();
    let target = target("kind-plain", "api");
    let key = Key::of(&target, 8080);

    table.detours.insert(key.clone(), 8081);
    table.remember(&key, &target, 8081);
    assert!(table.remembered.is_empty());
    assert!(table.detours.is_empty());

    table.remember(&key, &target, 9000);
    assert_eq!(table.remembered[&key].local, 9000);
    table.detours.insert(key.clone(), 8081);
    table.remember(&key, &target, 9001);
    assert_eq!(table.remembered[&key].local, 9001, "not the offered port");
}

fn status(sent: u64, state: ForwardState) -> data::Status {
    data::Status {
        state,
        pod: None,
        pod_port: None,
        connections: 0,
        queued: 0,
        sent,
        received: 0,
        failure: None,
    }
}

fn shown() -> Forward {
    Forward {
        id: ForwardId(1),
        target: target("kind-plain", "api"),
        kind: "Pod".to_owned(),
        port: 8080,
        port_name: None,
        local: 8080,
        addresses: vec!["127.0.0.1".to_owned()],
        state: ForwardState::Stopped,
        pod: None,
        pod_port: None,
        connections: 0,
        queued: 0,
        sent: 0,
        received: 0,
        failure: None,
    }
}

#[tokio::test(start_paused = true)]
async fn a_forward_goes_out_at_most_four_times_a_second_but_a_change_of_state_at_once() {
    let (tell, status_rx) = watch::channel(status(0, ForwardState::Starting));
    let sent = Arc::new(Mutex::new(Vec::<(Duration, Forward)>::new()));
    let began = Instant::now();
    tokio::spawn(pump(status_rx, shown(), {
        let sent = Arc::clone(&sent);
        move |forward| sent.lock().unwrap().push((began.elapsed(), forward))
    }));
    for bytes in 1..=100 {
        tell.send_modify(|status| status.sent = bytes);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    {
        let sent = sent.lock().unwrap();
        let times: Vec<_> = sent.iter().map(|(at, _)| at.as_millis()).collect();
        assert_eq!(times, [250, 500, 750, 1000], "{times:?}");
        assert_eq!(sent.last().unwrap().1.sent, 100, "the latest goes out");
    }

    tell.send_modify(|status| status.sent = 101);
    tokio::time::sleep(Duration::from_millis(10)).await;
    tell.send_modify(|status| status.state = ForwardState::Ready);
    tokio::time::sleep(Duration::from_millis(1)).await;
    let sent = sent.lock().unwrap();
    let (at, last) = sent.last().unwrap();
    assert_eq!(last.state, ForwardState::Ready);
    assert!(
        *at - sent[sent.len() - 2].0 < Duration::from_millis(250),
        "a state goes out inside the window of the last"
    );
}
