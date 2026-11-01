//! How the core's errors reach the webview (`IpcError`).

use twigo_ipc::{ErrorKind, IpcError};
use twigo_kube::credentials::{CredentialError, RunError};

use crate::ClientsError;

impl From<&ClientsError> for IpcError {
    fn from(error: &ClientsError) -> Self {
        let kind = match error {
            ClientsError::NoContext(_) | ClientsError::NoPlugin(_) => ErrorKind::NotFound,
            ClientsError::Invalid(..) => ErrorKind::InvalidInput,
            ClientsError::Untrusted(..) => ErrorKind::Unauthorized,
            ClientsError::Connect(..) => ErrorKind::Unavailable,
        };
        IpcError {
            kind,
            message: error.to_string(),
        }
    }
}

/// A request's failure: the API server's status, else why the request got
/// no answer.
pub(crate) fn request(error: &kube::Error) -> IpcError {
    let kind = match error {
        kube::Error::Api(status) => match status.code {
            400 | 422 => ErrorKind::InvalidInput,
            401 => ErrorKind::Unauthorized,
            403 => ErrorKind::Forbidden,
            404 => ErrorKind::NotFound,
            409 => ErrorKind::Conflict,
            408 | 504 => ErrorKind::Timeout,
            429 | 500..=599 => ErrorKind::Unavailable,
            _ => ErrorKind::Internal,
        },
        kube::Error::Auth(_) => ErrorKind::Unauthorized,
        kube::Error::Service(error) if let Some(error) = credential(&**error) => match error {
            CredentialError::Run(RunError::Timeout { .. }) => ErrorKind::Timeout,
            _ => ErrorKind::Unauthorized,
        },
        kube::Error::Service(error) if elapsed(&**error) => ErrorKind::Timeout,
        kube::Error::Service(_) | kube::Error::HyperError(_) => ErrorKind::Unavailable,
        _ => ErrorKind::Internal,
    };
    IpcError {
        kind,
        message: error.to_string(),
    }
}

/// Why the context's plugin gave no credential, when that ended it.
fn credential<'a>(error: &'a (dyn std::error::Error + 'static)) -> Option<&'a CredentialError> {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(credential) = error.downcast_ref::<CredentialError>() {
            return Some(credential);
        }
        source = error.source();
    }
    None
}

/// Whether the client's request timeout ended it.
fn elapsed(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if error.is::<tower::timeout::error::Elapsed>() {
            return true;
        }
        source = error.source();
    }
    false
}

#[cfg(test)]
mod tests {
    use kube::core::Status;

    use super::*;

    fn status(code: u16) -> ErrorKind {
        let status = Status::failure("no", "Reason").with_code(code);
        request(&kube::Error::Api(Box::new(status))).kind
    }

    #[test]
    fn kinds() {
        assert_eq!(status(401), ErrorKind::Unauthorized);
        assert_eq!(status(403), ErrorKind::Forbidden);
        assert_eq!(status(404), ErrorKind::NotFound);
        assert_eq!(status(504), ErrorKind::Timeout);
        assert_eq!(status(503), ErrorKind::Unavailable);
        let timed_out = kube::Error::Service(tower::timeout::error::Elapsed::new().into());
        assert_eq!(request(&timed_out).kind, ErrorKind::Timeout);
        let refused = kube::Error::Service(std::io::Error::other("refused").into());
        assert_eq!(request(&refused).kind, ErrorKind::Unavailable);
        let plugin = |error: CredentialError| request(&kube::Error::Service(error.into())).kind;
        assert_eq!(
            plugin(CredentialError::Run(RunError::NotFound("aws".to_owned()))),
            ErrorKind::Unauthorized
        );
        assert_eq!(
            plugin(CredentialError::Run(RunError::Timeout {
                command: "aws".to_owned(),
                after: std::time::Duration::from_secs(120),
            })),
            ErrorKind::Timeout
        );
    }
}
