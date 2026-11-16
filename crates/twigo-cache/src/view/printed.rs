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
}
