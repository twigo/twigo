//! Logs (ARCHITECTURE 4.6): a session per logs tab follows the containers
//! of a pod, or of a workload's pods, into a buffer in Rust that it
//! filters, searches and windows for the webview.

pub mod buffer;
pub mod level;
pub mod line;
pub mod stream;
pub mod view;

/// Nanoseconds since the Unix epoch.
fn now() -> i64 {
    i64::try_from(jiff::Timestamp::now().as_nanosecond()).expect("before 2262")
}
