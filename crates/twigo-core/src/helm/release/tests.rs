use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use twigo_cache::fake::Fake;
use twigo_cache::hub::Hub;
use twigo_ipc::{
    CompareRevisions, ComparedPart, ErrorCode, IpcError, OpenRelease, ReleaseParts, ReleaseRef,
    ViewState,
};
use twigo_kube::client::{Budgets, Clients};

use super::*;
use crate::helm::fetch::{DECODE, secret_name};
use crate::helm::testing::{self, Shown, Watched};

const ALL: ReleaseParts = ReleaseParts {
    overview: true,
    values: true,
    manifest: true,
    history: true,
};

const OVERVIEW: ReleaseParts = ReleaseParts {
    overview: true,
    values: false,
    manifest: false,
    history: false,
};

struct Rig {
    fake: Fake,
    _hub: (Hub, Arc<Clients>),
    opened: Opened,
    watched: Watched,
}

impl Rig {
    async fn open(fake: Fake, revision: Option<u32>, parts: ReleaseParts) -> Self {
        let (hub, clients) = fake.hub(Budgets::default());
        let (watched, send) = Watched::new();
        let request = OpenRelease {
            release: release_ref(),
            revision,
            parts,
        };
        let opened = crate::helm::open(&hub, "kind-test".to_owned(), request, send)
            .await
            .unwrap();
        Self {
            fake,
            _hub: (hub, clients),
            opened,
            watched,
        }
    }

    async fn until(&mut self, what: &str, done: impl Fn(&Shown) -> bool) {
        let opened = &self.opened;
        self.watched.until(|seq| opened.ack(seq), what, done).await;
    }

    fn gets(&self, version: u32) -> usize {
        testing::gets(&self.fake, "a", "app", version)
    }

    async fn drain_for(&mut self, span: Duration) {
        let opened = &self.opened;
        self.watched.drain_for(|seq| opened.ack(seq), span).await;
    }
}

fn path(version: u32) -> String {
    format!(
        "/api/v1/namespaces/a/secrets/{}",
        secret_name("app", version)
    )
}

fn release_ref() -> ReleaseRef {
    ReleaseRef {
        space: "kind-test".to_owned(),
        namespace: "a".to_owned(),
        name: "app".to_owned(),
    }
}

fn revision(fake: &Fake, version: u32, status: &str) {
    testing::put(fake, &testing::release("a", "app", version, status), status);
}

fn notes(shown: &Shown) -> Option<&str> {
    shown.notes.as_ref().map(|notes| notes.text.as_str())
}

#[tokio::test(start_paused = true)]
async fn an_open_release_shows_its_latest_revision_fetched_once_and_each_part_asked() {
    let fake = Fake::default();
    revision(&fake, 1, "superseded");
    revision(&fake, 2, "deployed");
    let mut rig = Rig::open(fake, None, OVERVIEW).await;
    rig.until("the overview", |shown| shown.overview.is_some())
        .await;

    let shown = &rig.watched.shown;
    assert_eq!((shown.revision, shown.latest), (Some(2), Some(2)));
    assert_eq!(
        shown.printed(),
        [
            "Name=app",
            "Revision=2",
            "Status=deployed",
            "Chart=demo-1.2.0",
            "App Version=2.0",
            "Problem=",
        ]
    );
    assert_eq!(notes(shown), Some("Revision 2 of app"));
    assert!(shown.values.is_none() && shown.manifest.is_none() && shown.history.is_none());
    assert_eq!((rig.gets(2), rig.gets(1)), (1, 0));

    rig.opened.set_view(None, ALL);
    rig.until("the values and the manifest", |shown| {
        shown.values.is_some() && shown.manifest.is_some()
    })
    .await;
    let values = rig.watched.shown.values.as_ref().unwrap();
    assert_eq!(values.user, r#"{"image":"<6 bytes>"}"#);
    assert!(
        rig.watched
            .shown
            .manifest
            .as_ref()
            .unwrap()
            .text
            .contains("kind: ConfigMap")
    );
    assert_eq!(rig.gets(2), 1, "the page is held while the editor is open");
    let shown = rig.opened.showing().now().expect("a page is held");
    assert_eq!(shown.revision, 2);
}

#[tokio::test(start_paused = true)]
async fn an_open_release_follows_the_latest_revision_unless_one_is_pinned() {
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    let mut rig = Rig::open(fake, None, OVERVIEW).await;
    rig.until("revision 1", |shown| {
        notes(shown) == Some("Revision 1 of app")
    })
    .await;

    revision(&rig.fake, 2, "deployed");
    rig.until("revision 2", |shown| {
        notes(shown) == Some("Revision 2 of app")
    })
    .await;
    assert_eq!(rig.watched.shown.revision, Some(2));

    rig.opened.set_view(Some(1), OVERVIEW);
    rig.until("revision 1 pinned", |shown| {
        notes(shown) == Some("Revision 1 of app")
    })
    .await;
    revision(&rig.fake, 3, "deployed");
    rig.until("the latest", |shown| shown.latest == Some(3))
        .await;
    rig.until("the row's cells", |shown| {
        shown.printed().contains(&"Revision=3".to_owned())
    })
    .await;
    assert_eq!(rig.watched.shown.revision, Some(1));
    assert_eq!(notes(&rig.watched.shown), Some("Revision 1 of app"));
}

#[tokio::test(start_paused = true)]
async fn previous_is_the_highest_revision_helm_keeps_below_the_one_shown() {
    let fake = Fake::default();
    revision(&fake, 2, "superseded");
    revision(&fake, 4, "deployed");
    let mut rig = Rig::open(fake, None, OVERVIEW).await;
    rig.until("revision 4", |shown| shown.overview.is_some())
        .await;
    let shown = &rig.watched.shown;
    assert_eq!((shown.revision, shown.previous), (Some(4), Some(2)));

    rig.opened.set_view(Some(2), OVERVIEW);
    rig.until("revision 2", |shown| {
        notes(shown) == Some("Revision 2 of app")
    })
    .await;
    assert_eq!(rig.watched.shown.previous, None);

    rig.opened.set_view(Some(4), OVERVIEW);
    rig.until("revision 4", |shown| {
        notes(shown) == Some("Revision 4 of app")
    })
    .await;
    rig.fake
        .delete("secrets", Some("a"), &secret_name("app", 4));
    rig.until("revision 4 gone", |shown| shown.problem.is_some())
        .await;
    let shown = &rig.watched.shown;
    assert_eq!(
        shown.problem.as_ref().unwrap().code,
        ErrorCode::HelmRevisionGone
    );
    assert_eq!(
        (shown.revision, shown.latest, shown.previous),
        (Some(4), Some(2), None),
        "nothing to compare a revision Helm no longer keeps with"
    );
}

#[tokio::test(start_paused = true)]
async fn a_pinned_revision_that_helm_prunes_says_so() {
    let fake = Fake::default();
    revision(&fake, 1, "superseded");
    revision(&fake, 2, "deployed");
    let mut rig = Rig::open(fake, Some(1), OVERVIEW).await;
    rig.until("revision 1", |shown| {
        notes(shown) == Some("Revision 1 of app")
    })
    .await;

    rig.fake
        .delete("secrets", Some("a"), &secret_name("app", 1));
    rig.until("a problem", |shown| shown.problem.is_some())
        .await;
    let shown = &rig.watched.shown;
    assert_eq!(
        shown.problem.as_ref().unwrap().code,
        ErrorCode::HelmRevisionGone
    );
    assert!(shown.exists);
    assert_eq!(shown.revision, Some(1));
    assert!(rig.opened.showing().now().is_none(), "its page is dropped");
}

#[tokio::test(start_paused = true)]
async fn an_uninstall_that_keeps_no_history_ends_the_release() {
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    let mut rig = Rig::open(fake, None, OVERVIEW).await;
    rig.until("the overview", |shown| shown.overview.is_some())
        .await;

    rig.fake
        .delete("secrets", Some("a"), &secret_name("app", 1));
    rig.until("no revision", |shown| !shown.exists).await;
    let shown = &rig.watched.shown;
    assert_eq!((shown.revision, shown.latest), (None, None));
    assert_eq!(shown.status, Some(ViewState::Ready));
    assert!(rig.opened.showing().now().is_none());
}

#[tokio::test(start_paused = true)]
async fn a_release_that_cannot_be_read_says_its_code_and_shows_no_part() {
    let fake = Fake::default();
    let gzip = STANDARD
        .decode(testing::encoded(&testing::release(
            "a", "app", 1, "deployed",
        )))
        .unwrap();
    let cut = STANDARD.encode(&gzip[..gzip.len() / 2]);
    testing::put_payload(&fake, "a", "app", 1, "deployed", cut.as_bytes());
    let mut rig = Rig::open(fake, None, ALL).await;
    rig.until("a problem and the history", |shown| {
        shown.problem.is_some()
            && shown
                .history
                .as_ref()
                .is_some_and(|lines| lines[0].problem.is_some())
    })
    .await;

    let shown = &rig.watched.shown;
    assert_eq!(
        shown.problem.as_ref().unwrap().code,
        ErrorCode::HelmTruncated
    );
    assert_eq!(shown.revision, Some(1));
    assert!(shown.overview.is_none() && shown.values.is_none() && shown.manifest.is_none());
    let line = &shown.history.as_ref().unwrap()[0];
    assert_eq!(line.status, "unreadable", "as the list's row says it");
    assert_eq!(
        line.problem.as_ref().unwrap().code,
        ErrorCode::HelmTruncated
    );
}

/// A revision whose manifest holds a Secret with `password`, and whose
/// description quotes it, as a failed upgrade's can.
fn with_secret(version: u32, status: &str, password: &str) -> Value {
    let mut release = testing::release("a", "app", version, status);
    let manifest = release["manifest"].as_str().unwrap().to_owned()
        + &format!(
            "---\n# Source: demo/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: app\nstringData:\n  password: {password}\n"
        );
    release["manifest"] = json!(manifest);
    release["info"]["description"] = json!(format!("Upgrade failed: it quoted {password}"));
    release
}

#[tokio::test(start_paused = true)]
async fn history_decodes_each_revision_once_while_shown_and_scrubs_its_description() {
    let fake = Fake::default();
    testing::put(
        &fake,
        &with_secret(1, "superseded", "first-pass"),
        "superseded",
    );
    testing::put(
        &fake,
        &with_secret(2, "deployed", "second-pass"),
        "deployed",
    );
    let parts = ReleaseParts {
        history: true,
        ..OVERVIEW
    };
    let mut rig = Rig::open(fake, None, parts).await;
    let decoded = |count: usize| {
        move |shown: &Shown| {
            shown.history.as_ref().is_some_and(|lines| {
                lines.len() == count && lines.iter().all(|line| line.chart.is_some())
            })
        }
    };
    rig.until("two lines", decoded(2)).await;

    let lines = rig.watched.shown.history.clone().unwrap();
    assert_eq!(
        lines.iter().map(|line| line.revision).collect::<Vec<_>>(),
        [2, 1]
    );
    let first = lines[1].description.as_ref().unwrap();
    assert!(first.hidden);
    assert!(!first.text.contains("first-pass"), "{}", first.text);
    assert_eq!(lines[1].chart.as_deref(), Some("demo-1.1.0"));
    assert_eq!(
        (rig.gets(1), rig.gets(2)),
        (1, 1),
        "the shown page makes its line"
    );

    testing::put(
        &rig.fake,
        &with_secret(3, "deployed", "third-pass"),
        "deployed",
    );
    rig.until("three lines", decoded(3)).await;
    assert_eq!((rig.gets(1), rig.gets(2), rig.gets(3)), (1, 1, 1));
}

#[tokio::test(start_paused = true)]
async fn requests_that_fail_are_said_while_they_do_and_the_revisions_shown_once_they_answer() {
    let fake = Fake::default();
    revision(&fake, 1, "superseded");
    revision(&fake, 2, "deployed");
    let paths = [1, 2].map(path);
    fake.state().forbidden.extend(paths.clone());
    let mut rig = Rig::open(fake, None, ALL).await;
    let refused = |problem: Option<&IpcError>| {
        problem.is_some_and(|problem| problem.code == ErrorCode::ServerForbidden)
    };
    rig.until("the refusals", |shown| {
        refused(shown.problem.as_ref())
            && shown
                .history
                .as_ref()
                .is_some_and(|lines| refused(lines[1].problem.as_ref()))
    })
    .await;
    assert_eq!(rig.watched.shown.revision, Some(2));
    assert!(rig.opened.showing().now().is_none());
    let lines = rig.watched.shown.history.as_ref().unwrap();
    assert_eq!(
        lines[1].status, "superseded",
        "a request's failure keeps the label's"
    );

    for path in &paths {
        rig.fake.state().forbidden.remove(path);
    }
    rig.until("the revision and its history", |shown| {
        shown.overview.is_some()
            && shown.history.as_ref().is_some_and(|lines| {
                lines.len() == 2 && lines.iter().all(|line| line.chart.is_some())
            })
    })
    .await;
    assert!(rig.watched.shown.problem.is_none());
    assert_eq!(notes(&rig.watched.shown), Some("Revision 2 of app"));
}

#[tokio::test(start_paused = true)]
async fn a_relist_asks_a_failed_revision_again_at_once() {
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    let path = path(1);
    fake.state().no_endpoints.insert(path.clone());
    let mut rig = Rig::open(fake, None, OVERVIEW).await;
    rig.until("the failure", |shown| shown.problem.is_some())
        .await;
    while rig.gets(1) < 4 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    rig.fake.state().no_endpoints.remove(&path);
    testing::put(
        &rig.fake,
        &testing::release("b", "elsewhere", 1, "deployed"),
        "deployed",
    );
    rig.fake.compact();
    rig.fake.end_watches();
    let relisted = tokio::time::Instant::now();
    rig.until("the overview", |shown| shown.overview.is_some())
        .await;
    assert!(
        relisted.elapsed() < Duration::from_secs(1),
        "asked again {:?} after the relist, where its fourth failure waits at least 2.5 s",
        relisted.elapsed()
    );
}

#[tokio::test(start_paused = true)]
async fn an_overview_waits_through_a_status_change_for_the_page_it_brings() {
    let fake = Fake::default();
    revision(&fake, 1, "pending-install");
    let mut rig = Rig::open(fake, None, OVERVIEW).await;
    rig.until("the overview", |shown| {
        shown
            .overview
            .as_ref()
            .is_some_and(|overview| !overview.header.sentence.is_empty())
    })
    .await;

    rig.fake.state().gets_take = Duration::from_secs(1);
    revision(&rig.fake, 1, "deployed");
    let written = tokio::time::Instant::now();
    let opened = &rig.opened;
    let overview = loop {
        let batch = rig.watched.next(|seq| opened.ack(seq)).await;
        if let Some(overview) = batch.overview {
            break overview;
        }
    };
    assert!(written.elapsed() >= Duration::from_secs(1));
    let printed: Vec<String> = overview
        .header
        .printed
        .iter()
        .map(|cell| format!("{}={}", cell.column, cell.value))
        .collect();
    assert!(
        printed.contains(&"Status=deployed".to_owned())
            && printed.contains(&"Chart=demo-1.1.0".to_owned()),
        "{printed:?}"
    );
    assert!(overview.header.sentence.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_history_line_keeps_its_chart_through_a_status_change() {
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    revision(&fake, 2, "pending-upgrade");
    let parts = ReleaseParts {
        history: true,
        ..OVERVIEW
    };
    let mut rig = Rig::open(fake, None, parts).await;
    rig.until("both lines", |shown| {
        shown
            .history
            .as_ref()
            .is_some_and(|lines| lines.len() == 2 && lines.iter().all(|line| line.chart.is_some()))
    })
    .await;

    rig.fake.state().gets_take = Duration::from_secs(1);
    revision(&rig.fake, 1, "superseded");
    let opened = &rig.opened;
    let mut blank = Vec::new();
    loop {
        let batch = rig.watched.next(|seq| opened.ack(seq)).await;
        let Some(lines) = &batch.history else {
            continue;
        };
        let first = &lines[1];
        if first.chart.is_none() {
            blank.push(first.clone());
        } else if first.status == "superseded" {
            break;
        }
    }
    assert!(blank.is_empty(), "{blank:?}");
}

#[tokio::test(start_paused = true)]
async fn a_pinned_revision_s_overview_waits_for_the_newest_s_header_and_asks_it_again() {
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    let mut rig = Rig::open(fake, Some(1), OVERVIEW).await;
    rig.until("the overview", |shown| shown.overview.is_some())
        .await;

    rig.fake.state().gets_take = Duration::from_secs(1);
    revision(&rig.fake, 2, "deployed");
    let blank = rig.overviews_until("Revision=2", "Chart=demo-1.2.0").await;
    assert!(blank.is_empty(), "{blank:?}");

    let path = path(3);
    rig.fake.state().forbidden.insert(path.clone());
    revision(&rig.fake, 3, "deployed");
    rig.until("the refusal", |shown| {
        shown
            .printed()
            .contains(&format!("Problem={}", ErrorCode::ServerForbidden.wire()))
    })
    .await;
    rig.fake.state().forbidden.remove(&path);
    rig.until("the newest's chart", |shown| {
        shown.printed().contains(&"Chart=demo-1.3.0".to_owned())
    })
    .await;
    assert_eq!(rig.watched.shown.revision, Some(1));
}

impl Rig {
    /// The headers of the overviews sent until one holds `shown` and
    /// `chart`, that lacked `chart`.
    async fn overviews_until(&mut self, shown: &str, chart: &str) -> Vec<Vec<String>> {
        let opened = &self.opened;
        let mut blank = Vec::new();
        loop {
            let batch = self.watched.next(|seq| opened.ack(seq)).await;
            let Some(overview) = &batch.overview else {
                continue;
            };
            let printed: Vec<String> = overview
                .header
                .printed
                .iter()
                .map(|cell| format!("{}={}", cell.column, cell.value))
                .collect();
            if !printed.iter().any(|cell| cell == chart) {
                blank.push(printed);
            } else if printed.iter().any(|cell| cell == shown) {
                return blank;
            }
        }
    }
}

#[tokio::test(start_paused = true)]
async fn an_open_release_that_panics_ends_with_a_batch_that_says_so() {
    twigo_panic::inject::arm(ITEM, 1);
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    let mut rig = Rig::open(fake, None, OVERVIEW).await;
    let opened = &rig.opened;
    let last = rig.watched.next(|seq| opened.ack(seq)).await;
    let ViewState::Error { error } = &last.status else {
        panic!("the release failed: {:?}", last.status);
    };
    assert_eq!(error.code, ErrorCode::InternalPanic);
    assert!(last.overview.is_none() && last.history.is_none());
}

#[tokio::test(start_paused = true)]
async fn a_decode_that_panics_marks_the_revision_and_the_editor_goes_on() {
    twigo_panic::inject::arm(DECODE, 1);
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    let mut rig = Rig::open(fake, None, OVERVIEW).await;
    rig.until("a problem", |shown| shown.problem.is_some())
        .await;
    assert_eq!(
        rig.watched.shown.problem.as_ref().unwrap().code,
        ErrorCode::InternalPanic
    );

    revision(&rig.fake, 2, "deployed");
    rig.until("revision 2", |shown| shown.overview.is_some())
        .await;
    assert_eq!(rig.watched.shown.status, Some(ViewState::Ready));
}

#[tokio::test(start_paused = true)]
async fn two_revisions_compare_with_a_value_that_changed_marked_on_both_sides() {
    let fake = Fake::default();
    for (version, password) in [(1, "alpha1"), (2, "bravo2")] {
        let mut release = with_secret(version, "deployed", password);
        release["config"]["password"] = json!(password);
        testing::put(&fake, &release, "deployed");
    }
    let (hub, _clients) = fake.hub(Budgets::default());
    let compare = |part, from, to| {
        let hub = hub.clone();
        async move {
            let request = CompareRevisions {
                release: release_ref(),
                from,
                to,
                part,
            };
            crate::helm::compare(&hub, "kind-test", request).await
        }
    };

    let values = compare(ComparedPart::Values, 1, 2).await.unwrap();
    for side in [&values.from, &values.to] {
        assert!(
            side.contains(r#""password":"<6 bytes, changed>""#),
            "{side}"
        );
    }
    let defaults = compare(ComparedPart::Defaults, 1, 2).await.unwrap();
    assert_eq!(
        defaults.from, defaults.to,
        "the chart's defaults did not change"
    );
    let manifest = compare(ComparedPart::Manifest, 1, 2).await.unwrap();
    for side in [&manifest.from, &manifest.to] {
        assert!(side.contains("<6 bytes, changed>"), "{side}");
    }
    assert!(
        manifest.from.contains("revision: \"1\"") && manifest.to.contains("revision: \"2\""),
        "from is the left side and to the right"
    );
    let sent = serde_json::to_string(&(values, defaults, manifest)).unwrap();
    for password in ["alpha1", "bravo2"] {
        assert!(!sent.contains(password), "{password} left Rust");
    }

    let gone = compare(ComparedPart::Values, 1, 7).await.unwrap_err();
    assert_eq!(gone.code, ErrorCode::HelmRevisionGone);
    tokio::time::sleep(Duration::from_millis(1)).await;
}

#[tokio::test(start_paused = true)]
async fn a_failing_page_is_asked_again_with_growing_pauses_and_a_refused_one_as_the_hub_asks() {
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    fake.state().no_endpoints.insert(path(1));
    let mut rig = Rig::open(fake, None, OVERVIEW).await;
    rig.until("the failure", |shown| shown.problem.is_some())
        .await;

    rig.drain_for(Duration::from_secs(150)).await;
    let down = rig.gets(1);
    assert!(
        (25..=64).contains(&down),
        "{down} GETs in 150 s, where pauses of 0.5 s growing to 2.5-5 s give 26 to 62"
    );

    rig.fake.state().no_endpoints.remove(&path(1));
    rig.fake.state().forbidden.insert(path(1));
    rig.drain_for(Duration::from_secs(150)).await;
    let refused = rig.gets(1) - down;
    assert!(
        (3..=6).contains(&refused),
        "{refused} GETs in 150 s, where pauses of 30-60 s after the first refusal give 3 to 5"
    );
    assert_eq!(
        rig.watched.shown.problem.as_ref().unwrap().code,
        ErrorCode::ServerForbidden
    );
}

#[tokio::test(start_paused = true)]
async fn a_relist_asks_history_s_failed_lines_and_a_pinned_editor_s_newest_again_at_once() {
    let fake = Fake::default();
    revision(&fake, 1, "superseded");
    revision(&fake, 2, "deployed");
    fake.state().forbidden.insert(path(2));
    let parts = ReleaseParts {
        history: true,
        ..OVERVIEW
    };
    let mut rig = Rig::open(fake, Some(1), parts).await;
    let refused = format!("Problem={}", ErrorCode::ServerForbidden.wire());
    rig.until("both refusals", |shown| {
        shown.printed().contains(&refused)
            && shown
                .history
                .as_ref()
                .is_some_and(|lines| lines[0].problem.is_some())
    })
    .await;
    rig.drain_for(Duration::from_secs(1)).await;

    rig.fake.state().forbidden.remove(&path(2));
    testing::put(
        &rig.fake,
        &testing::release("b", "elsewhere", 1, "deployed"),
        "deployed",
    );
    rig.fake.compact();
    rig.fake.end_watches();
    let relisted = tokio::time::Instant::now();
    rig.until("the newest's header and line", |shown| {
        shown.printed().contains(&"Chart=demo-1.2.0".to_owned())
            && shown
                .history
                .as_ref()
                .is_some_and(|lines| lines[0].chart.is_some())
    })
    .await;
    assert!(
        relisted.elapsed() < Duration::from_secs(1),
        "asked again {:?} after the relist, where a refusal waits 30 s",
        relisted.elapsed()
    );
}

#[tokio::test(start_paused = true)]
async fn a_pinned_header_s_failure_shows_only_on_the_version_of_the_secret_it_was_for() {
    let fake = Fake::default();
    revision(&fake, 1, "deployed");
    revision(&fake, 2, "deployed");
    let mut rig = Rig::open(fake, Some(1), OVERVIEW).await;
    rig.until("the newest's chart", |shown| {
        shown.printed().contains(&"Chart=demo-1.2.0".to_owned())
    })
    .await;
    let refused = format!("Problem={}", ErrorCode::ServerForbidden.wire());

    rig.fake.state().forbidden.insert(path(3));
    revision(&rig.fake, 3, "pending-upgrade");
    rig.until("the refusal", |shown| shown.printed().contains(&refused))
        .await;
    rig.fake
        .delete("secrets", Some("a"), &secret_name("app", 3));
    rig.until("revision 2 again", |shown| {
        let printed = shown.printed();
        ["Revision=2", "Chart=demo-1.2.0", "Problem="]
            .iter()
            .all(|cell| printed.contains(&(*cell).to_owned()))
    })
    .await;

    rig.fake.state().forbidden.insert(path(4));
    revision(&rig.fake, 4, "pending-upgrade");
    rig.until("the refusal", |shown| shown.printed().contains(&refused))
        .await;
    rig.fake.state().forbidden.remove(&path(4));
    rig.fake.state().gets_take = Duration::from_secs(1);
    revision(&rig.fake, 4, "deployed");
    let blank = rig
        .overviews_until("Status=deployed", "Chart=demo-1.4.0")
        .await;
    let stale: Vec<_> = blank
        .iter()
        .filter(|printed| printed.contains(&refused))
        .collect();
    assert!(stale.is_empty(), "{stale:?}");
    assert_eq!(rig.watched.shown.revision, Some(1));
}
