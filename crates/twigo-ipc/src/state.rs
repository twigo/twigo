use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// UI state that is not settings (ARCHITECTURE 4.8), such as a space's
/// layout or the command history. The value is JSON that the webview writes
/// and reads back; the core checks only that it is JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct StateEntry {
    /// The space it belongs to; none for the whole app.
    pub space: Option<String>,
    pub key: String,
    pub value: String,
}

/// Every stored value, read once as the webview starts.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub struct StateSnapshot {
    pub app: HashMap<String, String>,
    /// By space id.
    pub spaces: HashMap<String, HashMap<String, String>>,
}
