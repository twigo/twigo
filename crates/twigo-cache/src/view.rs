//! Query views (ARCHITECTURE 3.4): a subscription's rows filtered, counted,
//! grouped, sorted and windowed in Rust, kept in an ordered index that each
//! change updates in O(log n), and the batches that tell the webview what
//! changed in its window.
//!
//! A list of pods or nodes joins their metrics as two columns (ARCHITECTURE
//! 3.6): each row reads the sample of its namespace and name, kept apart
//! from the row.

mod filter;
mod labels;
mod sort;

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::sync::Arc;

use indexset::BTreeSet;
use twigo_ipc::{
    self as ipc, IpcError, ListBatch, ListQuery, MetricsState, RowGroup, RowId, ValueCount,
    ViewState,
};

use crate::hub::Delta;
use crate::metrics::{self, Api, Kind, Sample, Scope};
use crate::store::RowKey;
use crate::table::{Cell, Column, ColumnKind, Row};

pub use filter::TextFilter;
pub use labels::Selector;
pub use sort::{SortKey, natural};

/// The column a list without a sort of its own is sorted by, and which
/// the text filter always reads.
const NAME: &str = "Name";
/// The column Rust adds after Name for a namespaced resource shown in
/// more than one namespace (ARCHITECTURE 4.4).
const NAMESPACE: &str = "Namespace";
const CPU: &str = "CPU";
const MEMORY: &str = "Memory";

/// What a query asks of its rows, checked once.
#[derive(Debug, Clone)]
pub struct Spec {
    context: String,
    namespace_column: bool,
    labels: Option<Selector>,
    owners: Option<HashSet<String>>,
    text: Option<TextFilter>,
    choices: Option<BTreeMap<String, bool>>,
    sort: Option<ipc::Sort>,
    count_by: Option<String>,
    group_by: Option<(String, HashSet<String>)>,
    values: Option<(String, HashSet<String>)>,
    metrics: Option<Kind>,
    all_namespaces: bool,
}

impl Spec {
    /// Refuses a label selector or a regex that does not parse.
    pub fn new(context: &str, query: &ListQuery) -> Result<Self, IpcError> {
        Ok(Self {
            context: context.to_owned(),
            namespace_column: query.namespaced
                && query.namespaces.iter().collect::<HashSet<_>>().len() != 1,
            labels: query
                .label_selector
                .as_deref()
                .map(Selector::parse)
                .transpose()?,
            owners: query
                .owners
                .as_ref()
                .map(|uids| uids.iter().cloned().collect()),
            text: match &query.text {
                Some(text) => TextFilter::parse(text)?,
                None => None,
            },
            choices: query.columns.clone(),
            sort: query.sort.clone(),
            count_by: query.count_by.clone(),
            group_by: query.group_by.as_ref().map(|grouping| {
                (
                    grouping.column.clone(),
                    grouping.collapsed.iter().cloned().collect(),
                )
            }),
            values: query.values.as_ref().map(|values| {
                (
                    values.column.clone(),
                    values.values.iter().cloned().collect(),
                )
            }),
            metrics: Kind::of(&query.gvr.group, &query.gvr.version, &query.gvr.resource),
            all_namespaces: query.namespaced && query.namespaces.is_empty(),
        })
    }

    pub fn metrics(&self) -> Option<Kind> {
        self.metrics
    }
}

/// Where a column of the webview's comes from.
#[derive(Debug, Clone, Copy)]
enum Source {
    Namespace,
    Cell(usize),
    Metric(Metric),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Metric {
    Cpu,
    Memory,
}

/// The query resolved against the server's columns: a choice, a sort, a
/// count, a group or values for a column the list lacks does nothing.
struct Layout {
    server: Arc<[Column]>,
    metrics: bool,
    wire: Vec<ipc::Column>,
    sources: Vec<Source>,
    /// What the text filter reads.
    text: Vec<usize>,
    sort: Option<usize>,
    descending: bool,
    sort_metric: bool,
    count: Option<usize>,
    /// The group column and the collapsed values.
    group: Option<(usize, HashSet<String>)>,
    values: Option<(usize, HashSet<String>)>,
}

impl Layout {
    fn new(spec: &Spec, server: Arc<[Column]>, metrics: bool) -> Self {
        // The metric columns come with the server's, in one batch.
        let metrics = metrics && !server.is_empty();
        let mut wire = Vec::with_capacity(server.len() + 3);
        let mut sources = Vec::with_capacity(server.len() + 3);
        let metric_columns = |wire: &mut Vec<ipc::Column>, sources: &mut Vec<Source>| {
            for (name, kind, metric) in [
                (CPU, ipc::ColumnKind::Cpu, Metric::Cpu),
                (MEMORY, ipc::ColumnKind::Memory, Metric::Memory),
            ] {
                wire.push(ipc::Column {
                    name: name.to_owned(),
                    kind,
                    priority: 0,
                });
                sources.push(Source::Metric(metric));
            }
        };
        let mut placed = !metrics;
        for (at, column) in server.iter().enumerate() {
            if !placed && column.kind == ColumnKind::Age {
                metric_columns(&mut wire, &mut sources);
                placed = true;
            }
            wire.push(ipc::Column {
                name: column.name.to_string(),
                kind: kind(column.kind),
                priority: column.priority,
            });
            sources.push(Source::Cell(at));
            if at == 0 && spec.namespace_column {
                wire.push(ipc::Column {
                    name: NAMESPACE.to_owned(),
                    kind: ipc::ColumnKind::String,
                    priority: 0,
                });
                sources.push(Source::Namespace);
            }
        }
        if !placed {
            metric_columns(&mut wire, &mut sources);
        }
        let find = |name: &str| wire.iter().position(|column| column.name == name);
        let find_text =
            |name: &str| find(name).filter(|&at| !matches!(sources[at], Source::Metric(_)));
        let text = wire
            .iter()
            .enumerate()
            .filter(|(at, column)| {
                !matches!(sources[*at], Source::Metric(_))
                    && (column.name == NAME
                        || spec
                            .choices
                            .as_ref()
                            .and_then(|choices| choices.get(&column.name).copied())
                            .unwrap_or(column.priority == 0))
            })
            .map(|(at, _)| at)
            .collect();
        let chosen = spec
            .sort
            .as_ref()
            .and_then(|sort| Some((find(&sort.column)?, sort.descending)));
        let (sort, descending) = match chosen {
            Some((at, descending)) => (Some(at), descending),
            None => (find(NAME), false),
        };
        let sort_metric = sort.is_some_and(|at| matches!(sources[at], Source::Metric(_)));
        let count = spec.count_by.as_deref().and_then(find_text);
        let group = spec
            .group_by
            .as_ref()
            .and_then(|(column, collapsed)| Some((find_text(column)?, collapsed.clone())));
        let values = spec
            .values
            .as_ref()
            .and_then(|(column, values)| Some((find_text(column)?, values.clone())));
        Self {
            server,
            metrics,
            wire,
            sources,
            text,
            sort,
            descending,
            sort_metric,
            count,
            group,
            values,
        }
    }

    fn cell<'a>(&self, row: &'a Row, sample: Option<&Sample>, at: usize) -> Cow<'a, Cell> {
        match self.sources[at] {
            Source::Namespace => Cow::Owned(match &row.meta.namespace {
                Some(namespace) => Cell::Text(namespace.clone()),
                None => Cell::Null,
            }),
            Source::Cell(at) => row
                .cells
                .get(at)
                .map_or(Cow::Owned(Cell::Null), Cow::Borrowed),
            Source::Metric(metric) => Cow::Owned(match (metric, sample) {
                (_, None) => Cell::Null,
                (Metric::Cpu, Some(sample)) => Cell::Int(sample.cpu),
                (Metric::Memory, Some(sample)) => Cell::Int(sample.memory),
            }),
        }
    }

    /// A metric is no text for the filter, the counts, the groups or the values.
    fn text<'a>(&self, row: &'a Row, at: usize) -> Cow<'a, str> {
        match self.sources[at] {
            Source::Namespace => row.meta.namespace.as_deref().unwrap_or_default().into(),
            Source::Cell(at) => row.cells.get(at).map_or("".into(), filter::text),
            Source::Metric(_) => "".into(),
        }
    }

    fn sort_key(&self, row: &Row, sample: Option<&Sample>) -> SortKey {
        match self.sort {
            Some(at) => SortKey::of(&self.cell(row, sample, at), row.meta.created),
            None => SortKey::Null,
        }
    }

    fn wire_row(&self, row: &Row, sample: Option<&Sample>, id: &str) -> ipc::Row {
        let cells = (0..self.wire.len())
            .map(|at| match &*self.cell(row, sample, at) {
                Cell::Null | Cell::Age => ipc::Cell::Null,
                Cell::Bool(value) => ipc::Cell::Bool(*value),
                Cell::Int(value) => ipc::Cell::Int(*value),
                Cell::Number(value) => ipc::Cell::Number(*value),
                Cell::Text(text) => ipc::Cell::Text(text.to_string()),
            })
            .collect();
        ipc::Row {
            id: RowId(id.to_owned()),
            created: row.meta.created.map(|created| created.to_string()),
            generated: row.meta.generated,
            cells,
        }
    }
}

fn kind(kind: ColumnKind) -> ipc::ColumnKind {
    match kind {
        ColumnKind::String => ipc::ColumnKind::String,
        ColumnKind::Integer => ipc::ColumnKind::Integer,
        ColumnKind::Number => ipc::ColumnKind::Number,
        ColumnKind::Boolean => ipc::ColumnKind::Boolean,
        ColumnKind::Date => ipc::ColumnKind::Date,
        ColumnKind::Age => ipc::ColumnKind::Age,
        ColumnKind::Other => ipc::ColumnKind::Other,
    }
}

/// A group column's text, ordered as groups are: naturally, the empty
/// value last.
#[derive(Debug, Clone, PartialEq, Eq)]
struct GroupKey(Arc<str>);

impl Ord for GroupKey {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0
            .is_empty()
            .cmp(&other.0.is_empty())
            .then_with(|| natural(&self.0, &other.0))
    }
}

impl PartialOrd for GroupKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A row's place in the index: by its group, then by its sort key in the
/// query's direction, then by its id, ascending either way.
#[derive(Debug, Clone)]
struct Entry {
    group: Option<GroupKey>,
    key: SortKey,
    id: Arc<str>,
    row: RowKey,
    descending: bool,
    /// A row without a sample is no zero, so it comes last whichever the direction.
    empty_last: bool,
}

impl Ord for Entry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.group.cmp(&other.group).then_with(|| {
            let order = match (&self.key, &other.key) {
                (SortKey::Null, SortKey::Null) => Ordering::Equal,
                (SortKey::Null, _) if self.empty_last => Ordering::Greater,
                (_, SortKey::Null) if self.empty_last => Ordering::Less,
                (a, b) if self.descending => b.cmp(a),
                (a, b) => a.cmp(b),
            };
            order.then_with(|| natural(&self.id, &other.id))
        })
    }
}

impl PartialOrd for Entry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Entry {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Entry {}

/// A row that passes the labels and the text: it is counted, and is in the
/// index unless the values drop it.
struct Tracked {
    row: Arc<Row>,
    sample: Option<Arc<Sample>>,
    id: Arc<str>,
    count: Option<Box<str>>,
    group: Option<GroupKey>,
    entry: Option<Entry>,
}

/// The rows of one value of the group column that the labels and the text
/// keep, which its counts count.
#[derive(Default)]
struct Group {
    tracked: u32,
    /// Those in the index.
    rows: u32,
    counts: HashMap<Box<str>, u32>,
}

/// What the webview holds: the last batches' window, rows and counts.
#[derive(Default)]
struct Sent {
    columns: Option<Vec<ipc::Column>>,
    start: u32,
    ids: Vec<Arc<str>>,
    rows: HashMap<Arc<str>, (Arc<Row>, Option<Usage>)>,
    total: u32,
    status: Option<ViewState>,
    counts: Option<Vec<ValueCount>>,
    groups: Option<Vec<RowGroup>>,
    metrics: Option<MetricsState>,
}

type Usage = (i64, i64);

struct Metrics {
    kind: Kind,
    reported: Option<MetricsState>,
    stale: bool,
    /// By namespace, none for a node, and name.
    names: HashMap<Box<str>, HashMap<Box<str>, RowKey>>,
}

pub struct QueryView {
    spec: Spec,
    layout: Layout,
    rows: HashMap<RowKey, Tracked>,
    index: BTreeSet<Entry>,
    counts: HashMap<Box<str>, u32>,
    /// In the index's order, so the groups' rows add up to their place in it.
    groups: BTreeMap<GroupKey, Group>,
    window: (u32, u32),
    sent: Sent,
    seq: u32,
    /// None while the context serves no metrics for the list's resource.
    metrics: Option<Metrics>,
    /// Rows that entered the index without a sample since `sample_entered` last ran.
    entered: Vec<RowKey>,
}

impl QueryView {
    pub fn new(spec: Spec) -> Self {
        let layout = Layout::new(&spec, Arc::default(), false);
        Self {
            spec,
            layout,
            rows: HashMap::new(),
            index: BTreeSet::new(),
            counts: HashMap::new(),
            groups: BTreeMap::new(),
            window: (0, 0),
            sent: Sent::default(),
            seq: 0,
            metrics: None,
            entered: Vec::new(),
        }
    }

    pub fn apply(&mut self, delta: Delta<Row>) {
        match delta {
            Delta::Reset { rows, columns } => {
                let columns = columns.unwrap_or_default();
                if *columns != *self.layout.server {
                    self.layout = Layout::new(&self.spec, columns, self.metrics.is_some());
                }
                let held: HashMap<RowKey, Arc<Sample>> = self
                    .rows
                    .drain()
                    .filter_map(|(key, tracked)| Some((key, tracked.sample?)))
                    .collect();
                self.index.clear();
                self.counts.clear();
                self.groups.clear();
                if let Some(metrics) = &mut self.metrics {
                    metrics.names.clear();
                }
                for row in rows {
                    let sample = held.get(&RowKey::of(&row.meta)).cloned();
                    self.insert(row, sample);
                }
            }
            Delta::Changed { upserted, removed } => {
                for key in &removed {
                    self.remove(key);
                }
                for row in upserted {
                    let sample = self.remove(&RowKey::of(&row.meta));
                    self.insert(row, sample);
                }
            }
        }
    }

    pub fn sorts_by_metric(&self) -> bool {
        self.layout.sort_metric
    }

    /// The CPU and Memory columns come and go with the API, as a change of the columns.
    pub fn set_api(&mut self, api: Api) {
        let Some(kind) = self.spec.metrics else {
            return;
        };
        let served = api.columns(kind);
        let stale = api.stale();
        match (&mut self.metrics, served) {
            (Some(metrics), true) => metrics.stale = stale,
            (None, false) => {}
            (_, served) => {
                self.metrics = served.then(|| Metrics {
                    kind,
                    reported: None,
                    stale,
                    names: HashMap::new(),
                });
                self.rebuild();
            }
        }
    }

    fn rebuild(&mut self) {
        let tracked: Vec<_> = self
            .rows
            .drain()
            .map(|(_, tracked)| (tracked.row, tracked.sample))
            .collect();
        self.index.clear();
        self.counts.clear();
        self.groups.clear();
        self.layout = Layout::new(
            &self.spec,
            Arc::clone(&self.layout.server),
            self.metrics.is_some(),
        );
        for (row, sample) in tracked {
            self.insert(row, sample.filter(|_| self.metrics.is_some()));
        }
    }

    /// The namespaces of the window's rows, or every one of the list when it is sorted by a
    /// metric, which for a list of all namespaces adds the cluster: one request, with the
    /// namespaces to fall back on when it is refused (decision 69).
    pub fn wants(&self, reading: bool) -> HashSet<Scope> {
        let Some(metrics) = self.metrics.as_ref().filter(|_| reading) else {
            return HashSet::new();
        };
        if self.rows.is_empty() {
            return HashSet::new();
        }
        if metrics.kind == Kind::Nodes {
            return HashSet::from([Scope::Cluster]);
        }
        let namespaces: HashSet<&str> = if self.layout.sort_metric {
            metrics.names.keys().map(|name| &**name).collect()
        } else {
            self.shown()
                .iter()
                .filter_map(|entry| self.rows[&entry.row].row.meta.namespace.as_deref())
                .collect()
        };
        let cluster = self.layout.sort_metric && self.spec.all_namespaces;
        namespaces
            .into_iter()
            .map(|namespace| Scope::Namespace(namespace.into()))
            .chain(cluster.then_some(Scope::Cluster))
            .collect()
    }

    pub fn samples(&mut self, update: metrics::Update) {
        let Some(metrics) = &mut self.metrics else {
            return;
        };
        metrics.reported = update.said().or(metrics.reported);
        for reset in update.resets {
            for (namespace, name, key) in self.named_in(&reset.scope) {
                self.set_sample(&key, reset.samples.get(&namespace, &name).cloned());
            }
        }
        for change in update.changes {
            let key = self
                .metrics
                .as_ref()
                .and_then(|metrics| metrics.names.get(&change.namespace)?.get(&change.name))
                .cloned();
            if let Some(key) = key {
                self.set_sample(&key, change.sample);
            }
        }
    }

    /// Gives the rows that entered the index since the last call the sample the poller already
    /// holds, which it tells no more of until it changes.
    pub fn sample_entered(&mut self, held: impl Fn(&str, &str) -> Option<Arc<Sample>>) {
        for key in std::mem::take(&mut self.entered) {
            let Some(tracked) = self
                .rows
                .get(&key)
                .filter(|tracked| tracked.sample.is_none())
            else {
                continue;
            };
            let found = held(
                tracked.row.meta.namespace.as_deref().unwrap_or_default(),
                &tracked.row.meta.name,
            )
            .filter(|found| found.taken_since(tracked.row.meta.created));
            if found.is_some() {
                self.set_sample(&key, found);
            }
        }
    }

    fn named_in(&self, scope: &Scope) -> Vec<(Box<str>, Box<str>, RowKey)> {
        let Some(metrics) = &self.metrics else {
            return Vec::new();
        };
        let all = |namespace: &str, names: &HashMap<Box<str>, RowKey>| -> Vec<_> {
            names
                .iter()
                .map(|(name, key)| (namespace.into(), name.clone(), key.clone()))
                .collect()
        };
        match scope {
            Scope::Cluster => metrics
                .names
                .iter()
                .flat_map(|(namespace, names)| all(namespace, names))
                .collect(),
            Scope::Namespace(namespace) => metrics
                .names
                .get(namespace)
                .map(|names| all(namespace, names))
                .unwrap_or_default(),
            Scope::Named { namespace, name } => metrics
                .names
                .get(namespace)
                .and_then(|names| names.get(name))
                .map(|key| (namespace.clone(), name.clone(), key.clone()))
                .into_iter()
                .collect(),
        }
    }

    fn set_sample(&mut self, key: &RowKey, sample: Option<Arc<Sample>>) {
        let Some(tracked) = self.rows.get_mut(key) else {
            return;
        };
        if tracked.sample == sample {
            return;
        }
        tracked.sample = sample;
        if !self.layout.sort_metric {
            return;
        }
        if let Some(entry) = &mut tracked.entry {
            let moved = self
                .layout
                .sort_key(&tracked.row, tracked.sample.as_deref());
            if moved != entry.key {
                self.index.remove(entry);
                entry.key = moved;
                self.index.insert(entry.clone());
            }
        }
    }

    /// The state its scopes last said, or the failure they last ended in before their first
    /// answer, kept while it reads nothing; none until there is one, but `unavailable` for a
    /// stale API, which discovery knows without a request, once the server's columns are known:
    /// the metric columns, and so the state, come with them.
    fn metrics_state(&self) -> Option<MetricsState> {
        let metrics = self.metrics.as_ref().filter(|_| self.layout.metrics)?;
        metrics
            .reported
            .or_else(|| metrics.stale.then_some(MetricsState::Unavailable))
    }

    /// The rows from `start` up to `end`, exclusive, of those the window
    /// reads: every row in the index, or those of the groups not collapsed.
    pub fn set_window(&mut self, start: u32, end: u32) {
        self.window = (start, end);
    }

    fn id(&self, row: &Row) -> Arc<str> {
        let context = &self.spec.context;
        let name = &row.meta.name;
        match &row.meta.namespace {
            Some(namespace) => format!("{context}/{namespace}/{name}").into(),
            None => format!("{context}/{name}").into(),
        }
    }

    fn insert(&mut self, row: Arc<Row>, sample: Option<Arc<Sample>>) {
        let layout = &self.layout;
        if let Some(labels) = &self.spec.labels
            && !labels.matches(&row.meta.labels)
        {
            return;
        }
        if let Some(owners) = &self.spec.owners
            && !row
                .meta
                .owners
                .iter()
                .any(|owner| owner.controller && owners.contains(&*owner.uid))
        {
            return;
        }
        if let Some(text) = &self.spec.text
            && !text.keeps(layout.text.iter().map(|&at| layout.text(&row, at)))
        {
            return;
        }
        let count: Option<Box<str>> = layout.count.map(|at| layout.text(&row, at).into());
        if let Some(count) = &count {
            *self.counts.entry(count.clone()).or_default() += 1;
        }
        let kept = match &layout.values {
            Some((at, values)) => values.contains(&*layout.text(&row, *at)),
            None => true,
        };
        let group = layout
            .group
            .as_ref()
            .map(|(at, _)| GroupKey(layout.text(&row, *at).into()));
        if let Some(group) = &group {
            let tally = self.groups.entry(group.clone()).or_default();
            tally.tracked += 1;
            tally.rows += u32::from(kept);
            if let Some(count) = &count {
                *tally.counts.entry(count.clone()).or_default() += 1;
            }
        }
        let id = self.id(&row);
        let key = RowKey::of(&row.meta);
        let entry = kept.then(|| Entry {
            group: group.clone(),
            key: layout.sort_key(&row, sample.as_deref()),
            id: Arc::clone(&id),
            row: key.clone(),
            descending: layout.descending,
            empty_last: layout.sort_metric,
        });
        if let Some(entry) = &entry {
            self.index.insert(entry.clone());
        }
        if let Some(metrics) = &mut self.metrics {
            metrics
                .names
                .entry(row.meta.namespace.clone().unwrap_or_default())
                .or_default()
                .insert(row.meta.name.clone(), key.clone());
            if sample.is_none() {
                self.entered.push(key.clone());
            }
        }
        self.rows.insert(
            key,
            Tracked {
                row,
                sample,
                id,
                count,
                group,
                entry,
            },
        );
    }

    /// Its sample goes with it, and is given back for the row's next version.
    fn remove(&mut self, key: &RowKey) -> Option<Arc<Sample>> {
        let tracked = self.rows.remove(key)?;
        if let Some(metrics) = &mut self.metrics {
            let namespace = tracked.row.meta.namespace.as_deref().unwrap_or_default();
            if let Some(names) = metrics.names.get_mut(namespace) {
                if names.get(&tracked.row.meta.name) == Some(key) {
                    names.remove(&tracked.row.meta.name);
                }
                if names.is_empty() {
                    metrics.names.remove(namespace);
                }
            }
        }
        if let Some(value) = &tracked.count {
            uncount(&mut self.counts, value);
        }
        if let Some(group) = &tracked.group
            && let Some(tally) = self.groups.get_mut(group)
        {
            tally.tracked -= 1;
            tally.rows -= u32::from(tracked.entry.is_some());
            if let Some(value) = &tracked.count {
                uncount(&mut tally.counts, value);
            }
            if tally.tracked == 0 {
                self.groups.remove(group);
            }
        }
        if let Some(entry) = tracked.entry {
            self.index.remove(&entry);
        }
        tracked.sample
    }

    /// The matching rows per value of the count column, largest first;
    /// none while the list has no rows to show.
    fn counts(&self, shows: bool) -> Option<Vec<ValueCount>> {
        self.spec.count_by.as_ref()?;
        Some(if shows {
            sorted(&self.counts)
        } else {
            Vec::new()
        })
    }

    /// The groups that hold matching rows, in group order; none without a
    /// group column, and empty while the list has no rows to show.
    fn groups(&self, shows: bool) -> Option<Vec<RowGroup>> {
        self.layout.group.as_ref()?;
        Some(
            self.groups
                .iter()
                .filter(|(_, group)| shows && group.rows > 0)
                .map(|(value, group)| RowGroup {
                    value: value.0.to_string(),
                    rows: group.rows,
                    counts: sorted(&group.counts),
                })
                .collect(),
        )
    }

    /// The ranges of the index that the window reads, in order: all of it,
    /// or with a group column those of the groups not collapsed.
    fn readable(&self) -> Vec<Range<usize>> {
        let Some((_, collapsed)) = &self.layout.group else {
            return std::iter::once(0..self.index.len()).collect();
        };
        let mut ranges: Vec<Range<usize>> = Vec::new();
        let mut at = 0;
        for (value, group) in &self.groups {
            let next = at + group.rows as usize;
            if at < next && !collapsed.contains(&*value.0) {
                match ranges.last_mut() {
                    Some(last) if last.end == at => last.end = next,
                    _ => ranges.push(at..next),
                }
            }
            at = next;
        }
        ranges
    }

    /// The window's entries, of the rows it reads.
    fn shown(&self) -> Vec<&Entry> {
        let (start, end) = (self.window.0 as usize, self.window.1 as usize);
        let mut shown = Vec::new();
        let mut before = 0;
        for range in self.readable() {
            let from = start.max(before) - before;
            let to = end.min(before + range.len()).saturating_sub(before);
            if from < to {
                shown.extend(self.index.range_idx(range.start + from..range.start + to));
            }
            before += range.len();
        }
        shown
    }

    /// What changed for the webview since the last batch, if anything did:
    /// the window when its rows or their order changed, the rows that
    /// entered it or changed, and the total, the status, the columns and
    /// the counts and the groups when they changed. Only a list that is
    /// ready, relisting or stale has rows to show; the others show their
    /// state.
    pub fn batch(&mut self, status: ViewState) -> Option<ListBatch> {
        let first = self.seq == 0;
        let shows = matches!(
            status,
            ViewState::Ready | ViewState::Relisting | ViewState::Stale
        );
        let columns_changed = self
            .sent
            .columns
            .as_ref()
            .is_none_or(|sent| *sent != self.layout.wire);
        if columns_changed {
            self.sent.rows.clear();
        }
        let total = if shows { self.index.len() } else { 0 };
        let shown = if shows { self.shown() } else { Vec::new() };
        let ids: Vec<Arc<str>> = shown.iter().map(|entry| Arc::clone(&entry.id)).collect();
        let window_changed = first || self.window.0 != self.sent.start || ids != self.sent.ids;
        let mut rows = HashMap::with_capacity(shown.len());
        let mut upserts = Vec::new();
        for entry in &shown {
            let tracked = &self.rows[&entry.row];
            let usage = tracked
                .sample
                .as_deref()
                .map(|sample| (sample.cpu, sample.memory));
            let same = self
                .sent
                .rows
                .get(&entry.id)
                .is_some_and(|(sent, sent_usage)| {
                    unchanged(sent, &tracked.row) && *sent_usage == usage
                });
            if !same {
                upserts.push(self.layout.wire_row(
                    &tracked.row,
                    tracked.sample.as_deref(),
                    &tracked.id,
                ));
            }
            rows.insert(Arc::clone(&entry.id), (Arc::clone(&tracked.row), usage));
        }
        let total = u32::try_from(total).unwrap_or(u32::MAX);
        let counts = self.counts(shows);
        let counts_changed = first || counts != self.sent.counts;
        let groups = self.groups(shows);
        let groups_changed = groups != self.sent.groups;
        let metrics = self.metrics_state();
        let metrics_changed = metrics != self.sent.metrics;
        if !window_changed
            && !columns_changed
            && !counts_changed
            && !groups_changed
            && !metrics_changed
            && upserts.is_empty()
            && total == self.sent.total
            && self.sent.status.as_ref() == Some(&status)
        {
            return None;
        }
        self.seq += 1;
        let batch = ListBatch {
            seq: self.seq,
            total,
            columns: columns_changed.then(|| self.layout.wire.clone()),
            window: window_changed.then(|| ipc::Window {
                start: self.window.0,
                ids: ids.iter().map(|id| RowId(id.to_string())).collect(),
            }),
            upserts,
            status: status.clone(),
            counts: if counts_changed { counts.clone() } else { None },
            groups: groups_changed.then(|| groups.clone().unwrap_or_default()),
            metrics: metrics.filter(|_| metrics_changed),
        };
        self.sent = Sent {
            columns: Some(self.layout.wire.clone()),
            start: self.window.0,
            ids,
            rows,
            total,
            status: Some(status),
            counts,
            groups,
            metrics,
        };
        Some(batch)
    }
}

/// Counts largest first, then by value.
fn sorted(counts: &HashMap<Box<str>, u32>) -> Vec<ValueCount> {
    let mut sorted: Vec<ValueCount> = counts
        .iter()
        .map(|(value, count)| ValueCount {
            value: value.to_string(),
            count: *count,
        })
        .collect();
    sorted.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.value.cmp(&b.value)));
    sorted
}

fn uncount(counts: &mut HashMap<Box<str>, u32>, value: &str) {
    if let Some(count) = counts.get_mut(value) {
        *count -= 1;
        if *count == 0 {
            counts.remove(value);
        }
    }
}

/// Nothing the webview shows of the row changed.
fn unchanged(sent: &Arc<Row>, row: &Arc<Row>) -> bool {
    Arc::ptr_eq(sent, row)
        || (sent.cells == row.cells
            && sent.meta.created == row.meta.created
            && sent.meta.generated == row.meta.generated)
}

#[cfg(test)]
mod tests;
