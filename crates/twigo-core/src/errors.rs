//! How the core's errors reach the webview (`IpcError`).

use twigo_ipc::{ErrorKind, IpcError};

use crate::ClientsError;

impl From<&ClientsError> for IpcError {
    fn from(error: &ClientsError) -> Self {
        let kind = match error {
            ClientsError::NoContext(_) | ClientsError::NoPlugin(_) => ErrorKind::NotFound,
            ClientsError::Invalid(..) | ClientsError::Oidc(..) => ErrorKind::InvalidInput,
            ClientsError::Untrusted(..) => ErrorKind::Unauthorized,
            ClientsError::Connect(..) => ErrorKind::Unavailable,
        };
        IpcError {
            kind,
            message: error.to_string(),
        }
    }
}
