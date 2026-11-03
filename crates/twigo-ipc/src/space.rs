use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A workbench space: one context or a group of them (ARCHITECTURE 4.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Space {
    pub id: String,
    pub name: String,
    /// The names of its contexts; the catalog's `Context` says the rest,
    /// as long as a source lists it.
    pub contexts: Vec<String>,
}

/// A context the catalog lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Context {
    pub name: String,
    /// From the `twigo` extension of the kubeconfig context; none by default.
    pub color: Option<ContextColor>,
    /// The kubeconfig file that defines it, as a person names it:
    /// `~/.kube/config`.
    pub source: String,
    /// The URL of the cluster it reaches, without user info, query or
    /// fragment: `https://10.0.0.1:6443`. None when the kubeconfig names no
    /// server that parses.
    pub server: Option<String>,
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
