//! The core's threads that a panic ends or hurts. The armed panic of a thread
//! has no runtime to be scoped to, so any other thread of the process may
//! spend it: these tests run alone, one at a time.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tokio::runtime::Runtime;
use twigo_core::catalog::{self, Catalog};
use twigo_core::state::State;
use twigo_ipc::StateEntry;
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
