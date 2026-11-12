use std::ffi::OsString;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{OnceLock, mpsc};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
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
        app_protocol: None,
        local,
        detour: false,
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

const FIRST_STRETCH: u16 = 10_000;
const SLOTS: u16 = 2_200;
const STRETCH: u16 = SLOTS + 400;
const STRETCHES: u16 = 8;

/// The ports this process hands out: a stretch that no other run holds, which
/// it claims by holding a listener on the stretch's first port for its life,
/// the next stretch when that bind fails. Not ports the system hands out by
/// itself (port 0): it hands those to other sockets too, on macOS in
/// sequence, so another could take one before the test binds it.
fn stretch() -> u16 {
    static CLAIMED: OnceLock<(u16, std::net::TcpListener)> = OnceLock::new();
    CLAIMED
        .get_or_init(|| {
            let first = u16::try_from(std::process::id() % u32::from(STRETCHES)).unwrap();
            (0..STRETCHES)
                .map(|step| FIRST_STRETCH + STRETCH * ((first + step) % STRETCHES))
                .find_map(|base| {
                    Some((base, std::net::TcpListener::bind(("127.0.0.1", base)).ok()?))
                })
                .expect("a stretch of ports that no other run holds")
        })
        .0
}

/// Whether something accepts connections on `port`, or would: a full backlog
/// drops the connection silently. Found by connecting and never by binding:
/// on macOS a child that another thread spawns holds a copy of every
/// descriptor of this process until its program starts, so a port whose
/// listener was just closed is in use for that moment.
fn listening(port: u16) -> bool {
    [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ]
    .into_iter()
    .any(|address| {
        let connected = std::net::TcpStream::connect_timeout(
            &SocketAddr::new(address, port),
            Duration::from_millis(250),
        );
        match connected {
            Ok(_) => true,
            Err(error) => matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ),
        }
    })
}

fn port_at(next: &AtomicU16, from: u16, step: u16, end: u16) -> u16 {
    loop {
        let offset = from + step * next.fetch_add(1, Ordering::Relaxed);
        assert!(offset < end, "the tests' ports are used up");
        let port = stretch() + offset;
        if !listening(port) {
            return port;
        }
    }
}

/// A port nothing listens on, which no other test of this process gets: one
/// in four, so that the next free one above it is free too.
fn free() -> u16 {
    static NEXT: AtomicU16 = AtomicU16::new(0);
    port_at(&NEXT, 4, 4, SLOTS)
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

const POD: &str = r#"{"kind":"Pod","apiVersion":"v1","metadata":{"name":"api","namespace":"shop","uid":"u1","resourceVersion":"1"},"spec":{"containers":[{"name":"app","ports":[{"name":"http","containerPort":8080}]}]},"status":{"phase":"Running"}}"#;
const LIST: &str =
    r#"{"kind":"PodList","apiVersion":"v1","metadata":{"resourceVersion":"1"},"items":[]}"#;
const POD_LIST: &str = r#"{"kind":"PodList","apiVersion":"v1","metadata":{"resourceVersion":"1"},"items":[{"kind":"Pod","apiVersion":"v1","metadata":{"name":"api","namespace":"shop","uid":"u1","resourceVersion":"1"},"spec":{"containers":[{"name":"app","ports":[{"name":"http","containerPort":8080}]}]},"status":{"phase":"Running"}}]}"#;
const STREAMING_REFUSED: &str = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Invalid","code":422,"message":"sendInitialEvents is forbidden","details":{"causes":[{"reason":"FieldValueForbidden","field":"sendInitialEvents"}]}}"#;
const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

async fn frame(socket: &mut TcpStream) -> Option<(u8, Vec<u8>)> {
    let mut head = [0; 2];
    socket.read_exact(&mut head).await.ok()?;
    let mut len = usize::from(head[1] & 0x7f);
    if len == 126 {
        let mut extra = [0; 2];
        socket.read_exact(&mut extra).await.ok()?;
        len = usize::from(u16::from_be_bytes(extra));
    }
    let mut mask = [0; 4];
    if head[1] & 0x80 != 0 {
        socket.read_exact(&mut mask).await.ok()?;
    }
    let mut payload = vec![0; len];
    socket.read_exact(&mut payload).await.ok()?;
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    Some((head[0] & 0x0f, payload))
}

async fn send(socket: &mut TcpStream, payload: &[u8]) {
    let mut message = vec![0x82, u8::try_from(payload.len()).unwrap()];
    message.extend_from_slice(payload);
    socket.write_all(&message).await.unwrap();
}

async fn echo(mut socket: TcpStream, head: &str) {
    let key = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("sec-websocket-key")
                .then(|| value.trim().to_owned())
        })
        .unwrap();
    let port: u16 = head
        .split("ports=")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .unwrap()
        .parse()
        .unwrap();
    let digest = ring::digest::digest(
        &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
        format!("{key}{WEBSOCKET_GUID}").as_bytes(),
    );
    let accept = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, digest);
    let answer = format!(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\nsec-websocket-protocol: v4.channel.k8s.io\r\n\r\n"
    );
    socket.write_all(answer.as_bytes()).await.unwrap();
    let [low, high] = port.to_le_bytes();
    for channel in [0, 1] {
        send(&mut socket, &[channel, low, high]).await;
    }
    while let Some((opcode, payload)) = frame(&mut socket).await {
        match (opcode, payload.split_first()) {
            (2, Some((0, data))) => send(&mut socket, &[&[0][..], data].concat()).await,
            (8, _) => return,
            _ => {}
        }
    }
}

struct Api {
    port: u16,
    reads: Arc<AtomicUsize>,
    requests: Arc<AtomicUsize>,
    release: Arc<Notify>,
    upgrades: Arc<AtomicU16>,
}

impl Api {
    async fn start(hold: bool) -> Self {
        Self::start_with(hold, false).await
    }

    async fn serving_pod() -> Self {
        Self::start_with(false, true).await
    }

    async fn start_with(hold: bool, data: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let reads = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Notify::new());
        let upgrades = Arc::new(AtomicU16::new(0));
        tokio::spawn({
            let (reads, requests, release, upgrades) = (
                Arc::clone(&reads),
                Arc::clone(&requests),
                Arc::clone(&release),
                Arc::clone(&upgrades),
            );
            async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let (reads, requests, release, upgrades) = (
                        Arc::clone(&reads),
                        Arc::clone(&requests),
                        Arc::clone(&release),
                        Arc::clone(&upgrades),
                    );
                    tokio::spawn(async move {
                        let mut seen = Vec::new();
                        let mut buffer = [0; 4096];
                        loop {
                            while !seen.windows(4).any(|window| window == b"\r\n\r\n") {
                                let Ok(read @ 1..) = socket.read(&mut buffer).await else {
                                    return;
                                };
                                seen.extend_from_slice(&buffer[..read]);
                            }
                            let end = seen.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
                            let head = String::from_utf8_lossy(&seen[..end]).into_owned();
                            seen.drain(..end);
                            requests.fetch_add(1, Ordering::SeqCst);
                            let path = head.split_whitespace().nth(1).unwrap_or_default();
                            let refused = upgrades.load(Ordering::SeqCst);
                            if data && path.contains("/portforward") && refused != 0 {
                                let status = format!(
                                    r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"refused with {refused}","code":{refused}}}"#
                                );
                                let answer = format!(
                                    "HTTP/1.1 {refused} Refused\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{status}",
                                    status.len()
                                );
                                if socket.write_all(answer.as_bytes()).await.is_err() {
                                    return;
                                }
                                continue;
                            }
                            if data && path.contains("/portforward") {
                                echo(socket, &head).await;
                                return;
                            }
                            if data && path.contains("watch=true") {
                                if path.contains("sendInitialEvents") {
                                    let refusal = format!(
                                        "HTTP/1.1 422 Unprocessable Entity\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{STREAMING_REFUSED}",
                                        STREAMING_REFUSED.len()
                                    );
                                    socket.write_all(refusal.as_bytes()).await.unwrap();
                                    continue;
                                }
                                let head = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n";
                                socket.write_all(head.as_bytes()).await.unwrap();
                                std::future::pending::<()>().await;
                            }
                            let body = if path.ends_with("/pods/api") {
                                if reads.fetch_add(1, Ordering::SeqCst) == 0 && hold {
                                    release.notified().await;
                                }
                                POD
                            } else if data && path.split('?').next().unwrap().ends_with("/pods") {
                                POD_LIST
                            } else {
                                LIST
                            };
                            let answer = format!(
                                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                                body.len()
                            );
                            if socket.write_all(answer.as_bytes()).await.is_err() {
                                return;
                            }
                        }
                    });
                }
            }
        });
        Self {
            port,
            reads,
            requests,
            release,
            upgrades,
        }
    }

    fn refuse_upgrades(&self, code: u16) {
        self.upgrades.store(code, Ordering::SeqCst);
    }

    async fn reached(&self) {
        while self.reads.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn running_over(dir: &Path, api: &Api) -> Arc<Core> {
    let kubeconfig = dir.join("config");
    std::fs::write(
        &kubeconfig,
        KUBECONFIG.replace("127.0.0.1:1", &format!("127.0.0.1:{}", api.port)),
    )
    .unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let (_status, followed) = watch::channel(twigo_env::Status::Resolved(Arc::new(
        ShellEnv::from_iter(std::iter::empty::<(OsString, OsString)>()),
    )));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            let _status = _status;
            core.run(followed, Some(kubeconfig)).await
        }
    });
    core
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
async fn a_forward_keeps_its_ports_app_protocol_across_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut saved = forward_of(1, 8080, free(), false);
    saved.app_protocol = Some("kubernetes.io/h2c".to_owned());
    keep(
        dir.path(),
        &Saved {
            forwards: vec![saved],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    forward_state(&core, 1).await;
    assert_eq!(
        listed(&core)[0].app_protocol.as_deref(),
        Some("kubernetes.io/h2c")
    );
    core.forward_stop(ForwardId(1)).await.unwrap();
    assert_eq!(
        core.state.forwards("kind-plain").forwards[0]
            .app_protocol
            .as_deref(),
        Some("kubernetes.io/h2c")
    );
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
    let api = Api::start(false).await;
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    let taken = std::net::TcpListener::bind(("127.0.0.1", free())).unwrap();
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
    tokio::time::sleep(Duration::from_millis(100)).await;

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
    until("the mode lets it go back to waiting", || {
        let now = listed(&core)[0].state.clone();
        (now == ForwardState::Restored).then_some(now)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        listed(&core)[0].state,
        ForwardState::Restored,
        "it asked no cluster"
    );
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

    core.forward_stop(ForwardId(1)).await.unwrap();
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

    core.forward_remove(ForwardId(1)).await.unwrap();
    let event = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(event, ForwardEvent::Removed { id } if id == ForwardId(1)));
    let kept = core.state.forwards("kind-plain");
    assert_eq!(kept.forwards.len(), 1);
    assert_eq!(kept.ports.len(), 1, "the port stays remembered");
    assert!(core.forward_stop(ForwardId(1)).await.is_err());

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
    assert!(
        TcpStream::connect(("127.0.0.1", second)).await.is_ok(),
        "and keeps accepting there"
    );
}

#[tokio::test]
async fn a_resume_leaves_a_forward_that_waits_for_its_first_connection_as_it_is() {
    let dir = tempfile::tempdir().unwrap();
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

    let ForwardStarted::Started { forward } = core
        .forward_resume(ResumeForward {
            id: ForwardId(1),
            local: None,
        })
        .await
        .unwrap()
    else {
        panic!("a resume answers with the forward");
    };
    assert_eq!(forward.state, ForwardState::Restored);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        forward_state(&core, 1).await,
        ForwardState::Restored,
        "nothing asked its cluster"
    );
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

    core.forward_stop(ForwardId(1)).await.unwrap();
    assert!(matches!(
        later_sees.recv_timeout(Duration::from_secs(5)).unwrap(),
        ForwardEvent::Changed { .. }
    ));
    assert!(earlier_sees.try_recv().is_err());

    core.drop_window("main");
    core.forward_remove(ForwardId(1)).await.unwrap();
    assert!(later_sees.recv_timeout(Duration::from_millis(200)).is_err());
}

#[tokio::test]
async fn a_mode_that_turns_while_a_start_reads_its_target_refuses_the_start_and_makes_no_forward() {
    let api = Api::start(true).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        r#"{"readOnly": {"allowPortForward": false}}"#,
    )
    .unwrap();
    keep(dir.path(), &Saved::default());
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    let local = free();
    let starting = start_of(&core, Some(local));
    api.reached().await;
    set_the_mode(&core, Mode::ReadOnly).await;
    api.release.notify_one();
    let refused = starting.await.unwrap().unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Permissions);
    assert!(refused.blocked.is_some());
    assert!(listed(&core).is_empty());
    assert!(core.state.forwards("kind-plain").forwards.is_empty());
    assert!(std::net::TcpListener::bind(("127.0.0.1", local)).is_ok());

    set_the_mode(&core, Mode::ReadWrite).await;
    let made = started(start_of(&core, Some(free())).await);
    assert_eq!(made.id, ForwardId(1), "the refused start took no id");
}

#[tokio::test]
async fn a_forward_on_a_detour_is_never_remembered_not_even_by_a_stop_and_a_resume() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    let taken = std::net::TcpListener::bind(("127.0.0.1", free())).unwrap();
    let held = taken.local_addr().unwrap().port();
    let start = |local| StartForward {
        target: target("kind-plain", "api"),
        port: 8080,
        local: Some(local),
    };

    let ForwardStarted::Busy { free, .. } = core.forward_start(start(held)).await.unwrap() else {
        panic!("a port another process holds is busy");
    };
    let ForwardStarted::Started { forward } = core.forward_start(start(free)).await.unwrap() else {
        panic!("the free port starts");
    };
    core.forward_stop(forward.id).await.unwrap();
    core.forward_resume(ResumeForward {
        id: forward.id,
        local: None,
    })
    .await
    .unwrap();
    let kept = core.state.forwards("kind-plain");
    assert!(kept.ports.is_empty(), "{:?}", kept.ports);
    assert!(kept.forwards[0].detour);

    core.forward_remove(forward.id).await.unwrap();
    let ports = core
        .forward_ports(target("kind-plain", "api"))
        .await
        .unwrap();
    assert_eq!(ports.ports[0].local, 8080);
}

#[tokio::test]
async fn port_0_is_not_a_local_port_to_start_or_resume_on() {
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), false)],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    core.catalog.contexts().await;
    assert_eq!(forward_state(&core, 1).await, ForwardState::Stopped);

    let refused = core
        .forward_start(StartForward {
            target: target("kind-plain", "other"),
            port: 8080,
            local: Some(0),
        })
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    let refused = core
        .forward_resume(ResumeForward {
            id: ForwardId(1),
            local: Some(0),
        })
        .await
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidInput);
    assert_eq!(listed(&core)[0].state, ForwardState::Stopped);
}

#[tokio::test]
async fn a_forward_goes_back_to_waiting_when_its_context_is_back_in_the_catalog() {
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

    std::fs::write(dir.path().join("config"), "contexts: []").unwrap();
    let failed = until("the catalog loses the context", || {
        let now = listed(&core)[0].state.clone();
        matches!(now, ForwardState::Failed { .. }).then_some(now)
    })
    .await;
    let ForwardState::Failed { error } = failed else {
        unreachable!("waited for");
    };
    assert_eq!(error.message, "no source lists the context \"kind-plain\"");

    std::fs::write(dir.path().join("config"), KUBECONFIG).unwrap();
    until("the catalog has it again", || {
        let now = listed(&core)[0].state.clone();
        (now == ForwardState::Restored).then_some(now)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(listed(&core)[0].state, ForwardState::Restored);
}

const NO_SOURCE: &str = "no source lists the context \"kind-plain\"";

fn failed_with(core: &Core, wanted: impl Fn(&IpcError) -> bool) -> Option<ForwardState> {
    let now = listed(core).first()?.state.clone();
    matches!(&now, ForwardState::Failed { error } if wanted(error)).then_some(now)
}

fn lose_the_context(dir: &Path) {
    std::fs::write(dir.join("config"), "contexts: []").unwrap();
}

fn find_the_context(dir: &Path) {
    std::fs::write(dir.join("config"), KUBECONFIG).unwrap();
}

async fn stays_restored(core: &Core) {
    until("it is restored", || {
        (listed(core)[0].state == ForwardState::Restored).then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(listed(core)[0].state, ForwardState::Restored);
}

async fn restored_without_its_context(dir: &Path) -> Arc<Core> {
    keep(
        dir,
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = running(dir);
    assert_eq!(forward_state(&core, 1).await, ForwardState::Restored);
    lose_the_context(dir);
    until("the catalog loses the context", || {
        failed_with(&core, |error| error.message == NO_SOURCE)
    })
    .await;
    core
}

#[tokio::test]
async fn a_resume_and_a_move_while_the_catalog_lacks_the_context_answer_the_refusal_and_the_forward_waits_after()
 {
    let dir = tempfile::tempdir().unwrap();
    let core = restored_without_its_context(dir.path()).await;
    let (events, seen) = mpsc::channel();
    core.follow_forwards("main", move |event| events.send(event).is_ok());
    let local = listed(&core)[0].local;

    let refused = core
        .forward_resume(ResumeForward {
            id: ForwardId(1),
            local: None,
        })
        .await
        .unwrap_err();
    assert_eq!(refused.message, NO_SOURCE);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(failed_with(&core, |error| error.message == NO_SOURCE).is_some());

    let moved = free();
    let refused = core
        .forward_resume(ResumeForward {
            id: ForwardId(1),
            local: Some(moved),
        })
        .await
        .unwrap_err();
    assert_eq!(refused.message, NO_SOURCE);
    assert_eq!(listed(&core)[0].local, local);
    assert!(std::net::TcpListener::bind(("127.0.0.1", moved)).is_ok());
    assert!(TcpStream::connect(("127.0.0.1", local)).await.is_ok());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(failed_with(&core, |error| error.message == NO_SOURCE).is_some());
    let states = states_of(&seen);
    assert!(!states.contains(&ForwardState::Starting), "{states:?}");

    find_the_context(dir.path());
    stays_restored(&core).await;
}

async fn without_its_context_and_not_yet_checked(dir: &Path) -> Arc<Core> {
    keep(
        dir,
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    std::fs::write(dir.join("config"), KUBECONFIG).unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    core.catalog.follow(crate::catalog::sources(
        Some(dir.join("config")),
        None,
        None,
    ));
    core.catalog.contexts().await;
    core.restore_forwards().await;
    assert_eq!(listed(&core)[0].state, ForwardState::Restored);
    lose_the_context(dir);
    until("the catalog loses the context", || {
        let catalog = core.catalog.subscribe();
        let lacks = catalog
            .borrow()
            .as_deref()
            .is_some_and(|contexts| contexts.find("kind-plain").is_none());
        lacks.then_some(())
    })
    .await;
    core
}

#[tokio::test]
async fn a_resume_and_a_move_ask_the_catalog_themselves_whether_the_forward_may_run() {
    let dir = tempfile::tempdir().unwrap();
    let core = without_its_context_and_not_yet_checked(dir.path()).await;
    assert_eq!(listed(&core)[0].state, ForwardState::Restored);
    let local = listed(&core)[0].local;

    let refused = core
        .forward_resume(ResumeForward {
            id: ForwardId(1),
            local: None,
        })
        .await
        .unwrap_err();
    assert_eq!(refused.message, NO_SOURCE);
    assert_eq!(listed(&core)[0].state, ForwardState::Restored);

    let refused = core
        .forward_resume(ResumeForward {
            id: ForwardId(1),
            local: Some(free()),
        })
        .await
        .unwrap_err();
    assert_eq!(refused.message, NO_SOURCE);
    assert_eq!(listed(&core)[0].local, local);
    assert_eq!(listed(&core)[0].state, ForwardState::Restored);
}

#[tokio::test]
async fn a_move_of_a_forward_that_waits_leaves_it_waiting_on_the_new_port_and_asks_nobody() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    let (first, second) = (free(), free());
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, first, true)],
            ports: Vec::new(),
        },
    );
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    assert_eq!(forward_state(&core, 1).await, ForwardState::Restored);

    let ForwardStarted::Started { forward } = core
        .forward_resume(ResumeForward {
            id: ForwardId(1),
            local: Some(second),
        })
        .await
        .unwrap()
    else {
        panic!("a move answers with the forward");
    };
    assert_eq!(
        (forward.state, forward.local),
        (ForwardState::Restored, second)
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(listed(&core)[0].state, ForwardState::Restored);
    assert_eq!(api.requests.load(Ordering::SeqCst), 0, "nobody was asked");
    assert!(TcpStream::connect(("127.0.0.1", second)).await.is_ok());
}

#[tokio::test]
async fn a_forward_restored_under_a_refusal_is_failed_from_its_first_instant_and_the_clients_leave_it_so()
 {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        r#"{"contexts": {"kind-plain": "read-only"}, "readOnly": {"allowPortForward": false}}"#,
    )
    .unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    std::fs::write(dir.path().join("config"), KUBECONFIG).unwrap();
    core.catalog.follow(crate::catalog::sources(
        Some(dir.path().join("config")),
        None,
        None,
    ));
    core.catalog.contexts().await;
    core.restore_forwards().await;
    assert!(
        failed_with(&core, |error| error.kind == ErrorKind::Permissions).is_some(),
        "{:?}",
        listed(&core)[0].state
    );
    let mut client = TcpStream::connect(("127.0.0.1", listed(&core)[0].local))
        .await
        .unwrap();
    let mut left = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut left))
        .await
        .expect("what it accepts is closed")
        .unwrap();

    core.forwards.recheck();
    core.forwards.connected("kind-plain");
    until("the policy fails the forward", || {
        failed_with(&core, |error| error.kind == ErrorKind::Permissions)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        failed_with(&core, |error| error.kind == ErrorKind::Permissions).is_some(),
        "the clients did not start it: {:?}",
        listed(&core)[0].state
    );
}

#[tokio::test]
async fn the_refusal_s_words_follow_a_change_of_cause() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        r#"{"contexts": {"kind-plain": "read-only"}, "readOnly": {"allowPortForward": false}}"#,
    )
    .unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    until("the mode refuses it", || {
        failed_with(&core, |error| error.kind == ErrorKind::Permissions)
    })
    .await;

    lose_the_context(dir.path());
    until("the words name the context", || {
        failed_with(&core, |error| error.message == NO_SOURCE)
    })
    .await;

    find_the_context(dir.path());
    until("the words name the mode again", || {
        failed_with(&core, |error| error.kind == ErrorKind::Permissions)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_state_keeps_what_the_table_holds_when_two_commands_race() {
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running(dir.path());
    core.catalog.contexts().await;
    for round in 0..2_000u32 {
        {
            let mut table = core.forwards.table();
            for id in [2 * round + 1, 2 * round + 2] {
                let mut base = shown();
                base.id = ForwardId(id);
                base.port = u16::try_from(id % 60_000).unwrap();
                table.entries.insert(
                    id,
                    Entry {
                        base,
                        context: "kind-plain".to_owned(),
                        run: None,
                        unbound: None,
                        refused: None,
                        detour: false,
                    },
                );
            }
        }
        core.save_forwards("kind-plain");
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let removes: Vec<_> = [2 * round + 1, 2 * round + 2]
            .into_iter()
            .map(|id| {
                let (core, barrier) = (Arc::clone(&core), Arc::clone(&barrier));
                tokio::spawn(async move {
                    barrier.wait().await;
                    core.forward_remove(ForwardId(id)).await.unwrap();
                })
            })
            .collect();
        for remove in removes {
            remove.await.unwrap();
        }
        let kept = core.state.forwards("kind-plain").forwards.len();
        assert_eq!(
            kept, 0,
            "round {round}: the state kept a forward the table has not"
        );
    }
}

async fn a_forward_that_carried_bytes() -> (tempfile::TempDir, Arc<Core>, Forward, u16) {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    let local = free();
    let ForwardStarted::Started { forward } = core
        .forward_start(StartForward {
            target: target("kind-plain", "api"),
            port: 8080,
            local: Some(local),
        })
        .await
        .unwrap()
    else {
        panic!("a free port starts");
    };
    until("the forward is ready", || {
        (listed(&core)[0].state == ForwardState::Ready).then_some(())
    })
    .await;
    let mut client = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
    client.write_all(b"hello").await.unwrap();
    let mut echoed = [0; 5];
    client.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"hello");
    (dir, core, *forward, local)
}

#[tokio::test]
async fn a_stop_keeps_the_bytes_the_forward_carried() {
    let (_dir, core, forward, _local) = a_forward_that_carried_bytes().await;

    core.forward_stop(forward.id).await.unwrap();
    let stopped = &listed(&core)[0];
    assert_eq!((stopped.sent, stopped.received), (5, 5));

    core.forward_resume(ResumeForward {
        id: forward.id,
        local: None,
    })
    .await
    .unwrap();
    let resumed = &listed(&core)[0];
    assert_eq!((resumed.sent, resumed.received), (5, 5));
}

fn a_run(core: &Core, id: u32, local: u16, listeners: Listeners) -> (Forward, Run) {
    let mut base = shown();
    base.id = ForwardId(id);
    base.local = local;
    let run = core
        .forwards
        .run(
            "kind-plain",
            &base,
            listeners,
            data::Begin::Restored,
            core.hub.clone(),
        )
        .unwrap();
    (base, run)
}

#[tokio::test]
async fn a_run_the_forward_has_left_says_nothing_older_after_a_stop_and_nothing_after_a_remove() {
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running(dir.path());
    core.catalog.contexts().await;
    let local = free();
    let (base, run) = a_run(&core, 7, local, listen(local).await.unwrap());
    core.forwards.table().entries.insert(
        7,
        Entry {
            base,
            context: "kind-plain".to_owned(),
            run: Some(run),
            unbound: None,
            refused: None,
            detour: false,
        },
    );
    let (events, seen) = mpsc::channel();
    core.follow_forwards("main", move |event| events.send(event).is_ok());
    let old = core
        .forwards
        .table()
        .entries
        .get_mut(&7)
        .unwrap()
        .run
        .take();
    tokio::task::yield_now().await;

    old.as_ref().unwrap().data.connected();
    tokio::time::sleep(Duration::from_millis(400)).await;
    while let Ok(event) = seen.try_recv() {
        let ForwardEvent::Changed { forward } = event else {
            panic!("nothing was removed yet");
        };
        assert_eq!(forward.state, ForwardState::Stopped, "not the old run's");
    }

    core.forward_remove(ForwardId(7)).await.unwrap();
    assert!(matches!(
        seen.try_recv(),
        Ok(ForwardEvent::Removed { id }) if id == ForwardId(7)
    ));
    old.as_ref()
        .unwrap()
        .data
        .refuse(IpcError::new(ErrorKind::Permissions, "refused"));
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(seen.try_recv().is_err(), "nothing after the remove");
}

#[tokio::test]
async fn a_follower_that_came_before_the_restore_learns_of_the_forwards() {
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![
                forward_of(1, 8080, free(), true),
                forward_of(2, 9090, free(), false),
            ],
            ports: Vec::new(),
        },
    );
    let kubeconfig = dir.path().join("config");
    std::fs::write(&kubeconfig, KUBECONFIG).unwrap();
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let (events, seen) = mpsc::channel();
    let before = core.follow_forwards("main", move |event| events.send(event).is_ok());
    assert!(before.is_empty());
    let (_status, followed) = watch::channel(twigo_env::Status::Resolved(Arc::new(
        ShellEnv::from_iter(std::iter::empty::<(OsString, OsString)>()),
    )));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            let _status = _status;
            core.run(followed, Some(kubeconfig)).await
        }
    });

    let mut learned = Vec::new();
    until("both forwards are announced", || {
        while let Ok(ForwardEvent::Changed { forward }) = seen.try_recv() {
            learned.push(forward.id.0);
        }
        (learned.contains(&1) && learned.contains(&2)).then_some(())
    })
    .await;
}

#[tokio::test]
async fn a_forward_whose_port_another_forward_of_twigo_holds_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let local = free();
    let mut second = forward_of(2, 9090, local, true);
    second.target = target("kind-plain", "db");
    second.kind = "Pod".to_owned();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, local, true), second],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    let failed = until("the second forward fails", || {
        let now = listed(&core).get(1)?.state.clone();
        matches!(now, ForwardState::Failed { .. }).then_some(now)
    })
    .await;
    let ForwardState::Failed { error } = failed else {
        unreachable!("waited for");
    };
    assert_eq!(
        error.message,
        format!("port {local} is held by another forward of Twigo, to Pod api")
    );
}

#[test]
fn a_forward_shows_the_bytes_of_its_earlier_runs_and_of_the_one_it_has() {
    let mut forward = shown();
    forward.sent = 100;
    forward.received = 7;
    apply(&mut forward, &status(5, ForwardState::Ready));
    assert_eq!((forward.sent, forward.received), (105, 7));
}

#[test]
fn a_port_is_a_detour_only_when_it_is_the_one_offered_for_that_port() {
    let mut table = Table::default();
    let target = target("kind-plain", "api");
    let key = Key::of(&target, 8080);

    table.detours.insert(key.clone(), 8081);
    assert!(!table.detour(&key, 9000));
    assert!(table.detours.is_empty(), "an offer is taken once");
    table.detours.insert(key.clone(), 8081);
    assert!(table.detour(&key, 8081));
}

#[test]
fn a_port_with_a_forward_shows_the_forwards_local_port_and_any_other_the_one_a_start_takes() {
    let mut table = Table::default();
    let target = target("kind-plain", "api");
    let mut forward = shown();
    forward.local = 18081;
    table.entries.insert(
        1,
        Entry {
            base: forward,
            context: "kind-plain".to_owned(),
            run: None,
            unbound: None,
            refused: None,
            detour: false,
        },
    );
    for port in [8080, 9090] {
        table.remembered.insert(
            Key::of(&target, port),
            Remembered {
                target: target.clone(),
                port,
                local: 18080,
            },
        );
    }
    let port = |number| ForwardPort {
        port: number,
        name: None,
        target_port: None,
        container: None,
        app_protocol: None,
        local: 0,
        forward: None,
    };
    let mut declared = [port(8080), port(9090), port(7070)];
    table.describe(&target, &mut declared);
    assert_eq!(
        declared.map(|port| (port.local, port.forward)),
        [(18081, Some(ForwardId(1))), (18080, None), (7070, None)]
    );
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
        app_protocol: None,
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

async fn unattended(dir: &Path, api: &Api) -> Arc<Core> {
    let kubeconfig = dir.join("config");
    std::fs::write(
        &kubeconfig,
        KUBECONFIG.replace("127.0.0.1:1", &format!("127.0.0.1:{}", api.port)),
    )
    .unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    core.catalog
        .follow(crate::catalog::sources(Some(kubeconfig), None, None));
    core.proxy_env
        .send_replace(Some(twigo_kube::client::ProxyEnv::default()));
    core.catalog.contexts().await;
    core
}

fn other_target(mut saved: SavedForward, name: &str) -> SavedForward {
    saved.target = target("kind-plain", name);
    saved
}

const REFUSING: &str = r#"{"readOnly": {"allowPortForward": false}}"#;

async fn set_the_mode(core: &Core, mode: Mode) {
    core.set_context_mode(SetContextMode {
        context: "kind-plain".to_owned(),
        mode: Some(mode),
    })
    .await
    .unwrap();
}

async fn refused_while_restored(dir: &Path, api: &Api) -> Arc<Core> {
    std::fs::write(dir.join("policy.json"), REFUSING).unwrap();
    keep(
        dir,
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = unattended(dir, api).await;
    core.restore_forwards().await;
    assert_eq!(listed(&core)[0].state, ForwardState::Restored);
    set_the_mode(&core, Mode::ReadOnly).await;
    core.forwards.recheck();
    until("the mode refuses it", || {
        failed_with(&core, |error| error.kind == ErrorKind::Permissions)
    })
    .await;
    core
}

async fn stays_waiting_and_asks_nobody(core: &Core, api: &Api) {
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(listed(core)[0].state, ForwardState::Restored);
    assert_eq!(api.requests.load(Ordering::SeqCst), 0, "nobody was asked");
}

#[tokio::test]
async fn a_start_waits_for_the_restore_and_sees_the_ports_and_forwards_it_restored() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    let remembered = free();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![other_target(forward_of(1, 5432, free(), true), "db")],
            ports: vec![Remembered {
                target: target("kind-plain", "api"),
                port: 8080,
                local: remembered,
            }],
        },
    );
    let core = unattended(dir.path(), &api).await;

    let starting = tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            core.forward_start(StartForward {
                target: target("kind-plain", "api"),
                port: 8080,
                local: None,
            })
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!starting.is_finished(), "a start waits for the restore");
    assert!(listed(&core).is_empty());

    core.restore_forwards().await;
    let ForwardStarted::Started { forward } = starting.await.unwrap().unwrap() else {
        panic!("the remembered port is free");
    };
    assert_eq!(forward.local, remembered);
    let kept = core.state.forwards("kind-plain");
    assert_eq!(kept.forwards.len(), 2, "the restored forward is kept");
    assert_eq!(
        serde_json::to_value(&kept).unwrap(),
        serde_json::to_value(core.forwards.table().saved("kind-plain")).unwrap(),
        "the state is the table"
    );
}

#[tokio::test]
async fn every_command_that_reads_or_changes_the_table_waits_for_the_restore() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![
                forward_of(1, 8080, free(), true),
                other_target(forward_of(2, 5432, free(), true), "db"),
                other_target(forward_of(3, 6379, free(), true), "cache"),
            ],
            ports: Vec::new(),
        },
    );
    let core = unattended(dir.path(), &api).await;

    let ports = tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.forward_ports(target("kind-plain", "api")).await }
    });
    let resume = tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            core.forward_resume(ResumeForward {
                id: ForwardId(1),
                local: None,
            })
            .await
        }
    });
    let stop = tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.forward_stop(ForwardId(2)).await }
    });
    let remove = tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.forward_remove(ForwardId(3)).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    for (command, finished) in [
        ("forward_ports", ports.is_finished()),
        ("forward_resume", resume.is_finished()),
        ("forward_stop", stop.is_finished()),
        ("forward_remove", remove.is_finished()),
    ] {
        assert!(!finished, "{command} waits for the restore");
    }

    core.restore_forwards().await;
    let ports = ports.await.unwrap().unwrap();
    assert_eq!(ports.ports[0].forward, Some(ForwardId(1)));
    resume.await.unwrap().unwrap();
    stop.await.unwrap().unwrap();
    remove.await.unwrap().unwrap();
    let ids: Vec<_> = listed(&core).iter().map(|forward| forward.id.0).collect();
    assert_eq!(ids, [1, 2]);
}

#[tokio::test]
async fn clients_made_while_the_restore_is_under_way_start_the_forwards_it_restores() {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = unattended(dir.path(), &api).await;

    core.forwards.connected("kind-plain");
    core.restore_forwards().await;
    until("the space's connecting starts it", || {
        let now = listed(&core)[0].state.clone();
        (now != ForwardState::Restored).then_some(now)
    })
    .await;
}

fn start_of(core: &Arc<Core>, local: Option<u16>) -> JoinHandle<Result<ForwardStarted, IpcError>> {
    let core = Arc::clone(core);
    tokio::spawn(async move {
        core.forward_start(StartForward {
            target: target("kind-plain", "api"),
            port: 8080,
            local,
        })
        .await
    })
}

fn started(answer: Result<Result<ForwardStarted, IpcError>, tokio::task::JoinError>) -> Forward {
    match answer.unwrap().unwrap() {
        ForwardStarted::Started { forward } => *forward,
        busy @ ForwardStarted::Busy { .. } => panic!("the port of its own forward: {busy:?}"),
    }
}

#[tokio::test]
async fn a_start_waits_for_no_other_start_s_read_of_the_target_and_the_later_one_moves_the_forward()
{
    let api = Api::start(true).await;
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    let (first, second) = (free(), free());

    let earlier = start_of(&core, Some(first));
    api.reached().await;
    let later = start_of(&core, Some(second));
    let made = started(
        tokio::time::timeout(Duration::from_secs(5), later)
            .await
            .expect("no claim is held while a target is read"),
    );
    assert_eq!(made.local, second);
    api.release.notify_one();
    let moved = started(earlier.await);

    assert_eq!((moved.id, moved.local), (made.id, first));
    assert_eq!(listed(&core).len(), 1, "no second forward");
    assert_eq!(listed(&core)[0].local, first);
    assert!(TcpStream::connect(("127.0.0.1", first)).await.is_ok());
    until("the port it left is released", || {
        std::net::TcpListener::bind(("127.0.0.1", second)).ok()
    })
    .await;
}

#[tokio::test]
async fn the_clients_of_a_context_that_lifts_the_refusal_start_the_forward_it_had_restored() {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    let core = refused_while_restored(dir.path(), &api).await;

    set_the_mode(&core, Mode::ReadWrite).await;
    core.forwards.connected("kind-plain");
    until("the lifted refusal and the clients start it", || {
        let now = listed(&core)[0].state.clone();
        (now != ForwardState::Restored && !matches!(now, ForwardState::Failed { .. }))
            .then_some(now)
    })
    .await;
}

#[tokio::test]
async fn the_clients_of_a_context_ask_the_policy_themselves_whether_its_forwards_may_run() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("policy.json"), REFUSING).unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = unattended(dir.path(), &api).await;
    core.restore_forwards().await;
    set_the_mode(&core, Mode::ReadOnly).await;

    core.forwards.connected("kind-plain");
    until("the clients fail it", || {
        failed_with(&core, |error| error.kind == ErrorKind::Permissions)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(failed_with(&core, |error| error.kind == ErrorKind::Permissions).is_some());
    assert_eq!(api.requests.load(Ordering::SeqCst), 0, "nobody was asked");

    set_the_mode(&core, Mode::ReadWrite).await;
    core.forwards.recheck();
    stays_waiting_and_asks_nobody(&core, &api).await;
}

#[tokio::test]
async fn a_resume_that_lifts_the_refusal_of_a_forward_that_waited_leaves_it_waiting() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    let core = refused_while_restored(dir.path(), &api).await;

    set_the_mode(&core, Mode::ReadWrite).await;
    core.forward_resume(ResumeForward {
        id: ForwardId(1),
        local: None,
    })
    .await
    .unwrap();
    stays_waiting_and_asks_nobody(&core, &api).await;
}

#[tokio::test]
async fn a_resume_between_a_lifted_refusal_and_the_data_path_handling_it_leaves_the_forward_waiting()
 {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    let core = refused_while_restored(dir.path(), &api).await;

    set_the_mode(&core, Mode::ReadWrite).await;
    core.forwards.recheck();
    core.forward_resume(ResumeForward {
        id: ForwardId(1),
        local: None,
    })
    .await
    .unwrap();
    stays_waiting_and_asks_nobody(&core, &api).await;
}

#[tokio::test]
async fn a_move_after_the_clients_came_does_not_leave_the_forward_waiting() {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = unattended(dir.path(), &api).await;
    core.restore_forwards().await;

    core.forwards.connected("kind-plain");
    core.forward_resume(ResumeForward {
        id: ForwardId(1),
        local: Some(free()),
    })
    .await
    .unwrap();
    until("the moved forward starts", || {
        let now = listed(&core)[0].state.clone();
        (now != ForwardState::Restored).then_some(now)
    })
    .await;
}

#[tokio::test]
async fn clients_the_core_had_made_already_start_no_forward_that_waits() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    let core = refused_while_restored(dir.path(), &api).await;
    core.clients("kind-plain").await.unwrap();
    set_the_mode(&core, Mode::ReadWrite).await;
    core.forwards.recheck();
    stays_waiting_and_asks_nobody(&core, &api).await;

    core.clients("kind-plain").await.unwrap();
    stays_waiting_and_asks_nobody(&core, &api).await;
}

#[tokio::test]
async fn two_starts_of_one_port_at_once_answer_with_one_forward_on_one_port() {
    for asked in [None, Some(free())] {
        let api = Api::start(true).await;
        let dir = tempfile::tempdir().unwrap();
        let remembered = free();
        keep(
            dir.path(),
            &Saved {
                forwards: Vec::new(),
                ports: vec![Remembered {
                    target: target("kind-plain", "api"),
                    port: 8080,
                    local: remembered,
                }],
            },
        );
        let core = running_over(dir.path(), &api);
        core.catalog.contexts().await;

        let first = start_of(&core, asked);
        api.reached().await;
        let second = start_of(&core, asked);
        tokio::time::sleep(Duration::from_millis(300)).await;
        api.release.notify_one();
        let (first, second) = (started(first.await), started(second.await));
        assert_eq!(first.id, second.id, "{asked:?}");
        assert_eq!(first.local, asked.unwrap_or(remembered));
        assert_eq!(second.local, first.local);
        assert_eq!(listed(&core).len(), 1);
    }
}

#[tokio::test]
async fn a_move_of_a_forward_that_works_asks_for_no_proof_and_keeps_its_connections() {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    let local = free();
    let ForwardStarted::Started { forward } = core
        .forward_start(StartForward {
            target: target("kind-plain", "api"),
            port: 8080,
            local: Some(local),
        })
        .await
        .unwrap()
    else {
        panic!("a free port starts");
    };
    until("the forward is ready", || {
        (listed(&core)[0].state == ForwardState::Ready).then_some(())
    })
    .await;
    let mut open = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
    open.write_all(b"hello").await.unwrap();
    let mut echoed = [0; 5];
    open.read_exact(&mut echoed).await.unwrap();
    let (events, seen) = mpsc::channel();
    core.follow_forwards("main", move |event| events.send(event).is_ok());

    let moved = free();
    core.forward_resume(ResumeForward {
        id: forward.id,
        local: Some(moved),
    })
    .await
    .unwrap();
    open.write_all(b"again").await.unwrap();
    open.read_exact(&mut echoed).await.unwrap();
    assert_eq!(
        &echoed, b"again",
        "a connection open before the move goes on"
    );
    let mut after = TcpStream::connect(("127.0.0.1", moved)).await.unwrap();
    after.write_all(b"moved").await.unwrap();
    after.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"moved");
    let states: Vec<_> = seen
        .try_iter()
        .filter_map(|event| match event {
            ForwardEvent::Changed { forward } => Some(forward.state),
            ForwardEvent::Removed { .. } => None,
        })
        .collect();
    assert!(!states.contains(&ForwardState::Starting), "{states:?}");
    assert_eq!(listed(&core)[0].state, ForwardState::Ready);
}

fn states_of(seen: &mpsc::Receiver<ForwardEvent>) -> Vec<ForwardState> {
    seen.try_iter()
        .filter_map(|event| match event {
            ForwardEvent::Changed { forward } => Some(forward.state),
            ForwardEvent::Removed { .. } => None,
        })
        .collect()
}

async fn failed_for_a_credential(api: &Api, dir: &Path) -> (Arc<Core>, ForwardId) {
    keep(dir, &Saved::default());
    let core = running_over(dir, api);
    core.catalog.contexts().await;
    api.refuse_upgrades(401);
    let ForwardStarted::Started { forward } = core
        .forward_start(StartForward {
            target: target("kind-plain", "api"),
            port: 8080,
            local: Some(free()),
        })
        .await
        .unwrap()
    else {
        panic!("a free port starts");
    };
    until("the proof fails it", || {
        failed_with(&core, |error| error.kind == ErrorKind::Unauthorized)
    })
    .await;
    api.refuse_upgrades(0);
    (core, forward.id)
}

#[tokio::test]
async fn a_resume_and_a_move_of_a_failed_forward_answer_starting_and_start_it_again() {
    for moved in [None, Some(free())] {
        let api = Api::serving_pod().await;
        let dir = tempfile::tempdir().unwrap();
        let (core, id) = failed_for_a_credential(&api, dir.path()).await;

        let ForwardStarted::Started { forward } = core
            .forward_resume(ResumeForward { id, local: moved })
            .await
            .unwrap()
        else {
            panic!("a resume answers with the forward");
        };
        assert_eq!(forward.state, ForwardState::Starting, "{moved:?}");
        if let Some(moved) = moved {
            assert_eq!(forward.local, moved);
        }
        until("the forward is ready", || {
            (listed(&core)[0].state == ForwardState::Ready).then_some(())
        })
        .await;
    }
}

#[tokio::test]
async fn a_resume_or_a_start_of_a_stopped_forward_whose_context_the_catalog_lacks_answers_the_refusal_and_starts_nothing()
 {
    let dir = tempfile::tempdir().unwrap();
    let local = free();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, local, false)],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    assert_eq!(forward_state(&core, 1).await, ForwardState::Stopped);
    lose_the_context(dir.path());
    until("the catalog loses the context", || {
        let catalog = core.catalog.subscribe();
        let lacks = catalog
            .borrow()
            .as_deref()
            .is_some_and(|contexts| contexts.find("kind-plain").is_none());
        lacks.then_some(())
    })
    .await;
    let (events, seen) = mpsc::channel();
    core.follow_forwards("main", move |event| events.send(event).is_ok());
    let _held = std::net::TcpListener::bind(("127.0.0.1", local)).unwrap();

    let refused = core
        .forward_resume(ResumeForward {
            id: ForwardId(1),
            local: None,
        })
        .await
        .unwrap_err();
    assert_eq!(refused.message, NO_SOURCE, "before it binds");
    let moved = free();
    for asked in [Some(local), Some(moved)] {
        let refused = core
            .forward_start(StartForward {
                target: target("kind-plain", "api"),
                port: 8080,
                local: asked,
            })
            .await
            .unwrap_err();
        assert_eq!(refused.message, NO_SOURCE);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(states_of(&seen).is_empty());
    assert_eq!(listed(&core)[0].state, ForwardState::Stopped);
    assert_eq!(listed(&core)[0].local, local);
    assert!(!core.state.forwards("kind-plain").forwards[0].runs);
    assert!(std::net::TcpListener::bind(("127.0.0.1", moved)).is_ok());
}

#[tokio::test]
async fn a_stop_and_a_remove_wait_for_the_command_that_changes_the_forward() {
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![
                forward_of(1, 8080, free(), true),
                other_target(forward_of(2, 5432, free(), true), "db"),
            ],
            ports: Vec::new(),
        },
    );
    let core = running(dir.path());
    assert_eq!(forward_state(&core, 2).await, ForwardState::Restored);

    for (id, name, port) in [(1, "api", 8080), (2, "db", 5432)] {
        let claim = core
            .forwards
            .claim(&Key::of(&target("kind-plain", name), port))
            .await;
        let command = tokio::spawn({
            let core = Arc::clone(&core);
            async move {
                if id == 1 {
                    core.forward_stop(ForwardId(id)).await
                } else {
                    core.forward_remove(ForwardId(id)).await
                }
            }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!command.is_finished(), "forward {id} waits for the claim");
        drop(claim);
        command.await.unwrap().unwrap();
    }
    let forwards = listed(&core);
    assert_eq!(forwards.len(), 1);
    assert_eq!(forwards[0].state, ForwardState::Stopped);
}

#[tokio::test]
async fn a_start_and_a_resume_wait_for_the_claim_of_their_port_once_the_target_is_read() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![other_target(forward_of(1, 5432, free(), false), "db")],
            ports: Vec::new(),
        },
    );
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    assert_eq!(forward_state(&core, 1).await, ForwardState::Stopped);

    let claim = core
        .forwards
        .claim(&Key::of(&target("kind-plain", "api"), 8080))
        .await;
    let starting = start_of(&core, Some(free()));
    api.reached().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!starting.is_finished(), "the start waits for the claim");
    drop(claim);
    started(
        tokio::time::timeout(Duration::from_secs(5), starting)
            .await
            .expect("the start ends"),
    );

    let claim = core
        .forwards
        .claim(&Key::of(&target("kind-plain", "db"), 5432))
        .await;
    let resuming = tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            core.forward_resume(ResumeForward {
                id: ForwardId(1),
                local: None,
            })
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!resuming.is_finished(), "the resume waits for the claim");
    drop(claim);
    started(
        tokio::time::timeout(Duration::from_secs(5), resuming)
            .await
            .expect("the resume ends"),
    );
}

#[tokio::test]
async fn a_stop_waits_for_the_resume_of_its_forward_until_the_resume_has_answered() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), false)],
            ports: Vec::new(),
        },
    );
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    assert_eq!(forward_state(&core, 1).await, ForwardState::Stopped);

    let resume = core.forward_resume(ResumeForward {
        id: ForwardId(1),
        local: None,
    });
    let stop = core.forward_stop(ForwardId(1));
    tokio::pin!(resume, stop);
    assert!(
        futures::poll!(resume.as_mut()).is_pending(),
        "the resume waits for its data path, which has not run yet"
    );
    assert!(
        futures::poll!(stop.as_mut()).is_pending(),
        "the stop waits for the claim of the resume"
    );
    let ForwardStarted::Started { forward } = resume.await.unwrap() else {
        panic!("the port of its own forward is free");
    };
    assert_eq!(forward.state, ForwardState::Starting);
    stop.await.unwrap();
    assert_eq!(listed(&core)[0].state, ForwardState::Stopped);
}

#[tokio::test]
async fn a_start_that_waited_for_a_remove_reads_the_target_and_makes_a_forward() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), false)],
            ports: Vec::new(),
        },
    );
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    assert_eq!(forward_state(&core, 1).await, ForwardState::Stopped);
    let key = Key::of(&target("kind-plain", "api"), 8080);
    let claim = core.forwards.claim(&key).await;
    let local = free();
    let starting = start_of(&core, Some(local));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!starting.is_finished(), "it waits for the claim");
    assert_eq!(api.reads.load(Ordering::SeqCst), 0, "and read nothing");
    core.forwards.table().entries.remove(&1);
    drop(claim);
    let made = started(
        tokio::time::timeout(Duration::from_secs(5), starting)
            .await
            .expect("the start ends"),
    );
    assert_eq!(made.local, local);
    assert_eq!(api.reads.load(Ordering::SeqCst), 1);
    let ids: Vec<_> = listed(&core).iter().map(|forward| forward.id).collect();
    assert_eq!(ids, [made.id]);
}

#[tokio::test]
async fn a_window_learns_of_a_forward_a_start_made_as_the_start_answered_it() {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    let (events, seen) = mpsc::channel();
    core.follow_forwards("main", move |event| events.send(event).is_ok());

    let made = started(start_of(&core, Some(free())).await);
    assert_eq!(made.state, ForwardState::Starting);
    let learned = until("the window learns of it", || {
        seen.try_iter().find_map(|event| match event {
            ForwardEvent::Changed { forward } if forward.id == made.id => Some(forward),
            _ => None,
        })
    })
    .await;
    assert_eq!(*learned, made, "the first it learns is the answer");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_starts_whose_reads_return_together_make_one_forward() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    for round in 0..200 {
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let starts: Vec<_> = [free(), free()]
            .into_iter()
            .map(|local| {
                let (core, barrier) = (Arc::clone(&core), Arc::clone(&barrier));
                tokio::spawn(async move {
                    barrier.wait().await;
                    core.forward_start(StartForward {
                        target: target("kind-plain", "api"),
                        port: 8080,
                        local: Some(local),
                    })
                    .await
                })
            })
            .collect();
        for start in starts {
            let answer = start.await.unwrap().unwrap();
            assert!(
                matches!(answer, ForwardStarted::Started { .. }),
                "round {round}: {answer:?}"
            );
        }
        let forwards = listed(&core);
        assert_eq!(forwards.len(), 1, "round {round}: {forwards:?}");
        core.forward_remove(forwards[0].id).await.unwrap();
    }
}

#[tokio::test]
async fn after_the_shutdown_no_command_saves_binds_or_starts() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    let (ran, stopped, other) = (free(), free(), free());
    keep(
        dir.path(),
        &Saved {
            forwards: vec![
                forward_of(1, 8080, ran, true),
                other_target(forward_of(2, 5432, stopped, false), "db"),
            ],
            ports: Vec::new(),
        },
    );
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    assert_eq!(forward_state(&core, 1).await, ForwardState::Restored);
    let claim = core
        .forwards
        .claim(&Key::of(&target("kind-plain", "api"), 8080))
        .await;
    let racing = tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            core.forward_resume(ResumeForward {
                id: ForwardId(1),
                local: None,
            })
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    core.shutdown();
    drop(claim);
    let quitting = |answer: Result<ForwardStarted, IpcError>| {
        let error = answer.unwrap_err();
        assert_eq!(error.message, "Twigo is quitting");
    };
    quitting(racing.await.unwrap());
    let asked = api.requests.load(Ordering::SeqCst);
    quitting(
        core.forward_start(StartForward {
            target: target("kind-plain", "cache"),
            port: 6379,
            local: Some(other),
        })
        .await,
    );
    for id in [1, 2] {
        quitting(
            core.forward_resume(ResumeForward {
                id: ForwardId(id),
                local: None,
            })
            .await,
        );
    }
    assert_eq!(
        api.requests.load(Ordering::SeqCst),
        asked,
        "nothing asked the cluster"
    );
    assert!(core.forward_stop(ForwardId(1)).await.is_err());
    assert!(core.forward_remove(ForwardId(2)).await.is_err());
    for port in [stopped, other] {
        assert!(
            std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(),
            "port {port} is free"
        );
    }
    core.restore_forward(
        "kind-plain",
        other_target(forward_of(9, 7070, free(), true), "web"),
    )
    .await;
    assert!(
        listed(&core)
            .iter()
            .all(|forward| forward.id != ForwardId(9))
    );
    core.save_forwards("kind-plain");
    let kept: Vec<_> = core
        .state
        .forwards("kind-plain")
        .forwards
        .iter()
        .map(|forward| (forward.id.0, forward.runs))
        .collect();
    assert_eq!(kept, [(1, true), (2, false)]);
}

fn signing_in(dir: &Path, api: &Api) -> PathBuf {
    let script = dir.join("plugin");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho run >> '{}'\nprintf '{{\"status\":{{\"token\":\"t\"}}}}'\n",
            dir.join("runs").display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let kubeconfig = dir.join("config");
    std::fs::write(
        &kubeconfig,
        format!(
            "
clusters: [{{ name: c, cluster: {{ server: 'http://127.0.0.1:{}' }} }}]
users: [{{ name: u, user: {{ exec: {{ apiVersion: client.authentication.k8s.io/v1, interactiveMode: Never, command: '{}' }} }} }}]
contexts:
- name: kind-plain
  context: {{ cluster: c, user: u }}
",
            api.port,
            script.display()
        ),
    )
    .unwrap();
    kubeconfig
}

fn runs(dir: &Path) -> usize {
    std::fs::read_to_string(dir.join("runs"))
        .map(|runs| runs.lines().count())
        .unwrap_or(0)
}

#[tokio::test]
async fn a_sign_in_that_gets_a_credential_proves_a_forward_failed_for_its_credential_once() {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let kubeconfig = signing_in(dir.path(), &api);
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let (_status, followed) = watch::channel(twigo_env::Status::Resolved(Arc::new(
        ShellEnv::from_iter(std::iter::empty::<(OsString, OsString)>()),
    )));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            let _status = _status;
            core.run(followed, Some(kubeconfig)).await
        }
    });
    core.catalog.contexts().await;
    let review = core.review().await;
    core.trust_plugins(vec![review.plugins[0].plugin.digest.clone()])
        .unwrap();
    core.set_focused(true);

    api.refuse_upgrades(401);
    started(start_of(&core, Some(free())).await);
    until("the proof fails it", || {
        failed_with(&core, |error| error.kind == ErrorKind::Unauthorized)
    })
    .await;
    let before = runs(dir.path());
    core.sign_in("kind-plain").await.unwrap();
    until("the sign-in's run and one proof", || {
        (runs(dir.path()) > before + 1).then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = runs(dir.path());
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(
        runs(dir.path()),
        after,
        "the 401 that failed the proof again"
    );
    assert!(failed_with(&core, |error| error.kind == ErrorKind::Unauthorized).is_some());

    api.refuse_upgrades(0);
    core.sign_in("kind-plain").await.unwrap();
    until("the sign-in proves it", || {
        (listed(&core)[0].state == ForwardState::Ready).then_some(())
    })
    .await;
}

#[tokio::test]
async fn a_start_whose_read_outlasts_the_shutdown_binds_nothing() {
    let api = Api::start(true).await;
    let dir = tempfile::tempdir().unwrap();
    keep(dir.path(), &Saved::default());
    let core = running_over(dir.path(), &api);
    core.catalog.contexts().await;
    let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let busy = held.local_addr().unwrap().port();

    let starting = start_of(&core, Some(busy));
    api.reached().await;
    core.shutdown();
    api.release.notify_one();
    let refused = starting.await.unwrap().unwrap_err();
    assert_eq!(
        refused.message, "Twigo is quitting",
        "not a busy port and a free one found by binding"
    );
    assert!(listed(&core).is_empty());
}

#[tokio::test]
async fn before_the_catalog_has_loaded_a_start_and_a_resume_wait_for_it() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("policy.json"), REFUSING).unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![
                other_target(forward_of(1, 6379, free(), false), "cache"),
                other_target(forward_of(2, 7070, free(), false), "web"),
            ],
            ports: Vec::new(),
        },
    );
    let kubeconfig = dir.path().join("config");
    std::fs::write(
        &kubeconfig,
        KUBECONFIG.replace("127.0.0.1:1", &format!("127.0.0.1:{}", api.port)),
    )
    .unwrap();
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    core.proxy_env
        .send_replace(Some(twigo_kube::client::ProxyEnv::default()));
    core.restore_forwards().await;

    let starting = tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            core.forward_start(StartForward {
                target: target("kind-plain", "cache"),
                port: 6379,
                local: None,
            })
            .await
        }
    });
    let resuming = tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            core.forward_resume(ResumeForward {
                id: ForwardId(2),
                local: None,
            })
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!starting.is_finished(), "a start waits for the catalog");
    assert!(!resuming.is_finished(), "a resume waits for the catalog");

    core.catalog
        .follow(crate::catalog::sources(Some(kubeconfig), None, None));
    for answer in [starting.await, resuming.await] {
        assert_eq!(started(answer).state, ForwardState::Starting);
    }
}

#[tokio::test]
async fn a_forward_restored_before_the_catalog_has_loaded_waits_and_the_check_after_the_load_refuses_it_in_place()
 {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("policy.json"),
        r#"{"contexts": {"kind-plain": "read-only"}, "readOnly": {"allowPortForward": false}}"#,
    )
    .unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let kubeconfig = dir.path().join("config");
    std::fs::write(&kubeconfig, KUBECONFIG).unwrap();
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let (status, followed) = watch::channel(twigo_env::Status::Resolving);
    tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.run(followed, None).await }
    });
    assert_eq!(forward_state(&core, 1).await, ForwardState::Restored);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(listed(&core)[0].state, ForwardState::Restored);

    status.send_replace(twigo_env::Status::Resolved(Arc::new(ShellEnv::from_iter(
        [
            (OsString::from("KUBECONFIG"), kubeconfig.into_os_string()),
            (OsString::from("HOME"), dir.path().as_os_str().to_owned()),
        ],
    ))));
    until("the check after the load refuses it", || {
        failed_with(&core, |error| error.kind == ErrorKind::Permissions)
    })
    .await;
}

#[tokio::test]
async fn a_restored_forward_keeps_the_refusal_it_began_with_so_its_lifting_makes_it_wait() {
    let api = Api::start(false).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("policy.json"), REFUSING).unwrap();
    keep(
        dir.path(),
        &Saved {
            forwards: vec![forward_of(1, 8080, free(), true)],
            ports: Vec::new(),
        },
    );
    let core = unattended(dir.path(), &api).await;
    set_the_mode(&core, Mode::ReadOnly).await;
    core.restore_forwards().await;
    assert!(failed_with(&core, |error| error.kind == ErrorKind::Permissions).is_some());

    set_the_mode(&core, Mode::ReadWrite).await;
    core.forwards.recheck();
    stays_waiting_and_asks_nobody(&core, &api).await;
}

#[tokio::test]
async fn a_sign_in_checks_the_forward_before_it_proves_it() {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("policy.json"), REFUSING).unwrap();
    keep(dir.path(), &Saved::default());
    let core = unattended(dir.path(), &api).await;
    core.restore_forwards().await;
    api.refuse_upgrades(401);
    started(start_of(&core, Some(free())).await);
    until("the proof fails it", || {
        failed_with(&core, |error| error.kind == ErrorKind::Unauthorized)
    })
    .await;
    api.refuse_upgrades(0);

    set_the_mode(&core, Mode::ReadOnly).await;
    core.forwards.signed_in(&["kind-plain".to_owned()]).await;
    set_the_mode(&core, Mode::ReadWrite).await;
    core.forwards.recheck();
    until("the lifted refusal makes it wait", || {
        (listed(&core)[0].state == ForwardState::Restored).then_some(())
    })
    .await;
}

fn plugin(dir: &Path, name: &str, body: &str) -> PathBuf {
    let script = dir.join(name);
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho run >> '{}'\n{body}\n",
            dir.join(format!("{name}.runs")).display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    script
}

fn runs_of(dir: &Path, name: &str) -> usize {
    std::fs::read_to_string(dir.join(format!("{name}.runs")))
        .map(|runs| runs.lines().count())
        .unwrap_or(0)
}

const TOKEN: &str = r#"printf '{"status":{"token":"t"}}'"#;

async fn signing_in_to(dir: &Path, api: &Api, contexts: &[(&str, &str)]) -> Arc<Core> {
    let state = State::open(dir.join("state.json"));
    for (context, _) in contexts {
        state.open_space(context);
    }
    state.flush().unwrap();
    drop(state);
    let mut users = String::new();
    for name in ["one", "other"] {
        let script = plugin(dir, name, TOKEN);
        users.push_str(&format!(
            "- {{ name: {name}, user: {{ exec: {{ apiVersion: client.authentication.k8s.io/v1, interactiveMode: Never, command: '{}' }} }} }}\n",
            script.display()
        ));
    }
    let named: String = contexts
        .iter()
        .map(|(context, user)| {
            format!("- {{ name: {context}, context: {{ cluster: c, user: {user} }} }}\n")
        })
        .collect();
    let kubeconfig = dir.join("config");
    std::fs::write(
        &kubeconfig,
        format!(
            "clusters: [{{ name: c, cluster: {{ server: 'http://127.0.0.1:{}' }} }}]\nusers:\n{users}contexts:\n{named}",
            api.port
        ),
    )
    .unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let (_status, followed) = watch::channel(twigo_env::Status::Resolved(Arc::new(
        ShellEnv::from_iter(std::iter::empty::<(OsString, OsString)>()),
    )));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            let _status = _status;
            core.run(followed, Some(kubeconfig)).await
        }
    });
    core.catalog.contexts().await;
    let review = core.review().await;
    core.trust_plugins(
        review
            .plugins
            .iter()
            .map(|reviewed| reviewed.plugin.digest.clone())
            .collect(),
    )
    .unwrap();
    core.set_focused(true);
    core
}

fn state_in(core: &Core, space: &str) -> Option<ForwardState> {
    listed(core)
        .into_iter()
        .find(|forward| forward.target.space == space)
        .map(|forward| forward.state)
}

#[tokio::test]
async fn a_sign_in_proves_the_forwards_of_every_context_that_shares_the_plugin_and_no_other() {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    let spaces = [("kind-a", "one"), ("kind-b", "one"), ("kind-c", "other")];
    let core = signing_in_to(dir.path(), &api, &spaces).await;
    api.refuse_upgrades(401);
    for (space, _) in spaces {
        let answer = core
            .forward_start(StartForward {
                target: target(space, "api"),
                port: 8080,
                local: Some(free()),
            })
            .await;
        assert!(
            matches!(answer, Ok(ForwardStarted::Started { .. })),
            "{answer:?}"
        );
    }
    until("each proof fails its forward", || {
        spaces
            .iter()
            .all(|(space, _)| {
                matches!(state_in(&core, space), Some(ForwardState::Failed { error }) if error.kind == ErrorKind::Unauthorized)
            })
            .then_some(())
    })
    .await;
    api.refuse_upgrades(0);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let other_runs = runs_of(dir.path(), "other");

    core.sign_in("kind-a").await.unwrap();
    until("the sign-in proves the forwards of its plugin", || {
        ["kind-a", "kind-b"]
            .iter()
            .all(|space| state_in(&core, space) == Some(ForwardState::Ready))
            .then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(matches!(
        state_in(&core, "kind-c"),
        Some(ForwardState::Failed { .. })
    ));
    assert_eq!(runs_of(dir.path(), "other"), other_runs, "its plugin ran");
}

#[tokio::test]
async fn a_sign_in_that_fails_proves_nothing() {
    let api = Api::serving_pod().await;
    let dir = tempfile::tempdir().unwrap();
    let core = signing_in_to(dir.path(), &api, &[("kind-plain", "one")]).await;
    api.refuse_upgrades(401);
    started(start_of(&core, Some(free())).await);
    until("the proof fails it", || {
        failed_with(&core, |error| error.kind == ErrorKind::Unauthorized)
    })
    .await;
    api.refuse_upgrades(0);
    tokio::time::sleep(Duration::from_millis(500)).await;
    plugin(dir.path(), "one", "exit 1");
    let before = runs_of(dir.path(), "one");

    core.sign_in("kind-plain").await.unwrap();
    until("the sign-in's run", || {
        (runs_of(dir.path(), "one") > before).then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(
        runs_of(dir.path(), "one"),
        before + 1,
        "a proof ran it again"
    );
    assert!(failed_with(&core, |error| error.kind == ErrorKind::Unauthorized).is_some());
}
