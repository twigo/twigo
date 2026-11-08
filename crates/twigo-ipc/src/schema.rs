use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Names a kind of the cluster a space reaches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SchemaQuery {
    pub space: String,
    /// Empty for the core group.
    pub group: String,
    pub version: String,
    pub kind: String,
}
