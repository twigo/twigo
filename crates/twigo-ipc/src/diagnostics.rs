use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What the webview tells the diagnostics log (ARCHITECTURE 4.10): an error
/// it caught or did not, which the log writes with the window's label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct DiagnosticsEntry {
    pub level: DiagnosticsLevel,
    pub message: String,
    pub stack: Option<String>,
    /// What caught it: `error`, `unhandledrejection`, or the React root
    /// option that did.
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticsLevel {
    Error,
    Warn,
    Info,
}

/// How much Twigo's own crates write to the diagnostics log until Twigo
/// quits; the libraries stay at warnings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetLogLevel {
    pub level: LogVerbosity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LogVerbosity {
    Info,
    Debug,
    Trace,
}
