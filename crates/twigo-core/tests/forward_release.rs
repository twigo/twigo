//! A stop, a move and a shutdown leave the forward's port free when they
//! return. The test binds the port straight after, so this binary holds this
//! test alone: on macOS a child that another test spawns meanwhile holds a
//! copy of the closed listeners until its program starts, and the port stays
//! in use for that moment.
//!
//! cargo test -p twigo-core --test forward_release

use std::ffi::OsString;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::sync::watch;
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{ForwardId, ForwardState, ForwardTarget, Gvr, ResumeForward};

const KUBECONFIG: &str = "
clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]
users: [{ name: u, user: {} }]
contexts:
- name: kind-plain
  context: { cluster: c, user: u }
";

const FIRST_BLOCK: u16 = 31_000;
const BLOCKS: u32 = 250;

fn listening(port: u16) -> bool {
    [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ]
    .into_iter()
    .any(|address| {
        TcpStream::connect_timeout(&SocketAddr::new(address, port), Duration::from_millis(250))
            .is_ok()
    })
}

fn released(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
        && match TcpListener::bind(("::1", port)) {
            Ok(_) => true,
            Err(error) => error.kind() == io::ErrorKind::AddrNotAvailable,
        }
}

/// Three ports next to a fourth that this run holds a listener on, which
/// claims the block against another run of this binary.
fn claimed_ports() -> (TcpListener, [u16; 3]) {
    let first = std::process::id() % BLOCKS;
    (0..BLOCKS)
        .find_map(|step| {
            let claim = FIRST_BLOCK + 4 * u16::try_from((first + step) % BLOCKS).unwrap();
            let listener = TcpListener::bind(("127.0.0.1", claim)).ok()?;
            let ports = [claim + 1, claim + 2, claim + 3];
            (!ports.into_iter().any(listening)).then_some((listener, ports))
        })
        .expect("a block of ports that no other run holds")
}

fn target(name: &str) -> ForwardTarget {
    ForwardTarget {
        space: "kind-plain".to_owned(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
        },
        namespace: "shop".to_owned(),
        name: name.to_owned(),
    }
}

fn keep(dir: &Path, forwards: &[(u32, &str, u16, u16)]) {
    let forwards: Vec<_> = forwards
        .iter()
        .map(|&(id, name, port, local)| {
            json!({
                "id": id,
                "target": target(name),
                "kind": "Pod",
                "port": port,
                "local": local,
                "detour": false,
                "runs": true,
            })
        })
        .collect();
    let state = json!({
        "version": 1,
        "app": {},
        "spaces": [{
            "id": "kind-plain",
            "contexts": ["kind-plain"],
            "state": { "forwards": { "forwards": forwards, "ports": [] } },
        }],
    });
    std::fs::write(dir.join("state.json"), state.to_string()).unwrap();
}

fn running(dir: &Path) -> Arc<Core> {
    let kubeconfig = dir.join("config");
    std::fs::write(&kubeconfig, KUBECONFIG).unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let (_status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            let _status = _status;
            core.run(followed, Some(kubeconfig)).await
        }
    });
    core
}

async fn restored(core: &Core, id: u32) {
    let waited = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let listed = core.follow_forwards("poll", |_| false);
            if listed.iter().any(|forward| {
                forward.id == ForwardId(id) && forward.state == ForwardState::Restored
            }) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    waited
        .await
        .unwrap_or_else(|_| panic!("forward {id} is restored within 10 s"));
}

#[tokio::test]
async fn a_stop_a_move_and_a_shutdown_leave_the_port_free_when_they_return() {
    let dir = tempfile::tempdir().unwrap();
    let (_claim, [first, second, third]) = claimed_ports();
    keep(
        dir.path(),
        &[(1, "api", 8080, first), (2, "db", 9090, second)],
    );
    let core = running(dir.path());
    core.catalog.contexts().await;
    restored(&core, 1).await;
    restored(&core, 2).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    core.forward_stop(ForwardId(1)).await.unwrap();
    assert!(released(first), "a stop leaves the port free");
    core.forward_resume(ResumeForward {
        id: ForwardId(2),
        local: Some(third),
    })
    .await
    .unwrap();
    assert!(released(second), "a move leaves the port it left free");
    core.shutdown();
    assert!(released(third), "a shutdown leaves the port free");
}
