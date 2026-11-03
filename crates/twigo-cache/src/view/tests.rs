use std::collections::BTreeMap;

use twigo_ipc::{ColumnValues, Grouping, Gvr, Sort};

use super::*;
use crate::meta::Meta;
use crate::store::{Drained, Feed, Store};

fn column(name: &str, kind: ColumnKind, priority: i32) -> Column {
    Column {
        name: name.into(),
        kind,
        format: "".into(),
        priority,
    }
}

fn pod_columns() -> Arc<[Column]> {
    Arc::new([
        column("Name", ColumnKind::String, 0),
        column("Ready", ColumnKind::String, 0),
        column("Status", ColumnKind::String, 0),
        column("Restarts", ColumnKind::String, 0),
        column("Age", ColumnKind::Age, 0),
        column("IP", ColumnKind::String, 1),
    ])
}

fn pod(namespace: &str, name: &str, status: &str, restarts: &str) -> Row {
    Row {
        meta: Meta {
            name: name.into(),
            namespace: Some(namespace.into()),
            uid: Some(format!("{namespace}/{name}").into()),
            resource_version: "1".into(),
            labels: Box::new([("app".into(), name.split('-').next().unwrap_or(name).into())]),
            owners: Box::default(),
            created: Some(jiff::Timestamp::UNIX_EPOCH),
            generated: None,
        },
        cells: Box::new([
            Cell::Text(name.into()),
            Cell::Text("1/1".into()),
            Cell::Text(status.into()),
            Cell::Text(restarts.into()),
            Cell::Age,
            Cell::Text("10.0.0.1".into()),
        ]),
    }
}

fn query() -> ListQuery {
    ListQuery {
        space: "kind-test".to_owned(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "pods".to_owned(),
        },
        namespaced: true,
        namespaces: Vec::new(),
        label_selector: None,
        text: None,
        columns: None,
        sort: None,
        count_by: None,
        group_by: None,
        values: None,
    }
}

/// A store, its feed, and a view of it, as a one-part subscription reads
/// them.
struct Rig {
    store: Store<Row>,
    feed: Feed,
    view: QueryView,
}

impl Rig {
    fn new(query: &ListQuery) -> Self {
        let store = Store::default();
        store.set_columns(Some(&pod_columns()));
        let feed = store.feed();
        let mut view = QueryView::new(Spec::new("kind-test", query).unwrap());
        view.set_window(0, 100);
        Self { store, feed, view }
    }

    fn flush(&mut self) -> Option<ListBatch> {
        let delta = match self.store.drain(&self.feed) {
            Drained::Reset { items, columns } => Delta::Reset {
                rows: items,
                columns,
            },
            Drained::Changed(changes) => {
                let (mut upserted, mut removed) = (Vec::new(), Vec::new());
                for (key, item) in changes {
                    match item {
                        Some(item) => upserted.push(item),
                        None => removed.push(key),
                    }
                }
                Delta::Changed { upserted, removed }
            }
        };
        self.view.apply(delta);
        self.view.batch(ViewState::Ready)
    }
}

fn ids(batch: &ListBatch) -> Vec<&str> {
    batch
        .window
        .as_ref()
        .expect("a window")
        .ids
        .iter()
        .map(|id| id.0.as_str())
        .collect()
}

fn upserts(batch: &ListBatch) -> Vec<(&str, &ipc::Cell)> {
    batch
        .upserts
        .iter()
        .map(|row| (row.id.0.as_str(), &row.cells[4]))
        .collect()
}

#[test]
fn the_latest_version_wins() {
    let mut rig = Rig::new(&query());
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    rig.flush().unwrap();
    rig.store.upsert(pod("a", "web-1", "Running", "1"));
    rig.store.upsert(pod("a", "web-1", "Running", "2"));
    let batch = rig.flush().unwrap();
    assert!(batch.window.is_none(), "the window kept its rows");
    assert_eq!(
        upserts(&batch),
        [("kind-test/a/web-1", &ipc::Cell::Text("2".to_owned()))]
    );
}

#[test]
fn a_delete_wins() {
    let mut rig = Rig::new(&query());
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    rig.flush().unwrap();
    rig.store.upsert(pod("a", "web-1", "Running", "1"));
    rig.store.delete(&pod("a", "web-1", "Running", "1"));
    let batch = rig.flush().unwrap();
    assert_eq!(ids(&batch), Vec::<&str>::new());
    assert!(batch.upserts.is_empty());
    assert_eq!(batch.total, 0);
}

#[test]
fn an_add_followed_by_a_delete_sends_nothing() {
    let mut rig = Rig::new(&query());
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    rig.flush().unwrap();
    rig.store.upsert(pod("a", "web-2", "Running", "0"));
    rig.store.delete(&pod("a", "web-2", "Running", "0"));
    assert_eq!(rig.flush(), None);
}

#[test]
fn an_add_followed_by_a_modify_is_sent_as_an_add() {
    let mut rig = Rig::new(&query());
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    rig.flush().unwrap();
    rig.store.upsert(pod("a", "web-2", "Pending", "0"));
    rig.store.upsert(pod("a", "web-2", "Running", "1"));
    let batch = rig.flush().unwrap();
    assert_eq!(ids(&batch), ["kind-test/a/web-1", "kind-test/a/web-2"]);
    assert_eq!(
        upserts(&batch),
        [("kind-test/a/web-2", &ipc::Cell::Text("1".to_owned()))],
        "once, as it is now"
    );
}

#[test]
fn a_change_that_shows_nothing_new_sends_nothing() {
    let mut rig = Rig::new(&query());
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    rig.flush().unwrap();
    let mut same = pod("a", "web-1", "Running", "0");
    same.meta.resource_version = "2".into();
    rig.store.upsert(same);
    assert_eq!(rig.flush(), None);
}

#[test]
fn the_first_batch_has_the_columns_and_namespace_comes_after_name() {
    let mut rig = Rig::new(&query());
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    let batch = rig.flush().unwrap();
    let names: Vec<_> = batch
        .columns
        .as_ref()
        .unwrap()
        .iter()
        .map(|column| column.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "Name",
            "Namespace",
            "Ready",
            "Status",
            "Restarts",
            "Age",
            "IP"
        ]
    );
    let row = &batch.upserts[0];
    assert_eq!(row.cells[1], ipc::Cell::Text("a".to_owned()));
    assert_eq!(row.cells[5], ipc::Cell::Null, "Age is the webview's");
    assert_eq!(row.created.as_deref(), Some("1970-01-01T00:00:00Z"));
    assert_eq!(rig.flush(), None);

    let mut one = query();
    one.namespaces = vec!["a".to_owned()];
    let mut rig = Rig::new(&one);
    let batch = rig.flush().unwrap();
    assert_eq!(
        batch.columns.unwrap()[1].name,
        "Ready",
        "none under one namespace"
    );
}

#[test]
fn a_window_change_sends_the_rows_that_entered_it() {
    let mut rig = Rig::new(&query());
    for n in 1..=5 {
        rig.store
            .upsert(pod("a", &format!("web-{n}"), "Running", "0"));
    }
    rig.view.set_window(0, 2);
    let batch = rig.flush().unwrap();
    assert_eq!(ids(&batch), ["kind-test/a/web-1", "kind-test/a/web-2"]);
    rig.view.set_window(1, 3);
    let batch = rig.flush().unwrap();
    assert_eq!(ids(&batch), ["kind-test/a/web-2", "kind-test/a/web-3"]);
    assert_eq!(batch.window.as_ref().unwrap().start, 1);
    assert_eq!(upserts(&batch).len(), 1, "only web-3 is new to it");
    assert_eq!(batch.total, 5);
}

#[test]
fn a_window_that_moves_as_rows_enter_above_it_is_sent() {
    let mut rig = Rig::new(&query());
    for name in ["web-b", "web-c", "web-d"] {
        rig.store.upsert(pod("a", name, "Running", "0"));
    }
    rig.view.set_window(0, 2);
    rig.flush().unwrap();
    rig.store.upsert(pod("a", "web-a", "Running", "0"));
    rig.view.set_window(1, 3);
    let batch = rig.flush().unwrap();
    let window = batch.window.expect("the window's start moved");
    assert_eq!(window.start, 1);
    assert_eq!(
        window
            .ids
            .iter()
            .map(|id| id.0.as_str())
            .collect::<Vec<_>>(),
        ["kind-test/a/web-b", "kind-test/a/web-c"]
    );
}

#[test]
fn columns_the_list_lacks_do_nothing() {
    let mut odd = query();
    odd.sort = Some(Sort {
        column: "Nominated".to_owned(),
        descending: true,
    });
    odd.count_by = Some("Phase".to_owned());
    odd.group_by = grouping("Phase", &[""]);
    odd.values = Some(ColumnValues {
        column: "Phase".to_owned(),
        values: vec!["Failed".to_owned()],
    });
    let mut rig = Rig::new(&odd);
    rig.store.upsert(pod("a", "web-2", "Running", "0"));
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    let batch = rig.flush().unwrap();
    assert_eq!(
        ids(&batch),
        ["kind-test/a/web-1", "kind-test/a/web-2"],
        "by Name, and no empty group to collapse"
    );
    assert_eq!(batch.counts, Some(Vec::new()));
    assert_eq!(batch.groups, None);
}

#[test]
fn the_filter_reads_the_shown_columns_and_name() {
    let mut text = query();
    text.text = Some("10.0".to_owned());
    let mut rig = Rig::new(&text);
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    assert_eq!(rig.flush().unwrap().total, 0, "IP has priority 1");

    text.columns = Some(BTreeMap::from([
        ("IP".to_owned(), true),
        ("Name".to_owned(), false),
    ]));
    let mut rig = Rig::new(&text);
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    assert_eq!(rig.flush().unwrap().total, 1, "chosen");

    text.text = Some("WEB".to_owned());
    let mut rig = Rig::new(&text);
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    assert_eq!(rig.flush().unwrap().total, 1, "Name always counts");
}

#[test]
fn counts_come_before_values_drop_rows() {
    let mut health = query();
    health.count_by = Some("Status".to_owned());
    health.values = Some(ColumnValues {
        column: "Status".to_owned(),
        values: vec!["Error".to_owned()],
    });
    health.label_selector = Some("app=web".to_owned());
    let mut rig = Rig::new(&health);
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    rig.store.upsert(pod("a", "web-2", "Error", "0"));
    rig.store.upsert(pod("a", "web-3", "Running", "0"));
    rig.store.upsert(pod("a", "db-1", "Error", "0"));
    let batch = rig.flush().unwrap();
    assert_eq!(ids(&batch), ["kind-test/a/web-2"]);
    let counts = |batch: &ListBatch| {
        batch
            .counts
            .clone()
            .unwrap()
            .into_iter()
            .map(|count| (count.value, count.count))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        counts(&batch),
        [("Running".to_owned(), 2), ("Error".to_owned(), 1)]
    );

    rig.store.upsert(pod("a", "web-1", "Error", "1"));
    let batch = rig.flush().unwrap();
    assert_eq!(
        counts(&batch),
        [("Error".to_owned(), 2), ("Running".to_owned(), 1)]
    );
    rig.store.upsert(pod("a", "web-3", "Running", "1"));
    assert_eq!(
        rig.flush(),
        None,
        "web-3 is outside the values, its count stays"
    );
}

#[test]
fn only_a_list_that_shows_rows_sends_them() {
    let mut counted = query();
    counted.count_by = Some("Status".to_owned());
    counted.group_by = grouping("Status", &[]);
    let mut rig = Rig::new(&counted);
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    let delta = match rig.store.drain(&rig.feed) {
        Drained::Reset { items, columns } => Delta::Reset {
            rows: items,
            columns,
        },
        Drained::Changed(_) => unreachable!("a new feed resets"),
    };
    rig.view.apply(delta);
    let syncing = rig.view.batch(ViewState::Syncing { loaded: 1 }).unwrap();
    assert_eq!((syncing.total, syncing.counts), (0, Some(Vec::new())));
    assert_eq!(syncing.groups, Some(Vec::new()));
    assert!(syncing.window.unwrap().ids.is_empty());
    let ready = rig.view.batch(ViewState::Ready).unwrap();
    assert_eq!(ready.total, 1);
    assert_eq!(ids(&ready), ["kind-test/a/web-1"]);
    assert_eq!(groups(&ready), [("Running", 1)]);
}

#[test]
fn a_row_says_where_its_name_was_generated() {
    let mut rig = Rig::new(&query());
    let mut row = pod("a", "web-1", "Running", "0");
    rig.store.upsert(row.clone());
    assert_eq!(rig.flush().unwrap().upserts[0].generated, None);
    row.meta.generated = Some(4);
    row.meta.resource_version = "2".into();
    rig.store.upsert(row);
    let batch = rig.flush().expect("the generated part changed");
    assert_eq!(batch.upserts[0].generated, Some(4));
}

#[test]
fn a_status_change_alone_is_a_batch() {
    let mut rig = Rig::new(&query());
    rig.flush().unwrap();
    assert_eq!(rig.view.batch(ViewState::Ready), None);
    let batch = rig.view.batch(ViewState::Stale).unwrap();
    assert_eq!(batch.status, ViewState::Stale);
    assert_eq!(batch.seq, 2);
}

fn grouping(column: &str, collapsed: &[&str]) -> Option<Grouping> {
    Some(Grouping {
        column: column.to_owned(),
        collapsed: collapsed.iter().map(|value| (*value).to_owned()).collect(),
    })
}

fn groups(batch: &ListBatch) -> Vec<(&str, u32)> {
    batch
        .groups
        .as_ref()
        .expect("groups")
        .iter()
        .map(|group| (group.value.as_str(), group.rows))
        .collect()
}

fn counts(counts: &[ValueCount]) -> Vec<(&str, u32)> {
    counts
        .iter()
        .map(|count| (count.value.as_str(), count.count))
        .collect()
}

#[test]
fn groups_follow_their_values_in_natural_order_with_the_empty_value_last() {
    let mut grouped = query();
    grouped.group_by = grouping("Status", &[]);
    grouped.sort = Some(Sort {
        column: "Restarts".to_owned(),
        descending: true,
    });
    let mut rig = Rig::new(&grouped);
    for (name, status, restarts) in [
        ("web-1", "node-10", "0"),
        ("web-2", "", "1"),
        ("web-3", "node-9", "2"),
        ("web-4", "Node-2", "3"),
        ("web-5", "node-10", "4"),
        ("web-6", "node-9", "5"),
    ] {
        rig.store.upsert(pod("a", name, status, restarts));
    }
    let batch = rig.flush().unwrap();
    assert_eq!(
        groups(&batch),
        [("Node-2", 1), ("node-9", 2), ("node-10", 2), ("", 1)]
    );
    assert_eq!(
        ids(&batch),
        [
            "kind-test/a/web-4",
            "kind-test/a/web-6",
            "kind-test/a/web-3",
            "kind-test/a/web-5",
            "kind-test/a/web-1",
            "kind-test/a/web-2",
        ],
        "the query's sort within each group"
    );
}

#[test]
fn a_collapsed_group_counts_everywhere_but_in_the_window() {
    let mut grouped = query();
    grouped.group_by = grouping("Namespace", &["b", "nowhere"]);
    grouped.count_by = Some("Status".to_owned());
    let mut rig = Rig::new(&grouped);
    for (namespace, name, status) in [
        ("a", "web-1", "Running"),
        ("a", "web-2", "Error"),
        ("b", "web-1", "Error"),
        ("b", "web-2", "Error"),
        ("c", "web-1", "Running"),
        ("c", "web-2", "Running"),
    ] {
        rig.store.upsert(pod(namespace, name, status, "0"));
    }
    let batch = rig.flush().unwrap();
    assert_eq!(batch.total, 6);
    assert_eq!(
        ids(&batch),
        [
            "kind-test/a/web-1",
            "kind-test/a/web-2",
            "kind-test/c/web-1",
            "kind-test/c/web-2",
        ]
    );
    assert_eq!(
        counts(batch.counts.as_deref().unwrap()),
        [("Error", 3), ("Running", 3)]
    );
    let shown: Vec<_> = batch
        .groups
        .as_ref()
        .unwrap()
        .iter()
        .map(|group| (group.value.as_str(), group.rows, counts(&group.counts)))
        .collect();
    assert_eq!(
        shown,
        [
            ("a", 2, vec![("Error", 1), ("Running", 1)]),
            ("b", 2, vec![("Error", 2)]),
            ("c", 2, vec![("Running", 2)]),
        ]
    );

    rig.view.set_window(1, 3);
    let batch = rig.flush().unwrap();
    let window = batch.window.as_ref().unwrap();
    assert_eq!(window.start, 1);
    assert_eq!(
        ids(&batch),
        ["kind-test/a/web-2", "kind-test/c/web-1"],
        "across the collapsed group"
    );
    assert_eq!(batch.groups, None, "unchanged");
}

#[test]
fn a_collapsed_value_no_group_has_does_nothing() {
    let mut grouped = query();
    grouped.group_by = grouping("Status", &["Error", ""]);
    let mut rig = Rig::new(&grouped);
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    rig.store.upsert(pod("a", "web-2", "Running", "0"));
    let batch = rig.flush().unwrap();
    assert_eq!(ids(&batch), ["kind-test/a/web-1", "kind-test/a/web-2"]);
    assert_eq!(groups(&batch), [("Running", 2)]);
}

#[test]
fn a_change_to_the_groups_alone_is_a_batch() {
    let mut grouped = query();
    grouped.group_by = grouping("Restarts", &[]);
    grouped.count_by = Some("Status".to_owned());
    let mut rig = Rig::new(&grouped);
    rig.view.set_window(0, 0);
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    rig.store.upsert(pod("a", "web-2", "Error", "1"));
    rig.flush().unwrap();

    rig.store.upsert(pod("a", "web-1", "Running", "1"));
    rig.store.upsert(pod("a", "web-2", "Error", "0"));
    let batch = rig.flush().expect("the counts within the groups changed");
    assert_eq!(
        (&batch.window, &batch.counts, batch.upserts.len()),
        (&None, &None, 0)
    );
    let shown: Vec<_> = batch
        .groups
        .as_ref()
        .unwrap()
        .iter()
        .map(|group| (group.value.as_str(), group.rows, counts(&group.counts)))
        .collect();
    assert_eq!(
        shown,
        [("0", 1, vec![("Error", 1)]), ("1", 1, vec![("Running", 1)])]
    );

    rig.store.upsert(pod("a", "web-1", "Running", "3"));
    let batch = rig.flush().expect("a group went, another came");
    assert_eq!(groups(&batch), [("0", 1), ("3", 1)]);
    rig.store.upsert(pod("a", "web-2", "Error", "4"));
    let batch = rig.flush().expect("the groups moved");
    assert_eq!(groups(&batch), [("3", 1), ("4", 1)]);

    let mut same = pod("a", "web-2", "Error", "4");
    same.meta.resource_version = "2".into();
    rig.store.upsert(same);
    assert_eq!(rig.flush(), None, "the same groups");
}

#[test]
fn groups_end_empty_once_the_list_loses_their_column() {
    let mut grouped = query();
    grouped.group_by = grouping("Status", &["Running"]);
    let mut rig = Rig::new(&grouped);
    rig.store.upsert(pod("a", "web-1", "Running", "0"));
    let batch = rig.flush().unwrap();
    assert_eq!(groups(&batch), [("Running", 1)]);
    assert_eq!(ids(&batch), Vec::<&str>::new(), "collapsed");

    rig.store.set_columns(Some(&Arc::from([
        column("Name", ColumnKind::String, 0),
        column("Ready", ColumnKind::String, 0),
    ])));
    let batch = rig.flush().unwrap();
    assert_eq!(batch.groups, Some(Vec::new()));
    assert_eq!(ids(&batch), ["kind-test/a/web-1"], "nothing to collapse");
    assert_eq!(rig.flush(), None);
}

/// What the view must show, worked out from scratch: every row the query
/// keeps in the index's order, those the window reads, and the counts and
/// the groups.
struct Expected {
    every: Vec<String>,
    readable: Vec<String>,
    counts: Vec<ValueCount>,
    groups: Option<Vec<RowGroup>>,
}

fn naive(rows: &HashMap<String, Row>, query: &ListQuery) -> Expected {
    fn sorted(counts: HashMap<String, u32>) -> Vec<ValueCount> {
        let mut counts: Vec<ValueCount> = counts
            .into_iter()
            .map(|(value, count)| ValueCount { value, count })
            .collect();
        counts.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.value.cmp(&b.value)));
        counts
    }
    fn by_group(a: &str, b: &str) -> Ordering {
        a.is_empty().cmp(&b.is_empty()).then_with(|| natural(a, b))
    }
    let spec = Spec::new("kind-test", query).unwrap();
    let layout = Layout::new(&spec, pod_columns());
    let mut kept = Vec::new();
    let mut counts: HashMap<String, u32> = HashMap::new();
    let mut groups: HashMap<String, (u32, HashMap<String, u32>)> = HashMap::new();
    for row in rows.values() {
        if spec
            .labels
            .as_ref()
            .is_some_and(|l| !l.matches(&row.meta.labels))
        {
            continue;
        }
        let texts = layout.text.iter().map(|&at| layout.text(row, at));
        if spec.text.as_ref().is_some_and(|t| !t.keeps(texts)) {
            continue;
        }
        let count = layout.count.map(|at| layout.text(row, at).into_owned());
        let group = layout
            .group
            .as_ref()
            .map(|(at, _)| layout.text(row, *at).into_owned());
        if let Some(count) = &count {
            *counts.entry(count.clone()).or_default() += 1;
        }
        if let Some(group) = &group {
            let (_, within) = groups.entry(group.clone()).or_default();
            if let Some(count) = &count {
                *within.entry(count.clone()).or_default() += 1;
            }
        }
        if let Some((at, values)) = &layout.values
            && !values.contains(&*layout.text(row, *at))
        {
            continue;
        }
        if let Some(group) = &group {
            groups.get_mut(group).unwrap().0 += 1;
        }
        let id = format!(
            "kind-test/{}/{}",
            row.meta.namespace.as_deref().unwrap(),
            row.meta.name
        );
        kept.push((group, layout.sort_key(row), id));
    }
    kept.sort_by(|(g, a, x), (h, b, y)| {
        let order = a.cmp(b);
        let order = if layout.descending {
            order.reverse()
        } else {
            order
        };
        let group = match (g, h) {
            (Some(g), Some(h)) => by_group(g, h),
            _ => Ordering::Equal,
        };
        group.then(order).then_with(|| natural(x, y))
    });
    let collapsed = |group: &Option<String>| match (&layout.group, group) {
        (Some((_, collapsed)), Some(group)) => collapsed.contains(group),
        _ => false,
    };
    let readable = kept
        .iter()
        .filter(|(group, ..)| !collapsed(group))
        .map(|(.., id)| id.clone())
        .collect();
    let groups = layout.group.as_ref().map(|_| {
        let mut groups: Vec<RowGroup> = groups
            .into_iter()
            .filter(|(_, (rows, _))| *rows > 0)
            .map(|(value, (rows, within))| RowGroup {
                value,
                rows,
                counts: sorted(within),
            })
            .collect();
        groups.sort_by(|a, b| by_group(&a.value, &b.value));
        groups
    });
    Expected {
        every: kept.into_iter().map(|(.., id)| id).collect(),
        readable,
        counts: sorted(counts),
        groups,
    }
}

/// What the webview holds, applied as `ListView` applies batches.
#[derive(Default)]
struct Mirror {
    start: u32,
    ids: Vec<String>,
    rows: HashMap<String, Vec<ipc::Cell>>,
    groups: Vec<RowGroup>,
}

impl Mirror {
    fn apply(&mut self, batch: ListBatch) {
        if let Some(window) = batch.window {
            self.start = window.start;
            self.ids = window.ids.into_iter().map(|id| id.0).collect();
            let shown: HashSet<&String> = self.ids.iter().collect();
            self.rows.retain(|id, _| shown.contains(id));
        }
        for row in batch.upserts {
            self.rows.insert(row.id.0, row.cells);
        }
        if let Some(groups) = batch.groups {
            self.groups = groups;
        }
    }
}

/// Random changes to `names` pods in two namespaces, `rounds` flushes of
/// up to `burst` changes each, every flush checked against a full sort and
/// against what the webview holds.
fn random_change_sets(seeds: std::ops::Range<u64>, names: usize, rounds: usize, burst: usize) {
    const STATUSES: [&str; 5] = ["Running", "Pending", "Error", "CrashLoopBackOff", ""];
    const COLLAPSIBLE: [&str; 7] = ["Running", "Error", "", "a", "3", "1/1", "none"];
    const RESTARTS: [&str; 5] = ["0", "3", "3 (5m ago)", "12 (1h ago)", "1 (45s ago)"];
    const TEXTS: [&str; 5] = ["web", "!db", "/^api-\\d$/", "!/1$/", "RUN"];
    for seed in seeds {
        let mut random = fastrand::Rng::with_seed(seed);
        let mut query = query();
        query.sort = random.bool().then(|| Sort {
            column: ["Name", "Namespace", "Status", "Restarts", "Age", "Ready"][random.usize(..6)]
                .to_owned(),
            descending: random.bool(),
        });
        query.text = random
            .bool()
            .then(|| TEXTS[random.usize(..TEXTS.len())].to_owned());
        query.count_by = random.bool().then(|| "Status".to_owned());
        query.group_by = random.bool().then(|| Grouping {
            column: ["Status", "Namespace", "Restarts", "Ready", "Phase"][random.usize(..5)]
                .to_owned(),
            collapsed: COLLAPSIBLE
                .iter()
                .filter(|_| random.bool())
                .map(|value| (*value).to_owned())
                .collect(),
        });
        query.values = random.bool().then(|| ColumnValues {
            column: "Status".to_owned(),
            values: vec!["Running".to_owned(), "Error".to_owned()],
        });
        query.label_selector = random.bool().then(|| "app notin (db)".to_owned());
        let mut rig = Rig::new(&query);
        let mut mirror = Mirror::default();
        let mut rows: HashMap<String, Row> = HashMap::new();
        for _ in 0..rounds {
            for _ in 0..random.usize(1..burst) {
                let name = format!(
                    "{}-{}",
                    ["web", "db", "api"][random.usize(..3)],
                    random.usize(..names)
                );
                let namespace = ["a", "b"][random.usize(..2)];
                let key = format!("{namespace}/{name}");
                if random.u8(..4) == 0 {
                    if let Some(gone) = rows.remove(&key) {
                        rig.store.delete(&gone);
                    }
                    continue;
                }
                let mut row = pod(
                    namespace,
                    &name,
                    STATUSES[random.usize(..STATUSES.len())],
                    RESTARTS[random.usize(..RESTARTS.len())],
                );
                row.meta.created =
                    Some(jiff::Timestamp::from_second(random.i64(0..1_000)).expect("a timestamp"));
                rig.store.upsert(row.clone());
                rows.insert(key, row);
            }
            let start = random.u32(..30);
            rig.view.set_window(start, start + random.u32(..40));
            if let Some(batch) = rig.flush() {
                mirror.apply(batch);
            }
            let expected = naive(&rows, &query);
            let (start, end) = rig.view.window;
            let window: Vec<&str> = expected
                .readable
                .iter()
                .skip(start as usize)
                .take(end.saturating_sub(start) as usize)
                .map(String::as_str)
                .collect();
            let shown: Vec<&str> = rig.view.sent.ids.iter().map(|id| &**id).collect();
            assert_eq!(shown, window, "seed {seed}: {query:?}");
            assert_eq!(
                rig.view.sent.total as usize,
                expected.every.len(),
                "seed {seed}"
            );
            if query.count_by.is_some() {
                assert_eq!(
                    rig.view.sent.counts.as_ref(),
                    Some(&expected.counts),
                    "seed {seed}"
                );
            }
            assert_eq!(rig.view.sent.groups, expected.groups, "seed {seed}");
            let every: Vec<&str> = rig.view.index.iter().map(|entry| &*entry.id).collect();
            assert_eq!(every, expected.every, "seed {seed}: the whole index");
            assert_eq!(mirror.start, start, "seed {seed}: the webview's start");
            assert_eq!(mirror.ids, window, "seed {seed}: the webview's window");
            assert_eq!(
                mirror.groups,
                expected.groups.unwrap_or_default(),
                "seed {seed}: the webview's groups"
            );
            for id in &mirror.ids {
                let key = id.trim_start_matches("kind-test/");
                let wire = rig.view.layout.wire_row(&rows[key], id);
                assert_eq!(mirror.rows.get(id), Some(&wire.cells), "seed {seed}: {id}");
            }
        }
    }
}

#[test]
fn the_index_matches_a_full_sort_over_random_change_sets() {
    random_change_sets(0..200, 40, 30, 40);
}

#[test]
fn the_index_holds_across_nodes_of_a_thousand_rows() {
    random_change_sets(0..3, 2_000, 10, 2_500);
}
