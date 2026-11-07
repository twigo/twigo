//! Sort keys (ARCHITECTURE 3.4): the formats the server prints are parsed,
//! so that `2/3` sorts as two thirds, `3 (5m ago)` as three restarts and
//! then five minutes, and `1h5m` as 3,900 seconds; other text sorts
//! naturally. `packages/protocol/src/mock/query.ts` sorts alike, as the
//! shared query cases check.

use std::cmp::Ordering;

use jiff::Timestamp;

use crate::table::Cell;

/// Variants order first: empty cells, numbers, ratios, then text.
#[derive(Debug, Clone, PartialEq)]
pub enum SortKey {
    Null,
    /// Numbers, booleans, plain counts, durations in seconds, and the
    /// negated creation time of Age columns, so the youngest come first.
    /// `then` breaks ties: the duration of a count such as `3 (5m ago)`.
    Number {
        value: f64,
        then: Option<f64>,
    },
    /// `ready/total`, by its fraction, then its total; `0/0` counts as
    /// whole.
    Ratio {
        ready: f64,
        total: f64,
    },
    Text(Box<str>),
}

impl SortKey {
    pub fn of(cell: &Cell, created: Option<Timestamp>) -> Self {
        match cell {
            Cell::Null => SortKey::Null,
            Cell::Bool(value) => number(f64::from(u8::from(*value))),
            Cell::Int(value) => number(*value as f64),
            Cell::Number(value) => number(*value),
            Cell::Text(text) => Self::text(text),
            Cell::Age => match created {
                Some(created) => number(-(created.as_millisecond() as f64)),
                None => SortKey::Null,
            },
        }
    }

    pub fn text(text: &str) -> Self {
        if let Some(value) = count(text) {
            return number(value);
        }
        if let Some(seconds) = duration(text) {
            return number(seconds);
        }
        if let Some((count, ago)) = text
            .strip_suffix(" ago)")
            .and_then(|rest| rest.split_once(" ("))
            && let (Some(count), Some(ago)) = (self::count(count), duration(ago))
        {
            return SortKey::Number {
                value: count,
                then: Some(ago),
            };
        }
        if let Some((ready, total)) = text.split_once('/')
            && let (Some(ready), Some(total)) = (count(ready), count(total))
        {
            return SortKey::Ratio { ready, total };
        }
        SortKey::Text(text.into())
    }

    fn rank(&self) -> u8 {
        match self {
            SortKey::Null => 0,
            SortKey::Number { .. } => 1,
            SortKey::Ratio { .. } => 2,
            SortKey::Text(_) => 3,
        }
    }
}

impl Eq for SortKey {}

impl PartialOrd for SortKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SortKey {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (
                SortKey::Number { value, then },
                SortKey::Number {
                    value: other_value,
                    then: other_then,
                },
            ) => value
                .total_cmp(other_value)
                .then_with(|| match (then, other_then) {
                    (Some(then), Some(other)) => then.total_cmp(other),
                    (then, other) => then.is_some().cmp(&other.is_some()),
                }),
            (
                SortKey::Ratio { ready, total },
                SortKey::Ratio {
                    ready: other_ready,
                    total: other_total,
                },
            ) => fraction(*ready, *total)
                .total_cmp(&fraction(*other_ready, *other_total))
                .then_with(|| total.total_cmp(other_total))
                .then_with(|| ready.total_cmp(other_ready)),
            (SortKey::Text(text), SortKey::Text(other)) => natural(text, other),
            _ => self.rank().cmp(&other.rank()),
        }
    }
}

/// Without negative zero, which `total_cmp` puts before zero.
fn number(value: f64) -> SortKey {
    SortKey::Number {
        value: value + 0.0,
        then: None,
    }
}

fn fraction(ready: f64, total: f64) -> f64 {
    if total == 0.0 { 1.0 } else { ready / total }
}

/// ASCII digits only, as a count.
fn count(text: &str) -> Option<f64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// A duration as Kubernetes prints one, `2y10d`, `5h3m`, `45s`: each unit
/// at most once, largest first.
fn duration(text: &str) -> Option<f64> {
    const UNITS: [(u8, f64); 5] = [
        (b'y', 365.0 * 86_400.0),
        (b'd', 86_400.0),
        (b'h', 3_600.0),
        (b'm', 60.0),
        (b's', 1.0),
    ];
    let mut rest = text.as_bytes();
    let mut units = UNITS.iter();
    let mut seconds = 0.0;
    if rest.is_empty() {
        return None;
    }
    while !rest.is_empty() {
        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        let (number, after) = rest.split_at(digits);
        let (&unit, after) = after.split_first()?;
        if number.is_empty() {
            return None;
        }
        let (_, scale) = units.find(|(name, _)| *name == unit)?;
        let number: f64 = std::str::from_utf8(number).ok()?.parse().ok()?;
        seconds += number * scale;
        rest = after;
    }
    Some(seconds)
}

/// Text in natural order: runs of ASCII digits compare by their value,
/// other characters one by one with ASCII letters folded to lower case,
/// and a tie by the characters themselves.
pub fn natural(a: &str, b: &str) -> Ordering {
    // UTF-8 bytes order as their characters do, and only ASCII bytes are
    // digits or fold.
    let (mut x, mut y) = (a.as_bytes(), b.as_bytes());
    loop {
        let (c, d) = match (x.first(), y.first()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(&c), Some(&d)) => (c, d),
        };
        if c.is_ascii_digit() && d.is_ascii_digit() {
            let (left, rest_x) = digit_run(x);
            let (right, rest_y) = digit_run(y);
            let order = left.len().cmp(&right.len()).then_with(|| left.cmp(right));
            if order != Ordering::Equal {
                return order;
            }
            (x, y) = (rest_x, rest_y);
            continue;
        }
        let order = c.to_ascii_lowercase().cmp(&d.to_ascii_lowercase());
        if order != Ordering::Equal {
            return order;
        }
        (x, y) = (&x[1..], &y[1..]);
    }
}

/// The digits `text` starts with, without leading zeros, and what follows.
fn digit_run(text: &[u8]) -> (&[u8], &[u8]) {
    let end = text
        .iter()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(text.len());
    let zeros = text[..end].iter().take_while(|&&b| b == b'0').count();
    (&text[zeros..end], &text[end..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(texts: &[&str]) -> Vec<String> {
        let mut keys: Vec<(SortKey, &str)> = texts.iter().map(|t| (SortKey::text(t), *t)).collect();
        keys.sort_by(|a, b| a.0.cmp(&b.0));
        keys.into_iter().map(|(_, text)| text.to_owned()).collect()
    }

    #[test]
    fn ratios_sort_by_their_fraction_then_their_total() {
        assert_eq!(
            sorted(&["1/1", "2/2", "0/1", "1/3", "1/2", "0/0", "0/3"]),
            ["0/1", "0/3", "1/3", "1/2", "0/0", "1/1", "2/2"]
        );
    }

    #[test]
    fn counts_sort_by_their_value_then_how_long_ago() {
        assert_eq!(
            sorted(&["12", "3 (5m ago)", "3 (1h ago)", "3", "0"]),
            ["0", "3", "3 (5m ago)", "3 (1h ago)", "12"]
        );
    }

    #[test]
    fn durations_sort_by_their_seconds() {
        assert_eq!(
            sorted(&["2d", "5m", "1h5m", "45s", "1y", "90s"]),
            ["45s", "90s", "5m", "1h5m", "2d", "1y"]
        );
        assert_eq!(duration("5m1h"), None, "units in order only");
        assert_eq!(duration("5mm"), None);
        assert_eq!(duration("m"), None);
        assert_eq!(duration("5"), None);
    }

    #[test]
    fn text_sorts_naturally_after_numbers_and_ratios() {
        assert_eq!(
            sorted(&["web-10", "web-9", "Web-9", "<none>", "1/2", "7", "web-09"]),
            ["7", "1/2", "<none>", "Web-9", "web-09", "web-9", "web-10"]
        );
    }

    #[test]
    fn empty_cells_come_first_and_age_puts_the_youngest_first() {
        let old: Timestamp = "2026-11-01T10:00:00Z".parse().unwrap();
        let young: Timestamp = "2026-11-02T10:00:00Z".parse().unwrap();
        let mut keys = [
            SortKey::of(&Cell::Age, Some(old)),
            SortKey::of(&Cell::Null, None),
            SortKey::of(&Cell::Age, Some(young)),
            SortKey::of(&Cell::Age, None),
        ];
        keys.sort();
        assert_eq!(
            keys,
            [
                SortKey::Null,
                SortKey::Null,
                SortKey::of(&Cell::Age, Some(young)),
                SortKey::of(&Cell::Age, Some(old)),
            ]
        );
    }

    #[test]
    fn natural_order_is_total() {
        assert_eq!(natural("a01", "a1"), Ordering::Less);
        assert_eq!(natural("a1", "a01"), Ordering::Greater);
        assert_eq!(natural("A", "a"), Ordering::Less);
        assert_eq!(natural("a", "a"), Ordering::Equal);
        assert_eq!(
            natural("x99999999999999999999999", "x100000000000000000000000"),
            Ordering::Less,
            "digit runs of any length"
        );
        assert_eq!(natural("a10", "a010"), Ordering::Greater, "a tie in value");
        assert_eq!(natural("Z", "é"), Ordering::Less, "ASCII before the rest");
        assert_eq!(natural("é", "è"), Ordering::Greater, "by code point");
        assert_eq!(natural("é1", "é01"), Ordering::Greater, "digits after é");
        assert_eq!(natural("Éa", "éa"), Ordering::Less, "only ASCII folds");
        assert_eq!(natural("𝟙", "2"), Ordering::Greater, "only ASCII digits");
    }
}
