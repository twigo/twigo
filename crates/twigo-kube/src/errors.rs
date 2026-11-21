//! How a request's failure reaches the webview (`IpcError`).

use http::StatusCode;
use kube::core::Status;
use tower::timeout::error::Elapsed;
use twigo_ipc::{Blocked, ErrorCode, IpcError, ServerCause, ServerStatus};

use crate::credentials::{CredentialError, OidcError, RunError};

/// A request's failure: the API server's status in its own words, rather
/// than kube's `ApiError: … (Status { … })`, with its reason and causes as
/// data, else why the request got no answer.
pub fn request(error: &kube::Error) -> IpcError {
    if let Some(blocked) = gate(error) {
        return blocked.clone().into();
    }
    let code = match error {
        kube::Error::Api(status) => match status.code {
            400 | 422 => ErrorCode::ServerInvalid,
            401 => ErrorCode::ServerUnauthorized,
            403 => ErrorCode::ServerForbidden,
            404 => ErrorCode::ServerNotFound,
            409 => ErrorCode::ServerConflict,
            408 | 504 => ErrorCode::ServerTimeout,
            429 | 500..=599 => ErrorCode::ServerUnavailable,
            _ => ErrorCode::ServerOther,
        },
        kube::Error::Auth(_) => ErrorCode::CredentialsUnusable,
        kube::Error::Service(error) if let Some(error) = find::<CredentialError>(&**error) => {
            match error {
                CredentialError::Run(error) => plugin_code(error),
                CredentialError::SignInFailed(_) => ErrorCode::CredentialsPluginFailed,
            }
        }
        kube::Error::Service(error) if find::<OidcError>(&**error).is_some() => {
            ErrorCode::CredentialsOidcRefresh
        }
        kube::Error::Service(error) if find::<Elapsed>(&**error).is_some() => {
            ErrorCode::ConnectTimeout
        }
        kube::Error::Service(_) | kube::Error::HyperError(_) => ErrorCode::ConnectOther,
        kube::Error::ReadEvents(_) => ErrorCode::ConnectLost,
        kube::Error::SerdeError(_)
        | kube::Error::FromUtf8(_)
        | kube::Error::LinesCodecMaxLineLengthExceeded => ErrorCode::AnswerUndecodable,
        _ => ErrorCode::InternalRequest,
    };
    let message = match error {
        kube::Error::Api(status) if !status.message.is_empty() => status.message.clone(),
        _ => error.to_string(),
    };
    let refused = IpcError::new(code, message);
    match error {
        kube::Error::Api(status) => refused.with_server(server(status)),
        _ => refused,
    }
}

/// A credential plugin's failed run, as the context's plugin panel says it.
pub fn plugin(error: &RunError) -> IpcError {
    IpcError::new(plugin_code(error), error.to_string())
}

fn plugin_code(error: &RunError) -> ErrorCode {
    match error {
        RunError::Timeout { .. } => ErrorCode::CredentialsPluginTimeout,
        RunError::NotFound(_) => ErrorCode::CredentialsPluginMissing,
        RunError::Cancelled(_) => ErrorCode::CredentialsPluginCancelled,
        _ => ErrorCode::CredentialsPluginFailed,
    }
}

fn server(status: &Status) -> ServerStatus {
    ServerStatus {
        reason: status.reason.clone(),
        causes: status
            .details
            .iter()
            .flat_map(|details| &details.causes)
            .map(|cause| ServerCause {
                reason: cause.reason.clone(),
                field: cause.field.clone(),
                message: cause.message.clone(),
            })
            .collect(),
    }
}

/// The status a refused request answers with, as kube's
/// `handle_api_errors` reads it, which `Client::send` leaves to its caller.
pub fn refused(status: StatusCode, body: &[u8]) -> kube::Error {
    let status = serde_json::from_slice::<Status>(body).unwrap_or_else(|_| {
        Status::failure(&String::from_utf8_lossy(body), "Failed to parse error data")
            .with_code(status.as_u16())
    });
    kube::Error::Api(status.boxed())
}

/// What the gate said, when it stopped the request.
pub fn gate(error: &kube::Error) -> Option<&Blocked> {
    match error {
        kube::Error::Service(service) => find(&**service),
        _ => None,
    }
}

/// Whether a proxied request found the proxy's budget full.
pub fn over_budget(error: &kube::Error) -> bool {
    let kube::Error::Service(service) = error else {
        return false;
    };
    find::<crate::client::OverBudget>(&**service).is_some()
}

/// Whether the context's plugin or oidc provider gave the request no
/// credential.
pub fn no_credential(error: &kube::Error) -> bool {
    match error {
        kube::Error::Auth(_) => true,
        kube::Error::Service(error) => {
            find::<CredentialError>(&**error).is_some() || find::<OidcError>(&**error).is_some()
        }
        _ => false,
    }
}

/// The first `T` in the chain of `error` and its causes.
pub(crate) fn find<'a, T: std::error::Error + 'static>(
    error: &'a (dyn std::error::Error + 'static),
) -> Option<&'a T> {
    std::iter::successors(Some(error), |error| error.source())
        .find_map(|error| error.downcast_ref())
}

#[cfg(test)]
mod tests {
    use kube::core::Status;
    use kube::core::response::{StatusCause, StatusDetails};
    use twigo_ipc::ErrorKind;

    use super::*;

    fn status(code: u16) -> ErrorCode {
        let status = Status::failure("no", "Reason").with_code(code);
        request(&kube::Error::Api(Box::new(status))).code
    }

    #[test]
    fn codes() {
        assert_eq!(status(401), ErrorCode::ServerUnauthorized);
        assert_eq!(status(403), ErrorCode::ServerForbidden);
        assert_eq!(status(404), ErrorCode::ServerNotFound);
        assert_eq!(status(504), ErrorCode::ServerTimeout);
        assert_eq!(status(503), ErrorCode::ServerUnavailable);
        assert_eq!(status(418), ErrorCode::ServerOther);
        let timed_out = kube::Error::Service(tower::timeout::error::Elapsed::new().into());
        assert_eq!(request(&timed_out).code, ErrorCode::ConnectTimeout);
        assert!(!no_credential(&timed_out));
        let refused = kube::Error::Service(std::io::Error::other("refused").into());
        let refused = request(&refused);
        assert_eq!(refused.code, ErrorCode::ConnectOther);
        assert_eq!(refused.kind, ErrorKind::Unavailable);
        let plugin = |error: CredentialError| kube::Error::Service(error.into());
        let missing = plugin(CredentialError::Run(RunError::NotFound("aws".to_owned())));
        assert_eq!(request(&missing).code, ErrorCode::CredentialsPluginMissing);
        assert!(no_credential(&missing));
        let slow = plugin(CredentialError::Run(RunError::Timeout {
            command: "aws".to_owned(),
            after: std::time::Duration::from_secs(120),
        }));
        assert_eq!(request(&slow).code, ErrorCode::CredentialsPluginTimeout);
        assert!(no_credential(&slow));
    }

    #[test]
    fn the_server_says_what_was_wrong_in_its_own_words() {
        let status = Status::failure("field label not supported: spec.containers", "BadRequest")
            .with_code(400);
        let refused = request(&kube::Error::Api(Box::new(status)));
        assert_eq!(
            (refused.code, refused.message.as_str()),
            (
                ErrorCode::ServerInvalid,
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

    #[test]
    fn the_servers_reason_and_causes_are_data_and_never_a_code() {
        let invalid = Status::failure("Deployment \"web\" is invalid", "Invalid")
            .with_code(422)
            .with_details(StatusDetails {
                name: "web".to_owned(),
                group: "apps".to_owned(),
                kind: "Deployment".to_owned(),
                uid: String::new(),
                causes: vec![StatusCause {
                    reason: "FieldValueInvalid".to_owned(),
                    message: "Invalid value: -1: must be non-negative".to_owned(),
                    field: "spec.replicas".to_owned(),
                }],
                retry_after_seconds: 0,
            });
        let refused = request(&kube::Error::Api(Box::new(invalid)));
        assert_eq!(refused.code, ErrorCode::ServerInvalid);
        assert_eq!(
            refused.server,
            Some(ServerStatus {
                reason: "Invalid".to_owned(),
                causes: vec![ServerCause {
                    reason: "FieldValueInvalid".to_owned(),
                    field: "spec.replicas".to_owned(),
                    message: "Invalid value: -1: must be non-negative".to_owned(),
                }],
            })
        );
        let aggregated = Status::failure("no", "SomethingAnAggregatedApiMade").with_code(404);
        let refused = request(&kube::Error::Api(Box::new(aggregated)));
        assert_eq!(refused.code, ErrorCode::ServerNotFound);
        assert_eq!(
            refused.server.map(|server| server.reason).as_deref(),
            Some("SomethingAnAggregatedApiMade")
        );
    }
}
