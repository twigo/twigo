//! Values as the document shows them, and fields built from an object.

use serde_json::Value;
use twigo_ipc::{Block, Field, Finding, Fold, ObjectRef, Section, Span, Tone, Value as Shown};

use crate::layout::wrong;
use crate::text;

/// A section as its describer builds it: folded, with no line at its end
/// and no tone, which the page's layout and the describer's findings settle.
pub(crate) fn section(id: &str, title: &str, blocks: Vec<Block>) -> Section {
    Section {
        id: id.to_owned(),
        title: title.to_owned(),
        summary: Vec::new(),
        tone: None,
        fold: Fold::Folded,
        blocks,
    }
}

/// A section that holds a finding names it where its line would count.
pub(crate) fn named(finding: &Finding) -> Vec<Span> {
    Summary::default().part(&finding.title).done()
}

/// A section's line and tone: the finding's title and its tone where one is
/// about it, else `own`.
pub(crate) fn said(
    finding: Option<&Finding>,
    own: impl FnOnce() -> Vec<Span>,
) -> (Vec<Span>, Option<Tone>) {
    match finding {
        Some(finding) => (named(finding), wrong(finding.tone)),
        None => (own(), None),
    }
}

/// A section whose line counts what it lists: `2 ports`.
pub(crate) fn listing(
    id: &str,
    title: &str,
    count: usize,
    noun: &str,
    blocks: Vec<Block>,
) -> Section {
    Section {
        summary: Summary::default().count(count, noun).done(),
        ..section(id, title, blocks)
    }
}

/// `2 volumes`, `1 claim`: a count with its noun, which takes an `s`.
pub(crate) fn counted(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

/// The line a section's header ends with: parts joined by a dot, where a
/// part may end in a time that the webview keeps counting.
#[derive(Default)]
pub(crate) struct Summary(Vec<Span>);

impl Summary {
    pub fn part(mut self, text: impl AsRef<str>) -> Self {
        if !text.as_ref().is_empty() {
            self.separate();
            self.push(text.as_ref());
        }
        self
    }

    /// A count with its noun, none when there are none.
    pub fn count(self, count: usize, noun: &str) -> Self {
        if count == 0 {
            self
        } else {
            self.part(counted(count, noun))
        }
    }

    /// A part that ends in a time: `created 3 d ago`.
    pub fn ago(mut self, text: &str, at: String) -> Self {
        self.separate();
        self.push(text);
        self.0.push(Span::Ago { at });
        self
    }

    pub fn done(self) -> Vec<Span> {
        self.0
    }

    fn separate(&mut self) {
        if !self.0.is_empty() {
            self.push(" · ");
        }
    }

    fn push(&mut self, text: &str) {
        match self.0.last_mut() {
            Some(Span::Text { text: last }) => last.push_str(text),
            _ => self.0.push(Span::Text {
                text: text.to_owned(),
            }),
        }
    }
}

pub(crate) fn plain(text: impl Into<String>) -> Shown {
    Shown::Text { text: text.into() }
}

pub(crate) fn code(text: impl Into<String>) -> Shown {
    Shown::Code { text: text.into() }
}

pub(crate) fn toned(text: impl Into<String>, tone: Tone) -> Shown {
    Shown::Toned {
        text: text.into(),
        tone,
    }
}

/// A link to an object of a kind the describer knows; `namespace` is the
/// describer's, which the webview drops for a cluster-scoped kind.
pub(crate) fn link(
    (group, version, kind): (&str, &str, &str),
    namespace: Option<&str>,
    name: &str,
    shown: impl Into<String>,
) -> Shown {
    Shown::Link {
        target: ObjectRef {
            group: group.to_owned(),
            version: version.to_owned(),
            kind: kind.to_owned(),
            namespace: namespace.map(str::to_owned),
            name: name.to_owned(),
        },
        text: shown.into(),
    }
}

pub(crate) const CONFIG_MAP: (&str, &str, &str) = ("", "v1", "ConfigMap");
pub(crate) const SECRET: (&str, &str, &str) = ("", "v1", "Secret");
pub(crate) const NODE: (&str, &str, &str) = ("", "v1", "Node");
pub(crate) const SERVICE: (&str, &str, &str) = ("", "v1", "Service");
pub(crate) const SERVICE_ACCOUNT: (&str, &str, &str) = ("", "v1", "ServiceAccount");
pub(crate) const PVC: (&str, &str, &str) = ("", "v1", "PersistentVolumeClaim");
pub(crate) const PV: (&str, &str, &str) = ("", "v1", "PersistentVolume");
pub(crate) const POD: (&str, &str, &str) = ("", "v1", "Pod");
pub(crate) const JOB: (&str, &str, &str) = ("batch", "v1", "Job");
pub(crate) const REPLICA_SET: (&str, &str, &str) = ("apps", "v1", "ReplicaSet");

/// Fields in the order they are added, those without a value left out.
#[derive(Default)]
pub(crate) struct Fields(pub Vec<Field>);

impl Fields {
    pub fn add(&mut self, label: &str, value: Shown) -> &mut Self {
        self.add_default(label, value, false)
    }

    /// A row, when there is a value, that holds the cluster's default when
    /// `default` says so.
    pub fn add_default_maybe(
        &mut self,
        label: &str,
        value: Option<Shown>,
        default: bool,
    ) -> &mut Self {
        if let Some(value) = value {
            self.add_default(label, value, default);
        }
        self
    }

    /// A row that holds the cluster's default when `default` says so.
    pub fn add_default(&mut self, label: &str, value: Shown, default: bool) -> &mut Self {
        self.0.push(Field {
            default,
            label: label.to_owned(),
            value,
        });
        self
    }

    pub fn maybe(&mut self, label: &str, value: Option<Shown>) -> &mut Self {
        if let Some(value) = value {
            self.add(label, value);
        }
        self
    }

    /// A non-empty string of the object as text.
    pub fn text(&mut self, label: &str, value: &Value) -> &mut Self {
        self.maybe(label, text(value).map(plain))
    }

    /// A number or a boolean of the object as text.
    pub fn scalar(&mut self, label: &str, value: &Value) -> &mut Self {
        self.maybe(label, scalar(value).map(plain))
    }

    pub fn time(&mut self, label: &str, value: &Value) -> &mut Self {
        self.maybe(label, text(value).map(|at| Shown::Time { at }))
    }

    /// Present only when true, as kubectl leaves such flags out.
    pub fn flag(&mut self, label: &str, value: &Value) -> &mut Self {
        if value.as_bool() == Some(true) {
            self.add(label, plain("true"));
        }
        self
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// A number or a boolean as text, a string as it is.
pub(crate) fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::String(_) => text(value),
        _ => None,
    }
}

/// A list of values, or the one value it holds.
pub(crate) fn list(items: Vec<Shown>) -> Option<Shown> {
    match <[Shown; 1]>::try_from(items) {
        Ok([item]) => Some(item),
        Err(items) if items.is_empty() => None,
        Err(items) => Some(Shown::List { items }),
    }
}

/// A map of strings as `key=value` labels, sorted by key.
pub(crate) fn labels(map: &Value) -> Option<Shown> {
    let mut labels: Vec<twigo_ipc::Label> = map
        .as_object()?
        .iter()
        .map(|(key, value)| twigo_ipc::Label {
            key: key.clone(),
            value: value.as_str().unwrap_or_default().to_owned(),
        })
        .collect();
    labels.sort_by(|a, b| a.key.cmp(&b.key));
    (!labels.is_empty()).then_some(Shown::Labels { labels })
}

/// Resource quantities as kubectl's sorted names print them: `cpu 10m,
/// memory 16Mi`.
pub(crate) fn quantities(map: &Value) -> Option<Shown> {
    let map = map.as_object().filter(|map| !map.is_empty())?;
    let mut names: Vec<&String> = map.keys().collect();
    names.sort();
    Some(plain(
        names
            .iter()
            .map(|name| format!("{name} {}", map[*name].as_str().unwrap_or_default()))
            .collect::<Vec<_>>()
            .join(", "),
    ))
}

/// A label selector as apimachinery formats one: requirements sorted by
/// key, each one's values sorted, `app=web,tier in (back,front)`.
pub(crate) fn selector(selector: &Value) -> Option<String> {
    let mut parts: Vec<(String, String)> = Vec::new();
    for (key, value) in selector["matchLabels"].as_object().into_iter().flatten() {
        parts.push((
            key.clone(),
            format!("{key}={}", value.as_str().unwrap_or_default()),
        ));
    }
    for expression in selector["matchExpressions"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let key = expression["key"].as_str().unwrap_or_default();
        let mut values: Vec<&str> = expression["values"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        values.sort_unstable();
        let values = values.join(",");
        let shown = match expression["operator"].as_str().unwrap_or_default() {
            "In" => format!("{key} in ({values})"),
            "NotIn" => format!("{key} notin ({values})"),
            "Exists" => key.to_owned(),
            "DoesNotExist" => format!("!{key}"),
            other => format!("{key} {other} ({values})"),
        };
        parts.push((key.to_owned(), shown));
    }
    parts.sort_by(|a, b| a.0.cmp(&b.0));
    (!parts.is_empty()).then(|| {
        parts
            .into_iter()
            .map(|(_, shown)| shown)
            .collect::<Vec<_>>()
            .join(",")
    })
}
