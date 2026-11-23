use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;
use tokio::sync::mpsc;
use twigo_cache::batcher::Batcher;
use twigo_cache::fake::Fake;
use twigo_cache::hub::Hub;
use twigo_ipc::{
    Cell, Column, ColumnKind, ErrorCode, ListBatch, Part, PartState, Parts, ReleaseListQuery, Row,
    RowId, Sort, ViewState,
};
use twigo_kube::client::{Budgets, Clients};

use super::fetch::secret_name;
use super::*;

fn revision(fake: &Fake, namespace: &str, release: &str, version: u32, status: &str) {
    testing::put(
        fake,
        &testing::release(namespace, release, version, status),
        status,
    );
}

fn gone(fake: &Fake, namespace: &str, release: &str, version: u32) {
    fake.delete("secrets", Some(namespace), &secret_name(release, version));
}

fn query(namespaces: &[&str]) -> ReleaseListQuery {
    ReleaseListQuery {
        space: "kind-test".to_owned(),
        namespaces: namespaces.iter().map(|&name| name.to_owned()).collect(),
        text: None,
        columns: None,
        sort: None,
        count_by: None,
        group_by: None,
        values: None,
    }
}

#[derive(Default)]
struct Seen {
    columns: Vec<Column>,
    ids: Vec<RowId>,
    rows: HashMap<RowId, Row>,
    status: Option<ViewState>,
    parts: Option<Parts>,
}

impl Seen {
    fn apply(&mut self, batch: ListBatch) {
        if let Some(columns) = batch.columns {
            self.columns = columns;
        }
        if let Some(window) = batch.window {
            self.ids = window.ids;
        }
        self.rows
            .extend(batch.upserts.into_iter().map(|row| (row.id.clone(), row)));
        self.status = Some(batch.status);
        if batch.parts.is_some() {
            self.parts = batch.parts;
        }
    }

    fn cell<'a>(&self, row: &'a Row, column: &str) -> Option<&'a Cell> {
        let at = self.columns.iter().position(|found| found.name == column)?;
        row.cells.get(at)
    }

    fn table(&self) -> Vec<String> {
        self.ids
            .iter()
            .filter_map(|id| self.rows.get(id))
            .map(|row| {
                ["Namespace", "Name", "Revision", "Status", "Problem"]
                    .iter()
                    .filter_map(|column| self.cell(row, column))
                    .map(|cell| match cell {
                        Cell::Null => "-".to_owned(),
                        Cell::Int(number) => number.to_string(),
                        Cell::Text(text) => text.clone(),
                        other => panic!("a cell no column of a release holds: {other:?}"),
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect()
    }
}

struct Rig {
    fake: Fake,
    _hub: (Hub, Arc<Clients>),
    list: Batcher,
    batches: mpsc::UnboundedReceiver<ListBatch>,
    seen: Seen,
}

impl Rig {
    async fn new(fake: Fake, query: ReleaseListQuery) -> Self {
        let (hub, clients) = fake.hub(Budgets::default());
        let (sender, batches) = mpsc::unbounded_channel();
        let batcher = list(&hub, "kind-test".to_owned(), query, move |batch| {
            sender.send(batch).is_ok()
        })
        .await
        .unwrap();
        batcher.set_window(0, 100, false);
        Self {
            fake,
            _hub: (hub, clients),
            list: batcher,
            batches,
            seen: Seen::default(),
        }
    }

    async fn over(namespaces: &[&str], seed: impl FnOnce(&Fake)) -> Self {
        let fake = Fake::default();
        seed(&fake);
        Self::new(fake, query(namespaces)).await
    }

    async fn next(&mut self) -> ListBatch {
        let received = tokio::time::timeout(Duration::from_secs(600), self.batches.recv()).await;
        let batch = received
            .expect("a batch within ten minutes")
            .expect("the list runs");
        self.list.ack(batch.seq);
        batch
    }

    async fn shows(&mut self, rows: &[&str]) {
        let reached = async {
            while self.seen.status != Some(ViewState::Ready) || self.seen.table() != rows {
                let batch = self.next().await;
                self.seen.apply(batch);
            }
        };
        let within = tokio::time::timeout(Duration::from_secs(600), reached).await;
        assert!(
            within.is_ok(),
            "not within ten minutes; the list shows {:?}",
            self.seen.table()
        );
    }
}

#[tokio::test(start_paused = true)]
async fn the_release_secrets_are_followed_by_helms_label_as_metadata() {
    let mut rig = Rig::over(&["a", "b"], |fake| {
        fake.state().gets_take = Duration::from_secs(3600);
        revision(fake, "a", "app", 1, "deployed");
    })
    .await;
    rig.shows(&["a app 1 deployed -"]).await;

    let secrets = rig.fake.count("/secrets?");
    assert!(secrets > 0);
    assert_eq!(
        rig.fake.count("/secrets?labelSelector=owner%3Dhelm"),
        secrets
    );
    assert_eq!(rig.fake.count("fieldSelector"), 0, "Helm reads no type");
    let kinds: Vec<_> = rig
        .seen
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            ("Name", ColumnKind::String),
            ("Namespace", ColumnKind::String),
            ("Revision", ColumnKind::Integer),
            ("Status", ColumnKind::String),
            ("Chart", ColumnKind::String),
            ("App Version", ColumnKind::String),
            ("Updated", ColumnKind::Age),
            ("Problem", ColumnKind::String),
        ]
    );
    let row = &rig.seen.rows[&RowId("kind-test/a/app".to_owned())];
    assert_eq!(rig.seen.cell(row, "Revision"), Some(&Cell::Int(1)));
    for column in ["Chart", "App Version", "Updated"] {
        assert_eq!(rig.seen.cell(row, column), Some(&Cell::Null), "{column}");
    }
    assert_eq!(row.created, None, "until its revision is decoded");
}

#[tokio::test(start_paused = true)]
async fn an_upgrade_moves_the_row_to_the_new_revision() {
    let mut rig = Rig::over(&["a", "b"], |fake| {
        revision(fake, "a", "app", 1, "deployed");
    })
    .await;
    rig.shows(&["a app 1 deployed -"]).await;

    revision(&rig.fake, "a", "app", 2, "pending-upgrade");
    rig.shows(&["a app 2 pending-upgrade -"]).await;
    revision(&rig.fake, "a", "app", 1, "superseded");
    revision(&rig.fake, "a", "app", 2, "deployed");
    rig.shows(&["a app 2 deployed -"]).await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_upgrade_shows_its_revision_and_not_the_one_that_still_runs() {
    let mut rig = Rig::over(&["a", "b"], |fake| {
        revision(fake, "a", "app", 1, "deployed");
        revision(fake, "a", "app", 2, "failed");
    })
    .await;
    rig.shows(&["a app 2 failed -"]).await;
}

#[tokio::test(start_paused = true)]
async fn of_several_deployed_revisions_the_highest_is_the_row() {
    let mut rig = Rig::over(&["a", "b"], |fake| {
        revision(fake, "a", "app", 3, "deployed");
        revision(fake, "a", "app", 1, "deployed");
        revision(fake, "a", "app", 2, "deployed");
    })
    .await;
    rig.shows(&["a app 3 deployed -"]).await;
}

#[tokio::test(start_paused = true)]
async fn a_name_in_two_namespaces_is_two_releases() {
    let mut rig = Rig::over(&["a", "b"], |fake| {
        revision(fake, "a", "app", 1, "deployed");
        revision(fake, "b", "app", 4, "failed");
    })
    .await;
    rig.shows(&["a app 1 deployed -", "b app 4 failed -"]).await;

    revision(&rig.fake, "b", "app", 5, "deployed");
    rig.shows(&["a app 1 deployed -", "b app 5 deployed -"])
        .await;
}

#[tokio::test(start_paused = true)]
async fn an_uninstall_that_keeps_no_history_takes_the_row_and_one_that_keeps_it_does_not() {
    let mut rig = Rig::over(&["a", "b"], |fake| {
        for version in 1..=2 {
            revision(fake, "a", "app", version, "deployed");
        }
        revision(fake, "a", "kept", 1, "deployed");
    })
    .await;
    rig.shows(&["a app 2 deployed -", "a kept 1 deployed -"])
        .await;

    revision(&rig.fake, "a", "kept", 1, "uninstalled");
    rig.shows(&["a app 2 deployed -", "a kept 1 uninstalled -"])
        .await;
    gone(&rig.fake, "a", "app", 1);
    gone(&rig.fake, "a", "app", 2);
    rig.shows(&["a kept 1 uninstalled -"]).await;
}

#[tokio::test(start_paused = true)]
async fn a_pruned_history_leaves_the_row_and_a_row_falls_back_to_the_newest_that_remains() {
    let mut rig = Rig::over(&["a", "b"], |fake| {
        for version in 1..=3 {
            revision(fake, "a", "app", version, "superseded");
        }
    })
    .await;
    rig.shows(&["a app 3 superseded -"]).await;

    gone(&rig.fake, "a", "app", 1);
    revision(&rig.fake, "a", "app", 4, "deployed");
    rig.shows(&["a app 4 deployed -"]).await;
    gone(&rig.fake, "a", "app", 4);
    rig.shows(&["a app 3 superseded -"]).await;
}

#[tokio::test(start_paused = true)]
async fn a_secret_of_helms_owner_without_the_labels_is_a_row_of_its_own() {
    let mut rig = Rig::over(&["a", "b"], |fake| {
        revision(fake, "a", "app", 1, "deployed");
        fake.put(
            "",
            "secrets",
            Some("a"),
            json!({
                "kind": "PartialObjectMetadata",
                "apiVersion": "meta.k8s.io/v1",
                "metadata": {
                    "name": "stray",
                    "namespace": "a",
                    "uid": "stray-uid",
                    "labels": { "owner": "helm" },
                },
            }),
        );
    })
    .await;
    rig.shows(&[
        "a app 1 deployed -",
        &format!("a stray - - {}", ErrorCode::HelmNotARelease.wire()),
    ])
    .await;

    odd_secret(&rig.fake);
    rig.shows(&[
        "a app 1 deployed -",
        &format!("a odd - - {}", ErrorCode::HelmNotARelease.wire()),
        &format!("a stray - - {}", ErrorCode::HelmNotARelease.wire()),
    ])
    .await;
}

fn odd_secret(fake: &Fake) {
    fake.put(
        "",
        "secrets",
        Some("a"),
        json!({
            "kind": "PartialObjectMetadata",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": {
                "name": "odd",
                "namespace": "a",
                "uid": "odd-uid",
                "labels": { "owner": "helm", "name": "app", "version": "latest" },
            },
        }),
    );
}

fn three(fake: &Fake) {
    revision(fake, "a", "web", 7, "failed");
    revision(fake, "a", "api", 1, "deployed");
    revision(fake, "a", "db", 3, "deployed");
}

#[tokio::test(start_paused = true)]
async fn the_query_view_sorts_and_filters_releases() {
    let fake = Fake::default();
    three(&fake);
    let mut sorted = query(&["a"]);
    sorted.sort = Some(Sort {
        column: "Revision".to_owned(),
        descending: true,
    });
    let mut rig = Rig::new(fake, sorted).await;
    rig.shows(&["web 7 failed -", "db 3 deployed -", "api 1 deployed -"])
        .await;

    let fake = Fake::default();
    three(&fake);
    let mut filtered = query(&["a"]);
    filtered.text = Some("failed".to_owned());
    let mut rig = Rig::new(fake, filtered).await;
    rig.shows(&["web 7 failed -"]).await;
}

#[tokio::test(start_paused = true)]
async fn a_namespace_the_person_may_not_read_is_said_beside_the_rows_of_the_others() {
    let fake = Fake::default();
    revision(&fake, "a", "app", 1, "deployed");
    revision(&fake, "c", "hidden", 1, "deployed");
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/c/secrets".to_owned());
    let mut rig = Rig::new(fake, query(&["a", "c"])).await;
    rig.shows(&["a app 1 deployed -"]).await;
    assert_eq!(
        rig.seen.parts,
        Some(Parts {
            count: 2,
            omitted: 0,
            unready: vec![PartState {
                part: Part::Namespace { name: "c".into() },
                state: ViewState::Forbidden {
                    verb: "watch".into(),
                    resource: "secrets".into(),
                },
                shown: false,
            }],
        })
    );
}

#[tokio::test(start_paused = true)]
async fn a_list_of_releases_that_panics_ends_with_a_batch_that_says_so() {
    twigo_panic::inject::arm("helm releases", 1);
    let mut rig = Rig::over(&["a", "b"], |fake| {
        revision(fake, "a", "app", 1, "deployed");
    })
    .await;
    let last = rig.next().await;
    let ViewState::Error { error } = &last.status else {
        panic!("the list failed: {:?}", last.status);
    };
    assert_eq!(error.code, ErrorCode::InternalPanic);
    assert!(last.window.is_none() && last.upserts.is_empty());
}

impl Rig {
    async fn until(&mut self, what: &str, done: impl Fn(&Seen) -> bool) {
        let reached = async {
            while !done(&self.seen) {
                let batch = self.next().await;
                self.seen.apply(batch);
            }
        };
        let within = tokio::time::timeout(Duration::from_secs(600), reached).await;
        assert!(
            within.is_ok(),
            "{what} not within ten minutes; the list shows {:?}",
            self.seen.table()
        );
    }
}

impl Seen {
    fn of(&self, namespace: &str, name: &str) -> Option<&Row> {
        self.rows
            .get(&RowId(format!("kind-test/{namespace}/{name}")))
            .filter(|row| self.ids.contains(&row.id))
    }

    /// The text of a row's cell, `-` for none.
    fn text(&self, namespace: &str, name: &str, column: &str) -> String {
        match self
            .of(namespace, name)
            .and_then(|row| self.cell(row, column))
        {
            Some(Cell::Text(text)) => text.clone(),
            Some(Cell::Int(number)) => number.to_string(),
            _ => "-".to_owned(),
        }
    }

    fn charted(&self, namespace: &str, name: &str) -> bool {
        self.text(namespace, name, "Chart") != "-"
    }
}

#[tokio::test(start_paused = true)]
async fn a_row_fills_once_its_newest_revision_is_decoded() {
    let mut rig = Rig::over(&["a"], |fake| {
        revision(fake, "a", "app", 1, "superseded");
        let mut newest = testing::release("a", "app", 2, "deployed");
        newest["chart"]["metadata"]["appVersion"] = json!("2.7");
        testing::put(fake, &newest, "pending-upgrade");
    })
    .await;
    rig.until("the chart", |seen| seen.charted("a", "app"))
        .await;

    let row = rig.seen.of("a", "app").unwrap();
    assert_eq!(rig.seen.text("a", "app", "Revision"), "2");
    assert_eq!(
        rig.seen.text("a", "app", "Status"),
        "deployed",
        "the payload's"
    );
    assert_eq!(rig.seen.text("a", "app", "Chart"), "demo-1.2.0");
    assert_eq!(rig.seen.text("a", "app", "App Version"), "2.7");
    assert_eq!(rig.seen.text("a", "app", "Problem"), "-");
    assert_eq!(
        row.created.as_deref(),
        Some("2026-11-02T10:00:00Z"),
        "Updated counts from last_deployed"
    );
    assert_eq!(testing::gets(&rig.fake, "a", "app", 2), 1);
    assert_eq!(
        testing::gets(&rig.fake, "a", "app", 1),
        0,
        "only the newest"
    );
}

#[tokio::test(start_paused = true)]
async fn a_new_revision_is_fetched_once_and_the_old_one_not_again() {
    let mut rig = Rig::over(&["a"], |fake| {
        revision(fake, "a", "app", 1, "deployed");
    })
    .await;
    rig.until("revision 1's chart", |seen| {
        seen.text("a", "app", "Chart") == "demo-1.1.0"
    })
    .await;

    revision(&rig.fake, "a", "app", 2, "deployed");
    rig.until("revision 2's chart", |seen| {
        seen.text("a", "app", "Chart") == "demo-1.2.0"
    })
    .await;
    revision(&rig.fake, "a", "app", 1, "superseded");
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(testing::gets(&rig.fake, "a", "app", 2), 1);
    assert_eq!(testing::gets(&rig.fake, "a", "app", 1), 1);
}

#[tokio::test(start_paused = true)]
async fn a_broken_release_secret_keeps_its_row_with_its_problem_while_the_others_fill() {
    let mut rig = Rig::over(&["a"], |fake| {
        revision(fake, "a", "app", 1, "deployed");
        let whole = testing::encoded(&testing::release("a", "cut", 3, "failed"));
        let gzip = STANDARD.decode(&whole).unwrap();
        let cut = STANDARD.encode(&gzip[..gzip.len() / 2]);
        testing::put_payload(fake, "a", "cut", 3, "failed", cut.as_bytes());
    })
    .await;
    rig.until("both decoded", |seen| {
        seen.charted("a", "app") && seen.text("a", "cut", "Problem") != "-"
    })
    .await;

    assert_eq!(
        rig.seen.text("a", "cut", "Problem"),
        ErrorCode::HelmTruncated.wire()
    );
    for (column, label) in [("Name", "cut"), ("Revision", "3"), ("Status", "failed")] {
        assert_eq!(rig.seen.text("a", "cut", column), label, "{column}");
    }
    for column in ["Chart", "App Version"] {
        assert_eq!(rig.seen.text("a", "cut", column), "-", "{column}");
    }
    assert_eq!(rig.seen.of("a", "cut").unwrap().created, None);
    assert_eq!(rig.seen.text("a", "app", "Chart"), "demo-1.1.0");
}

#[tokio::test(start_paused = true)]
async fn a_decode_that_panics_marks_its_row_alone() {
    twigo_panic::inject::arm(fetch::DECODE, 1);
    let mut rig = Rig::over(&["a"], three).await;
    let names = ["web", "api", "db"];
    rig.until("every row decoded", |seen| {
        names
            .iter()
            .all(|name| seen.charted("a", name) || seen.text("a", name, "Problem") != "-")
    })
    .await;

    let panicked: Vec<&str> = names
        .into_iter()
        .filter(|name| rig.seen.text("a", name, "Problem") == ErrorCode::InternalPanic.wire())
        .collect();
    assert_eq!(panicked.len(), 1, "{:?}", rig.seen.table());
    assert_eq!(rig.seen.status, Some(ViewState::Ready), "the list goes on");
    assert_eq!(
        names
            .iter()
            .filter(|name| rig.seen.charted("a", name))
            .count(),
        2
    );
}

#[tokio::test(start_paused = true)]
async fn no_more_than_four_release_secrets_are_fetched_at_once() {
    let names: Vec<String> = (0..10).map(|index| format!("r{index}")).collect();
    let mut rig = Rig::over(&["a"], |fake| {
        fake.state().gets_take = Duration::from_secs(1);
        for name in &names {
            revision(fake, "a", name, 1, "deployed");
        }
    })
    .await;
    rig.until("every row decoded", |seen| {
        names.iter().all(|name| seen.charted("a", name))
    })
    .await;
    assert_eq!(rig.fake.state().gets_overlap, 4);
}

#[tokio::test(start_paused = true)]
async fn a_release_whose_get_fails_says_so_while_it_does_and_fills_once_it_answers() {
    let path = format!("/api/v1/namespaces/a/secrets/{}", secret_name("app", 1));
    let mut rig = Rig::over(&["a"], |fake| {
        revision(fake, "a", "app", 1, "deployed");
        fake.state().no_endpoints.insert(path.clone());
    })
    .await;
    rig.until("the failure", |seen| {
        seen.text("a", "app", "Problem") == ErrorCode::ServerUnavailable.wire()
    })
    .await;
    assert_eq!(rig.seen.text("a", "app", "Status"), "deployed");

    rig.fake.state().no_endpoints.remove(&path);
    rig.until("the chart", |seen| seen.charted("a", "app"))
        .await;
    assert_eq!(rig.seen.text("a", "app", "Problem"), "-");
    assert!(testing::gets(&rig.fake, "a", "app", 1) >= 2);
}

#[tokio::test(start_paused = true)]
async fn a_status_change_keeps_the_row_s_chart_until_its_new_decode_lands() {
    let mut rig = Rig::over(&["a"], |fake| {
        revision(fake, "a", "app", 1, "pending-install");
    })
    .await;
    rig.until("the chart", |seen| seen.charted("a", "app"))
        .await;

    rig.fake.state().gets_take = Duration::from_secs(1);
    revision(&rig.fake, "a", "app", 1, "deployed");
    let mut blank = Vec::new();
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        while let Ok(batch) = rig.batches.try_recv() {
            rig.list.ack(batch.seq);
            rig.seen.apply(batch);
            if !rig.seen.charted("a", "app") || rig.seen.of("a", "app").unwrap().created.is_none() {
                blank.push(rig.seen.table());
            }
        }
    }
    assert!(blank.is_empty(), "{blank:?}");
    assert_eq!(testing::gets(&rig.fake, "a", "app", 1), 2);
    assert_eq!(rig.seen.text("a", "app", "Status"), "deployed");
}

#[tokio::test(start_paused = true)]
async fn a_decode_under_way_when_its_release_moves_on_is_dropped() {
    let mut rig = Rig::over(&["a"], |fake| {
        fake.state().gets_take = Duration::from_secs(10);
        revision(fake, "a", "app", 1, "deployed");
    })
    .await;
    rig.shows(&["app 1 deployed -"]).await;

    tokio::time::sleep(Duration::from_secs(1)).await;
    revision(&rig.fake, "a", "app", 2, "deployed");
    let mut wrong = Vec::new();
    while rig.seen.text("a", "app", "Chart") != "demo-1.2.0" {
        let batch = rig.next().await;
        rig.seen.apply(batch);
        if rig.seen.text("a", "app", "Revision") == "2" && rig.seen.charted("a", "app") {
            wrong.push(rig.seen.text("a", "app", "Chart"));
        }
    }
    wrong.retain(|chart| chart != "demo-1.2.0");
    assert!(wrong.is_empty(), "revision 2 showed {wrong:?}");
}

#[tokio::test(start_paused = true)]
async fn a_relist_asks_a_failed_release_again_at_once() {
    let path = format!("/api/v1/namespaces/a/secrets/{}", secret_name("app", 1));
    let mut rig = Rig::over(&["a"], |fake| {
        revision(fake, "a", "app", 1, "deployed");
        fake.state().no_endpoints.insert(path.clone());
    })
    .await;
    let mut failed_at = tokio::time::Instant::now();
    while testing::gets(&rig.fake, "a", "app", 1) < 4
        || failed_at.elapsed() < Duration::from_millis(100)
    {
        if testing::gets(&rig.fake, "a", "app", 1) < 4 {
            failed_at = tokio::time::Instant::now();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        while let Ok(batch) = rig.batches.try_recv() {
            rig.list.ack(batch.seq);
            rig.seen.apply(batch);
        }
    }

    rig.fake.state().no_endpoints.remove(&path);
    revision(&rig.fake, "b", "elsewhere", 1, "deployed");
    rig.fake.compact();
    rig.fake.end_watches();
    let relisted = tokio::time::Instant::now();
    rig.until("the chart", |seen| seen.charted("a", "app"))
        .await;
    assert!(
        relisted.elapsed() < Duration::from_secs(1),
        "asked again {:?} after the relist, where its fourth failure waits at least 2.5 s",
        relisted.elapsed()
    );
}
