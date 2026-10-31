use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The error every command returns. The webview branches on `kind`; `message`
/// is for people.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct IpcError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    InvalidInput,
    NotFound,
    Conflict,
    Forbidden,
    Unauthorized,
    Timeout,
    Unavailable,
    Internal,
}
