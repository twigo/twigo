//! The link to the repository's new-issue form, filled with the facts the
//! person left ticked.

use std::cmp::Reverse;

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use twigo_ipc::{Fact, OpenedIssue};

/// The repository the issue goes to, which the workspace names.
const REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");

/// The template's file under `.github/ISSUE_TEMPLATE`, and the id of the
/// field of it that the link fills.
pub(super) const TEMPLATE: &str = "bug_report.yml";
pub(super) const ENVIRONMENT: &str = "environment";

/// GitHub answered `500` to a link of 7,051 characters with no session
/// (`curl`, 2026-11-22), and `302` to one of 7,001.
const LIMIT: usize = 6000;

/// The least a cut fact value keeps.
const FLOOR: usize = 40;

/// The new-issue link for `facts`, and what it left out to stay under
/// [`LIMIT`]: the longest fact values, down to [`FLOOR`] characters.
pub(super) fn link(facts: &[Fact]) -> (String, OpenedIssue) {
    let mut values: Vec<String> = facts.iter().map(|fact| fact.value.clone()).collect();
    let url = |values: &[String]| {
        let environment = facts
            .iter()
            .zip(values)
            .map(|(fact, value)| format!("{}: {value}", fact.label))
            .collect::<Vec<_>>()
            .join("\n");
        filled(&environment)
    };
    let mut opened = OpenedIssue {
        facts_cut: Vec::new(),
    };

    if url(&values).len() > LIMIT {
        let mut longest_first: Vec<usize> = (0..values.len()).collect();
        longest_first.sort_by_key(|&at| Reverse(values[at].chars().count()));
        for at in longest_first {
            if url(&values).len() <= LIMIT {
                break;
            }
            let whole = values[at].clone();
            let kept = longest(
                FLOOR.min(whole.chars().count()),
                whole.chars().count(),
                |kept| {
                    values[at] = cut(&whole, kept);
                    url(&values).len() <= LIMIT
                },
            );
            values[at] = cut(&whole, kept);
            if kept < whole.chars().count() {
                opened.facts_cut.push(facts[at].id);
            }
        }
    }
    (url(&values), opened)
}

fn filled(environment: &str) -> String {
    let mut url = format!("{REPOSITORY}/issues/new?template={TEMPLATE}");
    if !environment.is_empty() {
        url.push('&');
        url.push_str(ENVIRONMENT);
        url.push('=');
        url.extend(utf8_percent_encode(environment, NON_ALPHANUMERIC));
    }
    url
}

/// The most characters from `least` to `most` for which `fits` holds, which
/// it does for fewer where it does for more; `least` where none does.
fn longest(least: usize, most: usize, mut fits: impl FnMut(usize) -> bool) -> usize {
    let (mut low, mut high) = (least, most);
    while low < high {
        let middle = (low + high).div_ceil(2);
        if fits(middle) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    low
}

fn cut(text: &str, kept: usize) -> String {
    if text.chars().count() <= kept {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(kept).collect();
    cut.push('…');
    cut
}
