//! The link to the repository's new-issue form, filled with the facts the
//! person left ticked.

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use twigo_ipc::Fact;

/// The repository the issue goes to, which the workspace names.
const REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");

/// The template's file under `.github/ISSUE_TEMPLATE`, and the id of the
/// field of it that the link fills.
pub(super) const TEMPLATE: &str = "bug_report.yml";
pub(super) const ENVIRONMENT: &str = "environment";

/// GitHub answered `500` to a link of 7,051 characters with no session
/// (`curl`, 2026-11-22), and `302` to one of 7,001.
const LIMIT: usize = 6000;

/// The new-issue link for `facts`, or the bare template when that link would
/// pass [`LIMIT`].
pub(super) fn link(facts: &[Fact]) -> String {
    let environment = facts
        .iter()
        .map(|fact| format!("{}: {}", fact.label, fact.value))
        .collect::<Vec<_>>()
        .join("\n");
    let url = filled(&environment);
    if url.len() <= LIMIT { url } else { filled("") }
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
