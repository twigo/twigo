//! The core's threads that a panic ends or hurts. The armed panic of a thread
//! has no runtime to be scoped to, so any other thread of the process may
//! spend it: these tests run alone, one at a time.

use std::ffi::OsString;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tokio::runtime::Runtime;
use tokio::sync::{mpsc, watch};
use twigo_core::Core;
use twigo_core::catalog::{self, Catalog};
use twigo_core::state::State;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{Environment, StateEntry};
use twigo_kube::client::Actor;
use twigo_panic::{Supervisor, inject, reports};

fn serial() -> MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

fn until(what: &str, reached: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !reached() {
        assert!(Instant::now() < deadline, "not within ten seconds: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn entry(key: &str) -> StateEntry {
    StateEntry {
        space: None,
        key: key.to_owned(),
        value: "1".to_owned(),
    }
}

#[test]
fn a_state_writer_whose_write_panics_writes_with_the_next_change() {
    let _serial = serial();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    inject::arm("state writer", 1);
    let state = State::open(file.clone());
    state.set(vec![entry("first")]).unwrap();
    until("the first write panicked", || {
        inject::armed("state writer") == 0
    });
    assert!(!file.exists());
    state.set(vec![entry("second")]).unwrap();
    until("the next write", || {
        std::fs::read_to_string(&file)
            .is_ok_and(|text| text.contains("first") && text.contains("second"))
    });
}

const ONE: &str = "
clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]
contexts: [{ name: kind-a, context: { cluster: c } }]
";
const TWO: &str = "
clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]
contexts: [{ name: kind-a, context: { cluster: c } }, { name: kind-b, context: { cluster: c } }]
";
const THREE: &str = "
clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]
contexts: [{ name: kind-a, context: { cluster: c } }, { name: kind-b, context: { cluster: c } }, { name: kind-c, context: { cluster: c } }]
";

fn listed(catalog: &Catalog) -> usize {
    catalog
        .subscribe()
        .borrow()
        .as_ref()
        .map_or(0, |contexts| contexts.iter().count())
}

fn write(dir: &Path, text: &str) {
    std::fs::write(dir.join("config"), text).unwrap();
}

#[test]
fn a_kubeconfig_watch_that_panics_is_followed_again_by_the_supervisor() {
    let _serial = serial();
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), ONE);
    inject::arm("kubeconfig watch", 1);
    let runtime = Runtime::new().unwrap();
    let (reporter, reports) = reports();
    let catalog = Arc::new(Catalog::default().supervised_by(reporter));
    let sources = catalog::sources(Some(dir.path().join("config")), None, None);
    let restarts = Arc::new(AtomicUsize::new(0));
    let mut supervisor = Supervisor::new(reports, |fatal| panic!("{fatal}"));
    supervisor.task("idle", std::future::pending::<()>);
    supervisor.thread("kubeconfig watch", {
        let (catalog, sources, restarts) =
            (Arc::clone(&catalog), sources.clone(), restarts.clone());
        move || {
            restarts.fetch_add(1, Ordering::SeqCst);
            catalog.follow(sources.clone());
            true
        }
    });
    let _supervising = runtime.spawn(supervisor.run());
    catalog.follow(sources);
    assert_eq!(listed(&catalog), 1);

    write(dir.path(), TWO);
    until("the supervisor followed the files again", || {
        listed(&catalog) == 2
    });
    assert_eq!(restarts.load(Ordering::SeqCst), 1);
    assert_eq!(inject::armed("kubeconfig watch"), 0);

    write(dir.path(), THREE);
    until("the new watch", || listed(&catalog) == 3);
}

#[tokio::test]
async fn a_policy_proxy_whose_accept_loop_panics_takes_the_fatal_path_at_once() {
    inject::arm("policy proxy", 1);
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), ONE);
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let (told, fatal) = mpsc::unbounded_channel();
    let (_status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))));
    let supervising = tokio::spawn(core.start(
        followed,
        Some(dir.path().join("config")),
        None,
        move |why| told.send(why).unwrap(),
    ));
    core.catalog.contexts().await;
    core.policy
        .set_environment("kind-a", Some(Environment::Local))
        .unwrap();
    let _process = core
        .proxy_process(Actor::Terminal, "Terminal 1", Some("main"), "kind-a")
        .await
        .unwrap();

    let mut fatal = fatal;
    let why = tokio::time::timeout(Duration::from_secs(5), fatal.recv())
        .await
        .expect("the fatal path within five seconds")
        .unwrap();
    assert_eq!(why.duty, "policy proxy");
    supervising.await.unwrap();
}

#[tokio::test]
async fn a_duty_that_panics_four_times_takes_the_fatal_path() {
    inject::arm("unlock expiry", 4);
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(
        dir.path(),
        &dir.path().join("cache"),
        &dir.path().join("policy.json"),
    );
    let (told, mut fatal) = mpsc::unbounded_channel();
    let (_status, followed) = watch::channel(Status::Resolving);
    let supervising = tokio::spawn(core.start(followed, None, None, move |why| {
        told.send(why).unwrap();
    }));
    let why = tokio::time::timeout(Duration::from_secs(5), fatal.recv())
        .await
        .expect("the fatal path within five seconds")
        .unwrap();
    assert_eq!(why.duty, "unlock expiry");
    assert_eq!(inject::armed("unlock expiry"), 0, "it panicked four times");
    supervising.await.unwrap();
}
