//! What a panic of the core's threads and loops does, through `Core::start`.
//! Each test arms its names in its own runtime, and a thread checks the seam
//! in the runtime that started it, so the tests never spend each other's
//! arms.

use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use twigo_core::Core;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{Environment, StateEntry};
use twigo_kube::client::Actor;
use twigo_panic::inject;

async fn until(what: &str, reached: impl Fn() -> bool) {
    let waited = tokio::time::timeout(Duration::from_secs(10), async {
        while !reached() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    waited
        .await
        .unwrap_or_else(|_| panic!("not within ten seconds: {what}"));
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

fn write(dir: &Path, text: &str) {
    std::fs::write(dir.join("config"), text).unwrap();
}

fn core(dir: &Path) -> Arc<Core> {
    Core::new(dir, &dir.join("cache"), &dir.join("policy.json"))
}

fn resolved() -> (watch::Sender<Status>, watch::Receiver<Status>) {
    watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter(
        std::iter::empty::<(OsString, OsString)>(),
    ))))
}

fn listed(core: &Core) -> usize {
    core.catalog
        .subscribe()
        .borrow()
        .as_ref()
        .map_or(0, |contexts| contexts.iter().count())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_kubeconfig_watch_that_panics_is_followed_again() {
    inject::arm("kubeconfig watch", 1);
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), ONE);
    let (_status, followed) = resolved();
    let core = core(dir.path()).start_for_tests(followed, Some(dir.path().join("config")));
    core.catalog.contexts().await;
    assert_eq!(listed(&core), 1);

    write(dir.path(), TWO);
    until("the supervisor follows the files again", || {
        listed(&core) == 2
    })
    .await;
    assert_eq!(inject::armed("kubeconfig watch"), 0, "it panicked");

    write(dir.path(), THREE);
    until("the new watch", || listed(&core) == 3).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_state_writer_whose_write_panics_goes_on_and_writes_with_the_next_change() {
    inject::arm("state writer", 1);
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), ONE);
    let (_status, followed) = resolved();
    let core = core(dir.path()).start_for_tests(followed, Some(dir.path().join("config")));
    let entry = |key: &str| StateEntry {
        space: None,
        key: key.to_owned(),
        value: "1".to_owned(),
    };
    core.state.set(vec![entry("first")]).unwrap();
    until("a write panicked", || inject::armed("state writer") == 0).await;
    core.state.set(vec![entry("second")]).unwrap();
    let file = dir.path().join("state.json");
    until("the next write", || {
        std::fs::read_to_string(&file)
            .is_ok_and(|text| text.contains("first") && text.contains("second"))
    })
    .await;
}

#[tokio::test]
async fn a_policy_proxy_whose_accept_loop_panics_takes_the_fatal_path_at_once() {
    inject::arm("policy proxy", 1);
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), ONE);
    let core = core(dir.path());
    let (told, mut fatal) = mpsc::unbounded_channel();
    let (_status, followed) = resolved();
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

    let why = tokio::time::timeout(Duration::from_secs(5), fatal.recv())
        .await
        .expect("the fatal path within five seconds")
        .unwrap();
    assert_eq!(why.duty, "policy proxy");
    supervising.abort();
}

#[tokio::test]
async fn a_duty_that_panics_four_times_takes_the_fatal_path() {
    inject::arm("unlock expiry", 4);
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
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
    supervising.abort();
}
