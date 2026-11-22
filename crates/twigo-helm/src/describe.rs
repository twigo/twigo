//! A revision described for people, as an object's page is
//! (ARCHITECTURE 4.3): a header whose word is its row's status and whose
//! sentence says what is wrong, the vitals, then sections that each say a
//! fact once. Its description is not among them: it is secret-grade, and
//! goes scrubbed beside the overview.

use twigo_ipc::{
    Block, Field, Finding, Fold, Header, Label, ObjectRef, Overview, Printed, RevisionLine,
    Scrubbed, Section, Span, Tone, Value, Vital,
};

use crate::{Page, Status, Summary};

/// What the caller knows of the release beyond the revision it shows.
pub struct Release<'a> {
    /// The cells of the release's row, Updated left out as an age.
    pub printed: &'a [Printed],
    /// The highest revision Helm keeps whose status is `deployed`.
    pub deployed: Option<u32>,
}

/// What a vital without a value shows.
const NONE: &str = "–";

/// The revision's overview.
pub fn overview(page: &Page, release: &Release<'_>) -> Overview {
    let summary = page.summary();
    let findings = findings(summary, release.deployed);
    let mut sections = Vec::new();
    if !findings.is_empty() {
        sections.push(Section {
            tone: findings.first().map(|finding| finding.tone),
            fold: Fold::Open,
            ..section(
                "helm.diagnostics",
                "Diagnostics",
                vec![Block::Diagnostics {
                    findings: findings.clone(),
                }],
            )
        });
    }
    sections.extend(objects(page));
    sections.extend(hooks(page));
    sections.push(chart(page));
    sections.push(metadata(page));
    Overview {
        header: Header {
            owner: None,
            node: None,
            created: summary.last_deployed().map(|at| at.to_string()),
            generated: None,
            printed: release.printed.to_vec(),
            sentence: findings
                .first()
                .map(|finding| text(&finding.title))
                .unwrap_or_default(),
            vitals: vitals(summary, release.deployed),
        },
        sections,
    }
}

/// A revision as `helm history` prints it, its description scrubbed.
pub fn line(summary: &Summary, description: Option<Scrubbed>) -> RevisionLine {
    RevisionLine {
        revision: summary.revision(),
        status: summary.status().word().to_owned(),
        updated: summary.last_deployed().map(|at| at.to_string()),
        chart: summary.chart(),
        app_version: summary.app_version().map(str::to_owned),
        description,
        rollback_of: summary.rollback_revision(),
        problem: None,
    }
}

fn findings(summary: &Summary, deployed: Option<u32>) -> Vec<Finding> {
    let revision = summary.revision();
    let finding = |tone, title: String, detail: Vec<Span>| Finding {
        tone,
        title,
        detail,
        message: None,
        logs: None,
    };
    let status = summary.status();
    if let Some(operation) = status.pending() {
        let mut detail = Vec::new();
        if let Some(at) = summary.last_deployed() {
            detail.push(Span::Text {
                text: "It started ".to_owned(),
            });
            detail.push(Span::Ago { at: at.to_string() });
            detail.push(Span::Text {
                text: ". ".to_owned(),
            });
        }
        detail.push(Span::Text {
            text: "Helm refuses to upgrade the release until it ends.".to_owned(),
        });
        return vec![finding(
            Tone::Warning,
            format!("The {operation} of revision {revision} has not ended"),
            detail,
        )];
    }
    match status {
        Status::Failed => vec![finding(
            Tone::Danger,
            format!("Revision {revision} failed"),
            text(&match deployed {
                Some(deployed) if deployed != revision => {
                    format!("Revision {deployed} is deployed.")
                }
                _ => "No revision is deployed.".to_owned(),
            }),
        )],
        Status::Uninstalling => vec![finding(
            Tone::Warning,
            "The uninstall has not ended".to_owned(),
            text(
                "Helm marks a release so before it deletes its objects, and the mark stays where the deletion failed.",
            ),
        )],
        _ => Vec::new(),
    }
}

fn vitals(summary: &Summary, deployed: Option<u32>) -> Vec<Vital> {
    let plain = |text: Option<&str>| Value::Text {
        text: text
            .filter(|text| !text.is_empty())
            .unwrap_or(NONE)
            .to_owned(),
    };
    let revision = summary.revision();
    vec![
        Vital {
            label: "Revision".to_owned(),
            value: plain(Some(&revision.to_string())),
            note: match deployed {
                Some(deployed) if deployed != revision => text(&format!("r{deployed} deployed")),
                _ => Vec::new(),
            },
        },
        Vital {
            label: "Chart version".to_owned(),
            value: plain(summary.chart_version()),
            note: Vec::new(),
        },
        Vital {
            label: "App version".to_owned(),
            value: plain(summary.app_version()),
            note: Vec::new(),
        },
    ]
}

/// What the manifest makes, each a link to its object.
fn objects(page: &Page) -> Option<Section> {
    if page.objects.is_empty() {
        return None;
    }
    let target = page.summary().namespace();
    let rows = page
        .objects
        .iter()
        .map(|head| {
            let (group, version) = head
                .api_version
                .split_once('/')
                .unwrap_or(("", &head.api_version));
            vec![
                Value::Text {
                    text: head.kind.clone(),
                },
                Value::Link {
                    target: ObjectRef {
                        group: group.to_owned(),
                        version: version.to_owned(),
                        kind: head.kind.clone(),
                        namespace: Some(head.namespace.as_deref().unwrap_or(target).to_owned()),
                        name: head.name.clone(),
                    },
                    text: head.name.clone(),
                },
                Value::Text {
                    text: head.namespace.clone().unwrap_or_default(),
                },
            ]
        })
        .collect();
    Some(Section {
        summary: text(&counted(page.objects.len(), "object")),
        fold: Fold::Open,
        ..section(
            "helm.objects",
            "Objects",
            vec![Block::Table {
                columns: vec!["Kind".to_owned(), "Name".to_owned(), "Namespace".to_owned()],
                rows,
            }],
        )
    })
}

fn hooks(page: &Page) -> Option<Section> {
    if page.hooks.is_empty() {
        return None;
    }
    let failed = page
        .hooks
        .iter()
        .filter(|hook| hook.phase == "Failed")
        .count();
    let rows = page
        .hooks
        .iter()
        .map(|hook| {
            let plain = |text: String| Value::Text { text };
            vec![
                plain(hook.name.clone()),
                plain(hook.kind.clone()),
                plain(hook.events.join(", ")),
                plain(hook.weight.to_string()),
                match hook.phase.as_str() {
                    "" => plain("Not run".to_owned()),
                    "Failed" => Value::Toned {
                        text: hook.phase.clone(),
                        tone: Tone::Danger,
                    },
                    phase => plain(phase.to_owned()),
                },
            ]
        })
        .collect();
    let mut summary = counted(page.hooks.len(), "hook");
    if failed > 0 {
        summary.push_str(&format!(" · {failed} failed"));
    }
    Some(Section {
        summary: text(&summary),
        tone: (failed > 0).then_some(Tone::Danger),
        fold: if failed > 0 {
            Fold::Finding
        } else {
            Fold::Folded
        },
        ..section(
            "helm.hooks",
            "Hooks",
            vec![Block::Table {
                columns: ["Name", "Kind", "Events", "Weight", "Last run"]
                    .map(str::to_owned)
                    .to_vec(),
                rows,
            }],
        )
    })
}

/// The chart, but for its versions, which the vitals hold.
fn chart(page: &Page) -> Section {
    let chart = &page.chart;
    let mut fields = Vec::new();
    let mut add = |label: &str, value: Value| {
        fields.push(Field {
            label: label.to_owned(),
            value,
            default: false,
        });
    };
    for (label, text) in [
        ("Name", &chart.name),
        ("Description", &chart.description),
        ("Home", &chart.home),
        ("Kubernetes", &chart.kube_version),
    ] {
        if !text.is_empty() {
            add(label, Value::Text { text: text.clone() });
        }
    }
    if !chart.sources.is_empty() {
        add(
            "Sources",
            Value::List {
                items: chart
                    .sources
                    .iter()
                    .map(|source| Value::Text {
                        text: source.clone(),
                    })
                    .collect(),
            },
        );
    }
    if chart.deprecated {
        add(
            "Deprecated",
            Value::Toned {
                text: "Its authors deprecated it".to_owned(),
                tone: Tone::Warning,
            },
        );
    }
    Section {
        summary: match (chart.deprecated, chart.name.as_str()) {
            (true, _) => text("deprecated"),
            (false, "") => Vec::new(),
            (false, name) => text(name),
        },
        tone: chart.deprecated.then_some(Tone::Warning),
        fold: if chart.deprecated {
            Fold::Finding
        } else {
            Fold::Folded
        },
        ..section("helm.chart", "Chart", vec![Block::Fields { fields }])
    }
}

fn metadata(page: &Page) -> Section {
    let summary = page.summary();
    let stored = &page.stored_in;
    let mut fields = Vec::new();
    let mut add = |label: &str, value: Value| {
        fields.push(Field {
            label: label.to_owned(),
            value,
            default: false,
        });
    };
    for (label, at) in [
        ("First deployed", summary.first_deployed()),
        ("Last deployed", summary.last_deployed()),
    ] {
        if let Some(at) = at {
            add(label, Value::Time { at: at.to_string() });
        }
    }
    if !summary.namespace().is_empty() && summary.namespace() != stored.namespace {
        add(
            "Target namespace",
            Value::Link {
                target: ObjectRef {
                    group: String::new(),
                    version: "v1".to_owned(),
                    kind: "Namespace".to_owned(),
                    namespace: None,
                    name: summary.namespace().to_owned(),
                },
                text: summary.namespace().to_owned(),
            },
        );
    }
    add(
        "Apply method",
        Value::Text {
            text: match page.apply_method.as_deref() {
                Some("ssa") => "Server-side apply",
                _ => "Client-side apply",
            }
            .to_owned(),
        },
    );
    if !stored.labels.is_empty() {
        add(
            "Labels",
            Value::Labels {
                labels: stored
                    .labels
                    .iter()
                    .map(|(key, value)| Label {
                        key: key.clone(),
                        value: value.clone(),
                    })
                    .collect(),
            },
        );
    }
    add(
        "Stored in",
        Value::Link {
            target: ObjectRef {
                group: String::new(),
                version: "v1".to_owned(),
                kind: "Secret".to_owned(),
                namespace: Some(stored.namespace.clone()),
                name: stored.name.clone(),
            },
            text: stored.name.clone(),
        },
    );
    section("helm.metadata", "Metadata", vec![Block::Fields { fields }])
}

/// A section folded, with no line at its end and no tone.
fn section(id: &str, title: &str, blocks: Vec<Block>) -> Section {
    Section {
        id: id.to_owned(),
        title: title.to_owned(),
        summary: Vec::new(),
        tone: None,
        fold: Fold::Folded,
        blocks,
    }
}

fn text(text: &str) -> Vec<Span> {
    vec![Span::Text {
        text: text.to_owned(),
    }]
}

fn counted(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}
