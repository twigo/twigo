//! What a space keeps of its forwards (ARCHITECTURE 4.6, 4.8): the forwards
//! and the local port each target's port had last, which removing a forward
//! leaves.

use serde::{Deserialize, Serialize};
use twigo_ipc::{ForwardId, ForwardTarget};

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct Saved {
    #[serde(default)]
    pub forwards: Vec<SavedForward>,
    #[serde(default)]
    pub ports: Vec<Remembered>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SavedForward {
    pub id: ForwardId,
    pub target: ForwardTarget,
    pub kind: String,
    pub port: u16,
    pub port_name: Option<String>,
    pub app_protocol: Option<String>,
    pub local: u16,
    /// Whether it listens: a stopped forward is kept, not started again.
    pub runs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Remembered {
    pub target: ForwardTarget,
    pub port: u16,
    pub local: u16,
}
