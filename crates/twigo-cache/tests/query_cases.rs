//! The query cases the mock runs too (`packages/protocol/src/query-cases.json`),
//! through Rust's query view. A list's CPU and Memory columns are the
//! poller's samples joined to the rows, not cells of the rows' own.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use twigo_cache::hub::Delta;
use twigo_cache::meta::{Meta, Owner};
use twigo_cache::metrics::{Api, Change, Sample, Update};
use twigo_cache::table::{Cell, Column, ColumnKind, Row};
use twigo_cache::view::{QueryView, Spec};
use twigo_ipc::{
    ColumnValues, ErrorKind, Grouping, Gvr, ListQuery, RowGroup, Sort, ValueCount, ViewState,
};

const CASES: &str = include_str!("../../../packages/protocol/src/query-cases.json");

#[derive(Deserialize)]
struct Cases {
    context: String,
    lists: Vec<List>,
}

#[derive(Deserialize)]
struct List {
    name: String,
    namespaced: bool,
    columns: Vec<twigo_ipc::Column>,
    rows: Vec<CaseRow>,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct CaseRow {
    namespace: Option<String>,
    name: String,
    created: Option<jiff::Timestamp>,
    labels: BTreeMap<String, String>,
    #[serde(default)]
    owners: Vec<CaseOwner>,
    cells: Vec<Value>,
}

#[derive(Deserialize)]
struct CaseOwner {
    uid: String,
    controller: bool,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    query: CaseQuery,
    window: (u32, u32),
    expect: Expect,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CaseQuery {
    namespaces: Vec<String>,
    label_selector: Option<String>,
    owners: Option<Vec<String>>,
    text: Option<String>,
    columns: Option<BTreeMap<String, bool>>,
    sort: Option<Sort>,
    count_by: Option<String>,
    group_by: Option<Grouping>,
    values: Option<ColumnValues>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Expect {
    refused: Option<ErrorKind>,
    columns: Option<Vec<String>>,
    total: u32,
    ids: Vec<String>,
    counts: Option<Vec<ValueCount>>,
    groups: Option<Vec<RowGroup>>,
}

fn is_metric(column: &twigo_ipc::Column) -> bool {
    use twigo_ipc::ColumnKind as Wire;
    matches!(column.kind, Wire::Cpu | Wire::Memory)
}

fn column(column: &twigo_ipc::Column) -> Option<Column> {
    use twigo_ipc::ColumnKind as Wire;
    Some(Column {
        name: column.name.as_str().into(),
        kind: match column.kind {
            Wire::String => ColumnKind::String,
            Wire::Integer => ColumnKind::Integer,
            Wire::Number => ColumnKind::Number,
            Wire::Boolean => ColumnKind::Boolean,
            Wire::Date => ColumnKind::Date,
            Wire::Age => ColumnKind::Age,
            Wire::Other => ColumnKind::Other,
            Wire::Cpu | Wire::Memory => return None,
        },
        format: "".into(),
        priority: column.priority,
    })
}

/// A row as the Table decoder makes it: Age cells, and JSON's types.
fn row(row: &CaseRow, cells: Vec<&Value>, columns: &[Column], at: usize) -> Row {
    let cells = cells
        .into_iter()
        .zip(columns)
        .map(|(cell, column)| match (column.kind, cell) {
            (ColumnKind::Age, _) => Cell::Age,
            (_, Value::Null) => Cell::Null,
            (_, Value::Bool(value)) => Cell::Bool(*value),
            (ColumnKind::Number, Value::Number(n)) => Cell::Number(n.as_f64().unwrap()),
            (_, Value::Number(n)) => match n.as_i64() {
                Some(value) => Cell::Int(value),
                None => Cell::Number(n.as_f64().unwrap()),
            },
            (_, Value::String(text)) => Cell::Text(text.as_str().into()),
            (_, other) => panic!("no cell is {other}"),
        })
        .collect();
    Row {
        meta: Meta {
            name: row.name.as_str().into(),
            namespace: row.namespace.as_deref().map(Into::into),
            uid: Some(format!("uid-{at}").into()),
            resource_version: "1".into(),
            labels: row
                .labels
                .iter()
                .map(|(key, value)| (key.as_str().into(), value.as_str().into()))
                .collect(),
            owners: row
                .owners
                .iter()
                .map(|owner| Owner {
                    kind: "ReplicaSet".into(),
                    name: owner.uid.as_str().into(),
                    uid: owner.uid.as_str().into(),
                    controller: owner.controller,
                })
                .collect(),
            created: row.created,
            generated: None,
        },
        cells,
    }
}

#[test]
fn the_query_cases_pass() {
    let cases: Cases = serde_json::from_str(CASES).unwrap();
    let mut failed = Vec::new();
    for list in &cases.lists {
        let columns: Arc<[Column]> = list.columns.iter().filter_map(column).collect();
        let metric_at = |kind: twigo_ipc::ColumnKind| {
            list.columns.iter().position(|column| column.kind == kind)
        };
        let metrics =
            metric_at(twigo_ipc::ColumnKind::Cpu).zip(metric_at(twigo_ipc::ColumnKind::Memory));
        for case in &list.cases {
            let query = ListQuery {
                space: cases.context.clone(),
                gvr: Gvr {
                    group: String::new(),
                    version: "v1".to_owned(),
                    resource: list.name.clone(),
                },
                namespaced: list.namespaced,
                namespaces: case.query.namespaces.clone(),
                label_selector: case.query.label_selector.clone(),
                field_selector: None,
                owners: case.query.owners.clone(),
                text: case.query.text.clone(),
                columns: case.query.columns.clone(),
                sort: case.query.sort.clone(),
                count_by: case.query.count_by.clone(),
                group_by: case.query.group_by.clone(),
                values: case.query.values.clone(),
            };
            // The hub's upstreams serve only the query's namespaces.
            let rows = list
                .rows
                .iter()
                .enumerate()
                .filter(|(_, row)| {
                    !list.namespaced
                        || query.namespaces.is_empty()
                        || row
                            .namespace
                            .as_ref()
                            .is_some_and(|namespace| query.namespaces.contains(namespace))
                })
                .collect::<Vec<_>>();
            let samples: Vec<Change> = rows
                .iter()
                .filter_map(|(_, case_row)| {
                    let (cpu, memory) = metrics?;
                    Some(Change {
                        namespace: case_row.namespace.as_deref().unwrap_or_default().into(),
                        name: case_row.name.as_str().into(),
                        sample: Some(Arc::new(Sample {
                            sampled: None,
                            cpu: case_row.cells[cpu].as_i64()?,
                            memory: case_row.cells[memory].as_i64()?,
                            containers: Box::default(),
                        })),
                    })
                })
                .collect();
            let rows = rows
                .into_iter()
                .map(|(at, case_row)| {
                    let cells = case_row
                        .cells
                        .iter()
                        .zip(&list.columns)
                        .filter(|(_, column)| !is_metric(column))
                        .map(|(cell, _)| cell)
                        .collect();
                    Arc::new(row(case_row, cells, &columns, at))
                })
                .collect();
            let spec = Spec::new(&cases.context, &query);
            if let Some(kind) = case.expect.refused {
                if spec.as_ref().map_err(|error| error.kind).err() != Some(kind) {
                    failed.push(format!(
                        "{}: {}: not refused as {kind:?}",
                        list.name, case.name
                    ));
                }
                continue;
            }
            let Ok(spec) = spec else {
                failed.push(format!("{}: {}: refused", list.name, case.name));
                continue;
            };
            let mut view = QueryView::new(spec);
            view.set_api(Api::Served {
                version: "v1beta1",
                pods: true,
                nodes: true,
            });
            view.set_window(case.window.0, case.window.1);
            view.apply(Delta::Reset {
                rows,
                columns: Some(Arc::clone(&columns)),
            });
            view.samples(Update {
                changes: samples,
                ..Update::default()
            });
            let batch = view.batch(ViewState::Ready).unwrap();
            let ids: Vec<&str> = batch
                .window
                .as_ref()
                .unwrap()
                .ids
                .iter()
                .map(|id| id.0.as_str())
                .collect();
            let names: Vec<&str> = batch
                .columns
                .as_ref()
                .unwrap()
                .iter()
                .map(|column| column.name.as_str())
                .collect();
            let expect = &case.expect;
            let wrong = ids != expect.ids
                || batch.total != expect.total
                || expect
                    .columns
                    .as_ref()
                    .is_some_and(|columns| *columns != names)
                || expect.counts.is_some() && batch.counts != expect.counts
                || query.group_by.is_some() && batch.groups != expect.groups;
            if wrong {
                failed.push(format!(
                    "{}: {}: total {}, ids {ids:?}, columns {names:?}, counts {:?}, groups {:?}",
                    list.name, case.name, batch.total, batch.counts, batch.groups
                ));
            }
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
