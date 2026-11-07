//! How a request's failure reaches the webview (`IpcError`).

use twigo_ipc::{Blocked, ErrorKind, IpcError};

use crate::credentials::{CredentialError, OidcError, RunError};

/// A request's failure: the API server's status in its own words, rather
/// than kube's `ApiError: … (Status { … })`, else why the request got no
/// answer.
pub fn request(error: &kube::Error) -> IpcError {
    if let kube::Error::Service(service) = error
        && let Some(blocked) = blocked(&**service)
    {
        return blocked.clone().into();
    }
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
        kube::Error::Service(error) if oidc(&**error) => ErrorKind::Unauthorized,
        kube::Error::Service(error) if elapsed(&**error) => ErrorKind::Timeout,
        kube::Error::Service(_) | kube::Error::HyperError(_) => ErrorKind::Unavailable,
        _ => ErrorKind::Internal,
    };
    let message = match error {
        kube::Error::Api(status) if !status.message.is_empty() => status.message.clone(),
        _ => error.to_string(),
    };
    IpcError::new(kind, message)
}

/// What the gate said, when it stopped the request.
fn blocked<'a>(error: &'a (dyn std::error::Error + 'static)) -> Option<&'a Blocked> {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(blocked) = error.downcast_ref::<Blocked>() {
            return Some(blocked);
        }
        source = error.source();
    }
    None
}

/// Whether the context's plugin or oidc provider gave the request no
/// credential.
pub fn no_credential(error: &kube::Error) -> bool {
    match error {
        kube::Error::Auth(_) => true,
        kube::Error::Service(error) => credential(&**error).is_some() || oidc(&**error),
        _ => false,
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

/// Whether the oidc refresh failed.
fn oidc(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if error.is::<OidcError>() {
            return true;
        }
        source = error.source();
    }
    false
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
        assert!(!no_credential(&timed_out));
        let refused = kube::Error::Service(std::io::Error::other("refused").into());
        assert_eq!(request(&refused).kind, ErrorKind::Unavailable);
        let plugin = |error: CredentialError| kube::Error::Service(error.into());
        let missing = plugin(CredentialError::Run(RunError::NotFound("aws".to_owned())));
        assert_eq!(request(&missing).kind, ErrorKind::Unauthorized);
        assert!(no_credential(&missing));
        let slow = plugin(CredentialError::Run(RunError::Timeout {
            command: "aws".to_owned(),
            after: std::time::Duration::from_secs(120),
        }));
        assert_eq!(request(&slow).kind, ErrorKind::Timeout);
        assert!(no_credential(&slow));
    }

    #[test]
    fn the_server_says_what_was_wrong_in_its_own_words() {
        let status = Status::failure("field label not supported: spec.containers", "BadRequest")
            .with_code(400);
        let refused = request(&kube::Error::Api(Box::new(status)));
        assert_eq!(
            (refused.kind, refused.message.as_str()),
            (
                ErrorKind::InvalidInput,
                "field label not supported: spec.containers"
            )
        );
        let silent = Status::failure("", "InternalError").with_code(500);
        assert!(
            request(&kube::Error::Api(Box::new(silent)))
                .message
                .contains("InternalError")
        );
    }
}
