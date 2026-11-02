//! The query cases the mock runs too (`packages/protocol/src/query-cases.json`),
//! through Rust's query view.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use twigo_cache::hub::Delta;
use twigo_cache::meta::Meta;
use twigo_cache::table::{Cell, Column, ColumnKind, Row};
use twigo_cache::view::{QueryView, Spec};
use twigo_ipc::{ColumnValues, ErrorKind, Gvr, ListQuery, Sort, ValueCount, ViewState};

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
    cells: Vec<Value>,
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
    text: Option<String>,
    columns: Option<BTreeMap<String, bool>>,
    sort: Option<Sort>,
    count_by: Option<String>,
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
}

fn column(column: &twigo_ipc::Column) -> Column {
    use twigo_ipc::ColumnKind as Wire;
    Column {
        name: column.name.as_str().into(),
        kind: match column.kind {
            Wire::String => ColumnKind::String,
            Wire::Integer => ColumnKind::Integer,
            Wire::Number => ColumnKind::Number,
            Wire::Boolean => ColumnKind::Boolean,
            Wire::Date => ColumnKind::Date,
            Wire::Age => ColumnKind::Age,
            Wire::Other => ColumnKind::Other,
        },
        format: "".into(),
        priority: column.priority,
    }
}

/// A row as the Table decoder makes it: Age cells, and JSON's types.
fn row(row: &CaseRow, columns: &[Column], at: usize) -> Row {
    let cells = row
        .cells
        .iter()
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
            owners: Box::default(),
            created: row.created,
        },
        cells,
    }
}

#[test]
fn the_query_cases_pass() {
    let cases: Cases = serde_json::from_str(CASES).unwrap();
    let mut failed = Vec::new();
    for list in &cases.lists {
        let columns: Arc<[Column]> = list.columns.iter().map(column).collect();
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
                text: case.query.text.clone(),
                columns: case.query.columns.clone(),
                sort: case.query.sort.clone(),
                count_by: case.query.count_by.clone(),
                group_by: None,
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
                .map(|(at, case_row)| Arc::new(row(case_row, &columns, at)))
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
            view.set_window(case.window.0, case.window.1);
            view.apply(Delta::Reset {
                rows,
                columns: Some(Arc::clone(&columns)),
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
                || expect.counts.is_some() && batch.counts != expect.counts;
            if wrong {
                failed.push(format!(
                    "{}: {}: total {}, ids {ids:?}, columns {names:?}, counts {:?}",
                    list.name, case.name, batch.total, batch.counts
                ));
            }
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
