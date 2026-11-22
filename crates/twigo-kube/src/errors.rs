//! How a request's failure reaches the webview (`IpcError`).

use std::io;

use http::StatusCode;
use kube::core::Status;
use rustls::CertificateError;
use tower::timeout::error::Elapsed;
use twigo_ipc::{Blocked, ErrorCode, IpcError, ServerCause, ServerStatus};

use crate::client::dial::{ProxyRefused, ProxyUnreachable, Unresolved};
use crate::credentials::{CredentialError, OidcError, RunError};

/// kube-client's reason for an answer that is no `Status`: a proxy's HTML or
/// an API path that does not exist answers text (`handle_api_errors`).
const NOT_A_STATUS: &str = "Failed to parse error data";

/// A request's failure: the API server's status in its own words, rather
/// than kube's `ApiError: … (Status { … })`, with its reason and causes as
/// data, else why the request got no answer.
pub fn request(error: &kube::Error) -> IpcError {
    if let Some(blocked) = gate(error) {
        return blocked.clone().into();
    }
    let (code, message) = match error {
        kube::Error::Api(status) => return Said::from(&**status).refused(),
        kube::Error::Auth(_) => (ErrorCode::CredentialsUnusable, error.to_string()),
        kube::Error::Service(inner) if let Some(error) = find::<CredentialError>(&**inner) => {
            let (CredentialError::Run(run) | CredentialError::SignInFailed(run)) = error;
            (plugin_code(run), error.to_string())
        }
        kube::Error::Service(inner) if find::<OidcError>(&**inner).is_some() => {
            (ErrorCode::CredentialsOidcRefresh, error.to_string())
        }
        kube::Error::Service(inner) => transport(&**inner),
        kube::Error::HyperError(inner) => transport(inner),
        kube::Error::UpgradeConnection(inner) => upgrade(inner),
        kube::Error::ReadEvents(_) => (ErrorCode::ConnectLost, error.to_string()),
        kube::Error::SerdeError(_)
        | kube::Error::FromUtf8(_)
        | kube::Error::LinesCodecMaxLineLengthExceeded => {
            (ErrorCode::AnswerUndecodable, error.to_string())
        }
        _ => (ErrorCode::InternalRequest, error.to_string()),
    };
    IpcError::new(code, message)
}

/// What a `Status` says, as either of its two types carries it: kube's, which
/// a request's refusal comes as, and k8s-openapi's, which an exec's end
/// carries over its channel.
struct Said {
    code: u16,
    message: String,
    reason: String,
    causes: Vec<ServerCause>,
}

impl Said {
    /// The error for it: the server's own words and `server` as data, which a
    /// body that was no `Status` has none of.
    fn refused(self) -> IpcError {
        let is_status = self.reason != NOT_A_STATUS;
        let message = match (
            self.message.is_empty(),
            self.reason.is_empty() || !is_status,
        ) {
            (false, _) => self.message,
            (true, false) => self.reason.clone(),
            (true, true) => format!("the server answered {}", self.code),
        };
        let refused = IpcError::new(server_code(self.code), message);
        if !is_status {
            return refused;
        }
        refused.with_server(ServerStatus {
            reason: self.reason,
            causes: self.causes,
        })
    }
}

impl From<&Status> for Said {
    fn from(status: &Status) -> Self {
        Self {
            code: status.code,
            message: status.message.clone(),
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
}

impl From<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Status> for Said {
    fn from(status: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Status) -> Self {
        Self {
            code: status
                .code
                .and_then(|code| u16::try_from(code).ok())
                .unwrap_or_default(),
            message: status.message.clone().unwrap_or_default(),
            reason: status.reason.clone().unwrap_or_default(),
            causes: status
                .details
                .iter()
                .flat_map(|details| details.causes.iter().flatten())
                .map(|cause| ServerCause {
                    reason: cause.reason.clone().unwrap_or_default(),
                    field: cause.field.clone().unwrap_or_default(),
                    message: cause.message.clone().unwrap_or_default(),
                })
                .collect(),
        }
    }
}

/// The error an exec's `Status` ends in, as a request's refusal is read.
pub fn exec(status: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Status) -> IpcError {
    Said::from(status).refused()
}

fn server_code(status: u16) -> ErrorCode {
    match status {
        400 | 422 => ErrorCode::ServerInvalid,
        401 => ErrorCode::ServerUnauthorized,
        403 => ErrorCode::ServerForbidden,
        404 => ErrorCode::ServerNotFound,
        409 => ErrorCode::ServerConflict,
        408 | 504 => ErrorCode::ServerTimeout,
        429 | 500..=599 => ErrorCode::ServerUnavailable,
        _ => ErrorCode::ServerOther,
    }
}

/// A WebSocket upgrade that failed: the transport's failure by its cause,
/// the server's answer that was no upgrade by its status.
fn upgrade(error: &kube::client::UpgradeConnectionError) -> (ErrorCode, String) {
    use kube::client::UpgradeConnectionError::{GetPendingUpgrade, ProtocolSwitch};
    match error {
        GetPendingUpgrade(inner) => transport(inner),
        ProtocolSwitch(status) => (server_code(status.as_u16()), error.to_string()),
        _ => (ErrorCode::ServerOther, error.to_string()),
    }
}

/// Why a request got no answer: the first cause down the chain that names a
/// condition, in Twigo's sentence with the innermost cause after it, as
/// kubectl prints `Unable to connect to the server: <inner>`.
fn transport(error: &(dyn std::error::Error + 'static)) -> (ErrorCode, String) {
    let (code, sentence) = chain(error).find_map(said).unwrap_or((
        ErrorCode::ConnectOther,
        "The connection to the cluster failed",
    ));
    if code == ErrorCode::ConnectTimeout {
        return (code, sentence.to_owned());
    }
    let inner = chain(error)
        .find_map(certificate)
        .unwrap_or_else(|| innermost(error));
    (code, format!("{sentence}: {inner}"))
}

/// The last of `error`'s causes, which says what happened where the top of
/// the chain says only that a request failed (`client error (Connect)`).
pub(crate) fn innermost(error: &(dyn std::error::Error + 'static)) -> String {
    chain(error)
        .last()
        .map_or_else(String::new, ToString::to_string)
}

fn said(cause: &(dyn std::error::Error + 'static)) -> Option<(ErrorCode, &'static str)> {
    if cause.is::<Elapsed>() {
        return Some((
            ErrorCode::ConnectTimeout,
            "The cluster did not answer in time",
        ));
    }
    if cause.is::<ProxyUnreachable>() {
        return Some((ErrorCode::ConnectProxy, "Twigo could not reach the proxy"));
    }
    if cause.is::<ProxyRefused>() {
        return Some((
            ErrorCode::ConnectProxy,
            "The proxy did not open the connection to the cluster",
        ));
    }
    if cause.is::<Unresolved>() {
        return Some((
            ErrorCode::ConnectUnresolved,
            "The cluster's name does not resolve",
        ));
    }
    if let Some(error) = cause.downcast_ref::<rustls::Error>() {
        return Some(match error {
            rustls::Error::InvalidCertificate(_) => (
                ErrorCode::ConnectCertificate,
                "The cluster's certificate cannot be verified",
            ),
            _ => (
                ErrorCode::ConnectTls,
                "The TLS connection to the cluster failed",
            ),
        });
    }
    match cause.downcast_ref::<io::Error>()?.kind() {
        io::ErrorKind::ConnectionRefused => Some((
            ErrorCode::ConnectRefused,
            "The cluster refused the connection",
        )),
        io::ErrorKind::TimedOut => Some((
            ErrorCode::ConnectTimeout,
            "The cluster did not answer in time",
        )),
        _ => None,
    }
}

/// What the verifier said of a certificate: the platform's own words for an
/// error it could not name, else rustls's name for it (`UnknownIssuer`).
fn certificate(cause: &(dyn std::error::Error + 'static)) -> Option<String> {
    match cause.downcast_ref::<rustls::Error>()? {
        rustls::Error::InvalidCertificate(CertificateError::Other(other)) => {
            Some(other.to_string())
        }
        rustls::Error::InvalidCertificate(certificate) => Some(certificate.to_string()),
        _ => None,
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

/// The status a refused request answers with, which `Client::send` leaves to
/// its caller. kube's `handle_api_errors` reads any JSON object as a `Status`,
/// since each of its fields has a default, so a gateway's `{"message": …}`
/// would come out with code 0: only a body that says its `kind` is `Status`
/// or has a code is read as one, and any other takes the response's status.
pub fn refused(status: StatusCode, body: &[u8]) -> kube::Error {
    let status = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .filter(|json| {
            json["kind"] == "Status" || json["code"].as_u64().is_some_and(|code| code > 0)
        })
        .and_then(|json| serde_json::from_value::<Status>(json).ok())
        .unwrap_or_else(|| {
            Status::failure(&String::from_utf8_lossy(body), NOT_A_STATUS).with_code(status.as_u16())
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
    chain(error).find_map(|error| error.downcast_ref())
}

/// `error`, then its causes. `io::Error::source` steps over the error it
/// wraps, which is where hyper-rustls hands over a failed handshake's, so the
/// walk goes through it.
fn chain<'a>(
    error: &'a (dyn std::error::Error + 'static),
) -> impl Iterator<Item = &'a (dyn std::error::Error + 'static)> {
    std::iter::successors(Some(error), |error| {
        match error
            .downcast_ref::<io::Error>()
            .and_then(io::Error::get_ref)
        {
            Some(wrapped) => Some(wrapped as _),
            None => error.source(),
        }
    })
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
        let other = request(&kube::Error::Service(
            std::io::Error::other("a reset").into(),
        ));
        assert_eq!(other.code, ErrorCode::ConnectOther);
        assert_eq!(other.kind, ErrorKind::Unavailable);
        assert_eq!(
            other.message,
            "The connection to the cluster failed: a reset"
        );
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

    #[test]
    fn a_held_sign_in_failure_keeps_the_code_of_the_run_it_holds() {
        let held = |run| kube::Error::Service(CredentialError::SignInFailed(run).into());
        let cancelled = held(RunError::Cancelled("kubelogin".to_owned()));
        assert_eq!(
            request(&cancelled).code,
            ErrorCode::CredentialsPluginCancelled
        );
        let missing = held(RunError::NotFound("kubelogin".to_owned()));
        assert_eq!(request(&missing).code, ErrorCode::CredentialsPluginMissing);
        assert!(no_credential(&cancelled));
    }

    #[test]
    fn an_upgrade_the_server_answered_without_upgrading_is_the_servers_answer() {
        use kube::client::UpgradeConnectionError;
        let upgrade = |error| kube::Error::UpgradeConnection(error);
        let redirected = upgrade(UpgradeConnectionError::ProtocolSwitch(StatusCode::FOUND));
        assert_eq!(request(&redirected).code, ErrorCode::ServerOther);
        let headerless = upgrade(UpgradeConnectionError::MissingUpgradeWebSocketHeader);
        assert_eq!(request(&headerless).code, ErrorCode::ServerOther);
    }

    #[test]
    fn a_body_that_is_no_status_has_no_server_status_and_a_status_keeps_its_own() {
        let text = request(&refused(
            StatusCode::BAD_GATEWAY,
            b"<html>bad gateway</html>",
        ));
        assert_eq!(text.code, ErrorCode::ServerUnavailable);
        assert_eq!(text.message, "<html>bad gateway</html>");
        assert_eq!(text.server, None);
        let status = br#"{"kind":"Status","status":"Failure","reason":"ServiceUnavailable","code":503,"message":"overloaded"}"#;
        let answered = request(&refused(StatusCode::SERVICE_UNAVAILABLE, status));
        assert_eq!(
            answered.server.map(|server| server.reason).as_deref(),
            Some("ServiceUnavailable")
        );
    }

    #[test]
    fn a_json_body_that_is_no_status_takes_the_responses_code_and_has_no_server_status() {
        let gateway = request(&refused(
            StatusCode::SERVICE_UNAVAILABLE,
            br#"{"message":"failure to get a peer from the ring-balancer"}"#,
        ));
        assert_eq!(gateway.code, ErrorCode::ServerUnavailable);
        assert_eq!(gateway.server, None);
        assert!(gateway.message.contains("ring-balancer"), "{gateway:?}");
        let coded = request(&refused(
            StatusCode::BAD_GATEWAY,
            br#"{"code":409,"message":"a conflict"}"#,
        ));
        assert_eq!(coded.code, ErrorCode::ServerConflict);
    }
}
