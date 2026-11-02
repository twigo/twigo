use std::time::Duration;

use tokio::time::sleep;
use twigo_ipc::ViewState;
use twigo_kube::client::Budgets;

use super::*;
use crate::fake::Fake;
use crate::upstream::IDLE;

fn pods() -> Resource {
    Resource {
        group: String::new(),
        version: "v1".to_owned(),
        resource: "pods".to_owned(),
        namespaced: true,
    }
}

fn query(namespaces: &[&str]) -> Query {
    Query {
        context: "kind-test".to_owned(),
        resource: pods(),
        format: RowFormat::Metadata,
        namespaces: namespaces
            .iter()
            .map(|&namespace| namespace.to_owned())
            .collect(),
        field_selector: None,
    }
}

fn namespace(name: &str) -> Scope {
    Scope::Namespace(name.to_owned())
}

fn budget(watches: usize) -> Budgets {
    Budgets {
        watches,
        ..Budgets::default()
    }
}

async fn until<T: Item>(subscription: &mut Subscription<T>, wanted: impl Fn(&ViewState) -> bool) {
    let reached = async {
        while !wanted(&subscription.state()) {
            subscription.changed().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(600), reached)
        .await
        .expect("the state within ten minutes");
}

async fn ready<T: Item>(subscription: &mut Subscription<T>) {
    until(subscription, |state| *state == ViewState::Ready).await;
}

fn names(subscription: &Subscription<Row>) -> Vec<String> {
    let mut names: Vec<String> = subscription
        .items()
        .iter()
        .map(|row| row.meta.name.to_string())
        .collect();
    names.sort();
    names
}

/// Lets every task that can run, run.
async fn settle() {
    sleep(Duration::from_millis(1)).await;
}

#[tokio::test(start_paused = true)]
async fn an_upstream_lingers_after_its_last_subscription_then_stops() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut first = hub.rows(query(&["a"])).await;
    ready(&mut first).await;
    assert_eq!(names(&first), ["p1"]);
    drop(first);

    sleep(LINGER - Duration::from_secs(1)).await;
    assert_eq!(hub.scopes(), [namespace("a")]);
    let again = hub.rows(query(&["a"])).await;
    assert_eq!(
        again.state(),
        ViewState::Ready,
        "the lingering upstream serves at once"
    );
    assert_eq!(names(&again), ["p1"]);
    assert_eq!(fake.count("watch=true"), 1);

    drop(again);
    fake.bookmark();
    sleep(LINGER - Duration::from_secs(1)).await;
    assert_eq!(hub.scopes(), [namespace("a")], "the linger started anew");
    sleep(Duration::from_secs(2)).await;
    settle().await;
    assert!(hub.scopes().is_empty());
    assert_eq!(fake.watching(), 0, "its watch closed");
}

#[tokio::test(start_paused = true)]
async fn a_watch_over_the_budget_evicts_the_least_recently_used_idle_upstream() {
    let fake = Fake::default();
    let (hub, clients) = fake.hub(budget(2));
    let mut a = hub.rows(query(&["a"])).await;
    ready(&mut a).await;
    let mut b = hub.rows(query(&["b"])).await;
    ready(&mut b).await;
    drop(a);
    sleep(Duration::from_secs(1)).await;
    drop(b);

    let mut c = hub.rows(query(&["c"])).await;
    ready(&mut c).await;
    settle().await;
    assert_eq!(hub.scopes(), [namespace("b"), namespace("c")]);
    assert_eq!(clients.usage().borrow().watches.held, 2);
}

#[tokio::test(start_paused = true)]
async fn with_nothing_idle_a_watch_stays_queued_until_one_lingers() {
    let fake = Fake::default();
    let (hub, _clients) = fake.hub(budget(1));
    let mut a = hub.rows(query(&["a"])).await;
    ready(&mut a).await;
    let mut b = hub.rows(query(&["b"])).await;
    until(&mut b, |state| *state == ViewState::Queued).await;
    sleep(Duration::from_secs(30)).await;
    assert_eq!(b.state(), ViewState::Queued, "nothing to evict");

    drop(a);
    ready(&mut b).await;
    settle().await;
    assert_eq!(
        hub.scopes(),
        [namespace("b")],
        "the idle one made way at once"
    );
}

#[tokio::test(start_paused = true)]
async fn a_lingering_cluster_wide_upstream_serves_narrower_subscriptions() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    fake.add("pods", Some("b"), "p2");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut all = hub.rows(query(&[])).await;
    ready(&mut all).await;
    assert_eq!(names(&all), ["p1", "p2"]);

    let mut narrow = hub.rows(query(&["a"])).await;
    assert_eq!(narrow.state(), ViewState::Ready);
    assert_eq!(names(&narrow), ["p1"], "filtered in Rust");
    assert_eq!(hub.scopes(), [Scope::Cluster], "no upstream of its own");

    drop(all);
    let back = hub.rows(query(&[])).await;
    assert_eq!(back.state(), ViewState::Ready, "going back costs nothing");
    drop(back);
    fake.bookmark();
    sleep(LINGER - Duration::from_secs(1)).await;
    assert_eq!(hub.scopes(), [Scope::Cluster], "it serves while it lingers");
    assert_eq!(fake.count("watch=true"), 1);

    sleep(Duration::from_secs(2)).await;
    narrow.changed().await;
    settle().await;
    assert_eq!(hub.scopes(), [namespace("a")], "moved off once it lingered");
    assert_eq!(names(&narrow), ["p1"]);
    assert_eq!(narrow.state(), ViewState::Ready);
    fake.add("pods", Some("a"), "p3");
    settle().await;
    assert_eq!(names(&narrow), ["p1", "p3"]);
}

#[tokio::test(start_paused = true)]
async fn more_than_four_namespaces_watch_cluster_wide_only_if_the_person_may_list() {
    let five = ["a", "b", "c", "d", "e"];
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    fake.add("pods", Some("f"), "p2");
    fake.state().may_list = true;
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut wide = hub.rows(query(&five)).await;
    ready(&mut wide).await;
    assert_eq!(hub.scopes(), [Scope::Cluster]);
    assert_eq!(names(&wide), ["p1"], "f is not among them");

    let fake = Fake::default();
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut narrow = hub.rows(query(&five)).await;
    ready(&mut narrow).await;
    let scopes: Vec<Scope> = five.iter().map(|name| namespace(name)).collect();
    assert_eq!(hub.scopes(), scopes);
    assert_eq!(fake.count("selfsubjectaccessreviews"), 1);
    drop(narrow);
    let again = hub.rows(query(&five)).await;
    assert_eq!(again.state(), ViewState::Ready);
    assert_eq!(
        fake.count("selfsubjectaccessreviews"),
        1,
        "the review is kept"
    );
}

#[tokio::test(start_paused = true)]
async fn failures_back_off_from_half_a_second_to_five_and_events_reset_it() {
    let fake = Fake::default();
    fake.state().unavailable = 6;
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await;
    until(&mut pods, |state| *state == ViewState::Connecting).await;
    ready(&mut pods).await;
    let gaps = |fake: &Fake| -> Vec<Duration> {
        let state = fake.state();
        state
            .requests
            .windows(2)
            .map(|pair| pair[1].0 - pair[0].0)
            .collect()
    };
    let bounds = [
        (0.5, 1.0),
        (1.0, 2.0),
        (2.0, 4.0),
        (2.5, 5.0),
        (2.5, 5.0),
        (2.5, 5.0),
    ];
    let seen = gaps(&fake);
    assert_eq!(seen.len(), bounds.len());
    for (gap, (low, high)) in seen.iter().zip(bounds) {
        let gap = gap.as_secs_f64();
        assert!((low..high).contains(&gap), "{gap} s outside {low}–{high} s");
    }

    fake.state().unavailable = 1;
    fake.state().requests.clear();
    fake.end_watches();
    until(&mut pods, |state| *state == ViewState::Stale).await;
    ready(&mut pods).await;
    let after = gaps(&fake);
    assert_eq!(after.len(), 1);
    assert!(
        (0.5..1.0).contains(&after[0].as_secs_f64()),
        "the events since reset it"
    );
}

#[tokio::test(start_paused = true)]
async fn a_quiet_watch_probes_the_connection_before_it_watches_again() {
    let fake = Fake::default();
    let (hub, clients) = fake.hub(Budgets::default());
    let retired = clients.connections().retired();
    let mut a = hub.rows(query(&["a"])).await;
    ready(&mut a).await;
    sleep(IDLE / 2).await;
    let mut b = hub.rows(query(&["b"])).await;
    ready(&mut b).await;
    let resumed = |namespace: &str| {
        fake.count(&format!("namespaces/{namespace}/pods?watch=true&allowWatchBookmarks=true&timeoutSeconds=290&resourceVersion="))
    };

    sleep(IDLE / 2 + Duration::from_secs(1)).await;
    assert_eq!(fake.count("/version"), 1, "a went quiet");
    assert_eq!((resumed("a"), resumed("b")), (1, 0), "only a watches again");
    assert_eq!(*retired.borrow(), 0);
    assert_eq!(a.state(), ViewState::Ready);

    fake.state().dead = true;
    sleep(IDLE / 2).await;
    settle().await;
    assert_eq!(fake.count("/version"), 2, "b went quiet");
    assert_eq!(*retired.borrow(), 1, "its probe failed: retired once");
    assert_eq!(
        (resumed("a"), resumed("b")),
        (2, 1),
        "every upstream watches again"
    );
}

#[tokio::test(start_paused = true)]
async fn a_watch_resumed_from_a_compacted_version_relists_with_its_rows() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await;
    ready(&mut pods).await;

    fake.add("pods", Some("a"), "p2");
    settle().await;
    {
        let mut state = fake.state();
        state.compacted = u64::MAX;
        state.hold_initial = true;
    }
    fake.end_watches();
    until(&mut pods, |state| *state == ViewState::Relisting).await;
    assert_eq!(
        names(&pods),
        ["p1", "p2"],
        "a relist keeps the rows it replaces"
    );

    fake.delete("pods", Some("a"), "p1");
    fake.state().compacted = 0;
    fake.release_initial();
    ready(&mut pods).await;
    assert_eq!(names(&pods), ["p2"], "the relist's rows replace them");
    assert_eq!(fake.count("sendInitialEvents"), 2);
}

#[tokio::test(start_paused = true)]
async fn a_cluster_without_streaming_lists_is_listed_in_pages_once_it_said_so() {
    let fake = Fake::default();
    fake.state().no_streaming = true;
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut a = hub.rows(query(&["a"])).await;
    ready(&mut a).await;
    assert_eq!(names(&a), ["p1"]);
    let mut b = hub.rows(query(&["b"])).await;
    ready(&mut b).await;
    assert_eq!(fake.count("sendInitialEvents"), 1);
    assert_eq!(fake.count("limit=500"), 2);
    fake.add("pods", Some("a"), "p2");
    settle().await;
    assert_eq!(names(&a), ["p1", "p2"], "watched from the list's version");
}

#[tokio::test(start_paused = true)]
async fn a_forbidden_upstream_retries_until_it_is_allowed() {
    let fake = Fake::default();
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/a/pods".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await;
    let forbidden = ViewState::Forbidden {
        verb: "watch".to_owned(),
        resource: "pods".to_owned(),
    };
    until(&mut pods, |state| *state == forbidden).await;
    sleep(Duration::from_secs(30)).await;
    let tries = fake.count("namespaces/a/pods");
    assert!((6..=60).contains(&tries), "{tries} tries in 30 s");
    assert_eq!(pods.state(), forbidden);

    fake.state().forbidden.clear();
    ready(&mut pods).await;
}

#[tokio::test(start_paused = true)]
async fn rejected_credentials_wait_to_be_subscribed_again() {
    let fake = Fake::default();
    fake.state()
        .unauthorized
        .insert("/api/v1/namespaces/a/pods".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await;
    until(&mut pods, |state| *state == ViewState::Unauthorized).await;
    sleep(Duration::from_secs(30)).await;
    assert_eq!(
        fake.count("namespaces/a/pods"),
        1,
        "no retry, which would run a plugin by itself"
    );

    fake.state().unauthorized.clear();
    let mut again = hub.rows(query(&["a"])).await;
    ready(&mut again).await;
    assert_eq!(
        pods.state(),
        ViewState::Ready,
        "both share the restarted upstream"
    );
}

#[tokio::test(start_paused = true)]
async fn a_cluster_scoped_resource_ignores_namespaces() {
    let fake = Fake::default();
    fake.add("namespaces", None, "a");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut query = query(&["a", "b"]);
    query.resource = Resource {
        resource: "namespaces".to_owned(),
        namespaced: false,
        ..pods()
    };
    let mut namespaces = hub.rows(query).await;
    ready(&mut namespaces).await;
    assert_eq!(hub.scopes(), [Scope::Cluster]);
    assert_eq!(names(&namespaces), ["a"]);
}

#[test]
fn parts_combine_into_their_least_ready_state() {
    let syncing = |loaded| ViewState::Syncing { loaded };
    assert_eq!(
        combine([ViewState::Ready, syncing(2), syncing(3), ViewState::Stale].into_iter()),
        syncing(5)
    );
    assert_eq!(
        combine([ViewState::Queued, ViewState::Unauthorized].into_iter()),
        ViewState::Unauthorized
    );
    assert_eq!(combine(std::iter::empty()), ViewState::Ready);
}
