use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::{Instant, sleep, timeout};
use twigo_ipc::{Discovered, ErrorKind, IpcError};
use twigo_kube::client::{Budgets, Clients};
use twigo_kube::discovery::Cache;
use twigo_kube::kubeconfig::{Fingerprint, Sources};

use super::*;
use crate::fake::Fake;
use crate::hub::Connect;

const CRDS: &str = "/apis/apiextensions.k8s.io/v1/customresourcedefinitions";
const APISERVICES: &str = "/apis/apiregistration.k8s.io/v1/apiservices";

fn fake() -> Fake {
    let fake = Fake::default();
    fake.state().serve("", "namespaces", "Namespace");
    fake
}

async fn follower(fake: &Fake, cache: &Path) -> Follower {
    over(fake.hub(Budgets::default()).0, cache).await
}

async fn over(hub: Hub, cache: &Path) -> Follower {
    edited_over(hub, cache, watch::channel(None).1).await
}

async fn edited_over(
    hub: Hub,
    cache: &Path,
    entry: watch::Receiver<Option<Fingerprint>>,
) -> Follower {
    Follower::new(
        hub,
        Arc::new(Cache::new(cache)),
        "kind-test".to_owned(),
        entry,
    )
    .await
}

async fn next(follower: &mut Follower) -> Discovered {
    timeout(Duration::from_secs(600), follower.next())
        .await
        .expect("discovery within ten minutes")
}

fn names(discovered: &Discovered) -> Vec<&str> {
    match discovered {
        Discovered::Ready { resources } => resources
            .iter()
            .map(|resource| resource.gvr.resource.as_str())
            .collect(),
        Discovered::Failed { error } => panic!("discovery failed: {error:?}"),
    }
}

fn failure(discovered: &Discovered) -> ErrorKind {
    match discovered {
        Discovered::Failed { error } => error.kind,
        Discovered::Ready { resources } => panic!("discovery answered {resources:?}"),
    }
}

fn asked(fake: &Fake, path: &str) -> usize {
    fake.state()
        .requests
        .iter()
        .filter(|(_, request)| request == path)
        .count()
}

#[tokio::test(start_paused = true)]
async fn a_second_start_revalidates_the_cached_discovery_with_304() {
    let fake = fake();
    fake.state().serve("example.com", "widgets", "Widget");
    let cache = tempfile::tempdir().unwrap();
    let mut first = follower(&fake, cache.path()).await;
    assert_eq!(names(&next(&mut first).await), ["namespaces", "widgets"]);
    assert_eq!(fake.state().not_modified, 0);
    drop(first);

    let mut second = follower(&fake, cache.path()).await;
    assert_eq!(names(&next(&mut second).await), ["namespaces", "widgets"]);
    assert_eq!(fake.state().not_modified, 2);
}

#[tokio::test(start_paused = true)]
async fn a_crd_shows_once_its_changes_settle() {
    let fake = fake();
    let cache = tempfile::tempdir().unwrap();
    let mut follower = follower(&fake, cache.path()).await;
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);

    let start = Instant::now();
    fake.add("customresourcedefinitions", None, "gadgets.example.com");
    fake.state().serve("example.com", "gadgets", "Gadget");
    assert_eq!(names(&next(&mut follower).await), ["namespaces", "gadgets"]);
    assert_eq!(start.elapsed(), SETTLE);
}

#[tokio::test(start_paused = true)]
async fn discovery_that_lags_its_crd_comes_with_a_recheck() {
    let fake = fake();
    let cache = tempfile::tempdir().unwrap();
    let mut follower = follower(&fake, cache.path()).await;
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);

    let start = Instant::now();
    fake.add("apiservices", None, "v1.example.com");
    tokio::spawn({
        let fake = fake.clone();
        async move {
            sleep(Duration::from_secs(1)).await;
            fake.state().serve("example.com", "gadgets", "Gadget");
        }
    });
    assert_eq!(names(&next(&mut follower).await), ["namespaces", "gadgets"]);
    assert_eq!(start.elapsed(), RECHECKS[0]);
}

#[tokio::test(start_paused = true)]
async fn one_who_may_not_list_crds_or_apiservices_polls_every_minute() {
    let fake = fake();
    fake.state()
        .forbidden
        .extend([CRDS, APISERVICES].map(str::to_owned));
    let cache = tempfile::tempdir().unwrap();
    let mut follower = follower(&fake, cache.path()).await;
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);

    let start = Instant::now();
    fake.state().serve("example.com", "gadgets", "Gadget");
    assert_eq!(names(&next(&mut follower).await), ["namespaces", "gadgets"]);
    assert_eq!(start.elapsed(), POLL);
}

#[tokio::test(start_paused = true)]
async fn a_failed_discovery_tries_again_after_the_longest_backoff() {
    let fake = fake();
    fake.state()
        .forbidden
        .extend(["/apis", CRDS, APISERVICES].map(str::to_owned));
    let cache = tempfile::tempdir().unwrap();
    let mut follower = follower(&fake, cache.path()).await;
    assert_eq!(failure(&next(&mut follower).await), ErrorKind::Forbidden);

    let start = Instant::now();
    fake.state().forbidden.remove("/apis");
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);
    assert_eq!(start.elapsed(), RETRY_WITHIN);
}

#[tokio::test(start_paused = true)]
async fn unauthorized_discovery_waits_for_another_follower() {
    let fake = fake();
    fake.state().unauthorized.insert("/apis".to_owned());
    let cache = tempfile::tempdir().unwrap();
    let mut follower = follower(&fake, cache.path()).await;
    assert_eq!(failure(&next(&mut follower).await), ErrorKind::Unauthorized);

    fake.state().unauthorized.clear();
    let before = asked(&fake, "/apis");
    assert!(
        timeout(Duration::from_secs(600), follower.next())
            .await
            .is_err()
    );
    assert_eq!(asked(&fake, "/apis"), before);
    let mut another = self::follower(&fake, cache.path()).await;
    assert_eq!(names(&next(&mut another).await), ["namespaces"]);
}

#[tokio::test(start_paused = true)]
async fn replaced_clients_ask_again_at_once() {
    let fake = fake();
    let current = Arc::new(Mutex::new(Ok(fake.clients(Budgets::default()))));
    let cache = tempfile::tempdir().unwrap();
    let mut follower = over(Hub::new(swapping(&current)), cache.path()).await;
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);

    let start = Instant::now();
    fake.state().serve("example.com", "gadgets", "Gadget");
    rebuild(&current, Ok(fake.clients(Budgets::default())));
    assert_eq!(names(&next(&mut follower).await), ["namespaces", "gadgets"]);
    assert_eq!(start.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn a_timed_out_credential_plugin_waits_for_another_follower() {
    let fake = fake();
    fake.state().plugin_timed_out = true;
    let cache = tempfile::tempdir().unwrap();
    let mut follower = follower(&fake, cache.path()).await;
    assert_eq!(failure(&next(&mut follower).await), ErrorKind::Timeout);

    fake.state().plugin_timed_out = false;
    let before = asked(&fake, "/apis");
    assert!(
        timeout(Duration::from_secs(600), follower.next())
            .await
            .is_err()
    );
    assert_eq!(asked(&fake, "/apis"), before);
}

#[tokio::test(start_paused = true)]
async fn a_failed_refresh_keeps_the_resources_it_knew() {
    let fake = fake();
    let cache = tempfile::tempdir().unwrap();
    let mut follower = follower(&fake, cache.path()).await;
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);

    let start = Instant::now();
    fake.state().forbidden.insert("/apis".to_owned());
    fake.state().serve("example.com", "gadgets", "Gadget");
    fake.add("customresourcedefinitions", None, "gadgets.example.com");
    tokio::spawn({
        let fake = fake.clone();
        async move {
            sleep(Duration::from_secs(3)).await;
            fake.state().forbidden.clear();
        }
    });
    assert_eq!(names(&next(&mut follower).await), ["namespaces", "gadgets"]);
    assert_eq!(start.elapsed(), RECHECKS[0] + RETRY_WITHIN);
}

#[tokio::test(start_paused = true)]
async fn a_refused_start_fails_rather_than_trust_the_cache() {
    let fake = fake();
    fake.state().serve("example.com", "widgets", "Widget");
    let cache = tempfile::tempdir().unwrap();
    let mut first = follower(&fake, cache.path()).await;
    assert_eq!(names(&next(&mut first).await), ["namespaces", "widgets"]);
    drop(first);

    fake.state().forbidden.insert("/apis".to_owned());
    let mut second = follower(&fake, cache.path()).await;
    assert_eq!(failure(&next(&mut second).await), ErrorKind::Forbidden);
}

#[tokio::test(start_paused = true)]
async fn a_stopped_follower_leaves_rebuilt_clients_to_the_next_one() {
    let fake = fake();
    fake.state().unauthorized.insert("/apis".to_owned());
    let current = Arc::new(Mutex::new(Ok(fake.clients(Budgets::default()))));
    let cache = tempfile::tempdir().unwrap();
    let mut follower = over(Hub::new(swapping(&current)), cache.path()).await;
    assert_eq!(failure(&next(&mut follower).await), ErrorKind::Unauthorized);

    fake.state().unauthorized.clear();
    rebuild(&current, Ok(fake.clients(Budgets::default())));
    let before = asked(&fake, "/apis");
    assert!(
        timeout(Duration::from_secs(600), follower.next())
            .await
            .is_err()
    );
    assert_eq!(asked(&fake, "/apis"), before);
}

#[tokio::test(start_paused = true)]
async fn an_untrusted_plugin_stops_the_follower() {
    let connects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let connect: Connect = {
        let connects = Arc::clone(&connects);
        Arc::new(move |_context| {
            connects.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Box::pin(async {
                Err(IpcError {
                    kind: ErrorKind::Unauthorized,
                    message: "Twigo runs aws only once you trust it".to_owned(),
                })
            })
        })
    };
    let cache = tempfile::tempdir().unwrap();
    let mut follower = over(Hub::new(connect), cache.path()).await;
    assert_eq!(failure(&next(&mut follower).await), ErrorKind::Unauthorized);

    sleep(Duration::from_secs(1)).await;
    let before = connects.load(std::sync::atomic::Ordering::Relaxed);
    assert!(
        timeout(Duration::from_secs(600), follower.next())
            .await
            .is_err()
    );
    assert_eq!(connects.load(std::sync::atomic::Ordering::Relaxed), before);
}

#[tokio::test(start_paused = true)]
async fn clients_that_cannot_be_built_fail_rather_than_show_the_last_server() {
    let fake = fake();
    let current = Arc::new(Mutex::new(Ok(fake.clients(Budgets::default()))));
    let cache = tempfile::tempdir().unwrap();
    let mut follower = over(Hub::new(swapping(&current)), cache.path()).await;
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);

    rebuild(
        &current,
        Err(IpcError {
            kind: ErrorKind::Unavailable,
            message: "no such file: ca.pem".to_owned(),
        }),
    );
    assert_eq!(failure(&next(&mut follower).await), ErrorKind::Unavailable);
}

type Current = Arc<Mutex<Result<Arc<Clients>, IpcError>>>;

fn swapping(current: &Current) -> Connect {
    let current = Arc::clone(current);
    Arc::new(move |_context| {
        let clients = current.lock().unwrap().clone();
        Box::pin(async move { clients })
    })
}

fn rebuild(current: &Current, next: Result<Arc<Clients>, IpcError>) {
    let replaced = std::mem::replace(&mut *current.lock().unwrap(), next);
    if let Ok(replaced) = replaced {
        replaced.connections().abandon();
    }
}

fn fingerprint(server: &str) -> Fingerprint {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kubeconfig");
    std::fs::write(
        &file,
        format!(
            "clusters: [{{ name: c, cluster: {{ server: '{server}' }} }}]
contexts: [{{ name: kind-test, context: {{ cluster: c }} }}]
"
        ),
    )
    .unwrap();
    Sources::explicit(file).load().contexts[0].fingerprint
}

#[tokio::test(start_paused = true)]
async fn a_stopped_follower_restarts_once_its_kubeconfig_entry_changes() {
    let fake = fake();
    fake.state()
        .unauthorized
        .extend(["/apis", CRDS, APISERVICES].map(str::to_owned));
    let (edit, entry) = watch::channel(Some(fingerprint("https://a.example:6443")));
    let cache = tempfile::tempdir().unwrap();
    let mut follower = edited_over(fake.hub(Budgets::default()).0, cache.path(), entry).await;
    assert_eq!(failure(&next(&mut follower).await), ErrorKind::Unauthorized);

    fake.state().unauthorized.clear();
    edit.send_replace(Some(fingerprint("https://b.example:6443")));
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);

    let start = Instant::now();
    fake.state().serve("example.com", "gadgets", "Gadget");
    fake.add("customresourcedefinitions", None, "gadgets.example.com");
    assert_eq!(names(&next(&mut follower).await), ["namespaces", "gadgets"]);
    assert!(start.elapsed() <= RECHECKS[1], "{:?}", start.elapsed());
}

#[tokio::test(start_paused = true)]
async fn clients_refused_for_an_untrusted_plugin_come_once_the_entry_changes() {
    let fake = fake();
    let current = Arc::new(Mutex::new(Err(IpcError {
        kind: ErrorKind::Unauthorized,
        message: "Twigo runs aws only once you trust it".to_owned(),
    })));
    let (edit, entry) = watch::channel(Some(fingerprint("https://a.example:6443")));
    let cache = tempfile::tempdir().unwrap();
    let mut follower = edited_over(Hub::new(swapping(&current)), cache.path(), entry).await;
    assert_eq!(failure(&next(&mut follower).await), ErrorKind::Unauthorized);

    *current.lock().unwrap() = Ok(fake.clients(Budgets::default()));
    edit.send_replace(Some(fingerprint("https://a.example:6443/other")));
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);
}
