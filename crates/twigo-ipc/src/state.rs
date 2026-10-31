use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// UI state that is not settings (ARCHITECTURE 4.8): a space's layout, the
/// command history. The value is JSON the webview writes and reads back;
/// the core stores it without looking inside.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct StateEntry {
    pub key: String,
    pub value: String,
}
