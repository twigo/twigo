use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What "Report a Problem" shows (ARCHITECTURE 4.10): facts for the issue and
/// the log to paste, both redacted in Rust, which the webview never gets
/// unredacted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Report {
    pub facts: Vec<Fact>,
    /// The last lines of the log as text, one record each, with what a
    /// panic's record holds below it.
    pub log: String,
    pub hidden: Hidden,
}

/// One thing the issue states about this run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Fact {
    pub id: FactId,
    pub label: String,
    pub value: String,
    /// Whether the person may leave it out of the issue.
    pub optional: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FactId {
    Twigo,
    System,
    Engine,
    /// The versions of the clusters this run asked, without their names.
    Kubernetes,
    /// Where the newest panic of this run or the previous one was.
    LastPanic,
}

/// How many times the redaction hid each kind of thing in the log.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Hidden {
    /// Contexts, clusters, servers, users, namespaces, objects, the account
    /// and emails, each as an alias.
    pub names: u32,
    pub paths: u32,
    pub tokens: u32,
    /// URLs and addresses other than loopback.
    pub addresses: u32,
    /// Double-quoted strings.
    pub quoted: u32,
    /// Lines of the file that were not records, which the log shows as a
    /// placeholder, never as their text.
    pub lines: u32,
}

/// The new issue's form, filled with the ticked facts and what the person
/// wrote; with no facts it is the bare template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct OpenIssue {
    /// The ids of the facts the person left ticked: Rust states them again
    /// from this run, so only what it wrote goes in the link.
    pub facts: Vec<FactId>,
    pub title: Option<String>,
    pub description: Option<String>,
}

/// What the link left out to stay under its length: the person pastes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OpenedIssue {
    /// Facts whose values were shortened.
    pub facts_cut: Vec<FactId>,
    pub description_cut: bool,
}

/// The text the person sees, to save to a file they choose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SaveReport {
    pub text: String,
}
