use std::time::Duration;

use tokio::time::{Instant, sleep};
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

async fn until_rows(subscription: &mut Subscription<Row>, wanted: &[&str]) {
    let reached = async {
        while names(subscription) != wanted {
            subscription.changed().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(600), reached)
        .await
        .expect("the rows within ten minutes");
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
    let mut first = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut first).await;
    assert_eq!(names(&first), ["p1"]);
    drop(first);

    sleep(LINGER - Duration::from_secs(1)).await;
    assert_eq!(hub.scopes(), [namespace("a")]);
    let again = hub.rows(query(&["a"])).await.unwrap();
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
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut a).await;
    let mut b = hub.rows(query(&["b"])).await.unwrap();
    ready(&mut b).await;
    drop(a);
    sleep(Duration::from_secs(1)).await;
    drop(b);

    let asked = Instant::now();
    let mut c = hub.rows(query(&["c"])).await.unwrap();
    ready(&mut c).await;
    assert!(
        asked.elapsed() < Duration::from_secs(1),
        "an eviction, not a linger, made room"
    );
    settle().await;
    assert_eq!(hub.scopes(), [namespace("b"), namespace("c")]);
    assert_eq!(clients.usage().borrow().watches.held, 2);
}

#[tokio::test(start_paused = true)]
async fn with_nothing_idle_a_watch_stays_queued_until_one_lingers() {
    let fake = Fake::default();
    let (hub, _clients) = fake.hub(budget(1));
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut a).await;
    let mut b = hub.rows(query(&["b"])).await.unwrap();
    until(&mut b, |state| *state == ViewState::Queued).await;
    sleep(Duration::from_secs(30)).await;
    assert_eq!(b.state(), ViewState::Queued, "nothing to evict");

    let dropped = Instant::now();
    drop(a);
    ready(&mut b).await;
    assert!(
        dropped.elapsed() < Duration::from_secs(1),
        "the idle one made way at once"
    );
    settle().await;
    assert_eq!(hub.scopes(), [namespace("b")]);
}

#[tokio::test(start_paused = true)]
async fn only_an_upstream_that_holds_a_watch_is_evicted() {
    let fake = Fake::default();
    fake.state()
        .unauthorized
        .insert("/api/v1/namespaces/x/pods".to_owned());
    let (hub, _clients) = fake.hub(budget(1));
    let mut x = hub.rows(query(&["x"])).await.unwrap();
    until(&mut x, |state| *state == ViewState::Unauthorized).await;
    drop(x);
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut a).await;
    let mut b = hub.rows(query(&["b"])).await.unwrap();
    until(&mut b, |state| *state == ViewState::Queued).await;
    assert!(
        hub.scopes().contains(&namespace("x")),
        "x holds no watch: evicting it frees none"
    );

    let dropped = Instant::now();
    drop(a);
    ready(&mut b).await;
    assert!(dropped.elapsed() < Duration::from_secs(1), "a made way");
}

#[tokio::test(start_paused = true)]
async fn the_watch_that_waited_longest_gets_the_freed_one() {
    let fake = Fake::default();
    let (hub, _clients) = fake.hub(budget(1));
    let mut held = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut held).await;
    let mut waiting = Vec::new();
    for namespace in ["b", "c", "d", "e"] {
        let mut next = hub.rows(query(&[namespace])).await.unwrap();
        until(&mut next, |state| *state == ViewState::Queued).await;
        waiting.push(next);
        sleep(Duration::from_secs(1)).await;
    }
    for mut next in waiting {
        let dropped = Instant::now();
        drop(held);
        ready(&mut next).await;
        assert!(
            dropped.elapsed() < Duration::from_secs(1),
            "the one that left made way for the next at once"
        );
        held = next;
    }
}

#[tokio::test(start_paused = true)]
async fn a_queued_watch_nobody_shows_gives_up_its_place() {
    let fake = Fake::default();
    let (hub, _clients) = fake.hub(budget(1));
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut a).await;
    let mut b = hub.rows(query(&["b"])).await.unwrap();
    until(&mut b, |state| *state == ViewState::Queued).await;
    drop(b);
    let mut c = hub.rows(query(&["c"])).await.unwrap();
    until(&mut c, |state| *state == ViewState::Queued).await;

    let dropped = Instant::now();
    drop(a);
    ready(&mut c).await;
    assert!(
        dropped.elapsed() < Duration::from_secs(1),
        "b, which nobody shows, did not take the freed watch"
    );
    settle().await;
    assert_eq!(hub.scopes(), [namespace("c")]);
}

#[tokio::test(start_paused = true)]
async fn a_watch_that_queues_once_nobody_shows_it_gives_up_its_place() {
    let fake = Fake::default();
    let (hub, _clients) = fake.hub(budget(1));
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut a).await;
    let left = hub.rows(query(&["l"])).await.unwrap();
    drop(left);
    settle().await;
    let mut b = hub.rows(query(&["b"])).await.unwrap();
    until(&mut b, |state| *state == ViewState::Queued).await;

    let dropped = Instant::now();
    drop(a);
    ready(&mut b).await;
    assert!(
        dropped.elapsed() < Duration::from_secs(1),
        "l, which queued after its view left, took no watch"
    );
    settle().await;
    assert_eq!(hub.scopes(), [namespace("b")]);
}

#[tokio::test(start_paused = true)]
async fn a_borrowed_upstream_that_waits_goes_with_its_last_borrower() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(budget(1));
    let mut all = hub.rows(query(&[])).await.unwrap();
    ready(&mut all).await;
    let narrow = hub.rows(query(&["a"])).await.unwrap();
    drop(all);
    // Another resource, which no pods upstream serves.
    let mut secrets = query(&["b"]);
    secrets.resource.resource = "secrets".to_owned();
    let mut b = hub.rows(secrets).await.unwrap();
    until(&mut b, |state| *state == ViewState::Queued).await;
    fake.end_watches();
    ready(&mut b).await;
    settle().await;
    assert_eq!(
        narrow.state(),
        ViewState::Queued,
        "its watch waits behind b's"
    );
    assert_eq!(hub.scopes(), [Scope::Cluster, namespace("b")]);

    drop(narrow);
    settle().await;
    assert_eq!(hub.scopes(), [namespace("b")], "it goes at once");
}

/// On one worker, a run started inside a task takes the worker's next
/// slot before the cancel of the run it replaces, so the old run's word
/// that it stopped waiting comes after the new one's that it waits.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn a_stopped_run_does_not_speak_for_its_successor() {
    let fake = Fake::default();
    let (hub, _clients) = fake.hub(budget(1));
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut a).await;
    let mut k = hub.rows(query(&["k"])).await.unwrap();
    until(&mut k, |state| *state == ViewState::Queued).await;
    let again = tokio::spawn({
        let hub = hub.clone();
        async move {
            drop(k);
            hub.rows(query(&["k"])).await.unwrap()
        }
    });
    let mut k = again.await.unwrap();
    until(&mut k, |state| *state == ViewState::Queued).await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    drop(a);
    tokio::time::timeout(Duration::from_secs(3), ready(&mut k))
        .await
        .expect("a made way for the new run at once");
}

#[tokio::test(start_paused = true)]
async fn the_linger_of_an_evicted_upstream_leaves_its_successor_alone() {
    let fake = Fake::default();
    let (hub, _clients) = fake.hub(budget(1));
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut a).await;
    drop(a);
    sleep(Duration::from_secs(1)).await;
    let mut b = hub.rows(query(&["b"])).await.unwrap();
    ready(&mut b).await;
    assert_eq!(hub.scopes(), [namespace("b")], "b evicted a");
    drop(b);
    sleep(Duration::from_secs(1)).await;
    let mut again = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut again).await;
    sleep(Duration::from_secs(28)).await;
    drop(again);

    sleep(Duration::from_secs(31)).await;
    assert_eq!(
        hub.scopes(),
        [namespace("a")],
        "the first linger's timer fired, and left the new one be"
    );
    sleep(Duration::from_secs(30)).await;
    settle().await;
    assert!(hub.scopes().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_resource_the_server_cannot_watch_is_listed_again() {
    let fake = Fake::default();
    fake.state().unwatchable.insert("pods".to_owned());
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    assert_eq!(names(&pods), ["p1"]);
    fake.add("pods", Some("a"), "p2");
    let added = Instant::now();
    until_rows(&mut pods, &["p1", "p2"]).await;
    assert!(added.elapsed() <= Duration::from_secs(15));
    assert_eq!(
        pods.state(),
        ViewState::Ready,
        "between lists, no relisting"
    );
}

#[tokio::test(start_paused = true)]
async fn a_lingering_cluster_wide_upstream_serves_narrower_subscriptions() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    fake.add("pods", Some("b"), "p2");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut all = hub.rows(query(&[])).await.unwrap();
    ready(&mut all).await;
    assert_eq!(names(&all), ["p1", "p2"]);

    let mut narrow = hub.rows(query(&["a"])).await.unwrap();
    assert_eq!(narrow.state(), ViewState::Ready);
    assert_eq!(names(&narrow), ["p1"], "filtered in Rust");
    assert_eq!(hub.scopes(), [Scope::Cluster], "no upstream of its own");

    drop(all);
    let back = hub.rows(query(&[])).await.unwrap();
    assert_eq!(back.state(), ViewState::Ready, "going back costs nothing");
    drop(back);
    fake.bookmark();
    sleep(LINGER - Duration::from_secs(1)).await;
    assert_eq!(hub.scopes(), [Scope::Cluster], "it serves while it lingers");
    assert_eq!(fake.count("watch=true"), 1);

    {
        let mut state = fake.state();
        state.hold_initial = true;
        state.unavailable = 1;
    }
    sleep(Duration::from_secs(2)).await;
    assert_eq!(
        hub.scopes(),
        [Scope::Cluster, namespace("a")],
        "its own upstream lists while it lingers on"
    );
    assert_eq!(names(&narrow), ["p1"], "the borrowed rows until then");
    assert_eq!(narrow.state(), ViewState::Ready);
    sleep(Duration::from_secs(5)).await;
    assert_eq!(
        hub.scopes(),
        [Scope::Cluster, namespace("a")],
        "a first list that broke has not listed"
    );

    fake.release_initial();
    narrow.changed().await;
    settle().await;
    assert_eq!(hub.scopes(), [namespace("a")], "moved off once it listed");
    assert_eq!(names(&narrow), ["p1"]);
    assert_eq!(narrow.state(), ViewState::Ready);
    fake.add("pods", Some("a"), "p3");
    until_rows(&mut narrow, &["p1", "p3"]).await;
}

#[tokio::test(start_paused = true)]
async fn more_than_four_namespaces_watch_cluster_wide_only_if_the_person_may_list() {
    let five = ["a", "b", "c", "d", "e"];
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    fake.add("pods", Some("f"), "p2");
    fake.state().may_list = true;
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut wide = hub.rows(query(&five)).await.unwrap();
    ready(&mut wide).await;
    assert_eq!(hub.scopes(), [Scope::Cluster]);
    assert_eq!(names(&wide), ["p1"], "f is not among them");

    let fake = Fake::default();
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut narrow = hub.rows(query(&five)).await.unwrap();
    ready(&mut narrow).await;
    let scopes: Vec<Scope> = five.iter().map(|name| namespace(name)).collect();
    assert_eq!(hub.scopes(), scopes);
    assert_eq!(fake.count("selfsubjectaccessreviews"), 1);
    drop(narrow);
    let again = hub.rows(query(&five)).await.unwrap();
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
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
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
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut a).await;
    sleep(IDLE / 2).await;
    let mut b = hub.rows(query(&["b"])).await.unwrap();
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
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
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
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut a).await;
    assert_eq!(names(&a), ["p1"]);
    let mut b = hub.rows(query(&["b"])).await.unwrap();
    ready(&mut b).await;
    assert_eq!(fake.count("sendInitialEvents"), 1);
    assert_eq!(fake.count("limit=500"), 2);
    fake.add("pods", Some("a"), "p2");
    settle().await;
    assert_eq!(names(&a), ["p1", "p2"], "watched from the list's version");
}

#[tokio::test(start_paused = true)]
async fn a_list_in_pages_follows_its_continue_tokens() {
    let fake = Fake::default();
    fake.state().no_streaming = true;
    for index in 0..1200 {
        fake.add("pods", Some("a"), &format!("p{index:04}"));
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    assert_eq!(pods.items().len(), 1200);
    assert_eq!(fake.count("limit=500"), 3);
    assert_eq!(fake.count("continue=1200%3A500"), 1);
    assert_eq!(fake.count("continue=1200%3A1000"), 1);
    assert_eq!(
        fake.count("resourceVersion=1200"),
        1,
        "watched from the list's version"
    );
}

#[tokio::test(start_paused = true)]
async fn a_forbidden_upstream_retries_until_it_is_allowed() {
    let fake = Fake::default();
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/a/pods".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    let forbidden = ViewState::Forbidden {
        verb: "watch".to_owned(),
        resource: "pods".to_owned(),
    };
    until(&mut pods, |state| *state == forbidden).await;
    sleep(Duration::from_secs(30)).await;
    let tries = fake.count("namespaces/a/pods");
    assert!((6..=60).contains(&tries), "{tries} tries in 30 s");
    assert_eq!(pods.state(), forbidden);
    let asking: Vec<_> = futures::future::join_all((0..10).map(|_| hub.rows(query(&["a"]))))
        .await
        .into_iter()
        .map(Result::unwrap)
        .collect();
    assert!(asking.iter().all(|asked| asked.state() == forbidden));
    settle().await;
    assert_eq!(
        fake.count("namespaces/a/pods"),
        tries,
        "subscriptions leave its backoff alone"
    );
    drop(asking);

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
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    until(&mut pods, |state| *state == ViewState::Unauthorized).await;
    sleep(Duration::from_secs(30)).await;
    assert_eq!(
        fake.count("namespaces/a/pods"),
        1,
        "no retry, which would run a plugin by itself"
    );

    fake.state().unauthorized.clear();
    let mut again = hub.rows(query(&["a"])).await.unwrap();
    assert_eq!(
        again.state(),
        ViewState::Connecting,
        "not the failure it retries"
    );
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
    let mut namespaces = hub.rows(query).await.unwrap();
    ready(&mut namespaces).await;
    assert_eq!(hub.scopes(), [Scope::Cluster]);
    assert_eq!(names(&namespaces), ["a"]);
}

#[tokio::test(start_paused = true)]
async fn whole_rows_wait_for_a_whole_list() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    fake.state().unavailable = 1;
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    let rows = pods.whole().await.expect("one 503 is ridden out");
    assert_eq!(rows.len(), 1);

    fake.state().hold_initial = true;
    let mut partial = hub.rows(query(&["b"])).await.unwrap();
    let asked = tokio::time::timeout(Duration::from_secs(30), partial.whole());
    assert!(asked.await.is_err(), "no answer before the list ends");
    fake.release_initial();
    assert!(partial.whole().await.unwrap().is_empty());

    fake.state().unavailable = usize::MAX;
    let mut dead = hub.rows(query(&["c"])).await.unwrap();
    let started = Instant::now();
    assert_eq!(dead.whole().await.unwrap_err(), ViewState::Stale);
    assert!(started.elapsed() >= 2 * RETRY_WITHIN);

    fake.state().unavailable = 0;
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/d/pods".to_owned());
    let mut refused = hub.rows(query(&["d"])).await.unwrap();
    assert!(matches!(
        refused.whole().await,
        Err(ViewState::Forbidden { .. })
    ));
}

#[tokio::test(start_paused = true)]
async fn clients_abandoned_before_their_first_list_are_left_at_once() {
    for streaming in [true, false] {
        clients_abandoned_before_listing(streaming).await;
    }
}

async fn clients_abandoned_before_listing(streaming: bool) {
    let fake = Fake::default();
    fake.state().no_streaming = !streaming;
    fake.add("pods", Some("a"), "p1");
    let abandoned = fake.clients(Budgets::default());
    abandoned.connections().abandon();
    let current = fake.clients(Budgets::default());
    let connects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let connect: Connect = {
        let (abandoned, current, connects) = (
            Arc::clone(&abandoned),
            Arc::clone(&current),
            Arc::clone(&connects),
        );
        Arc::new(move |_context| {
            let first = connects.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0;
            let clients = Arc::clone(if first { &abandoned } else { &current });
            Box::pin(async move { Ok(clients) })
        })
    };
    let hub = Hub::new(connect);
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    assert_eq!(names(&pods), ["p1"]);
    assert_eq!(connects.load(std::sync::atomic::Ordering::Relaxed), 2);
    // Over the current clients: a streaming list, or one refused and a
    // page.
    assert_eq!(
        fake.count("sendInitialEvents") + fake.count("limit=500"),
        if streaming { 1 } else { 2 },
        "nothing listed over the abandoned clients"
    );
    sleep(Duration::from_secs(30)).await;
    assert_eq!(
        connects.load(std::sync::atomic::Ordering::Relaxed),
        2,
        "and stay on the current ones"
    );
}

#[tokio::test(start_paused = true)]
async fn a_name_that_can_be_no_path_segment_is_refused() {
    let (hub, _clients) = Fake::default().hub(Budgets::default());
    for name in ["a/pods", "a%2Fb", "..", ""] {
        let refused = hub.rows(query(&[name])).await.err().unwrap();
        assert_eq!(refused.kind, twigo_ipc::ErrorKind::InvalidInput, "{name:?}");
    }
    assert!(hub.scopes().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_poll_leaves_clients_abandoned_meanwhile() {
    let fake = Fake::default();
    fake.state().unwatchable.insert("pods".to_owned());
    let first = fake.clients(Budgets::default());
    let second = fake.clients(Budgets::default());
    let switched = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let connect: Connect = {
        let (first, second, switched) = (
            Arc::clone(&first),
            Arc::clone(&second),
            Arc::clone(&switched),
        );
        Arc::new(move |_context| {
            let now = switched.load(std::sync::atomic::Ordering::Relaxed);
            let clients = Arc::clone(if now { &second } else { &first });
            Box::pin(async move { Ok(clients) })
        })
    };
    let hub = Hub::new(connect);
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    let lists = fake.count("limit=500");
    switched.store(true, std::sync::atomic::Ordering::Relaxed);
    first.connections().abandon();
    sleep(Duration::from_secs(1)).await;
    assert_eq!(
        fake.count("limit=500"),
        lists + 1,
        "it listed over the new clients without waiting out its 15 s"
    );
}

#[test]
fn names_stay_in_their_segment() {
    let path = pods().path(&Scope::Namespace("a?c<d".to_owned()));
    assert_eq!(path, "/api/v1/namespaces/a%3Fc%3Cd/pods");
    let collection = crate::request::Collection::table(&path);
    let request = crate::request::list(&collection, 1, None);
    assert_eq!(request.uri().path(), path);
    let crd = Resource {
        group: "test.twigo.io".to_owned(),
        version: "v1".to_owned(),
        resource: "widgets".to_owned(),
        namespaced: true,
    };
    assert_eq!(
        crd.path(&Scope::Namespace("team-a".to_owned())),
        "/apis/test.twigo.io/v1/namespaces/team-a/widgets"
    );
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
