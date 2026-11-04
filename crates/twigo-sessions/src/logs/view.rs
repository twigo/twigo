//! A session's view of its buffer: the entries its level, filter and range
//! keep, the level and the filter keeping every marker, and the `Dropped`
//! entry first; the search's matches, the histogram of its lines, and the
//! window the webview reads.

use std::collections::VecDeque;

use aho_corasick::AhoCorasick;
use regex::{Regex, RegexBuilder};
use twigo_cache::view::TextFilter;
use twigo_ipc::{
    Bucket, ErrorKind, Histogram, IpcError, Level, LevelFilter, LogAround, LogEntries, LogEntry,
    LogMatches, LogView, LogWindow, TextRange,
};

use crate::logs::buffer::{Buffer, Entry, Judged, Kind};

/// The matches whose entries a batch lists.
pub const MATCHES: usize = 10_000;
/// The histogram's spans.
pub const BUCKETS: usize = 60;

/// A view, checked once: its filter's and search's regexes parse, and its
/// range's times.
#[derive(Debug, Clone)]
pub struct Spec {
    level: LevelFilter,
    filter: Option<TextFilter>,
    search: Option<Search>,
    /// Nanoseconds since the Unix epoch, `to` exclusive.
    range: Option<(i64, i64)>,
}

impl Spec {
    pub fn new(view: &LogView) -> Result<Self, IpcError> {
        let filter = match &view.filter {
            Some(text) => TextFilter::parse(text)?,
            None => None,
        };
        let search = match &view.search {
            Some(text) => Search::parse(text)?,
            None => None,
        };
        let range = match &view.range {
            Some(range) => Some((time(&range.from)?, time(&range.to)?)),
            None => None,
        };
        Ok(Self {
            level: view.level,
            filter,
            search,
            range,
        })
    }

    /// What it makes of an entry, its range aside; markers pass.
    pub fn judge(&self, kind: &Kind) -> Judged {
        let Kind::Line { level, text, .. } = kind else {
            return Judged {
                passes: true,
                hits: 0,
            };
        };
        let level = match self.level {
            LevelFilter::All => true,
            LevelFilter::Warn => matches!(level, Some(Level::Warn | Level::Error)),
            LevelFilter::Error => *level == Some(Level::Error),
        };
        let passes = level
            && self
                .filter
                .as_ref()
                .is_none_or(|filter| filter.keeps([text]));
        let hits = match &self.search {
            Some(search) if passes => u32::try_from(search.find(text).count()).unwrap_or(u32::MAX),
            _ => 0,
        };
        Judged { passes, hits }
    }

    /// Whether it keeps an entry at `at` it judged so.
    pub fn keeps(&self, at: i64, judged: Judged) -> bool {
        judged.passes && self.range.is_none_or(|(from, to)| (from..to).contains(&at))
    }
}

fn time(text: &str) -> Result<i64, IpcError> {
    let invalid = || IpcError {
        kind: ErrorKind::InvalidInput,
        message: format!("{text:?} is no RFC 3339 time"),
    };
    let parsed: jiff::Timestamp = text.parse().map_err(|_| invalid())?;
    i64::try_from(parsed.as_nanosecond()).map_err(|_| invalid())
}

/// The search: a substring in any case of ASCII letters, or a regex
/// between slashes, also in any case, as the filter reads them without its
/// negation.
#[derive(Debug, Clone)]
enum Search {
    Substring(AhoCorasick),
    Regex(Regex),
}

impl Search {
    fn parse(text: &str) -> Result<Option<Self>, IpcError> {
        let text = text.trim_ascii();
        let pattern = text
            .strip_prefix('/')
            .and_then(|inner| inner.strip_suffix('/'));
        let search = match pattern {
            Some(pattern) => Search::Regex(
                RegexBuilder::new(pattern)
                    .case_insensitive(true)
                    .build()
                    .map_err(|error| IpcError {
                        kind: ErrorKind::InvalidInput,
                        message: format!("the search /{pattern}/ is no regex: {error}"),
                    })?,
            ),
            None if text.is_empty() => return Ok(None),
            None => Search::Substring(
                AhoCorasick::builder()
                    .ascii_case_insensitive(true)
                    .build([text])
                    .map_err(|error| IpcError {
                        kind: ErrorKind::InvalidInput,
                        message: format!("the search {text:?} cannot be built: {error}"),
                    })?,
            ),
        };
        Ok(Some(search))
    }

    /// Its matches in `text`, as byte ranges; an empty one marks nothing.
    fn find<'a>(&'a self, text: &'a str) -> Box<dyn Iterator<Item = (usize, usize)> + 'a> {
        match self {
            Search::Substring(substring) => Box::new(
                substring
                    .find_iter(text)
                    .map(|found| (found.start(), found.end())),
            ),
            Search::Regex(regex) => Box::new(
                regex
                    .find_iter(text)
                    .filter(|found| !found.is_empty())
                    .map(|found| (found.start(), found.end())),
            ),
        }
    }
}

/// One of the view's entries: the `Dropped` entry, or one of the buffer's.
#[derive(Clone, Copy)]
enum Shown<'a> {
    Dropped { id: u64, count: u64 },
    Entry(&'a Entry),
}

/// The view's entries in order.
fn shown<'a>(buffer: &'a Buffer, spec: &'a Spec) -> impl Iterator<Item = Shown<'a>> + 'a {
    let dropped = buffer.dropped().map(|dropped| Shown::Dropped {
        id: dropped.id,
        count: dropped.count,
    });
    dropped.into_iter().chain(
        buffer
            .entries()
            .iter()
            .filter(|entry| spec.keeps(entry.at, entry.judged))
            .map(Shown::Entry),
    )
}

pub fn total(buffer: &Buffer, spec: &Spec) -> u32 {
    u32::try_from(shown(buffer, spec).count()).unwrap_or(u32::MAX)
}

/// The entries a window reads, with the search's marks.
pub fn window(buffer: &Buffer, spec: &Spec, window: LogWindow) -> LogEntries {
    let total = total(buffer, spec);
    let (start, end, around) = match window {
        LogWindow::Tail { count } => (total.saturating_sub(count), total, None),
        LogWindow::Range { start, end } => {
            let start = start.min(total);
            (start, end.clamp(start, total), None)
        }
        LogWindow::Around { id, before, after } => {
            let index = place(buffer, spec, id);
            (
                index.saturating_sub(before),
                index.saturating_add(after).min(total),
                Some(LogAround { id, index }),
            )
        }
    };
    let entries = shown(buffer, spec)
        .skip(start as usize)
        .take((end - start) as usize)
        .map(|shown| entry(shown, spec))
        .collect();
    LogEntries {
        start,
        entries,
        around,
    }
}

/// Where the entry with `id` stands in the view: at its index while the
/// view keeps it, else where its time, ties by id, places it, and at the
/// view's start once the buffer no longer holds it.
fn place(buffer: &Buffer, spec: &Spec, id: u64) -> u32 {
    let entries = buffer.entries();
    let Some(key) = entries.iter().find(|entry| entry.id == id).map(Entry::key) else {
        return 0;
    };
    let before = entries
        .iter()
        .take_while(|entry| entry.key() < key)
        .filter(|entry| spec.keeps(entry.at, entry.judged))
        .count();
    let dropped = usize::from(buffer.dropped().is_some());
    u32::try_from(dropped + before).unwrap_or(u32::MAX)
}

fn entry(shown: Shown<'_>, spec: &Spec) -> LogEntry {
    let entry = match shown {
        Shown::Dropped { id, count } => return LogEntry::Dropped { id, count },
        Shown::Entry(entry) => entry,
    };
    let id = entry.id;
    match &entry.kind {
        Kind::Line {
            origin,
            level,
            text,
            styles,
        } => LogEntry::Line {
            id,
            pod: origin.pod.to_string(),
            container: origin.container.to_string(),
            time: rfc3339(entry.at),
            level: *level,
            text: text.to_string(),
            styles: styles.to_vec(),
            marks: spec
                .search
                .as_ref()
                .map(|search| marks(search, text))
                .unwrap_or_default(),
        },
        Kind::Ended {
            origin,
            time,
            exit_code,
            reason,
            restarting,
        } => LogEntry::Ended {
            id,
            pod: origin.pod.to_string(),
            container: origin.container.to_string(),
            time: time.to_string(),
            exit_code: *exit_code,
            reason: reason.as_deref().map(str::to_owned),
            restarting: restarting.as_deref().map(str::to_owned),
        },
        Kind::Joined { pod, time, owner } => LogEntry::Joined {
            id,
            pod: pod.to_string(),
            time: time.to_string(),
            owner: owner.as_deref().cloned(),
        },
        Kind::Left { pod, time } => LogEntry::Left {
            id,
            pod: pod.to_string(),
            time: time.to_string(),
        },
    }
}

/// RFC 3339 with nine fractional digits, as the kubelet stamps a line.
pub fn rfc3339(at: i64) -> String {
    let time = jiff::Timestamp::from_nanosecond(i128::from(at)).expect("within jiff's range");
    format!("{time:.9}")
}

/// The search's matches in UTF-16 units, as the webview indexes text.
fn marks(search: &Search, text: &str) -> Vec<TextRange> {
    let mut units = Utf16::new(text);
    search
        .find(text)
        .map(|(start, end)| TextRange {
            start: units.at(start),
            end: units.at(end),
        })
        .collect()
}

/// Turns increasing byte offsets of a text into UTF-16 offsets.
struct Utf16<'a> {
    text: &'a str,
    byte: usize,
    unit: u32,
}

impl<'a> Utf16<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            byte: 0,
            unit: 0,
        }
    }

    fn at(&mut self, byte: usize) -> u32 {
        let units: usize = self.text[self.byte..byte]
            .chars()
            .map(char::len_utf16)
            .sum();
        self.unit += units as u32;
        self.byte = byte;
        self.unit
    }
}

/// Every match's entry by its id, in the view's order, the last
/// [`MATCHES`] of them, since a search steps back from the newest.
pub fn matches(buffer: &Buffer, spec: &Spec) -> LogMatches {
    let mut count = 0u32;
    let mut entries = VecDeque::with_capacity(MATCHES);
    for shown in shown(buffer, spec) {
        let Shown::Entry(entry) = shown else {
            continue;
        };
        let hits = entry.judged.hits;
        count = count.saturating_add(hits);
        for _ in 0..(hits as usize).min(MATCHES) {
            if entries.len() == MATCHES {
                entries.pop_front();
            }
            entries.push_back(entry.id);
        }
    }
    LogMatches {
        count,
        entries: entries.into(),
    }
}

/// Spans a histogram's buckets may take, in seconds: each divides a day, so
/// buckets start at whole times; past a day they double.
const SPANS: &[i64] = &[
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200,
    86_400,
];

const NANOS: i64 = 1_000_000_000;

/// The view's lines over time, its range aside: [`BUCKETS`] spans of the
/// shortest of [`SPANS`] that reach back from the span of the buffer's last
/// line to its first, so the newest lines sit at the right whatever the
/// filter keeps; no buckets, and empty times, while it holds no line.
pub fn histogram(buffer: &Buffer) -> Histogram {
    let mut lines = buffer
        .entries()
        .iter()
        .filter(|entry| matches!(entry.kind, Kind::Line { .. }))
        .map(|entry| entry.at);
    let Some(first) = lines.next() else {
        return Histogram {
            from: String::new(),
            to: String::new(),
            buckets: Vec::new(),
        };
    };
    let last = lines.next_back().unwrap_or(first);
    histogram_over(buffer, first, last)
}

fn histogram_over(buffer: &Buffer, first: i64, last: i64) -> Histogram {
    let buckets = BUCKETS as i64;
    let mut doubled = std::iter::successors(Some(2 * 86_400), |span: &i64| span.checked_mul(2));
    let span = SPANS
        .iter()
        .copied()
        .chain(&mut doubled)
        .map(|span| span * NANOS)
        .find(|span| (last.div_euclid(*span) + 1 - buckets) * span <= first)
        .expect("a span that doubles reaches any time");
    let to = (last.div_euclid(span) + 1) * span;
    let from = to - buckets * span;
    let empty = Bucket {
        lines: 0,
        warnings: 0,
        errors: 0,
    };
    let mut counts = vec![empty; BUCKETS];
    for entry in buffer.entries() {
        let Kind::Line { level, .. } = &entry.kind else {
            continue;
        };
        if !entry.judged.passes {
            continue;
        }
        let bucket = &mut counts[((entry.at - from) / span) as usize];
        bucket.lines += 1;
        match level {
            Some(Level::Warn) => bucket.warnings += 1,
            Some(Level::Error) => bucket.errors += 1,
            _ => {}
        }
    }
    let second = |at: i64| jiff::Timestamp::from_second(at / NANOS).expect("within jiff's range");
    Histogram {
        from: second(from).to_string(),
        to: second(to).to_string(),
        buckets: counts,
    }
}

/// The lines as a file: `<pod> <container> <time> <text>` each, those the
/// view keeps, or every line the buffer holds.
pub fn lines(buffer: &Buffer, spec: Option<&Spec>) -> Vec<u8> {
    let mut file = Vec::new();
    for entry in buffer.entries() {
        let Kind::Line { origin, text, .. } = &entry.kind else {
            continue;
        };
        if spec.is_some_and(|spec| !spec.keeps(entry.at, entry.judged)) {
            continue;
        }
        let line = format!(
            "{} {} {} {text}\n",
            origin.pod,
            origin.container,
            rfc3339(entry.at)
        );
        file.extend_from_slice(line.as_bytes());
    }
    file
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::logs::buffer::{LIMITS, Origin};

    #[test]
    fn a_download_holds_the_lines_the_view_keeps_or_every_line() {
        const T0: i64 = 1_793_700_000 * NANOS;
        let line = |pod: &str, text: &str| Kind::Line {
            origin: Arc::new(Origin {
                pod: pod.into(),
                container: "web".into(),
            }),
            level: None,
            text: text.into(),
            styles: Box::new([]),
        };
        let spec = Spec::new(&LogView {
            level: LevelFilter::All,
            filter: Some("GET".to_owned()),
            search: None,
            range: None,
        })
        .unwrap();
        let mut buffer = Buffer::new(LIMITS);
        buffer.insert(
            vec![
                (T0, line("web-1", "GET / 200")),
                (
                    T0 + NANOS,
                    Kind::Left {
                        pod: "web-2".into(),
                        time: "2026-11-03T10:00:01Z".into(),
                    },
                ),
                (T0 + 2 * NANOS, line("web-2", "boom")),
            ],
            |_, kind| spec.judge(kind),
        );
        let file = |spec| String::from_utf8(lines(&buffer, spec)).unwrap();
        assert_eq!(
            file(Some(&spec)),
            "web-1 web 2026-11-03T10:00:00.000000000Z GET / 200\n"
        );
        assert_eq!(
            file(None),
            "web-1 web 2026-11-03T10:00:00.000000000Z GET / 200\n\
             web-2 web 2026-11-03T10:00:02.000000000Z boom\n"
        );
    }
}
