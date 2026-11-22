//! The link to the repository's new-issue form, filled with the facts the
//! person left ticked and what they wrote.

use std::cmp::Reverse;

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use twigo_ipc::{Fact, OpenedIssue};

/// The repository the issue goes to, which the workspace names.
const REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");

/// The template's file under `.github/ISSUE_TEMPLATE`, and the ids of the
/// fields of it that the link fills.
pub(super) const TEMPLATE: &str = "bug_report.yml";
pub(super) const ENVIRONMENT: &str = "environment";
pub(super) const DESCRIPTION: &str = "description";

/// GitHub answered `500` to a link of 7,051 characters with no session
/// (`curl`, 2026-11-22), and `302` to one of 7,001.
const LIMIT: usize = 6000;

/// The least a cut fact value keeps, and the most a title does.
const FLOOR: usize = 40;
const TITLE: usize = 200;

/// The new-issue link for `facts`, and what it left out to stay under
/// [`LIMIT`]: first the longest fact values, down to [`FLOOR`] characters,
/// then the description.
pub(super) fn link(
    facts: &[Fact],
    title: Option<&str>,
    description: Option<&str>,
) -> (String, OpenedIssue) {
    let title = title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(|title| title.chars().take(TITLE).collect::<String>());
    let mut description = description
        .filter(|description| !description.trim().is_empty())
        .map(str::to_owned);
    let mut values: Vec<String> = facts.iter().map(|fact| fact.value.clone()).collect();
    let url = |values: &[String], description: Option<&str>| {
        let environment = facts
            .iter()
            .zip(values)
            .map(|(fact, value)| format!("{}: {value}", fact.label))
            .collect::<Vec<_>>()
            .join("\n");
        filled(title.as_deref(), &environment, description)
    };
    let mut opened = OpenedIssue {
        facts_cut: Vec::new(),
        description_cut: false,
    };

    if url(&values, description.as_deref()).len() > LIMIT {
        let mut longest_first: Vec<usize> = (0..values.len()).collect();
        longest_first.sort_by_key(|&at| Reverse(values[at].chars().count()));
        for at in longest_first {
            if url(&values, description.as_deref()).len() <= LIMIT {
                break;
            }
            let whole = values[at].clone();
            let kept = longest(
                FLOOR.min(whole.chars().count()),
                whole.chars().count(),
                |kept| {
                    values[at] = cut(&whole, kept);
                    url(&values, description.as_deref()).len() <= LIMIT
                },
            );
            values[at] = cut(&whole, kept);
            if kept < whole.chars().count() {
                opened.facts_cut.push(facts[at].id);
            }
        }
    }
    if url(&values, description.as_deref()).len() > LIMIT
        && let Some(whole) = description.clone()
    {
        let kept = longest(0, whole.chars().count(), |kept| {
            description = Some(cut(&whole, kept));
            url(&values, description.as_deref()).len() <= LIMIT
        });
        description = (kept > 0).then(|| cut(&whole, kept));
        opened.description_cut = true;
    }
    (url(&values, description.as_deref()), opened)
}

fn filled(title: Option<&str>, environment: &str, description: Option<&str>) -> String {
    let mut url = format!("{REPOSITORY}/issues/new?template={TEMPLATE}");
    let mut field = |name: &str, value: &str| {
        url.push('&');
        url.push_str(name);
        url.push('=');
        url.extend(utf8_percent_encode(value, NON_ALPHANUMERIC));
    };
    if let Some(title) = title {
        field("title", title);
    }
    if !environment.is_empty() {
        field(ENVIRONMENT, environment);
    }
    if let Some(description) = description {
        field(DESCRIPTION, description);
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
