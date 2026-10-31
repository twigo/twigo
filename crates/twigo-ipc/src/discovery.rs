use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Gvr;

/// A resource the space's clusters serve, from discovery: what the explorer
/// lists and what `:` in quick access resolves names against (ARCHITECTURE 4.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub gvr: Gvr,
    pub kind: String,
    pub singular: String,
    pub short_names: Vec<String>,
    pub namespaced: bool,
}
