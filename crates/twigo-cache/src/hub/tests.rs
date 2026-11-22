use std::time::Duration;

use http::StatusCode;
use tokio::time::{Instant, sleep};
use twigo_ipc::{ErrorCode, ViewState};
use twigo_kube::client::{Actor, Budgets, Class};

use super::*;
use crate::decode::{DecodeError, Event, Page};
use crate::fake::{Fake, Streams};
use crate::printed::Printed;
use crate::table::{Cell, ColumnKind};
use crate::upstream::{IDLE, INITIAL_IDLE};

pub(super) fn forbidden() -> ViewState {
    ViewState::Forbidden {
        verb: "watch".to_owned(),
        resource: "pods".to_owned(),
    }
}

/// The code of the failure that a waiting state waits out.
pub(super) fn waits_on(state: &ViewState) -> Option<ErrorCode> {
    match state {
        ViewState::Connecting { cause } | ViewState::Stale { cause } => {
            cause.as_ref().map(|cause| cause.code)
        }
        _ => None,
    }
}

pub(super) fn pods() -> Resource {
    Resource {
        group: String::new(),
        version: "v1".to_owned(),
        resource: "pods".to_owned(),
        namespaced: true,
    }
}

fn widgets() -> Resource {
    Resource {
        group: "example.io".to_owned(),
        version: "v1".to_owned(),
        resource: "widgets".to_owned(),
        namespaced: true,
    }
}

pub(super) fn query(namespaces: &[&str]) -> Query {
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

pub(super) fn namespace(name: &str) -> Scope {
    Scope::Namespace(name.to_owned())
}

pub(super) fn budget(watches: usize) -> Budgets {
    Budgets {
        watches,
        ..Budgets::default()
    }
}

pub(super) async fn reach<T: Item>(
    subscription: &mut Subscription<T>,
    mut wanted: impl FnMut(&Subscription<T>) -> bool,
) {
    let reached = async {
        while !wanted(subscription) {
            subscription.changed().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(600), reached)
        .await
        .unwrap_or_else(|_| {
            panic!(
                "not within ten minutes; the state is {:?}",
                subscription.state()
            )
        });
}

pub(super) async fn until<T: Item>(
    subscription: &mut Subscription<T>,
    wanted: impl Fn(&ViewState) -> bool,
) {
    reach(subscription, |subscription| wanted(&subscription.state())).await;
}

pub(super) async fn ready<T: Item>(subscription: &mut Subscription<T>) {
    until(subscription, |state| *state == ViewState::Ready).await;
}

pub(super) async fn until_rows(subscription: &mut Subscription<Row>, wanted: &[&str]) {
    reach(subscription, |subscription| names(subscription) == wanted).await;
}

pub(super) fn names(subscription: &Subscription<Row>) -> Vec<String> {
    let mut names: Vec<String> = subscription
        .items()
        .iter()
        .map(|row| row.meta.name.to_string())
        .collect();
    names.sort();
    names
}

/// Lets every task that can run, run.
pub(super) async fn settle() {
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
    fake.allow(None, "list", "pods");
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
    fake.allow(None, "list", "pods");
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

fn drained(delta: Delta<Row>) -> (bool, Vec<String>, usize) {
    let (reset, mut rows, removed) = match delta {
        Delta::Reset { rows, .. } => (true, rows, 0),
        Delta::Changed { upserted, removed } => (false, upserted, removed.len()),
    };
    rows.sort_by(|a, b| a.meta.name.cmp(&b.meta.name));
    let names = rows.iter().map(|row| row.meta.name.to_string()).collect();
    (reset, names, removed)
}

#[tokio::test(start_paused = true)]
async fn a_drain_takes_what_changed_since_the_last_and_every_row_after_a_move() {
    let fake = Fake::default();
    fake.allow(None, "list", "pods");
    fake.add("pods", Some("a"), "p1");
    fake.add("pods", Some("b"), "p2");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut all = hub.rows(query(&[])).await.unwrap();
    ready(&mut all).await;
    let mut narrow = hub.rows(query(&["a"])).await.unwrap();
    assert_eq!(drained(narrow.drain()), (true, vec!["p1".to_owned()], 0));
    assert_eq!(drained(narrow.drain()), (false, vec![], 0));

    fake.add("pods", Some("a"), "p3");
    fake.add("pods", Some("b"), "p4");
    fake.add("pods", Some("a"), "p5");
    fake.delete("pods", Some("a"), "p5");
    until_rows(&mut narrow, &["p1", "p3"]).await;
    until_rows(&mut all, &["p1", "p2", "p3", "p4"]).await;
    assert_eq!(
        drained(narrow.drain()),
        (false, vec!["p3".to_owned()], 1),
        "p4 of the namespace it does not show counts as removed; p5, added and deleted since, not at all"
    );

    drop(all);
    fake.bookmark();
    sleep(LINGER + Duration::from_secs(1)).await;
    until(&mut narrow, |_| hub.scopes() == [namespace("a")]).await;
    assert_eq!(
        drained(narrow.drain()),
        (true, vec!["p1".to_owned(), "p3".to_owned()], 0),
        "the parts it moved to start with every row"
    );
}

#[tokio::test(start_paused = true)]
async fn a_namespace_named_twice_gets_one_part() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut twice = hub.rows(query(&["a", "a"])).await.unwrap();
    ready(&mut twice).await;
    assert_eq!(hub.scopes(), [namespace("a")]);
    assert_eq!(drained(twice.drain()), (true, vec!["p1".to_owned()], 0));
}

#[tokio::test(start_paused = true)]
async fn more_than_four_namespaces_watch_cluster_wide_only_if_the_person_may_list() {
    let five = ["a", "b", "c", "d", "e"];
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    fake.add("pods", Some("f"), "p2");
    fake.allow(None, "list", "pods");
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
        assert!(
            (low..=high).contains(&gap),
            "{gap} s outside {low}–{high} s"
        );
    }

    fake.state().unavailable = 1;
    fake.state().requests.clear();
    fake.end_watches();
    until(&mut pods, |state| matches!(state, ViewState::Stale { .. })).await;
    ready(&mut pods).await;
    let after = gaps(&fake);
    assert_eq!(after.len(), 1);
    assert!(
        (0.5..=1.0).contains(&after[0].as_secs_f64()),
        "the events since reset it"
    );
}

#[tokio::test(start_paused = true)]
async fn an_error_event_does_not_reset_the_backoff() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    fake.state().watch_fails = true;
    fake.state().requests.clear();
    fake.end_watches();
    sleep(Duration::from_secs(60)).await;
    let state = fake.state();
    let times: Vec<Instant> = state.requests.iter().map(|(at, _)| *at).collect();
    assert!(times.len() < 30, "{} requests in a minute", times.len());
    let last = times[times.len() - 1] - times[times.len() - 2];
    assert!(
        last >= Duration::from_millis(2500),
        "{last:?} between the last two"
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
async fn a_probe_whose_body_never_comes_is_no_answer_at_15_s() {
    let fake = Fake::default();
    let (hub, clients) = fake.hub(Budgets::default());
    let retired = clients.connections().retired();
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    fake.state().version_body_hangs = true;
    sleep(IDLE + Duration::from_secs(14)).await;
    assert_eq!(fake.count("/version"), 1, "it went quiet and probed");
    assert_eq!(*retired.borrow(), 0, "the body may still come");
    sleep(Duration::from_secs(2)).await;
    assert_eq!(*retired.borrow(), 1, "no answer: the connection is retired");
}

#[tokio::test(start_paused = true)]
async fn a_probe_that_waits_for_a_request_slot_is_not_timed_by_its_15_s() {
    let fake = Fake::default();
    let (hub, clients) = fake.hub(Budgets {
        requests: 1,
        ..Budgets::default()
    });
    let retired = clients.connections().retired();
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    let slot = clients
        .try_admit(Class::Request, Actor::Ui)
        .expect("the only request slot is free");

    sleep(IDLE + Duration::from_secs(40)).await;
    assert_eq!(fake.count("/version"), 0, "the probe waits for the slot");
    assert_eq!(
        *retired.borrow(),
        0,
        "the wait for a slot does not retire the connection"
    );

    drop(slot);
    settle().await;
    assert_eq!(fake.count("/version"), 1, "the probe went out");
    assert_eq!(*retired.borrow(), 0, "and was answered");
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

type Restarts = Arc<Mutex<HashMap<String, (u32, Option<i64>)>>>;

struct Printing {
    meta: MetaDecoder,
    columns: Arc<[Column]>,
    restarts: Restarts,
}

impl Printing {
    fn new(restarts: &Restarts) -> Self {
        Self {
            meta: MetaDecoder,
            columns: Arc::new([Column {
                name: "Restarts".into(),
                kind: ColumnKind::String,
                format: "".into(),
                priority: 0,
                prints_duration: true,
            }]),
            restarts: Arc::clone(restarts),
        }
    }

    fn print(&self, row: &mut Row) {
        let restarts = self.restarts.lock().unwrap();
        let (count, last) = restarts.get(&*row.meta.name).copied().unwrap_or_default();
        let printed = match last {
            None => count.to_string(),
            Some(last) => format!("{count} ({} ago)", human(row.meta.received / 1000 - last)),
        };
        row.cells = Box::new([Cell::Text(printed.into())]);
    }
}

fn human(seconds: i64) -> String {
    match seconds {
        ..120 => format!("{seconds}s"),
        _ if seconds % 60 == 0 => format!("{}m", seconds / 60),
        _ => format!("{}m{}s", seconds / 60, seconds % 60),
    }
}

impl Decode for Printing {
    type Item = Row;

    fn decode_list(&mut self, body: &[u8], received: Timestamp) -> Result<Page, DecodeError> {
        let mut page = self.meta.decode_list(body, received)?;
        page.items.iter_mut().for_each(|row| self.print(row));
        Ok(page)
    }

    fn decode_event(&mut self, line: &[u8], received: Timestamp) -> Result<Event, DecodeError> {
        let mut event = self.meta.decode_event(line, received)?;
        if let Event::Upsert(row) | Event::Delete(row) = &mut event {
            self.print(row);
        }
        Ok(event)
    }

    fn columns(&self) -> Option<&Arc<[Column]>> {
        Some(&self.columns)
    }
}

fn arrived(upstream: &Upstream<Row>) -> Vec<(String, i64, Option<i64>)> {
    let mut arrived: Vec<_> = upstream
        .store
        .items(|_| true)
        .iter()
        .map(|row| {
            let stamp = row.meta.received / 1000;
            let ago = match &row.cells[..] {
                [Cell::Text(text)] => Printed::parse(text).map(|printed| printed.ago as i64),
                _ => None,
            };
            (row.meta.name.to_string(), stamp, ago.map(|ago| stamp - ago))
        })
        .collect();
    arrived.sort();
    arrived
}

#[tokio::test(start_paused = true)]
async fn a_row_is_stamped_when_its_page_or_its_event_arrives_and_a_relist_keeps_what_prints_as_it_did()
 {
    for streaming in [true, false] {
        stamped_as_it_arrives(streaming).await;
    }
}

async fn stamped_as_it_arrives(streaming: bool) {
    let fake = Fake::default();
    if !streaming {
        fake.streams("", Streams::NoWatchList);
    }
    for name in ["p1", "p2", "p3"] {
        fake.add("pods", Some("a"), name);
    }
    let restarts: Restarts = Arc::new(Mutex::new(HashMap::from([
        ("p1".to_owned(), (1, Some(-295))),
        ("p2".to_owned(), (0, None)),
        ("p3".to_owned(), (0, None)),
    ])));
    let (hub, _clients) = fake.hub(Budgets::default());
    sleep(Duration::from_secs(5)).await;
    let env = Env {
        connect: Arc::clone(&hub.inner.connect),
        clock: Arc::clone(&hub.inner.clock),
        cluster: hub.inner.cluster("kind-test"),
        waiting: Arc::new(|_| {}),
    };
    let key = Key {
        context: "kind-test".to_owned(),
        resource: pods(),
        format: Format::Metadata,
        scope: namespace("a"),
        field_selector: None,
    };
    let upstream = Arc::new(Upstream::<Row>::new());
    let mut state = upstream.state();
    let run = tokio::spawn(upstream::run(
        env,
        key.spec(),
        Printing::new(&restarts),
        Arc::clone(&upstream),
    ));
    let ready = |state: &ViewState| *state == ViewState::Ready;
    state.wait_for(ready).await.unwrap();
    assert_eq!(
        arrived(&upstream),
        [
            ("p1".to_owned(), 5, Some(-295)),
            ("p2".to_owned(), 5, None),
            ("p3".to_owned(), 5, None)
        ],
        "streaming {streaming}: the rows of the list arrived with it"
    );

    sleep(Duration::from_secs(10)).await;
    restarts
        .lock()
        .unwrap()
        .insert("p1".to_owned(), (2, Some(5)));
    fake.add("pods", Some("a"), "p1");
    settle().await;
    assert_eq!(
        arrived(&upstream),
        [
            ("p1".to_owned(), 15, Some(5)),
            ("p2".to_owned(), 5, None),
            ("p3".to_owned(), 5, None)
        ],
        "streaming {streaming}: an event stamps the row it brings, and no other"
    );

    sleep(Duration::from_secs(20)).await;
    fake.bookmark();
    settle().await;
    assert_eq!(
        arrived(&upstream),
        [
            ("p1".to_owned(), 15, Some(5)),
            ("p2".to_owned(), 5, None),
            ("p3".to_owned(), 5, None)
        ],
        "streaming {streaming}: a bookmark brings no row"
    );

    sleep(Duration::from_secs(30)).await;
    fake.end_watches();
    restarts
        .lock()
        .unwrap()
        .insert("p2".to_owned(), (1, Some(62)));
    fake.add("pods", Some("a"), "p2");
    fake.compact();
    sleep(Duration::from_secs(30)).await;
    let relisted = arrived(&upstream);
    let [(_, older, p1), (_, restarted, p2), (_, kept, _)] = relisted[..] else {
        panic!("three rows: {relisted:?}");
    };
    assert!(
        (65..=75).contains(&older) && p1 == Some(5),
        "streaming {streaming}: a relist that prints an age older stamps the row anew, from the same moment: {relisted:?}"
    );
    assert!(
        (65..=75).contains(&restarted) && p2 == Some(62),
        "streaming {streaming}: a relist stamps the row that restarted: {relisted:?}"
    );
    assert_eq!(
        kept, 5,
        "streaming {streaming}: and keeps the stamp of a row it prints as it was"
    );
    run.abort();
}

#[tokio::test(start_paused = true)]
async fn a_cluster_without_streaming_lists_is_listed_in_pages_once_it_said_so() {
    let fake = Fake::default();
    fake.streams("", Streams::NoWatchList);
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

fn streamed(fake: &Fake, path: &str) -> usize {
    fake.count(&format!(
        "{path}?watch=true&allowWatchBookmarks=true&timeoutSeconds=290&sendInitialEvents=true"
    ))
}

fn paged(fake: &Fake, path: &str) -> usize {
    fake.count(&format!("{path}?limit=500"))
}

const PODS_A: &str = "/api/v1/namespaces/a/pods";
const PODS_B: &str = "/api/v1/namespaces/b/pods";
const WIDGETS_A: &str = "/apis/example.io/v1/namespaces/a/widgets";

#[tokio::test(start_paused = true)]
async fn every_refusal_of_a_streaming_list_pages_that_group_version_alone() {
    for refusal in [
        Streams::NoWatchList,
        Streams::Status(StatusCode::BAD_REQUEST),
        Streams::Status(StatusCode::UNPROCESSABLE_ENTITY),
        Streams::Plain,
        Streams::PlainWatch,
        Streams::BlankBookmark,
        Streams::Silent,
        Streams::EndsAtOnce,
        Streams::ErrorThenEnd,
        Streams::Deleted,
    ] {
        refused_stream(refusal).await;
    }
}

async fn refused_stream(refusal: Streams) {
    let fake = Fake::default();
    fake.streams("", refusal);
    fake.add("pods", Some("a"), "p1");
    fake.add("pods", Some("a"), "p2");
    fake.add("pods", Some("b"), "p3");
    fake.add_to("example.io", "widgets", Some("a"), "w1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let started = Instant::now();
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    let allowed = match refusal {
        Streams::Silent => INITIAL_IDLE + Duration::from_secs(1),
        _ => Duration::from_secs(1),
    };
    assert!(
        started.elapsed() < allowed,
        "{refusal:?}: {:?}",
        started.elapsed()
    );
    assert_eq!(names(&pods), ["p1", "p2"], "{refusal:?}");
    assert_eq!(streamed(&fake, PODS_A), 1, "{refusal:?}");
    assert_eq!(paged(&fake, PODS_A), 1, "{refusal:?}: listed in pages");

    let widgets = Query {
        resource: widgets(),
        ..query(&["a"])
    };
    let mut widgets = hub.rows(widgets).await.unwrap();
    ready(&mut widgets).await;
    assert_eq!(names(&widgets), ["w1"]);
    assert_eq!(streamed(&fake, WIDGETS_A), 1, "{refusal:?}");
    assert_eq!(
        paged(&fake, WIDGETS_A),
        0,
        "{refusal:?}: another group streams"
    );

    let mut other = hub.rows(query(&["b"])).await.unwrap();
    ready(&mut other).await;
    assert_eq!(names(&other), ["p3"]);
    assert_eq!(
        streamed(&fake, PODS_B),
        0,
        "{refusal:?}: nothing asks again"
    );
    assert_eq!(paged(&fake, PODS_B), 1, "{refusal:?}");
}

#[tokio::test(start_paused = true)]
async fn a_failure_that_says_nothing_of_streaming_is_retried_by_streaming() {
    for code in [
        StatusCode::FORBIDDEN,
        StatusCode::NOT_FOUND,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let fake = Fake::default();
        fake.streams("", Streams::Status(code));
        fake.add("pods", Some("a"), "p1");
        let (hub, _clients) = fake.hub(Budgets::default());
        let mut pods = hub.rows(query(&["a"])).await.unwrap();
        sleep(Duration::from_secs(90)).await;
        assert!(streamed(&fake, PODS_A) > 1, "{code}: tried again");
        assert_eq!(paged(&fake, PODS_A), 0, "{code}: no page");

        fake.streams("", Streams::Compressed);
        ready(&mut pods).await;
        assert_eq!(names(&pods), ["p1"], "{code}");
        assert_eq!(paged(&fake, PODS_A), 0, "{code}: it streams once it can");
    }
}

#[tokio::test(start_paused = true)]
async fn a_silent_stream_retires_a_dead_connection_and_pages_over_a_live_one() {
    let fake = Fake::default();
    fake.streams("", Streams::Silent);
    fake.state().dead = true;
    fake.add("pods", Some("a"), "p1");
    let (hub, clients) = fake.hub(Budgets::default());
    let retired = clients.connections().retired();
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    sleep(INITIAL_IDLE + Duration::from_secs(1)).await;
    assert_eq!(*retired.borrow(), 1, "the probe got no answer");
    assert_eq!(
        streamed(&fake, PODS_A),
        2,
        "it streams again, over a new one"
    );
    assert_eq!(paged(&fake, PODS_A), 0);

    fake.state().dead = false;
    ready(&mut pods).await;
    assert_eq!(*retired.borrow(), 1, "an answer retires nothing");
    assert_eq!(names(&pods), ["p1"]);
    assert_eq!(paged(&fake, PODS_A), 1);
}

#[tokio::test(start_paused = true)]
async fn a_list_that_trickles_in_never_falls_back_however_long_it_takes() {
    let fake = Fake::default();
    fake.streams("", Streams::Trickle(INITIAL_IDLE - Duration::from_secs(5)));
    for name in ["p1", "p2", "p3", "p4", "p5"] {
        fake.add("pods", Some("a"), name);
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let started = Instant::now();
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    assert!(started.elapsed() > INITIAL_IDLE * 4);
    assert_eq!(pods.items().len(), 5);
    assert_eq!(streamed(&fake, PODS_A), 1);
    assert_eq!(paged(&fake, PODS_A), 0);
}

#[tokio::test(start_paused = true)]
async fn a_first_list_that_falls_back_lists_from_scratch() {
    let fake = Fake::default();
    fake.streams("", Streams::Trickle(Duration::from_secs(1)));
    for name in ["p1", "p2", "p3"] {
        fake.add("pods", Some("a"), name);
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    sleep(Duration::from_millis(2500)).await;
    assert_eq!(pods.state(), ViewState::Syncing { loaded: 2 });
    fake.delete("pods", Some("a"), "p2");
    ready(&mut pods).await;
    assert_eq!(
        names(&pods),
        ["p1", "p3"],
        "what the stream stored is gone with it"
    );
    assert_eq!(paged(&fake, PODS_A), 1);
}

#[tokio::test(start_paused = true)]
async fn a_relist_that_falls_back_keeps_its_rows_until_its_pages_end() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    fake.add("pods", Some("a"), "p2");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;

    fake.streams("", Streams::NoWatchList);
    fake.state().body_takes = Duration::from_secs(5);
    fake.end_watches();
    fake.delete("pods", Some("a"), "p1");
    fake.add("pods", Some("a"), "p3");
    fake.compact();
    until(&mut pods, |state| *state == ViewState::Relisting).await;
    sleep(Duration::from_secs(2)).await;
    assert_eq!(pods.state(), ViewState::Relisting);
    assert_eq!(names(&pods), ["p1", "p2"], "the old rows meanwhile");
    assert_eq!(paged(&fake, PODS_A), 1);

    ready(&mut pods).await;
    assert_eq!(names(&pods), ["p2", "p3"]);
}

fn switching(fake: &Fake) -> (Hub, Arc<Clients>, impl Fn()) {
    use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
    let first = fake.clients(Budgets::default());
    let second = fake.clients(Budgets::default());
    let switched = Arc::new(AtomicBool::new(false));
    let connect: Connect = {
        let (first, switched) = (Arc::clone(&first), Arc::clone(&switched));
        Arc::new(move |_context| {
            let clients = Arc::clone(if switched.load(Relaxed) {
                &second
            } else {
                &first
            });
            Box::pin(async move { Ok(clients) })
        })
    };
    (Hub::new(connect), first, move || {
        switched.store(true, Relaxed)
    })
}

#[tokio::test(start_paused = true)]
async fn rebuilt_clients_forget_a_refusal_and_a_retirement_keeps_it() {
    let fake = Fake::default();
    fake.streams("", Streams::NoWatchList);
    fake.add("pods", Some("a"), "p1");
    let (hub, first, switch) = switching(&fake);
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    assert_eq!(streamed(&fake, PODS_A), 1);

    first.connections().retire();
    fake.end_watches();
    fake.add("pods", Some("a"), "p2");
    fake.compact();
    sleep(Duration::from_secs(10)).await;
    assert_eq!(paged(&fake, PODS_A), 2, "it listed again");
    assert_eq!(
        streamed(&fake, PODS_A),
        1,
        "and did not ask for a stream after a retirement"
    );

    switch();
    first.connections().abandon();
    sleep(Duration::from_secs(10)).await;
    assert_eq!(streamed(&fake, PODS_A), 2, "new clients ask again");
    assert_eq!(paged(&fake, PODS_A), 3);
    ready(&mut pods).await;
}

#[tokio::test(start_paused = true)]
async fn a_list_in_pages_follows_its_continue_tokens() {
    let fake = Fake::default();
    fake.streams("", Streams::NoWatchList);
    for index in 0..1200 {
        fake.add("pods", Some("a"), &format!("p{index:04}"));
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    assert_eq!(pods.items().len(), 1200);
    assert_eq!(fake.count("limit=500"), 3);
    assert_eq!(
        fake.count_gzipped("limit=500"),
        3,
        "every page came gzipped"
    );
    assert_eq!(fake.count("continue=1200%3A500"), 1);
    assert_eq!(fake.count("continue=1200%3A1000"), 1);
    assert_eq!(
        fake.count("resourceVersion=1200"),
        1,
        "watched from the list's version"
    );
}

#[tokio::test(start_paused = true)]
async fn a_page_is_stamped_when_its_response_starts_whatever_its_body_takes() {
    let fake = Fake::default();
    fake.streams("", Streams::NoWatchList);
    fake.state().body_takes = Duration::from_secs(4);
    for index in 0..1200 {
        fake.add("pods", Some("a"), &format!("p{index:04}"));
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    let mut stamped = std::collections::BTreeMap::new();
    for row in pods.items() {
        *stamped.entry(row.meta.received / 1000).or_insert(0) += 1;
    }
    assert_eq!(
        stamped,
        [(0, 500), (4, 500), (8, 200)].into(),
        "each page by when its response started, not four seconds on"
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
    until(&mut pods, |state| *state == forbidden()).await;

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
        ViewState::Connecting { cause: None },
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
    let asked = tokio::time::timeout(Duration::from_secs(20), partial.whole());
    assert!(asked.await.is_err(), "no answer before the list ends");
    fake.release_initial();
    assert!(partial.whole().await.unwrap().is_empty());

    fake.state().unavailable = usize::MAX;
    let mut dead = hub.rows(query(&["c"])).await.unwrap();
    let started = Instant::now();
    let failed = dead.whole().await.unwrap_err();
    assert!(matches!(failed, ViewState::Stale { .. }), "{failed:?}");
    assert_eq!(waits_on(&failed), Some(ErrorCode::ServerUnavailable));
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
    if !streaming {
        fake.streams("", Streams::NoWatchList);
    }
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
        assert_eq!(
            refused.code,
            twigo_ipc::ErrorCode::InternalRequest,
            "{name:?}"
        );
    }
    assert!(hub.scopes().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_poll_leaves_clients_abandoned_meanwhile() {
    let fake = Fake::default();
    fake.state().unwatchable.insert("pods".to_owned());
    let (hub, first, switch) = switching(&fake);
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut pods).await;
    let lists = fake.count("limit=500");
    switch();
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
        combine(
            [
                ViewState::Ready,
                syncing(2),
                syncing(3),
                ViewState::Stale { cause: None }
            ]
            .into_iter()
        ),
        syncing(5)
    );
    assert_eq!(
        combine([ViewState::Queued, ViewState::Unauthorized].into_iter()),
        ViewState::Unauthorized
    );
    assert_eq!(combine(std::iter::empty()), ViewState::Ready);
}

#[tokio::test(start_paused = true)]
async fn a_no_from_rbac_is_asked_again_after_30_s_and_a_yes_holds() {
    let fake = Fake::default();
    let (hub, _clients) = fake.hub(Budgets::default());
    let access = twigo_ipc::Access {
        verb: "delete".to_owned(),
        group: String::new(),
        resource: "pods".to_owned(),
        subresource: None,
        name: None,
    };
    let may = || hub.may("kind-test", Some("a"), &access);
    assert_eq!(may().await, Some(false));
    sleep(crate::cluster::REFUSED_FOR - Duration::from_secs(1)).await;
    assert_eq!(may().await, Some(false));
    assert_eq!(fake.count("selfsubjectaccessreviews"), 1);
    fake.allow(Some("a"), "delete", "pods");
    sleep(Duration::from_secs(2)).await;
    assert_eq!(may().await, Some(true));
    assert_eq!(fake.count("selfsubjectaccessreviews"), 2);
    fake.deny(Some("a"), "delete", "pods");
    sleep(crate::cluster::REFUSED_FOR * 2).await;
    assert_eq!(may().await, Some(true));
    assert_eq!(fake.count("selfsubjectaccessreviews"), 2);
}

#[tokio::test(start_paused = true)]
async fn reviews_of_the_same_question_in_flight_send_one_request() {
    let fake = Fake::default();
    fake.allow(Some("a"), "list", "pods");
    fake.state().reviews_take = Duration::from_secs(1);
    let (hub, _clients) = fake.hub(Budgets::default());
    let access = list_access(&pods());
    let ask = |namespace| hub.may("kind-test", Some(namespace), &access);
    let answers = tokio::join!(ask("a"), ask("a"), ask("b"));
    assert_eq!(answers, (Some(true), Some(true), Some(false)));
    assert_eq!(
        fake.count("selfsubjectaccessreviews"),
        2,
        "one for a, one for b"
    );
    assert_eq!(ask("a").await, Some(true));
    assert_eq!(fake.count("selfsubjectaccessreviews"), 2, "a yes is kept");
}

/// When each list or watch of `path` was sent.
fn tries(fake: &Fake, path: &str) -> Vec<Instant> {
    let state = fake.state();
    state
        .requests
        .iter()
        .filter(|(_, request)| request.contains(path))
        .map(|(at, _)| *at)
        .collect()
}

fn gaps(tries: &[Instant]) -> Vec<Duration> {
    tries.windows(2).map(|pair| pair[1] - pair[0]).collect()
}

#[tokio::test(start_paused = true)]
async fn a_part_refused_before_it_listed_tries_again_after_30_s_and_one_that_listed_within_5() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    fake.add("pods", Some("b"), "p2");
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/a/pods".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut never = hub.rows(query(&["a"])).await.unwrap();
    let mut once = hub.rows(query(&["b"])).await.unwrap();
    ready(&mut once).await;
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/b/pods".to_owned());
    fake.end_watches();
    let refused = |state: &ViewState| matches!(state, ViewState::Forbidden { .. });
    until(&mut never, refused).await;
    until(&mut once, refused).await;

    fake.state().requests.clear();
    sleep(Duration::from_secs(200)).await;
    let never = gaps(&tries(&fake, "/namespaces/a/pods"));
    assert!(never.len() >= 2, "{never:?}");
    let wait = crate::cluster::REFUSED_FOR..=2 * crate::cluster::REFUSED_FOR;
    assert!(never.iter().all(|gap| wait.contains(gap)), "{never:?}");
    let once = gaps(&tries(&fake, "/namespaces/b/pods"));
    assert!(once.len() >= 40, "{} tries in 200 s", once.len() + 1);
    let wait = Duration::from_millis(500)..=RETRY_WITHIN;
    assert!(once.iter().all(|gap| wait.contains(gap)), "{once:?}");
}

#[tokio::test(start_paused = true)]
async fn the_namespaces_are_read_in_pages_with_no_watch_whatever_the_budget() {
    let fake = Fake::default();
    for n in 0..1100 {
        fake.add("namespaces", None, &format!("ns-{n:04}"));
    }
    fake.add("pods", Some("ns-0000"), "p1");
    let (hub, _clients) = fake.hub(budget(1));
    let mut shown = hub.rows(query(&["ns-0000"])).await.unwrap();
    ready(&mut shown).await;

    let read = tokio::time::timeout(Duration::from_secs(10), hub.namespaces("kind-test"));
    let names = read.await.expect("no watch to wait for").unwrap();
    assert_eq!(names.len(), 1100);
    assert!(names.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(fake.count("/api/v1/namespaces?"), 3, "pages of 500");
    assert_eq!(fake.count("watch=true"), 1, "the pods' alone");
}

#[tokio::test(start_paused = true)]
async fn the_namespaces_try_a_transient_failure_again_and_a_refusal_answers_at_once() {
    let fake = Fake::default();
    fake.add("namespaces", None, "b");
    fake.add("namespaces", None, "a");
    let (hub, _clients) = fake.hub(Budgets::default());
    let listed = || fake.count("/api/v1/namespaces?");

    fake.state().unavailable = 1;
    assert_eq!(
        hub.namespaces("kind-test").await,
        Ok(vec!["a".into(), "b".into()])
    );
    assert_eq!(listed(), 2, "one 503, then the names");

    fake.state()
        .forbidden
        .insert("/api/v1/namespaces".to_owned());
    let (before, started) = (listed(), Instant::now());
    assert_eq!(
        hub.namespaces("kind-test").await,
        Err(ViewState::Forbidden {
            verb: "list".to_owned(),
            resource: "namespaces".to_owned(),
        })
    );
    assert_eq!((listed() - before, started.elapsed()), (1, Duration::ZERO));
}

#[tokio::test(start_paused = true)]
async fn the_namespaces_count_their_10_s_from_the_first_failure_and_never_cut_a_try_under_way() {
    let fake = Fake::default();
    fake.add("namespaces", None, "b");
    fake.add("namespaces", None, "a");
    let (hub, _clients) = fake.hub(Budgets {
        requests: 1,
        ..Budgets::default()
    });

    fake.state().body_takes = Duration::from_secs(8);
    let started = Instant::now();
    let slow = tokio::spawn({
        let hub = hub.clone();
        async move { hub.namespaces("kind-test").await }
    });
    settle().await;
    fake.state()
        .no_endpoints
        .insert("/api/v1/namespaces".into());
    let answered = tokio::time::timeout(Duration::from_secs(60), hub.namespaces("kind-test"));
    let gave_up = answered.await.expect("it gives up").unwrap_err();
    assert!(matches!(gave_up, ViewState::Stale { .. }), "{gave_up:?}");
    assert_eq!(waits_on(&gave_up), Some(ErrorCode::ServerUnavailable));
    assert!(
        (18..19).contains(&started.elapsed().as_secs()),
        "10 s after the slot came free at 8 s, not after the call: {:?}",
        started.elapsed()
    );
    assert_eq!(slow.await.unwrap(), Ok(vec!["a".into(), "b".into()]));

    fake.state().no_endpoints.clear();
    fake.state().body_takes = Duration::from_secs(11);
    let started = Instant::now();
    assert_eq!(
        hub.namespaces("kind-test").await,
        Ok(vec!["a".into(), "b".into()])
    );
    assert_eq!(started.elapsed().as_secs(), 11, "a try that has not failed");
}

#[tokio::test(start_paused = true)]
async fn a_new_subscription_cuts_short_the_wait_of_a_refused_part_and_an_open_list_keeps_it() {
    for dropped in [false, true] {
        let fake = Fake::default();
        fake.add("pods", Some("a"), "p1");
        fake.state()
            .forbidden
            .insert("/api/v1/namespaces/a/pods".to_owned());
        let (hub, _clients) = fake.hub(Budgets::default());
        let mut first = hub.rows(query(&["a"])).await.unwrap();
        let refused = |state: &ViewState| matches!(state, ViewState::Forbidden { .. });
        until(&mut first, refused).await;
        sleep(Duration::from_secs(2)).await;

        fake.state().forbidden.clear();
        sleep(Duration::from_secs(20)).await;
        assert!(refused(&first.state()), "the open list keeps its 30 s");
        if dropped {
            drop(first);
        }
        let mut again = hub.rows(query(&["a"])).await.unwrap();
        let tried = tokio::time::timeout(Duration::from_secs(1), ready(&mut again));
        tried
            .await
            .expect("a list opened anew tries at once, the wait having run 5 s");
        assert_eq!(names(&again), ["p1"]);
    }
}

#[tokio::test(start_paused = true)]
async fn new_subscriptions_make_a_refused_part_try_again_within_5_s_and_no_oftener() {
    let fake = Fake::default();
    let namespaces = ["a", "b", "c"];
    for namespace in namespaces {
        fake.state()
            .forbidden
            .insert(format!("/api/v1/namespaces/{namespace}/pods"));
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut typed = Vec::new();
    for _ in 0..30 {
        typed.push(hub.rows(query(&namespaces)).await.unwrap());
        sleep(Duration::from_secs(1)).await;
    }
    for namespace in namespaces {
        let gaps = gaps(&tries(&fake, &format!("/namespaces/{namespace}/pods")));
        assert!(gaps.len() >= 4, "{namespace}: {gaps:?}");
        let wait = RETRY_WITHIN..=RETRY_WITHIN + Duration::from_secs(1);
        assert!(
            gaps.iter().all(|gap| wait.contains(gap)),
            "{namespace}: {gaps:?}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_first_list_that_ends_in_a_404_tries_again_within_5_s() {
    let events = twigo_log::capture();
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    fake.streams("", Streams::Status(StatusCode::NOT_FOUND));
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut pods = hub.rows(query(&["a"])).await.unwrap();
    until(&mut pods, |state| matches!(state, ViewState::Error { .. })).await;

    fake.state().requests.clear();
    sleep(Duration::from_secs(120)).await;
    let gaps = gaps(&tries(&fake, "/namespaces/a/pods"));
    assert!(gaps.len() >= 20, "{} tries in 120 s", gaps.len() + 1);
    let wait = Duration::from_millis(500)..=RETRY_WITHIN;
    assert!(gaps.iter().all(|gap| wait.contains(gap)), "{gaps:?}");

    let lines = events.lines();
    let [refused] = &lines[..] else {
        panic!("one event for twenty tries of one refusal: {lines:?}");
    };
    assert_eq!(refused["level"], "WARN");
    assert_eq!(refused["fields"]["code"], "server.not-found");
    assert_eq!(refused["fields"]["context"], "kind-test");
}

/// Panics under the lock of the store a scope's rows are kept in.
fn poison_store(hub: &Hub) {
    let upstream = hub
        .inner
        .registry()
        .entries
        .values()
        .next()
        .expect("one upstream")
        .upstream::<Row>();
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        upstream.store.items(|_| panic!("a reader's bug"));
    }));
    assert!(poisoned.is_err());
}

#[tokio::test(start_paused = true)]
async fn a_list_that_panics_as_it_joins_does_not_keep_a_subscriber_of_the_scope() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut first = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut first).await;
    poison_store(&hub);
    let joined =
        futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(hub.rows(query(&["a"]))))
            .await;
    assert!(joined.is_err());
    assert_eq!(hub.subscribers("pods"), 1, "the first list's alone");
}

fn error_code(state: &ViewState) -> Option<twigo_ipc::ErrorCode> {
    match state {
        ViewState::Error { error } => Some(error.code),
        _ => None,
    }
}

#[tokio::test(start_paused = true)]
async fn a_list_whose_upstream_panics_says_error_and_a_new_list_starts_it_again() {
    twigo_panic::inject::arm("hub upstream", 1);
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut first = hub.rows(query(&["a"])).await.unwrap();
    until(&mut first, |state| error_code(state).is_some()).await;
    assert_eq!(
        error_code(&first.state()),
        Some(twigo_ipc::ErrorCode::InternalPanic)
    );
    sleep(Duration::from_secs(600)).await;
    assert!(
        error_code(&first.state()).is_some(),
        "nothing starts it by itself"
    );

    let mut second = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut second).await;
    assert_eq!(names(&second), ["p1"]);
}

#[tokio::test(start_paused = true)]
async fn a_panic_under_the_stores_lock_does_not_poison_the_lists_after_it() {
    let fake = Fake::default();
    fake.add("pods", Some("a"), "p1");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut first = hub.rows(query(&["a"])).await.unwrap();
    ready(&mut first).await;
    twigo_panic::inject::arm("store lock", 1);
    fake.add("pods", Some("a"), "p2");
    until(&mut first, |state| error_code(state).is_some()).await;

    let mut second = hub.rows(query(&["a"])).await.unwrap();
    until_rows(&mut second, &["p1", "p2"]).await;
    ready(&mut second).await;
}
