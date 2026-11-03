//! A line's level, read from what it says rather than guessed from its
//! colours: a JSON object's level field, logfmt's `level=`, else a level
//! word where loggers print one, before the message.

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use twigo_ipc::Level;

/// The line's level, from the text without its escapes.
pub fn level(text: &str) -> Option<Level> {
    let trimmed = text.trim_start_matches(|c: char| c.is_ascii_whitespace());
    if trimmed.starts_with('{')
        && let Ok(fields) = serde_json::from_str::<Fields<'_>>(trimmed)
    {
        return fields.level();
    }
    logfmt(text).or_else(|| prefix(text))
}

/// A JSON object's level: the first of `level` (pino's numbers included),
/// `lvl`, `severity`, `levelname` and `log.level`, which ECS writes as a
/// dotted key and others as `log` holding `level`. A JSON object says its
/// level in its fields or not at all.
#[derive(Deserialize)]
struct Fields<'a> {
    #[serde(borrow)]
    level: Option<&'a RawValue>,
    #[serde(borrow)]
    lvl: Option<&'a RawValue>,
    #[serde(borrow)]
    severity: Option<&'a RawValue>,
    #[serde(borrow)]
    levelname: Option<&'a RawValue>,
    #[serde(borrow, rename = "log.level")]
    dotted: Option<&'a RawValue>,
    #[serde(borrow)]
    log: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Log<'a> {
    #[serde(borrow)]
    level: Option<&'a RawValue>,
}

impl Fields<'_> {
    fn level(&self) -> Option<Level> {
        let nested = self
            .log
            .and_then(|log| serde_json::from_str::<Log<'_>>(log.get()).ok())
            .and_then(|log| log.level);
        [
            self.level,
            self.lvl,
            self.severity,
            self.levelname,
            self.dotted,
            nested,
        ]
        .into_iter()
        .flatten()
        .find_map(|raw| match serde_json::from_str::<Value>(raw.get()).ok()? {
            Value::String(word) => named(&word),
            Value::Number(number) => pino(number.as_f64()?),
            _ => None,
        })
    }
}

/// pino's numbers: 10 trace, 20 debug, 30 info, 40 warn, 50 error and 60
/// fatal, custom levels between them counting as the one below.
fn pino(number: f64) -> Option<Level> {
    match number {
        n if n >= 50.0 => Some(Level::Error),
        n if n >= 40.0 => Some(Level::Warn),
        n if n >= 30.0 => Some(Level::Info),
        n if n >= 20.0 => Some(Level::Debug),
        n if n >= 10.0 => Some(Level::Trace),
        _ => None,
    }
}

/// logfmt's `level=` or `lvl=`, at the start or after a space, its value
/// quoted or not.
fn logfmt(text: &str) -> Option<Level> {
    text.split(' ').find_map(|pair| {
        let value = pair
            .strip_prefix("level=")
            .or_else(|| pair.strip_prefix("lvl="))?;
        named(value.trim_matches('"'))
    })
}

/// How many words from the start a level may come.
const PREFIX: usize = 4;

/// A level word where loggers print one: klog's `E1103` first, or a word
/// alone, in brackets, or before a colon or logrus's `[0000]` among the
/// first words, after the times, numbers, brackets and dashes that come
/// before it. The first other word starts the message, which says no
/// level, as in `No error found`.
fn prefix(text: &str) -> Option<Level> {
    let mut words = text.split_ascii_whitespace().take(PREFIX).peekable();
    if let Some(level) = words.peek().and_then(|first| klog(first)) {
        return Some(level);
    }
    for word in words {
        let bracketed = ['[', '(', '<']
            .into_iter()
            .zip([']', ')', '>'])
            .find_map(|(open, close)| word.strip_prefix(open)?.strip_suffix(close));
        if let Some(inner) = bracketed {
            match named(inner) {
                Some(level) => return Some(level),
                None => continue,
            }
        }
        let head = word.split([':', '[']).next().unwrap_or(word);
        if let Some(level) = named(head) {
            return Some(level);
        }
        let ignorable = word.contains(|c: char| c.is_ascii_digit())
            || word.chars().all(|c| c.is_ascii_punctuation());
        if !ignorable {
            return None;
        }
    }
    None
}

/// klog's header: its severity's letter and the month and day, as `E1103`
/// (k8s.io/klog v2.130.1, `internal/buffer/buffer.go`, `FormatHeader`).
fn klog(word: &str) -> Option<Level> {
    let (letter, digits) = word.split_at_checked(1)?;
    if digits.len() != 4 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    match letter {
        "I" => Some(Level::Info),
        "W" => Some(Level::Warn),
        "E" | "F" => Some(Level::Error),
        _ => None,
    }
}

/// The level a word names, in any case: syslog's, Python's, .NET's, zap's,
/// logrus's and slog's names; fatal, critical and panic count as errors.
fn named(word: &str) -> Option<Level> {
    const NAMES: &[(&str, Level)] = &[
        ("trace", Level::Trace),
        ("verbose", Level::Trace),
        ("debug", Level::Debug),
        ("dbg", Level::Debug),
        ("info", Level::Info),
        ("information", Level::Info),
        ("notice", Level::Info),
        ("warn", Level::Warn),
        ("warning", Level::Warn),
        ("error", Level::Error),
        ("err", Level::Error),
        ("fatal", Level::Error),
        ("critical", Level::Error),
        ("crit", Level::Error),
        ("panic", Level::Error),
        ("dpanic", Level::Error),
        ("alert", Level::Error),
        ("emerg", Level::Error),
        ("emergency", Level::Error),
    ];
    NAMES
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(word))
        .map(|(_, level)| *level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_says_it_in_its_fields() {
        assert_eq!(level(r#"{"level":"warn","msg":"slow"}"#), Some(Level::Warn));
        assert_eq!(level(r#"{"level":50,"msg":"boom"}"#), Some(Level::Error));
        assert_eq!(level(r#"{"level":60}"#), Some(Level::Error));
        assert_eq!(level(r#"{"level":35}"#), Some(Level::Info));
        assert_eq!(level(r#"{"severity":"CRITICAL"}"#), Some(Level::Error));
        assert_eq!(level(r#"{"levelname":"DEBUG"}"#), Some(Level::Debug));
        assert_eq!(level(r#"{"log.level":"info"}"#), Some(Level::Info));
        assert_eq!(level(r#"{"log":{"level":"error"}}"#), Some(Level::Error));
        assert_eq!(level(r#"{"lvl":"trace"}"#), Some(Level::Trace));
        assert_eq!(level(r#"{"msg":"error: nothing says it"}"#), None);
        assert_eq!(
            level(r#"{"log":"text","level":"fatal"}"#),
            Some(Level::Error)
        );
    }

    #[test]
    fn logfmt_says_it_after_level() {
        assert_eq!(
            level("time=2026-11-03T10:00:00Z level=WARN msg=slow"),
            Some(Level::Warn)
        );
        assert_eq!(level(r#"lvl="error" msg=boom"#), Some(Level::Error));
        assert_eq!(level("loglevel=error"), None);
    }

    #[test]
    fn a_word_where_loggers_print_one() {
        assert_eq!(
            level("2026-11-03T10:00:00.123Z  WARN 1 --- [main] slow"),
            Some(Level::Warn)
        );
        assert_eq!(
            level("10:00:00.123 [main] ERROR c.e.App - boom"),
            Some(Level::Error)
        );
        assert_eq!(
            level("2026/11/03 10:00:00 [error] 29#29: open() failed"),
            Some(Level::Error)
        );
        assert_eq!(level("WARNING:root:disk almost full"), Some(Level::Warn));
        assert_eq!(level("warning: deprecated flag"), Some(Level::Warn));
        assert_eq!(level("panic: runtime error"), Some(Level::Error));
        assert_eq!(
            level("E1103 10:00:00.000000       1 reflector.go:200] failed"),
            Some(Level::Error)
        );
        assert_eq!(
            level("I1103 10:00:00.000000 1 main.go:9] up"),
            Some(Level::Info)
        );
        assert_eq!(level("INFO[0000] listening"), Some(Level::Info));
    }

    #[test]
    fn the_message_says_no_level() {
        assert_eq!(level("No error found"), None);
        assert_eq!(level("2026/11/03 10:00:00 listening on :8080"), None);
        assert_eq!(
            level(r#"10.244.0.1 - - [03/Nov/2026:10:00:00 +0000] "GET /error HTTP/1.1" 500"#),
            None
        );
        assert_eq!(level("a b c d error"), None);
        assert_eq!(level("{not json, error"), None);
    }
}
