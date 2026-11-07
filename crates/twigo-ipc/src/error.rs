use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Blocked;

/// The error every command returns. The webview branches on `kind`; `message`
/// is for people.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct IpcError {
    pub kind: ErrorKind,
    pub message: String,
    /// With `permissions`: the mode and its source, when the gate stopped a
    /// request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blocked: Option<Box<Blocked>>,
}

impl IpcError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            blocked: None,
        }
    }
}

impl From<Blocked> for IpcError {
    fn from(blocked: Blocked) -> Self {
        Self {
            kind: ErrorKind::Permissions,
            message: blocked.to_string(),
            blocked: Some(Box::new(blocked)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    InvalidInput,
    NotFound,
    Conflict,
    Forbidden,
    Unauthorized,
    /// Twigo's own policy refused it, where `Forbidden` is the cluster's RBAC.
    Permissions,
    Timeout,
    Unavailable,
    Internal,
}
