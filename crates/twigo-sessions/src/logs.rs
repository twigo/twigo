//! Logs (ARCHITECTURE 4.6): a session per logs tab follows the containers
//! of a pod, or of a workload's pods, into a buffer in Rust that it
//! filters, searches and windows for the webview.

pub mod buffer;
pub mod level;
pub mod line;
pub mod view;
