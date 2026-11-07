//! How the core's errors reach the webview (`IpcError`).

use twigo_ipc::{ErrorKind, IpcError};
use twigo_policy::Refused;

use crate::ClientsError;

impl From<&ClientsError> for IpcError {
    fn from(error: &ClientsError) -> Self {
        let kind = match error {
            ClientsError::NoContext(_) | ClientsError::NoPlugin(_) => ErrorKind::NotFound,
            ClientsError::Invalid(..) | ClientsError::Oidc(..) => ErrorKind::InvalidInput,
            ClientsError::Untrusted(..) => ErrorKind::Unauthorized,
            ClientsError::Connect(..) => ErrorKind::Unavailable,
        };
        IpcError::new(kind, error.to_string())
    }
}

pub(crate) fn refused(error: &Refused) -> IpcError {
    let kind = match error {
        Refused::PolicyFile(..) | Refused::PolicyFileUnreadable(_) => ErrorKind::Permissions,
        Refused::NotLocked(..) => ErrorKind::InvalidInput,
    };
    IpcError::new(kind, error.to_string())
}
