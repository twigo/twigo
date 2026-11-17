//! The text the API server prints in a cell: a count, and a duration as
//! Kubernetes prints one (`2y10d`, `5h3m`, `45s`), alone or in a pod's
//! `3 (5m ago)`.

/// ASCII digits only, as a count.
pub fn count(text: &str) -> Option<f64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// A duration as Kubernetes prints one: each unit at most once, largest
/// first, in seconds.
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

/// A duration the server printed: `5m`, or a pod's `3 (5m ago)` with the
/// count of restarts before it.
#[derive(Debug, PartialEq)]
pub struct Printed<'a> {
    pub count: Option<&'a str>,
    /// How long ago, in seconds, as of the moment the server printed it.
    pub ago: f64,
}

impl<'a> Printed<'a> {
    pub fn parse(text: &'a str) -> Option<Self> {
        if let Some(ago) = duration(text) {
            return Some(Self { count: None, ago });
        }
        let (count, ago) = text.strip_suffix(" ago)")?.split_once(" (")?;
        self::count(count)?;
        Some(Self {
            count: Some(count),
            ago: duration(ago)?,
        })
    }
}

/// What the text filter reads of a cell that prints a duration: its count,
/// nothing of a bare duration, since the age on screen is not the printed
/// one; text that is no duration as it is.
pub fn filtered(text: &str) -> &str {
    match Printed::parse(text) {
        Some(printed) => printed.count.unwrap_or_default(),
        None => text,
    }
}

/// How much longer than its step one moment may print the same age, in
/// milliseconds. The server prints an age down to two seconds below zero
/// as `0s`, for clocks out of step
/// (<https://github.com/kubernetes/apimachinery/blob/v0.37.2/pkg/util/duration/duration.go#L49-L54>),
/// and a row is stamped when its response arrives, after it was printed.
const TOLERANCE_MS: f64 = 2_000.0;

/// The step `HumanDuration` prints an age of `ago` seconds in, so the age
/// lies from `ago` to before `ago` plus the step: seconds below ten
/// minutes, minutes below eight hours, hours below eight days, days below
/// eight years, then years
/// (<https://github.com/kubernetes/apimachinery/blob/v0.37.2/pkg/util/duration/duration.go#L48-L93>).
fn step(ago: f64) -> f64 {
    const MINUTE: f64 = 60.0;
    const HOUR: f64 = 60.0 * MINUTE;
    const DAY: f64 = 24.0 * HOUR;
    const YEAR: f64 = 365.0 * DAY;
    if ago < 10.0 * MINUTE {
        1.0
    } else if ago < 8.0 * HOUR {
        MINUTE
    } else if ago < 8.0 * DAY {
        HOUR
    } else if ago < 8.0 * YEAR {
        DAY
    } else {
        YEAR
    }
}

/// Whether `held_at`, when `held` was printed, still dates `printed`,
/// printed at `at`. The webview counts a printed age back from the stamp,
/// so `printed` must read the age `held` read, and less than that age's
/// step may have passed, give or take the tolerance: one moment prints the
/// same age no longer, so the moment moved, as a repeated event's `0s`.
/// An age that reads otherwise is dated by its own print. Text that is no
/// duration is drawn as printed: as `printed` it needs no stamp, and as
/// `held` it dated nothing. Times are Unix milliseconds.
pub fn keeps_stamp(held: Option<&str>, held_at: i64, printed: Option<&str>, at: i64) -> bool {
    let Some(printed) = printed.and_then(Printed::parse) else {
        return true;
    };
    let Some(held) = held.and_then(Printed::parse) else {
        return false;
    };
    let passed = (at - held_at) as f64;
    held.ago == printed.ago
        && -TOLERANCE_MS <= passed
        && passed < step(printed.ago) * 1000.0 + TOLERANCE_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_duration_has_each_unit_once_largest_first() {
        assert_eq!(duration("1h5m"), Some(3_900.0));
        assert_eq!(duration("2y10d"), Some(2.0 * 365.0 * 86_400.0 + 864_000.0));
        assert_eq!(duration("5m1h"), None, "units in order only");
        assert_eq!(duration("5mm"), None);
        assert_eq!(duration("m"), None);
        assert_eq!(duration("5"), None);
        assert_eq!(duration(""), None);
    }

    #[test]
    fn a_printed_duration_is_alone_or_after_a_count() {
        assert_eq!(
            Printed::parse("5m"),
            Some(Printed {
                count: None,
                ago: 300.0
            })
        );
        assert_eq!(
            Printed::parse("12 (1h5m ago)"),
            Some(Printed {
                count: Some("12"),
                ago: 3_900.0
            })
        );
        for text in [
            "3",
            "<none>",
            "<unknown>",
            "3 (soon ago)",
            "x (5m ago)",
            "3 (5m)",
        ] {
            assert_eq!(Printed::parse(text), None, "{text}");
        }
    }

    #[test]
    fn the_filter_reads_the_count_and_never_the_age() {
        assert_eq!(filtered("12 (1h5m ago)"), "12");
        assert_eq!(filtered("5m"), "");
        assert_eq!(filtered("3"), "3");
        assert_eq!(filtered("<none>"), "<none>");
    }

    #[derive(serde::Deserialize)]
    struct Cases {
        cases: Vec<Case>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        held: Option<String>,
        held_at: i64,
        printed: Option<String>,
        at: i64,
        keeps: bool,
    }

    #[test]
    fn a_stamp_dates_a_print_as_the_shared_cases_say() {
        let cases: Cases = serde_json::from_str(include_str!(
            "../../../packages/protocol/src/printed-cases.json"
        ))
        .unwrap();
        let wrong: Vec<&str> = cases
            .cases
            .iter()
            .filter(|case| {
                keeps_stamp(
                    case.held.as_deref(),
                    case.held_at,
                    case.printed.as_deref(),
                    case.at,
                ) != case.keeps
            })
            .map(|case| case.name.as_str())
            .collect();
        assert_eq!(wrong, Vec::<&str>::new());
    }
}
