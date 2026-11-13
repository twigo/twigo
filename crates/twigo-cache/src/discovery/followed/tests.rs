use std::collections::HashSet;
use std::time::Duration;

use serde_json::json;
use tokio::time::{Instant, sleep, timeout};
use twigo_ipc::Discovered;
use twigo_kube::client::Budgets;

use super::*;
use crate::discovery::RECHECKS;
use crate::fake::{Fake, fingerprint};
use crate::metrics::{GROUP, IN_FLIGHT, Kind, Poller, Scope};

const APIS: &str = "/apis";
const CRDS: &str = "/apis/apiextensions.k8s.io/v1/customresourcedefinitions";
const APISERVICES: &str = "/apis/apiregistration.k8s.io/v1/apiservices";

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

async fn get_under(
    followers: &Followers,
    entry: &watch::Receiver<Option<Fingerprint>>,
) -> Arc<Followed> {
    followers.get("kind-test", async { entry.clone() }).await
}

fn apiservice() -> serde_json::Value {
    json!({
        "kind": "PartialObjectMetadata",
        "apiVersion": "meta.k8s.io/v1",
        "metadata": { "name": "v1beta1.metrics.k8s.io" },
    })
}

fn index_requests(fake: &Fake) -> (usize, usize) {
    let to = |path: &str| {
        fake.state()
            .requests
            .iter()
            .filter(|(_, request)| request.starts_with(path))
            .count()
    };
    (to(CRDS), to(APISERVICES))
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
async fn nothing_is_watched_or_fetched_once_the_last_that_follows_a_context_lets_go() {
    let fake = fake();
    let cache = tempfile::tempdir().unwrap();
    let (followers, _clients) = followers(&fake, cache.path());
    let followed = get(&followers).await;
    let list = get(&followers).await;
    let api = followed.api();
    let mut webview = followed.follow();
    ready(&mut webview).await;
    drop(followed);
    drop(webview);
    sleep(Duration::from_secs(600)).await;
    assert!(fake.watching() > 0, "a list still holds it");
    assert!(index_requests(&fake).0 > 1, "and its watches reopen");

    drop(list);
    sleep(Duration::from_secs(300)).await;
    assert_eq!(
        fake.watching(),
        0,
        "no watch is left once the hub's linger ends"
    );
    assert!(api.has_changed().is_err(), "the follower ended");
    let (indexes, discoveries) = (index_requests(&fake), requests(&fake));
    sleep(Duration::from_secs(3600)).await;
    assert_eq!(
        (index_requests(&fake), requests(&fake)),
        (indexes, discoveries),
        "an hour with no watch and no discovery request"
    );
}

#[tokio::test(start_paused = true)]
async fn following_again_after_nobody_did_holds_the_indexes_and_fetches_discovery_anew() {
    let fake = fake();
    fake.state()
        .unauthorized
        .extend([CRDS, APISERVICES].map(str::to_owned));
    let cache = tempfile::tempdir().unwrap();
    let (followers, _clients) = followers(&fake, cache.path());
    let followed = get(&followers).await;
    let mut webview = followed.follow();
    assert!(matches!(
        ready(&mut webview).await,
        Discovered::Ready { .. }
    ));
    sleep(Duration::from_secs(900)).await;
    drop(webview);
    drop(followed);
    sleep(Duration::from_secs(300)).await;

    fake.state().unauthorized.clear();
    let before = (index_requests(&fake), requests(&fake));
    let followed = get(&followers).await;
    let mut again = followed.follow();
    assert!(matches!(ready(&mut again).await, Discovered::Ready { .. }));
    assert!(
        index_requests(&fake).0 > before.0.0 && index_requests(&fake).1 > before.0.1,
        "the CRDs and the APIServices are listed and watched anew"
    );
    assert!(requests(&fake) > before.1, "discovery is fetched");

    fake.state().serve("example.com", "gadgets", "Gadget");
    fake.add_to(
        "apiextensions.k8s.io",
        "customresourcedefinitions",
        None,
        "gadgets.example.com",
    );
    let Discovered::Ready { resources, .. } = ready(&mut again).await else {
        panic!("ready");
    };
    assert!(
        resources.iter().any(|r| r.gvr.resource == "gadgets"),
        "a CRD installed meanwhile is seen"
    );
}

#[tokio::test(start_paused = true)]
async fn a_context_that_leaves_the_sources_and_returns_keeps_its_one_follower_and_its_one_poller_context()
 {
    let fake = fake();
    for namespace in ["a", "b", "c", "d", "e", "f"] {
        fake.pod_usage(namespace, "p", &[("main", "1m", "1Mi")]);
    }
    fake.state().metrics_takes = Duration::from_secs(1);
    let cache = tempfile::tempdir().unwrap();
    let (followers, _clients) = followers(&fake, cache.path());
    let (edit, entry) = watch::channel(Some(fingerprint("https://a.example:6443")));
    let followed = get_under(&followers, &entry).await;
    let poller = Poller::new(followers.hub.clone());
    let context = poller.context("kind-test", &followed);
    let scopes = |namespaces: [&str; 3]| -> HashSet<Scope> {
        namespaces
            .map(|namespace| Scope::Namespace(namespace.into()))
            .into_iter()
            .collect()
    };
    let mut before = context.reader(Kind::Pods);
    before.want(scopes(["a", "b", "c"]));
    ready(&mut followed.follow()).await;

    edit.send_replace(None);
    sleep(Duration::from_secs(5)).await;
    edit.send_replace(Some(fingerprint("https://a.example:6443")));
    sleep(Duration::from_secs(5)).await;
    let again = get_under(&followers, &entry).await;
    assert!(Arc::ptr_eq(&followed, &again), "one follower per context");
    let next = poller.context("kind-test", &again);
    assert!(Arc::ptr_eq(&context, &next), "and one poller context");
    let mut after = next.reader(Kind::Nodes);
    after.want(HashSet::from([Scope::Cluster]));
    let mut more = next.reader(Kind::Pods);
    more.want(scopes(["d", "e", "f"]));
    sleep(Duration::from_secs(40)).await;
    assert_eq!(
        fake.state().metrics_overlap,
        IN_FLIGHT,
        "the limit holds across the leaving and the return"
    );
    assert!(
        fake.count("namespaces/f/pods") >= 2,
        "and every scope is polled"
    );
}

#[tokio::test(start_paused = true)]
async fn a_metrics_api_that_goes_from_stale_to_absent_and_back_reaches_those_who_read_it() {
    let fake = fake();
    fake.stale_metrics("v1beta1");
    fake.put("apiregistration.k8s.io", "apiservices", None, apiservice());
    let cache = tempfile::tempdir().unwrap();
    let (followers, _clients) = followers(&fake, cache.path());
    let followed = get(&followers).await;
    let mut api = followed.api();
    let mut webview = followed.follow();
    ready(&mut webview).await;
    let stale = Api::Stale { version: "v1beta1" };
    timeout(Duration::from_secs(600), api.wait_for(|api| *api == stale))
        .await
        .expect("stale")
        .unwrap();

    fake.state().served.remove(GROUP);
    fake.delete_from(
        "apiregistration.k8s.io",
        "apiservices",
        None,
        "v1beta1.metrics.k8s.io",
    );
    timeout(
        Duration::from_secs(600),
        api.wait_for(|api| *api == Api::Absent),
    )
    .await
    .expect("metrics-server uninstalled while it was down")
    .unwrap();

    fake.stale_metrics("v1beta1");
    fake.put("apiregistration.k8s.io", "apiservices", None, apiservice());
    timeout(Duration::from_secs(600), api.wait_for(|api| *api == stale))
        .await
        .expect("metrics-server installed but never ready")
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_follower_started_again_begins_from_what_its_predecessor_confirmed_and_corrects_it() {
    let fake = fake();
    let cache = tempfile::tempdir().unwrap();
    let (followers, _clients) = followers(&fake, cache.path());
    let (edit, entry) = watch::channel(Some(fingerprint("https://a.example:6443")));
    let first = get_under(&followers, &entry).await;
    ready(&mut first.follow()).await;
    assert!(first.api().borrow().columns(Kind::Pods));
    drop(first);
    sleep(Duration::from_secs(300)).await;

    fake.state().discovery_hangs = true;
    let second = get_under(&followers, &entry).await;
    assert!(
        second.api().borrow().columns(Kind::Pods),
        "its first state is the last one confirmed"
    );
    let mut resources = second.follow();
    assert!(matches!(resources.next().await, Discovered::Pending { .. }));
    sleep(Duration::from_secs(600)).await;
    assert!(
        second.api().borrow().columns(Kind::Pods),
        "the cluster's name and a discovery that does not answer say nothing against it"
    );
    drop(resources);
    drop(second);
    fake.state().discovery_hangs = false;
    sleep(Duration::from_secs(300)).await;

    fake.state().served.remove(GROUP);
    let third = get_under(&followers, &entry).await;
    let mut api = third.api();
    assert!(api.borrow().columns(Kind::Pods), "kept");
    ready(&mut third.follow()).await;
    api.wait_for(|api| *api == Api::Absent)
        .await
        .expect("the follower corrects what the cluster changed meanwhile");
    drop(third);
    sleep(Duration::from_secs(300)).await;

    fake.serve_metrics("v1beta1");
    let fourth = get_under(&followers, &entry).await;
    let mut api = fourth.api();
    ready(&mut fourth.follow()).await;
    api.wait_for(|api| api.columns(Kind::Pods)).await.unwrap();
    drop(fourth);
    sleep(Duration::from_secs(300)).await;

    edit.send_replace(Some(fingerprint("https://b.example:6443")));
    let moved = get_under(&followers, &entry).await;
    assert_eq!(
        *moved.api().borrow(),
        Api::Absent,
        "nothing kept for another fingerprint is used"
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
