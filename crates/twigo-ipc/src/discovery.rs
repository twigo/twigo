use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Gvr, IpcError};

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

/// A context's resources as discovery last answered, or why it did not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Discovered {
    Ready { resources: Vec<Resource> },
    Failed { error: IpcError },
}

/// What the API server says about itself, from `/version`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClusterVersion {
    /// Such as `v1.33.4`.
    pub git_version: String,
}
