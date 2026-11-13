use std::collections::HashSet;
use std::time::Duration;

use tokio::time::{Instant, timeout};
use twigo_ipc::Discovered;
use twigo_kube::client::Budgets;

use super::*;
use crate::discovery::RECHECKS;
use crate::fake::Fake;
use crate::metrics::Kind;

const APIS: &str = "/apis";

fn fake() -> Fake {
    let fake = Fake::default();
    fake.state().serve("", "namespaces", "Namespace");
    fake.serve_metrics("v1beta1");
    fake
}

fn followers(
    fake: &Fake,
    cache: &std::path::Path,
) -> (Followers, Arc<twigo_kube::client::Clients>) {
    let (hub, clients) = fake.hub(Budgets::default());
    (Followers::new(hub, Arc::new(Cache::new(cache))), clients)
}

async fn get(followers: &Followers) -> Arc<Followed> {
    followers
        .get("kind-test", async { watch::channel(None).1 })
        .await
}

async fn ready(resources: &mut Resources) -> Discovered {
    let answered = async {
        loop {
            match resources.next().await {
                Discovered::Pending { .. } => {}
                answer => return answer,
            }
        }
    };
    timeout(Duration::from_secs(600), answered)
        .await
        .expect("discovery within ten minutes")
}

fn requests(fake: &Fake) -> usize {
    fake.state()
        .requests
        .iter()
        .filter(|(_, request)| request == APIS)
        .count()
}

#[tokio::test(start_paused = true)]
async fn every_watch_and_every_list_of_a_context_share_one_follower_and_its_requests() {
    let fake = fake();
    let cache = tempfile::tempdir().unwrap();
    let (followers, _clients) = followers(&fake, cache.path());
    let first = get(&followers).await;
    let mut webview = first.follow();
    let mut other = first.follow();
    assert!(matches!(
        ready(&mut webview).await,
        Discovered::Ready { .. }
    ));
    assert!(matches!(ready(&mut other).await, Discovered::Ready { .. }));
    let list = get(&followers).await;
    assert!(Arc::ptr_eq(&first, &list), "one follower per context");
    assert!(list.api().borrow().columns(Kind::Pods));
    tokio::time::sleep(Duration::from_secs(30)).await;
    let before = requests(&fake);

    fake.state().serve("example.com", "gadgets", "Gadget");
    fake.add_to(
        "apiextensions.k8s.io",
        "customresourcedefinitions",
        None,
        "gadgets.example.com",
    );
    for resources in [&mut webview, &mut other] {
        let Discovered::Ready { resources, .. } = ready(resources).await else {
            panic!("ready");
        };
        assert!(resources.iter().any(|r| r.gvr.resource == "gadgets"));
    }
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(
        requests(&fake) - before,
        1 + RECHECKS.len(),
        "a change costs what it costs one follower, for all of them"
    );
}

#[tokio::test(start_paused = true)]
async fn a_watch_that_comes_later_hears_what_is_known_at_once_and_asks_nothing() {
    let fake = fake();
    let cache = tempfile::tempdir().unwrap();
    let (followers, _clients) = followers(&fake, cache.path());
    let followed = get(&followers).await;
    ready(&mut followed.follow()).await;
    tokio::time::sleep(Duration::from_secs(30)).await;
    let asked = requests(&fake);

    let started = Instant::now();
    let mut later = followed.follow();
    let heard = timeout(Duration::from_secs(1), later.next()).await.unwrap();
    assert!(matches!(heard, Discovered::Ready { .. }));
    assert_eq!(started.elapsed(), Duration::ZERO);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(requests(&fake), asked, "following again fetches nothing");
}

#[tokio::test(start_paused = true)]
async fn the_fact_outlives_the_watches_and_ends_with_the_context() {
    let fake = fake();
    let cache = tempfile::tempdir().unwrap();
    let (followers, _clients) = followers(&fake, cache.path());
    let followed = get(&followers).await;
    ready(&mut followed.follow()).await;
    let api = followed.api();
    drop(followed);
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert!(
        api.borrow().columns(Kind::Pods),
        "kept with no watch and no list"
    );

    followers.keep(&HashSet::from(["kind-test".to_owned()]));
    let kept = get(&followers).await;
    assert!(api.same_channel(&kept.api()));

    followers.keep(&HashSet::from(["other".to_owned()]));
    drop(kept);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        api.has_changed().is_err(),
        "the follower ended with the context's listing"
    );
}

#[tokio::test(start_paused = true)]
async fn following_again_makes_a_follower_that_a_failed_credential_stopped_fetch_again() {
    let fake = fake();
    fake.state().unauthorized.insert(APIS.to_owned());
    let cache = tempfile::tempdir().unwrap();
    let (followers, _clients) = followers(&fake, cache.path());
    let followed = get(&followers).await;
    let mut webview = followed.follow();
    let Discovered::Failed { error } = ready(&mut webview).await else {
        panic!("failed");
    };
    assert_eq!(error.kind, twigo_ipc::ErrorKind::Unauthorized);

    fake.state().unauthorized.clear();
    let stopped = requests(&fake);
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(requests(&fake), stopped, "it waits to be followed again");

    let mut again = followed.follow();
    assert!(matches!(ready(&mut again).await, Discovered::Failed { .. }));
    assert!(
        matches!(ready(&mut again).await, Discovered::Ready { .. }),
        "and then the cluster answers"
    );
    assert!(followed.api().borrow().columns(Kind::Pods));
}
