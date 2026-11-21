//! How the core's errors reach the webview (`IpcError`).

use twigo_ipc::{ErrorCode, IpcError};
use twigo_policy::Refused;

use crate::ClientsError;

impl From<&ClientsError> for IpcError {
    fn from(error: &ClientsError) -> Self {
        let code = match error {
            ClientsError::NoContext(_) => ErrorCode::ContextNotListed,
            ClientsError::NoPlugin(_) => ErrorCode::ContextNoPlugin,
            ClientsError::Invalid(..) | ClientsError::Connect(..) => ErrorCode::ContextInvalid,
            ClientsError::Oidc(..) => ErrorCode::CredentialsOidcConfig,
            ClientsError::Untrusted(..) => ErrorCode::CredentialsUntrusted,
        };
        IpcError::new(code, error.to_string())
    }
}

pub(crate) fn refused(error: &Refused) -> IpcError {
    let code = match error {
        Refused::PolicyFile(..) => ErrorCode::PolicyFileSetsMode,
        Refused::PolicyFileUnreadable(_) => ErrorCode::PolicyFileUnreadable,
        Refused::NotLocked(..) => ErrorCode::PolicyNotLocked,
        Refused::Unlisted(_) => ErrorCode::ContextNotListed,
        Refused::Changed(_) => ErrorCode::PolicyChanged,
    };
    IpcError::new(code, error.to_string())
}
