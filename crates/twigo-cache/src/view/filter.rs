//! The text filter (ARCHITECTURE 3.4): a substring of a shown cell, in any
//! case of ASCII letters; `!` before it keeps the rows without one; `/…/`
//! is a regex, also case-insensitive, and `!/…/` its negation. Until the
//! closing slash the text is a substring, so typing a regex never makes
//! the list an error.

use regex::{Regex, RegexBuilder};
use twigo_ipc::{ErrorKind, IpcError};

use crate::table::Cell;

#[derive(Debug, Clone)]
pub struct TextFilter {
    matcher: Matcher,
    negated: bool,
}

#[derive(Debug, Clone)]
enum Matcher {
    /// In ASCII lower case.
    Substring(String),
    Regex(Regex),
}

impl TextFilter {
    /// None for text that keeps every row: empty, or a bare `!`. Only
    /// ASCII whitespace around it is trimmed, space, tab, line feed, form
    /// feed and carriage return, as the mock trims it.
    pub fn parse(text: &str) -> Result<Option<Self>, IpcError> {
        let text = text.trim_ascii();
        let (negated, rest) = match text.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let matcher = match rest
            .strip_prefix('/')
            .and_then(|inner| inner.strip_suffix('/'))
        {
            Some(pattern) => Matcher::Regex(
                RegexBuilder::new(pattern)
                    .case_insensitive(true)
                    .build()
                    .map_err(|error| IpcError {
                        kind: ErrorKind::InvalidInput,
                        message: format!("the filter /{pattern}/ is no regex: {error}"),
                    })?,
            ),
            None if rest.is_empty() => return Ok(None),
            None => Matcher::Substring(rest.to_ascii_lowercase()),
        };
        Ok(Some(Self { matcher, negated }))
    }

    /// Whether a row whose shown cells read as `texts` passes.
    pub fn keeps(&self, texts: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
        let hit = texts.into_iter().any(|text| match &self.matcher {
            Matcher::Substring(needle) => contains(text.as_ref(), needle),
            Matcher::Regex(regex) => regex.is_match(text.as_ref()),
        });
        hit != self.negated
    }
}

/// `haystack` holds `needle`, which is in ASCII lower case, in any case of
/// ASCII letters.
fn contains(haystack: &str, needle: &str) -> bool {
    let (haystack, needle) = (haystack.as_bytes(), needle.as_bytes());
    needle.is_empty()
        || haystack
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle))
}

/// A cell as the filter, the values and the groups read it: empty when it
/// is null or an Age, which the webview renders.
pub fn text(cell: &Cell) -> std::borrow::Cow<'_, str> {
    match cell {
        Cell::Null | Cell::Age => "".into(),
        Cell::Bool(value) => value.to_string().into(),
        Cell::Int(value) => value.to_string().into(),
        Cell::Number(value) => value.to_string().into(),
        Cell::Text(text) => (&**text).into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keeps(filter: &str, cells: &[&str]) -> bool {
        TextFilter::parse(filter)
            .unwrap()
            .is_none_or(|filter| filter.keeps(cells))
    }

    #[test]
    fn a_substring_in_any_case_of_any_shown_cell() {
        assert!(keeps("WEB", &["db-1", "web-7"]));
        assert!(keeps("  web ", &["Web-7"]), "trimmed");
        assert!(!keeps("api", &["db-1", "web-7"]));
        assert!(!keeps("web.7", &["web-7"]), "no regex without slashes");
    }

    #[test]
    fn a_bang_negates() {
        assert!(keeps("!api", &["web-7"]));
        assert!(!keeps("!web", &["web-7"]));
        assert!(keeps("!", &["web-7"]), "a bare bang keeps every row");
        assert!(keeps("", &[]));
    }

    #[test]
    fn slashes_make_a_regex_in_any_case() {
        assert!(keeps("/^WEB-\\d$/", &["web-7"]));
        assert!(!keeps("/^web-\\d$/", &["web-17"]));
        assert!(keeps("!/^web/", &["db-1"]));
        assert!(!keeps("!/^web/", &["web-1"]));
        assert!(
            keeps("/web-[", &["/web-[0"]),
            "a substring until it is closed"
        );
    }

    #[test]
    fn a_closed_regex_that_does_not_parse_is_invalid_input() {
        let error = TextFilter::parse("/web-[/").unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput);
    }

    #[test]
    fn cells_read_as_text() {
        assert_eq!(text(&Cell::Int(3)), "3");
        assert_eq!(text(&Cell::Number(1.5)), "1.5");
        assert_eq!(text(&Cell::Number(2.0)), "2");
        assert_eq!(text(&Cell::Bool(true)), "true");
        assert_eq!(text(&Cell::Null), "");
        assert_eq!(text(&Cell::Age), "");
    }
}
