use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A workbench space: one context or a group of them (ARCHITECTURE 4.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub contexts: Vec<Context>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Context {
    pub name: String,
    /// From the `twigo` extension of the kubeconfig context; none by default.
    pub color: Option<ContextColor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ContextColor {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
}
