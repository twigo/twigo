use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use http::StatusCode;
use tokio::time::sleep;
use twigo_ipc::{Part, PartState, Parts, ViewState};
use twigo_kube::client::Budgets;

use super::tests::{budget, forbidden, pods, query, reach, ready, settle, until};
use super::*;
use crate::cluster::{REFUSED_FOR, RESOLVED_FOR};
use crate::fake::Fake;

fn namespace_part(name: &str, state: ViewState, shown: bool) -> PartState {
    PartState {
        part: Part::Namespace {
            name: name.to_owned(),
        },
        state,
        shown,
    }
}

fn pods_in(fake: &Fake, namespaces: &[&str]) {
    for namespace in namespaces {
        fake.add("pods", Some(namespace), &format!("p-{namespace}"));
    }
}

#[derive(Default)]
struct Mirror {
    rows: HashMap<RowKey, String>,
    status: Option<ViewState>,
    parts: Option<Parts>,
    columns: Option<Arc<[Column]>>,
}

impl Mirror {
    fn read(&mut self, subscription: &Subscription<Row>) {
        let named = |row: &Arc<Row>| (RowKey::of(&row.meta), row.meta.name.to_string());
        let shown = subscription.drain_shown();
        match shown.delta {
            Delta::Reset { rows, columns } => {
                self.rows = rows.iter().map(named).collect();
                self.columns = columns.or(self.columns.take());
            }
            Delta::Changed { upserted, removed } => {
                self.rows.extend(upserted.iter().map(named));
                for key in removed {
                    self.rows.remove(&key);
                }
            }
        }
        self.status = Some(shown.status);
        self.parts = Some(shown.parts);
    }

    fn names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.rows.values().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    fn unready(&self) -> &[PartState] {
        &self.parts.as_ref().expect("a read").unready
    }
}

async fn until_shown(
    subscription: &mut Subscription<Row>,
    mirror: &mut Mirror,
    wanted: impl Fn(&Mirror) -> bool,
) {
    reach(subscription, |subscription| {
        mirror.read(subscription);
        wanted(mirror)
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn a_refused_part_says_so_while_its_retry_waits_for_a_watch() {
    let fake = Fake::default();
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/a/pods".to_owned());
    let (hub, _clients) = fake.hub(budget(1));
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    until(&mut a, |state| *state == forbidden()).await;
    let mut b = hub.rows(query(&["b"])).await.unwrap();
    ready(&mut b).await;

    sleep(Duration::from_secs(30)).await;
    assert_eq!(a.state(), forbidden(), "its retries wait behind b's watch");
}

#[tokio::test(start_paused = true)]
async fn one_forbidden_namespace_of_five_shows_the_rows_of_the_four() {
    let fake = Fake::default();
    pods_in(&fake, &["a", "b", "c", "d", "e"]);
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/c/pods".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&["a", "b", "c", "d", "e"])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut list, &mut mirror, |m| m.names().len() == 4).await;
    assert_eq!(mirror.names(), ["p-a", "p-b", "p-d", "p-e"]);
    assert_eq!(mirror.status, Some(ViewState::Ready));
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 5,
            omitted: 0,
            unready: vec![namespace_part("c", forbidden(), false)],
        })
    );

    fake.state().forbidden.clear();
    until_shown(&mut list, &mut mirror, |m| m.names().len() == 5).await;
    assert_eq!(mirror.status, Some(ViewState::Ready));
    assert_eq!(mirror.unready(), [], "ready the moment its rows join");
}

#[tokio::test(start_paused = true)]
async fn over_the_budget_one_part_waits_and_joins_when_a_lingering_upstream_makes_way() {
    let fake = Fake::default();
    pods_in(&fake, &["a", "b", "c", "x"]);
    let (hub, _clients) = fake.hub(budget(3));
    let mut other = hub.rows(query(&["x"])).await.unwrap();
    ready(&mut other).await;
    let mut list = hub.rows(query(&["a", "b", "c"])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut list, &mut mirror, |m| m.names().len() == 2).await;
    assert_eq!(mirror.status, Some(ViewState::Ready));
    let [waiting] = mirror.unready() else {
        panic!("one part waits: {:?}", mirror.unready());
    };
    assert_eq!((&waiting.state, waiting.shown), (&ViewState::Queued, false));
    assert_eq!(mirror.parts.as_ref().unwrap().count, 3);

    drop(other);
    until_shown(&mut list, &mut mirror, |m| m.names().len() == 3).await;
    assert_eq!(mirror.names(), ["p-a", "p-b", "p-c"]);
    assert_eq!(mirror.status, Some(ViewState::Ready));
    assert_eq!(mirror.unready(), []);
}

#[tokio::test(start_paused = true)]
async fn when_the_watches_end_every_row_stays_and_the_part_that_waits_is_stale() {
    let fake = Fake::default();
    pods_in(&fake, &["a", "b", "c"]);
    let (hub, _clients) = fake.hub(budget(2));
    let mut list = hub.rows(query(&["a", "b", "c"])).await.unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut list, &mut mirror, |m| m.names().len() == 2).await;

    fake.end_watches();
    until_shown(&mut list, &mut mirror, |m| {
        m.names().len() == 3 && m.unready().len() == 1
    })
    .await;
    let [waiting] = mirror.unready() else {
        unreachable!("one waits");
    };
    assert_eq!((&waiting.state, waiting.shown), (&ViewState::Queued, true));
    assert_eq!(mirror.status, Some(ViewState::Stale));
}

#[tokio::test(start_paused = true)]
async fn a_part_still_syncing_adds_no_rows_until_it_has_listed() {
    let fake = Fake::default();
    pods_in(&fake, &["a", "b"]);
    fake.add("pods", Some("c"), "p-c1");
    fake.add("pods", Some("c"), "p-c2");
    fake.state()
        .hold_paths
        .insert("/api/v1/namespaces/c/pods".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&["a", "b", "c"])).await.unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut list, &mut mirror, |m| m.names().len() == 2).await;
    assert_eq!(
        mirror.unready(),
        [namespace_part("c", ViewState::Connecting, false)]
    );

    fake.stream_initial();
    let syncing = ViewState::Syncing { loaded: 2 };
    until_shown(&mut list, &mut mirror, |m| {
        m.unready() == [namespace_part("c", syncing.clone(), false)]
    })
    .await;
    assert_eq!(mirror.names(), ["p-a", "p-b"], "two of c's rows are held");
    assert_eq!(mirror.status, Some(ViewState::Ready));

    fake.release_initial();
    until_shown(&mut list, &mut mirror, |m| m.names().len() == 4).await;
    assert_eq!(mirror.status, Some(ViewState::Ready));
    assert_eq!(mirror.unready(), []);
}

#[tokio::test(start_paused = true)]
async fn a_first_list_that_broke_off_on_a_transient_error_says_connecting() {
    let fake = Fake::default();
    pods_in(&fake, &["a"]);
    fake.state().unavailable = 1;
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&["a"])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut list, &mut mirror, |m| {
        m.unready() == [namespace_part("a", ViewState::Stale, false)]
    })
    .await;
    assert_eq!(mirror.status, Some(ViewState::Connecting));

    until_shown(&mut list, &mut mirror, |m| m.names() == ["p-a"]).await;
    assert_eq!(mirror.status, Some(ViewState::Ready));
}

#[tokio::test(start_paused = true)]
async fn a_shown_part_that_turns_forbidden_takes_its_rows_out() {
    let fake = Fake::default();
    pods_in(&fake, &["a", "b", "c"]);
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&["a", "b", "c"])).await.unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut list, &mut mirror, |m| m.names().len() == 3).await;

    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/c/pods".to_owned());
    fake.end_watches();
    until_shown(&mut list, &mut mirror, |m| {
        m.unready() == [namespace_part("c", forbidden(), false)]
    })
    .await;
    assert_eq!(mirror.names(), ["p-a", "p-b"], "c's rows left with it");
    assert_eq!(mirror.status, Some(ViewState::Ready));
}

#[tokio::test(start_paused = true)]
async fn a_list_has_the_columns_of_a_part_that_has_not_listed_yet() {
    let fake = Fake::default();
    pods_in(&fake, &["a"]);
    fake.state()
        .hold_paths
        .insert("/api/v1/namespaces/a/pods".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub
        .rows(Query {
            format: RowFormat::Table,
            ..query(&["a"])
        })
        .await
        .unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut list, &mut mirror, |m| {
        m.unready() == [namespace_part("a", ViewState::Connecting, false)]
    })
    .await;
    assert_eq!(mirror.columns, None);

    settle().await;
    fake.stream_initial();
    until_shown(&mut list, &mut mirror, |m| m.columns.is_some()).await;
    assert_eq!(mirror.names(), Vec::<&str>::new(), "its rows are held");
    let columns = mirror.columns.as_deref().unwrap();
    assert_eq!(
        columns
            .iter()
            .map(|column| &*column.name)
            .collect::<Vec<_>>(),
        ["Name", "Age"]
    );
}

#[tokio::test(start_paused = true)]
async fn a_cluster_wide_part_whose_rewatch_waits_keeps_its_rows_and_is_stale() {
    let fake = Fake::default();
    fake.allow(None, "list", "pods");
    pods_in(&fake, &["a", "b", "z"]);
    let (hub, _clients) = fake.hub(budget(1));
    let mut list = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut list, &mut mirror, |m| m.names().len() == 3).await;
    assert_eq!(mirror.unready(), []);
    let mut waiting = hub
        .rows(Query {
            resource: Resource {
                resource: "configmaps".to_owned(),
                ..pods()
            },
            ..query(&["z"])
        })
        .await
        .unwrap();
    until(&mut waiting, |state| *state == ViewState::Queued).await;

    fake.end_watches();
    until_shown(&mut list, &mut mirror, |m| m.unready().len() == 1).await;
    assert_eq!(mirror.names(), ["p-a", "p-b", "p-z"]);
    assert_eq!(mirror.status, Some(ViewState::Stale));
    assert_eq!(
        mirror.unready(),
        [PartState {
            part: Part::Cluster,
            state: ViewState::Queued,
            shown: true,
        }]
    );
}

#[test]
fn a_list_says_the_state_of_its_rows_or_else_of_the_parts_still_on_their_way() {
    let syncing = ViewState::Syncing { loaded: 1 };
    for (looks, says) in [
        (
            [(forbidden(), false), (ViewState::Connecting, false)],
            ViewState::Connecting,
        ),
        (
            [(forbidden(), false), (syncing.clone(), false)],
            syncing.clone(),
        ),
        (
            [(forbidden(), false), (ViewState::Unauthorized, false)],
            ViewState::Unauthorized,
        ),
        (
            [(ViewState::Ready, true), (ViewState::Queued, true)],
            ViewState::Stale,
        ),
    ] {
        assert_eq!(status(&looks), says, "{looks:?}");
    }
    assert_eq!(status(&[(ViewState::Queued, false)]), ViewState::Queued);
    assert_eq!(status(&[(ViewState::Stale, false)]), ViewState::Connecting);
}

fn forty_namespaces(fake: &Fake) -> Vec<String> {
    let names: Vec<String> = (0..40).map(|n| format!("ns-{n:02}")).collect();
    for name in &names {
        fake.add("namespaces", None, name);
        pods_in(fake, &[name]);
    }
    names
}

fn asked_of(fake: &Fake, names: &[String]) -> Vec<String> {
    let asked = |name: &&String| fake.count(&format!("/api/v1/namespaces/{name}/pods")) > 0;
    names.iter().filter(asked).cloned().collect()
}

async fn resolved_to_two(fake: &Fake) -> Hub {
    forty_namespaces(fake);
    for name in ["ns-05", "ns-18"] {
        fake.allow(Some(name), "list", "pods");
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut first = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut first, &mut mirror, |m| m.names().len() == 2).await;
    hub
}

#[tokio::test(start_paused = true)]
async fn all_namespaces_of_a_person_who_may_list_pods_in_three_of_forty_read_three_parts() {
    let fake = Fake::default();
    let names = allowed_in_three(&fake);
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut list, &mut mirror, |m| m.names().len() == 3).await;
    assert_eq!(mirror.names(), ["p-ns-05", "p-ns-18", "p-ns-31"]);
    assert_eq!(mirror.status, Some(ViewState::Ready));
    assert_eq!(mirror.parts, Some(three_of_forty()));
    assert!(list.resolved());
    assert_eq!(
        asked_of(&fake, &names),
        ["ns-05", "ns-18", "ns-31"],
        "no list or watch of the 37"
    );
    assert_eq!(fake.count("/api/v1/pods"), 0, "none cluster-wide");
    assert_eq!(fake.count("selfsubjectaccessreviews"), 41, "1 and 40");
}

#[tokio::test(start_paused = true)]
async fn all_namespaces_of_a_person_who_may_list_pods_cluster_wide_is_one_part_after_one_review() {
    let fake = Fake::default();
    let names = forty_namespaces(&fake);
    fake.allow(None, "list", "pods");
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut list, &mut mirror, |m| m.names().len() == 40).await;
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 1,
            omitted: 0,
            unready: Vec::new(),
        })
    );
    assert_eq!(hub.scopes(), [Scope::Cluster]);
    assert_eq!(fake.count("selfsubjectaccessreviews"), 1);
    assert_eq!(
        fake.count("/api/v1/namespaces?"),
        0,
        "no list of namespaces"
    );
    assert_eq!(asked_of(&fake, &names), Vec::<String>::new());
}

#[tokio::test(start_paused = true)]
async fn all_namespaces_when_the_namespaces_are_refused_or_nothing_is_allowed_is_the_clusters_refusal()
 {
    let fake = Fake::default();
    forty_namespaces(&fake);
    fake.state().forbidden.insert("/api/v1/pods".to_owned());
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut refused = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut refused, &mut mirror, |m| m.status == Some(forbidden())).await;
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 1,
            omitted: 0,
            unready: vec![PartState {
                part: Part::Cluster,
                state: forbidden(),
                shown: false,
            }],
        })
    );
    assert_eq!(
        fake.count("selfsubjectaccessreviews"),
        1,
        "no namespace asked"
    );

    assert!(!refused.resolved());
    assert_eq!(fake.count("/api/v1/namespaces?"), 1);

    sleep(REFUSED_FOR - Duration::from_secs(1)).await;
    let within = hub.rows(query(&[])).await.unwrap();
    assert_eq!(within.state(), forbidden(), "no wait for its refusal");
    sleep(Duration::from_secs(1)).await;
    assert_eq!(
        fake.count("/api/v1/namespaces?"),
        1,
        "a refusal kept for 30 s is read, not asked"
    );

    fake.state().forbidden.remove("/api/v1/namespaces");
    sleep(Duration::from_secs(2)).await;
    let mut none = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut none, &mut mirror, |m| m.status == Some(forbidden())).await;
    assert_eq!(fake.count("/api/v1/namespaces?"), 2, "asked again after");
    let kept = hub.rows(query(&[])).await.unwrap();
    sleep(Duration::from_secs(1)).await;
    assert_eq!(
        fake.count("/api/v1/namespaces?"),
        2,
        "no namespace allowed is kept the same"
    );
    drop(kept);
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 1,
            omitted: 0,
            unready: vec![PartState {
                part: Part::Cluster,
                state: forbidden(),
                shown: false,
            }],
        }),
        "the 40 namespaces are no count of what a cluster part leaves out"
    );
    assert_eq!(mirror.names(), Vec::<&str>::new());
    assert!(!none.resolved(), "it reads the cluster, not parts");
}

#[tokio::test(start_paused = true)]
async fn what_all_namespaces_came_to_is_read_at_once_after_five_minutes_and_resolved_again_for_the_lists_after()
 {
    let fake = Fake::default();
    let hub = resolved_to_two(&fake).await;
    let (reviews, listed) = (
        fake.count("selfsubjectaccessreviews"),
        fake.count("/api/v1/namespaces?"),
    );

    fake.add("namespaces", None, "ns-40");
    fake.allow(Some("ns-40"), "list", "pods");
    pods_in(&fake, &["ns-40"]);
    sleep(RESOLVED_FOR - Duration::from_secs(1)).await;
    let mut within = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut within, &mut mirror, |m| m.names().len() == 2).await;
    assert_eq!(mirror.parts.as_ref().unwrap().omitted, 38);
    assert_eq!(fake.count("selfsubjectaccessreviews"), reviews);
    assert_eq!(fake.count("/api/v1/namespaces?"), listed, "it asks nothing");
    drop(within);

    sleep(Duration::from_secs(2)).await;
    fake.state().reviews_take = Duration::from_secs(1);
    let open = hub.rows(query(&[])).await.unwrap();
    let also = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();
    mirror.read(&open);
    let parts = mirror.parts.as_ref().unwrap();
    assert_eq!(
        (parts.count, parts.omitted),
        (2, 38),
        "the set is read at once, past its time"
    );

    sleep(Duration::from_secs(10)).await;
    assert_eq!(
        fake.count("/api/v1/namespaces?"),
        listed + 1,
        "resolved again once, for both"
    );
    mirror.read(&open);
    assert_eq!(
        mirror.parts.as_ref().unwrap().count,
        2,
        "it keeps its parts"
    );
    let later = hub.rows(query(&[])).await.unwrap();
    sleep(Duration::from_secs(1)).await;
    let mut mirror = Mirror::default();
    mirror.read(&later);
    assert_eq!(mirror.names(), ["p-ns-05", "p-ns-18", "p-ns-40"]);
    assert_eq!(mirror.parts.as_ref().unwrap().omitted, 38);
    drop(also);
}

#[tokio::test(start_paused = true)]
async fn a_set_read_past_five_minutes_is_forgotten_once_the_person_may_list_cluster_wide() {
    let fake = Fake::default();
    let hub = resolved_to_two(&fake).await;
    sleep(RESOLVED_FOR + Duration::from_secs(1)).await;
    fake.allow(None, "list", "pods");
    let stale = hub.rows(query(&[])).await.unwrap();
    assert!(stale.resolved(), "read at once, as it was");
    sleep(Duration::from_secs(5)).await;
    let later = hub.rows(query(&[])).await.unwrap();
    sleep(Duration::from_secs(1)).await;
    let mut mirror = Mirror::default();
    mirror.read(&later);
    assert_eq!(mirror.names().len(), 40);
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 1,
            omitted: 0,
            unready: Vec::new(),
        })
    );
}

#[tokio::test(start_paused = true)]
async fn a_renewal_that_does_not_settle_keeps_the_set_and_the_next_list_resolves_it_again() {
    for failure in ["the cluster-wide review", "the namespaces", "one review"] {
        let fake = Fake::default();
        let hub = resolved_to_two(&fake).await;
        sleep(RESOLVED_FOR + Duration::from_secs(1)).await;
        match failure {
            "the cluster-wide review" => {
                let unavailable = StatusCode::SERVICE_UNAVAILABLE;
                fake.state().reviews_fail.insert(None, unavailable);
            }
            "the namespaces" => {
                let namespaces = "/api/v1/namespaces".to_owned();
                fake.state().no_endpoints.insert(namespaces);
            }
            _ => {
                let unavailable = StatusCode::SERVICE_UNAVAILABLE;
                let namespace = Some("ns-30".to_owned());
                fake.state().reviews_fail.insert(namespace, unavailable);
            }
        }
        let renewing = hub.rows(query(&[])).await.unwrap();
        sleep(Duration::from_secs(10)).await;
        let next = hub.rows(query(&[])).await.unwrap();
        let mut mirror = Mirror::default();
        mirror.read(&next);
        let parts = mirror.parts.as_ref().unwrap();
        assert_eq!(
            (parts.count, parts.omitted, next.resolved()),
            (2, 38, true),
            "{failure} failed, and the list starts with the set it had"
        );

        fake.state().reviews_fail.clear();
        fake.state().no_endpoints.clear();
        fake.add("namespaces", None, "ns-40");
        fake.allow(Some("ns-40"), "list", "pods");
        pods_in(&fake, &["ns-40"]);
        let resolving = hub.rows(query(&[])).await.unwrap();
        sleep(Duration::from_secs(10)).await;
        let mut later = hub.rows(query(&[])).await.unwrap();
        let mut mirror = Mirror::default();
        until_shown(&mut later, &mut mirror, |m| m.names().len() == 3).await;
        assert_eq!(
            mirror.names(),
            ["p-ns-05", "p-ns-18", "p-ns-40"],
            "{failure} answers again, and it is resolved anew"
        );
        assert_eq!(mirror.parts.as_ref().unwrap().omitted, 38);
        drop((renewing, resolving));
    }
}

#[tokio::test(start_paused = true)]
async fn all_namespaces_say_connecting_until_their_reviews_are_in() {
    let fake = Fake::default();
    forty_namespaces(&fake);
    fake.allow(Some("ns-05"), "list", "pods");
    fake.state().reviews_take = Duration::from_secs(1);
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();

    assert_eq!(list.state(), ViewState::Connecting);
    mirror.read(&list);
    assert_eq!(mirror.status, Some(ViewState::Connecting));
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 1,
            omitted: 0,
            unready: Vec::new(),
        })
    );
    sleep(Duration::from_secs(3)).await;
    mirror.read(&list);
    assert_eq!(mirror.status, Some(ViewState::Connecting), "no refusal yet");
    until_shown(&mut list, &mut mirror, |m| m.names().len() == 1).await;
    assert_eq!(mirror.status, Some(ViewState::Ready));
    assert_eq!(fake.count("selfsubjectaccessreviews"), 41);
    assert_eq!(fake.state().reviews_overlap, 8, "at most eight at a time");
}

#[tokio::test(start_paused = true)]
async fn a_list_of_all_namespaces_that_ends_while_its_reviews_are_in_flight_reads_nothing() {
    let fake = Fake::default();
    let names = forty_namespaces(&fake);
    fake.allow(Some("ns-05"), "list", "pods");
    fake.state().reviews_take = Duration::from_secs(1);
    let (hub, _clients) = fake.hub(Budgets::default());
    drop(hub.rows(query(&[])).await.unwrap());
    sleep(Duration::from_secs(60)).await;
    assert_eq!(asked_of(&fake, &names), Vec::<String>::new());
    assert_eq!(fake.count("/api/v1/pods"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_list_of_all_namespaces_is_whole_only_once_it_has_resolved_and_listed() {
    let fake = Fake::default();
    forty_namespaces(&fake);
    fake.allow(Some("ns-05"), "list", "pods");
    fake.state().reviews_take = Duration::from_secs(1);
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&[])).await.unwrap();

    let rows = list.whole().await.unwrap();
    assert_eq!(rows.len(), 1);
}

fn allowed_in_three(fake: &Fake) -> Vec<String> {
    let names = forty_namespaces(fake);
    for name in ["ns-05", "ns-18", "ns-31"] {
        fake.allow(Some(name), "list", "pods");
    }
    names
}

fn three_of_forty() -> Parts {
    Parts {
        count: 3,
        omitted: 37,
        unready: Vec::new(),
    }
}

#[tokio::test(start_paused = true)]
async fn a_review_the_cluster_refuses_leaves_all_namespaces_to_the_clusters_own_answer() {
    let fake = Fake::default();
    allowed_in_three(&fake);
    fake.state()
        .reviews_fail
        .insert(None, StatusCode::FORBIDDEN);
    fake.state().forbidden.insert("/api/v1/pods".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut list, &mut mirror, |m| m.status == Some(forbidden())).await;
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 1,
            omitted: 0,
            unready: vec![PartState {
                part: Part::Cluster,
                state: forbidden(),
                shown: false,
            }],
        })
    );
    assert_eq!(hub.scopes(), [Scope::Cluster]);
    assert!(!list.resolved());
    assert_eq!(fake.count("selfsubjectaccessreviews"), 1);

    sleep(REFUSED_FOR - Duration::from_secs(1)).await;
    drop(hub.rows(query(&[])).await.unwrap());
    settle().await;
    assert_eq!(
        fake.count("selfsubjectaccessreviews"),
        1,
        "kept as long as a review's no"
    );
}

#[tokio::test(start_paused = true)]
async fn a_namespace_whose_review_does_not_answer_counts_as_allowed_and_the_next_list_asks_again() {
    let fake = Fake::default();
    forty_namespaces(&fake);
    for name in ["ns-05", "ns-31"] {
        fake.allow(Some(name), "list", "pods");
    }
    fake.state()
        .reviews_fail
        .insert(Some("ns-18".to_owned()), StatusCode::SERVICE_UNAVAILABLE);
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/ns-18/pods".to_owned());
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut first = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut first, &mut mirror, |m| m.names().len() == 2).await;
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 3,
            omitted: 37,
            unready: vec![namespace_part("ns-18", forbidden(), false)],
        }),
        "its part says its own state"
    );

    fake.state().reviews_fail.clear();
    let mut second = hub.rows(query(&[])).await.unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut second, &mut mirror, |m| {
        m.parts.as_ref().is_some_and(|parts| parts.count == 2)
    })
    .await;
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 2,
            omitted: 38,
            unready: Vec::new(),
        }),
        "asked again, and the answer is the set"
    );
}

fn connecting(
    fake: &Fake,
    failure: IpcError,
) -> (Hub, Arc<AtomicBool>, Arc<AtomicUsize>, Arc<Clients>) {
    let clients = fake.clients(Budgets::default());
    let down = Arc::new(AtomicBool::new(true));
    let tries = Arc::new(AtomicUsize::new(0));
    let connect: Connect = {
        let (down, tries, clients) = (Arc::clone(&down), Arc::clone(&tries), Arc::clone(&clients));
        Arc::new(move |_context| {
            tries.fetch_add(1, Ordering::Relaxed);
            let (clients, failure) = (Arc::clone(&clients), failure.clone());
            let down = down.load(Ordering::Relaxed);
            Box::pin(async move { if down { Err(failure) } else { Ok(clients) } })
        })
    };
    (Hub::new(connect), down, tries, clients)
}

#[tokio::test(start_paused = true)]
async fn all_namespaces_wait_for_what_does_not_answer_and_never_take_it_for_a_refusal() {
    let error = IpcError::new(ErrorKind::Timeout, "the credential plugin timed out");
    for (failing, says) in [
        ("the cluster-wide review", ViewState::Connecting),
        ("the namespaces", ViewState::Connecting),
        (
            "the clients",
            ViewState::Error {
                error: error.clone(),
            },
        ),
    ] {
        let fake = Fake::default();
        allowed_in_three(&fake);
        let (hub, down, tries, _clients) = connecting(&fake, error.clone());
        down.store(failing == "the clients", Ordering::Relaxed);
        match failing {
            "the cluster-wide review" => {
                let unavailable = StatusCode::SERVICE_UNAVAILABLE;
                fake.state().reviews_fail.insert(None, unavailable);
            }
            "the namespaces" => {
                let namespaces = "/api/v1/namespaces".to_owned();
                fake.state().no_endpoints.insert(namespaces);
            }
            _ => {}
        }
        let tried = || match failing {
            "the cluster-wide review" => fake.count("selfsubjectaccessreviews"),
            "the namespaces" => fake.count("/api/v1/namespaces?"),
            _ => tries.load(Ordering::Relaxed),
        };
        let mut list = hub.rows(query(&[])).await.unwrap();
        let mut mirror = Mirror::default();
        assert_eq!(list.state(), says, "{failing}");

        sleep(Duration::from_secs(60)).await;
        mirror.read(&list);
        assert_eq!(mirror.status, Some(says), "{failing}");
        assert_eq!(
            hub.scopes(),
            [],
            "{failing}: no part, the cluster's included"
        );
        assert_eq!(fake.count("/api/v1/pods"), 0, "{failing}");
        assert!(tried() > 5, "{failing}: it asks again, with the backoff");

        down.store(false, Ordering::Relaxed);
        fake.state().reviews_fail.clear();
        fake.state().no_endpoints.clear();
        until_shown(&mut list, &mut mirror, |m| m.names().len() == 3).await;
        assert_eq!(mirror.parts, Some(three_of_forty()), "{failing}");
    }
}

#[tokio::test(start_paused = true)]
async fn all_namespaces_of_rejected_credentials_say_unauthorized_and_wait_for_a_new_subscription() {
    for rejected in [
        "the clients",
        "the plugin",
        "the cluster-wide review",
        "the namespaces",
        "a namespace's review",
    ] {
        let fake = Fake::default();
        allowed_in_three(&fake);
        fake.state().reviews_take = Duration::from_secs(1);
        let error = IpcError::new(ErrorKind::Unauthorized, "the plugin failed");
        let (hub, down, tries, clients) = connecting(&fake, error);
        down.store(rejected == "the clients", Ordering::Relaxed);
        {
            let mut state = fake.state();
            match rejected {
                "the plugin" => state.plugin_timed_out = true,
                "the cluster-wide review" => {
                    state.reviews_fail.insert(None, StatusCode::UNAUTHORIZED);
                }
                "the namespaces" => {
                    state.unauthorized.insert("/api/v1/namespaces".to_owned());
                }
                "a namespace's review" => {
                    let namespace = Some("ns-18".to_owned());
                    state
                        .reviews_fail
                        .insert(namespace, StatusCode::UNAUTHORIZED);
                }
                _ => {}
            }
        }
        let list = hub.rows(query(&[])).await.unwrap();

        sleep(Duration::from_secs(60)).await;
        let sent = (fake.state().requests.len(), tries.load(Ordering::Relaxed));
        sleep(Duration::from_secs(60)).await;
        assert_eq!(list.state(), ViewState::Unauthorized, "{rejected}");
        assert_eq!(
            (fake.state().requests.len(), tries.load(Ordering::Relaxed)),
            sent,
            "{rejected}: a retry would run the plugin"
        );
        assert_eq!(
            hub.scopes(),
            [],
            "{rejected}: no part, not even for the namespaces allowed"
        );
        let usage = clients.usage();
        let slots = usage.borrow().requests;
        assert_eq!((slots.held, slots.queued), (0, 0), "{rejected}");

        down.store(false, Ordering::Relaxed);
        {
            let mut state = fake.state();
            state.plugin_timed_out = false;
            state.reviews_fail.clear();
            state.unauthorized.clear();
        }
        let mut again = hub.rows(query(&[])).await.unwrap();
        let mut mirror = Mirror::default();
        until_shown(&mut again, &mut mirror, |m| m.names().len() == 3).await;
        assert_eq!(mirror.parts, Some(three_of_forty()), "{rejected}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_reader_of_a_list_with_no_part_sees_what_it_waits_on_change() {
    let fake = Fake::default();
    allowed_in_three(&fake);
    fake.state()
        .reviews_fail
        .insert(None, StatusCode::SERVICE_UNAVAILABLE);
    let error = IpcError::new(ErrorKind::Timeout, "the credential plugin timed out");
    let (hub, down, ..) = connecting(&fake, error.clone());
    down.store(false, Ordering::Relaxed);
    let mut list = hub.rows(query(&[])).await.unwrap();
    assert_eq!(list.state(), ViewState::Connecting);

    down.store(true, Ordering::Relaxed);
    let says = ViewState::Error { error };
    until(&mut list, |state| *state == says).await;
}

#[tokio::test(start_paused = true)]
async fn all_namespaces_are_resolved_while_every_watch_is_taken() {
    let fake = Fake::default();
    forty_namespaces(&fake);
    fake.allow(Some("ns-05"), "list", "pods");
    let (hub, _clients) = fake.hub(budget(1));
    let mut other = hub.rows(query(&["ns-18"])).await.unwrap();
    ready(&mut other).await;
    let list = hub.rows(query(&[])).await.unwrap();

    sleep(Duration::from_secs(5)).await;
    let mut mirror = Mirror::default();
    mirror.read(&list);
    assert_eq!(mirror.status, Some(ViewState::Queued));
    assert_eq!(
        mirror.parts,
        Some(Parts {
            count: 1,
            omitted: 39,
            unready: vec![namespace_part("ns-05", ViewState::Queued, false)],
        }),
        "its part waits for a stream, the list does not wait to know it"
    );
}
