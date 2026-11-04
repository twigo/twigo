//! The log cases the mock runs too (`packages/protocol/src/log-cases.json`),
//! through Rust's line reader and logs view.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use twigo_ipc::{ErrorKind, Level, LogAround, LogEntry, LogView, LogWindow, ObjectRef, TextRange};
use twigo_sessions::logs::buffer::{Buffer, Dropped, Kind, LIMITS, Limits, Origin};
use twigo_sessions::logs::view::{self, BUCKETS, Spec, rfc3339};
use twigo_sessions::logs::{level, line};

const CASES: &str = include_str!("../../../packages/protocol/src/log-cases.json");

#[derive(Deserialize)]
struct Cases {
    lines: Vec<LineCase>,
    views: Vec<ViewCase>,
}

#[derive(Deserialize)]
struct LineCase {
    name: String,
    raw: String,
    expect: Value,
}

#[derive(Deserialize)]
struct ViewCase {
    name: String,
    limits: Option<CaseLimits>,
    entries: Vec<CaseEntry>,
    view: LogView,
    window: LogWindow,
    expect: Expect,
}

#[derive(Deserialize)]
struct CaseLimits {
    entries: usize,
    bytes: usize,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum CaseEntry {
    Line {
        pod: String,
        container: String,
        time: String,
        level: Option<Level>,
        text: String,
    },
    Ended {
        pod: String,
        container: String,
        time: String,
        exit_code: Option<i32>,
        reason: Option<String>,
        restarting: Option<String>,
    },
    Joined {
        pod: String,
        time: String,
        #[serde(default)]
        owner: Option<ObjectRef>,
    },
    Left {
        pod: String,
        time: String,
    },
}

#[derive(Deserialize)]
struct Expect {
    refused: Option<ErrorKind>,
    total: Option<u32>,
    window: Option<ExpectWindow>,
    #[serde(default)]
    marks: BTreeMap<u64, Vec<TextRange>>,
    matches: Option<Value>,
    histogram: Option<ExpectHistogram>,
    dropped: Option<ExpectDropped>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct ExpectWindow {
    start: u32,
    ids: Vec<u64>,
    #[serde(default)]
    around: Option<LogAround>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct ExpectHistogram {
    from: String,
    to: String,
    counts: BTreeMap<usize, [u32; 3]>,
}

#[derive(Deserialize)]
struct ExpectDropped {
    id: u64,
    count: u64,
}

fn at(time: &str) -> i64 {
    let parsed: jiff::Timestamp = time.parse().unwrap();
    i64::try_from(parsed.as_nanosecond()).unwrap()
}

fn origin(pod: String, container: String) -> Arc<Origin> {
    Arc::new(Origin {
        pod: pod.into(),
        container: container.into(),
    })
}

fn kind(entry: CaseEntry) -> (i64, Kind) {
    match entry {
        CaseEntry::Line {
            pod,
            container,
            time,
            level,
            text,
        } => (
            at(&time),
            Kind::Line {
                origin: origin(pod, container),
                level,
                text: text.into(),
                styles: Box::new([]),
            },
        ),
        CaseEntry::Ended {
            pod,
            container,
            time,
            exit_code,
            reason,
            restarting,
        } => (
            at(&time),
            Kind::Ended {
                origin: origin(pod, container),
                exit_code,
                reason: reason.map(Into::into),
                restarting: restarting.map(Into::into),
                time: time.into(),
            },
        ),
        CaseEntry::Joined { pod, time, owner } => (
            at(&time),
            Kind::Joined {
                pod: pod.into(),
                time: time.into(),
                owner: owner.map(Box::new),
            },
        ),
        CaseEntry::Left { pod, time } => (
            at(&time),
            Kind::Left {
                pod: pod.into(),
                time: time.into(),
            },
        ),
    }
}

fn id(entry: &LogEntry) -> u64 {
    match entry {
        LogEntry::Line { id, .. }
        | LogEntry::Ended { id, .. }
        | LogEntry::Joined { id, .. }
        | LogEntry::Left { id, .. }
        | LogEntry::Dropped { id, .. } => *id,
    }
}

#[test]
fn lines_read_as_the_mock_reads_them() {
    let cases: Cases = serde_json::from_str(CASES).unwrap();
    assert!(!cases.lines.is_empty());
    for case in cases.lines {
        let parsed = line::parse(case.raw.as_bytes());
        let read = serde_json::json!({
            "time": parsed.at.map(rfc3339),
            "text": parsed.text,
            "level": level::level(&parsed.text),
            "styles": parsed.styles,
        });
        assert_eq!(read, case.expect, "{}", case.name);
    }
}

#[test]
fn views_show_what_the_mock_shows() {
    let cases: Cases = serde_json::from_str(CASES).unwrap();
    assert!(!cases.views.is_empty());
    for case in cases.views {
        let name = &case.name;
        let spec = match Spec::new(&case.view) {
            Ok(spec) => spec,
            Err(error) => {
                assert_eq!(Some(error.kind), case.expect.refused, "{name}: {error:?}");
                continue;
            }
        };
        assert_eq!(case.expect.refused, None, "{name}: not refused");
        let limits = case.limits.map_or(LIMITS, |limits| Limits {
            entries: limits.entries,
            bytes: limits.bytes,
        });
        let mut buffer = Buffer::new(limits);
        let entries = case.entries.into_iter().map(kind).collect();
        buffer.insert(entries, |_, kind| spec.judge(kind));
        buffer.bound(&[]);

        assert_eq!(
            Some(view::total(&buffer, &spec)),
            case.expect.total,
            "{name}"
        );
        let window = view::window(&buffer, &spec, case.window);
        let shown = ExpectWindow {
            start: window.start,
            ids: window.entries.iter().map(id).collect(),
            around: window.around,
        };
        assert_eq!(Some(shown), case.expect.window, "{name}");
        for entry in &window.entries {
            if let LogEntry::Line { id, marks, .. } = entry {
                let expected = case.expect.marks.get(id).cloned().unwrap_or_default();
                assert_eq!(marks, &expected, "{name}: the marks of {id}");
            }
        }
        if let Some(matches) = case.expect.matches {
            let found = serde_json::to_value(view::matches(&buffer, &spec)).unwrap();
            assert_eq!(found, matches, "{name}");
        }
        if let Some(expected) = case.expect.histogram {
            let histogram = view::histogram(&buffer);
            let length = if expected.from.is_empty() { 0 } else { BUCKETS };
            assert_eq!(histogram.buckets.len(), length, "{name}");
            let counts = histogram
                .buckets
                .iter()
                .enumerate()
                .filter(|(_, bucket)| bucket.lines > 0)
                .map(|(index, bucket)| (index, [bucket.lines, bucket.warnings, bucket.errors]))
                .collect();
            let shown = ExpectHistogram {
                from: histogram.from,
                to: histogram.to,
                counts,
            };
            assert_eq!(shown, expected, "{name}");
        }
        let dropped = case.expect.dropped.map(|dropped| Dropped {
            id: dropped.id,
            count: dropped.count,
        });
        assert_eq!(buffer.dropped(), dropped, "{name}");
    }
}
