use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::{Instant, sleep, timeout};
use twigo_ipc::{Discovered, ErrorKind};
use twigo_kube::client::{Budgets, Clients};
use twigo_kube::discovery::Cache;

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
    Follower::new(hub, Arc::new(Cache::new(cache)), "kind-test".to_owned()).await
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
    let current = Arc::new(Mutex::new(fake.clients(Budgets::default())));
    let connect: Connect = {
        let current = Arc::clone(&current);
        Arc::new(move |_context| {
            let clients: Arc<Clients> = Arc::clone(&current.lock().unwrap());
            Box::pin(async move { Ok(clients) })
        })
    };
    let cache = tempfile::tempdir().unwrap();
    let mut follower = over(Hub::new(connect), cache.path()).await;
    assert_eq!(names(&next(&mut follower).await), ["namespaces"]);

    let start = Instant::now();
    fake.state().serve("example.com", "gadgets", "Gadget");
    let replaced = std::mem::replace(
        &mut *current.lock().unwrap(),
        fake.clients(Budgets::default()),
    );
    replaced.connections().abandon();
    assert_eq!(names(&next(&mut follower).await), ["namespaces", "gadgets"]);
    assert_eq!(start.elapsed(), Duration::ZERO);
}
