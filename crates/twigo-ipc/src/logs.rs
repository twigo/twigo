//! Logs (ARCHITECTURE 4.6): a session per logs tab follows the containers of
//! a pod, or of a workload's pods, into a ring buffer in Rust, which filters,
//! searches and windows them; its batches come with flow control, as a
//! list's do (3.5).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Gvr, IpcError, SubscriptionId, Tone, ViewState};

/// What a logs tab follows: a pod, or a Deployment, ReplicaSet,
/// StatefulSet, DaemonSet, Job or CronJob, whose pods it merges and whose
/// new pods join it, as a rollout's do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LogTarget {
    pub space: String,
    pub gvr: Gvr,
    pub namespace: String,
    pub name: String,
}

/// Which containers of each pod a session follows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Containers {
    /// The one its `kubectl.kubernetes.io/default-container` annotation
    /// names, else its first.
    Default,
    /// A pod without it follows none.
    Named { name: String },
    /// Its init containers and its containers, in the spec's order.
    All,
}

/// Where each container's lines start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Since {
    /// Its last lines.
    Lines {
        lines: u32,
    },
    Seconds {
        seconds: u32,
    },
    /// Its start.
    Start,
}

/// What a session reads from the cluster; a change reopens its streams.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LogSource {
    pub containers: Containers,
    /// The pods to follow, by name; null follows the target's pods, new
    /// ones included, as long as the tab's ten streams last (decision 23).
    pub pods: Option<Vec<String>>,
    pub since: Since,
    /// Each container's previous instance, the one that ended, read to its
    /// end rather than followed.
    pub previous: bool,
}

/// How a session shows its buffer; a change filters it again in Rust and
/// reopens nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LogView {
    pub level: LevelFilter,
    /// Keeps the lines whose text matches, in the list filter's syntax: a
    /// substring in any case of ASCII letters, `!` before it to keep the
    /// lines without one, or a regex between slashes, also in any case,
    /// negated as `!/…/`.
    pub filter: Option<String>,
    /// Marks the matches in the text of the lines the view keeps: a
    /// substring in any case of ASCII letters, or a regex between slashes,
    /// also in any case.
    pub search: Option<String>,
    /// Keeps the lines from `from` to `to`, picked on the histogram.
    pub range: Option<TimeRange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LevelFilter {
    All,
    /// Warnings and errors.
    Warn,
    Error,
}

/// RFC 3339; `to` is exclusive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TimeRange {
    pub from: String,
    pub to: String,
}

/// Rust sends nothing of the lines until the webview sets a window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct OpenLogs {
    pub target: LogTarget,
    pub source: LogSource,
    pub view: LogView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetLogSource {
    pub id: SubscriptionId,
    pub source: LogSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetLogView {
    pub id: SubscriptionId,
    pub view: LogView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetLogWindow {
    pub id: SubscriptionId,
    pub window: LogWindow,
}

/// The lines of the view a window reads, markers included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogWindow {
    /// The last `count`, following the end as lines come.
    Tail { count: u32 },
    /// Exclusive of `end`.
    Range { start: u32, end: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct DownloadLogs {
    pub id: SubscriptionId,
    /// The lines the view keeps, else every line the buffer holds.
    pub filtered: bool,
}

/// One flush of a session. Rust sends the next only after the webview
/// acknowledged this one's `seq`, and coalesces changes meanwhile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LogBatch {
    pub seq: u32,
    /// The target's: whether its pods are listed, may be read, or are gone.
    pub status: ViewState,
    /// Present in the first batch and whenever a pod, a container or a
    /// stream's state changes.
    pub pods: Option<Vec<LogPod>>,
    /// Entries the view keeps, in or out of the window.
    pub total: u32,
    /// Present when the window's entries changed; the view keeps exactly
    /// these.
    pub window: Option<LogEntries>,
    /// Present when the search, or what it matches, changed; empty without
    /// a search.
    pub matches: Option<LogMatches>,
    /// Present when it changed.
    pub histogram: Option<Histogram>,
    /// Lines the buffer's bound dropped since the session opened (decision
    /// 24).
    pub dropped: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LogEntries {
    /// An index into the view's entries, as in [`LogWindow::Range`].
    pub start: u32,
    pub entries: Vec<LogEntry>,
}

/// Every entry has an `id`, which stays its own while the buffer holds it,
/// so the webview keeps its place as entries enter and leave before it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LogEntry {
    Line {
        id: u64,
        pod: String,
        container: String,
        /// RFC 3339 with nanoseconds, as the kubelet stamps the line.
        time: String,
        level: Option<Level>,
        /// Without its ANSI escapes.
        text: String,
        /// What its ANSI escapes styled.
        styles: Vec<TextStyle>,
        /// The search's matches.
        marks: Vec<TextRange>,
    },
    /// A container ended: crashed, finished or was killed.
    Ended {
        id: u64,
        pod: String,
        container: String,
        /// RFC 3339.
        time: String,
        exit_code: Option<i32>,
        reason: Option<String>,
        /// RFC 3339, when the kubelet starts it again, in a crash loop's
        /// back-off.
        restarting: Option<String>,
    },
    /// A pod joined the target, as a rollout's new pod does.
    Joined {
        id: u64,
        pod: String,
        /// RFC 3339.
        time: String,
    },
    /// A pod left the target.
    Left {
        id: u64,
        pod: String,
        /// RFC 3339.
        time: String,
    },
    /// The buffer's bound dropped `count` older lines; always the first
    /// entry once it has.
    Dropped { id: u64, count: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warn,
    /// Fatal, critical and panic lines too.
    Error,
}

/// Indexes a line's text in UTF-16 units; `end` is exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TextRange {
    pub start: u32,
    pub end: u32,
}

/// A run of text an ANSI escape styled; 256 and true colours come as the
/// nearest of the sixteen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TextStyle {
    pub range: TextRange,
    pub fg: Option<AnsiColor>,
    pub bg: Option<AnsiColor>,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AnsiColor {
    Black,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    White,
    BrightBlack,
    BrightRed,
    BrightGreen,
    BrightYellow,
    BrightBlue,
    BrightMagenta,
    BrightCyan,
    BrightWhite,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LogMatches {
    /// Every match in the view.
    pub count: u32,
    /// The view's index of the entry of each match, in order, so an entry
    /// with two matches comes twice; the first 10,000 matches.
    pub entries: Vec<u32>,
}

/// The view's lines over time, its range aside, in equal spans from `from`
/// to `to`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Histogram {
    /// RFC 3339.
    pub from: String,
    /// RFC 3339.
    pub to: String,
    pub buckets: Vec<Bucket>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Bucket {
    /// Every line in the span, warnings and errors included.
    pub lines: u32,
    pub warnings: u32,
    pub errors: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LogPod {
    pub name: String,
    /// Where the generated part of its name starts, as a row's
    /// [`generated`](crate::Row::generated).
    pub generated: Option<u32>,
    /// As the pod list's Status column has it: Running, CrashLoopBackOff.
    pub status: String,
    pub tone: Tone,
    pub containers: Vec<LogContainer>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LogContainer {
    pub name: String,
    pub stream: StreamState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum StreamState {
    /// The source does not choose it.
    Off,
    /// Chosen, but the tab follows its ten streams already.
    OverLimit,
    /// Waiting for one of the cluster's followed logs (ARCHITECTURE 3.2).
    Queued,
    Connecting,
    Following,
    /// Read to its end: a previous instance, or one that ended for good.
    Ended,
    /// Not started yet, or waiting to start again, as the kubelet says why.
    Waiting {
        reason: Option<String>,
    },
    Error {
        error: IpcError,
    },
}
