//! How the core's errors reach the webview (`IpcError`).

use twigo_ipc::{ErrorCode, IpcError};
use twigo_policy::Refused;

use crate::ClientsError;

/// No source lists the context: the one place that says so, for a command, a session, a policy
/// change and the webview's own ask.
pub(crate) fn unlisted(context: &str) -> IpcError {
    IpcError::new(
        ErrorCode::ContextNotListed,
        format!("no source lists the context {context:?}"),
    )
}

impl From<&ClientsError> for IpcError {
    fn from(error: &ClientsError) -> Self {
        let code = match error {
            ClientsError::NoContext(context) => return unlisted(context),
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
        Refused::Unlisted(context) => return unlisted(context),
        Refused::Changed(_) => ErrorCode::PolicyChanged,
    };
    IpcError::new(code, error.to_string())
}
