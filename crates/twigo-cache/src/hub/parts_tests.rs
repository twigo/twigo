use std::collections::HashMap;
use std::time::Duration;

use tokio::time::sleep;
use twigo_ipc::{Part, PartState, Parts, ViewState};
use twigo_kube::client::Budgets;

use super::tests::{budget, pods, query, ready, settle, until};
use super::*;
use crate::fake::Fake;

fn forbidden() -> ViewState {
    ViewState::Forbidden {
        verb: "watch".to_owned(),
        resource: "pods".to_owned(),
    }
}

fn namespace_part(name: &str, state: ViewState, shown: bool) -> PartState {
    PartState {
        part: Part::Namespace {
            name: name.to_owned(),
        },
        state,
        shown,
    }
}

/// A pod `p-<namespace>` in each namespace.
fn pods_in(fake: &Fake, namespaces: &[&str]) {
    for namespace in namespaces {
        fake.add("pods", Some(namespace), &format!("p-{namespace}"));
    }
}

/// What a list holds of what its subscription drained.
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
    let reached = async {
        loop {
            mirror.read(subscription);
            if wanted(mirror) {
                return;
            }
            subscription.changed().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(600), reached)
        .await
        .expect("the list within ten minutes");
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
async fn a_fast_refusal_beside_a_part_still_on_its_way_does_not_name_the_list() {
    let fake = Fake::default();
    pods_in(&fake, &["a", "b"]);
    {
        let mut state = fake.state();
        state
            .forbidden
            .insert("/api/v1/namespaces/a/pods".to_owned());
        state
            .hold_paths
            .insert("/api/v1/namespaces/b/pods".to_owned());
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&["a", "b"])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut list, &mut mirror, |m| {
        m.unready()
            == [
                namespace_part("a", forbidden(), false),
                namespace_part("b", ViewState::Connecting, false),
            ]
    })
    .await;
    assert_eq!(mirror.names(), Vec::<&str>::new());
    assert_eq!(mirror.status, Some(ViewState::Connecting));

    settle().await;
    fake.stream_initial();
    until_shown(&mut list, &mut mirror, |m| {
        m.status == Some(ViewState::Syncing { loaded: 1 })
    })
    .await;
    assert_eq!(mirror.names(), Vec::<&str>::new());
}

#[tokio::test(start_paused = true)]
async fn a_list_whose_parts_are_all_refused_says_the_worst_refusal() {
    let fake = Fake::default();
    pods_in(&fake, &["a", "b"]);
    {
        let mut state = fake.state();
        state
            .forbidden
            .insert("/api/v1/namespaces/a/pods".to_owned());
        state
            .unauthorized
            .insert("/api/v1/namespaces/b/pods".to_owned());
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let mut list = hub.rows(query(&["a", "b"])).await.unwrap();
    let mut mirror = Mirror::default();

    until_shown(&mut list, &mut mirror, |m| {
        m.unready()
            == [
                namespace_part("a", forbidden(), false),
                namespace_part("b", ViewState::Unauthorized, false),
            ]
    })
    .await;
    assert_eq!(mirror.status, Some(ViewState::Unauthorized));
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

#[tokio::test(start_paused = true)]
async fn a_list_whose_only_part_waits_for_a_stream_says_queued() {
    let fake = Fake::default();
    pods_in(&fake, &["a", "x"]);
    let (hub, _clients) = fake.hub(budget(1));
    let mut other = hub.rows(query(&["x"])).await.unwrap();
    ready(&mut other).await;
    let mut list = hub.rows(query(&["a"])).await.unwrap();
    let mut mirror = Mirror::default();
    until_shown(&mut list, &mut mirror, |m| {
        m.unready() == [namespace_part("a", ViewState::Queued, false)]
    })
    .await;
    assert_eq!(mirror.names(), Vec::<&str>::new());
    assert_eq!(mirror.status, Some(ViewState::Queued));
}
