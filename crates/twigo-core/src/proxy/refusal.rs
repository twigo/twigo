//! What the proxy answers instead of the server: a Kubernetes `Status`
//! whose message starts with `Twigo: `, which kubectl prints
//! ([`transformResponse`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/rest/request.go#L1240-L1257)).

use std::fmt::Display;

use bytes::Bytes;
use http::header::{CONTENT_TYPE, RETRY_AFTER};
use http::{HeaderValue, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use serde_json::json;
use twigo_ipc::Blocked;

use super::forward::ProxyBody;

pub(super) struct Refusal {
    status: StatusCode,
    reason: &'static str,
    message: String,
}

impl Refusal {
    fn new(status: StatusCode, reason: &'static str, message: impl Display) -> Self {
        Self {
            status,
            reason,
            message: format!("Twigo: {message}"),
        }
    }

    pub(super) fn forbidden(message: impl Display) -> Self {
        Self::new(StatusCode::FORBIDDEN, "Forbidden", message)
    }

    pub(super) fn unauthorized(message: impl Display) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "Unauthorized", message)
    }

    pub(super) fn bad_request(message: impl Display) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "BadRequest", message)
    }

    /// What the gate said, in its words.
    pub(super) fn blocked(blocked: &Blocked) -> Self {
        Self::forbidden(blocked)
    }

    pub(super) fn moved(context: &str) -> Self {
        Self::forbidden(format_args!(
            "{context} names another cluster now than when this process got its token, so Twigo sent nothing"
        ))
    }

    pub(super) fn too_large(limit: usize) -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "RequestEntityTooLarge",
            format_args!(
                "the request's body is larger than the API server's {} MiB, so Twigo sent nothing",
                limit >> 20
            ),
        )
    }

    /// A budget that refuses rather than waits is full: client-go waits for
    /// `Retry-After` in whole seconds and retries up to ten times
    /// ([`checkWait`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/rest/with_retry.go#L309-L318)).
    pub(super) fn too_many(message: impl Display) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "TooManyRequests", message)
    }

    /// The context's clients could not be built or the request not sent.
    pub(super) fn unreachable(error: &impl Display) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "InternalError", error)
    }

    pub(super) fn unavailable(message: impl Display) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "ServiceUnavailable",
            message,
        )
    }

    pub(super) fn into_response(self) -> Response<ProxyBody> {
        let body = json!({
            "kind": "Status",
            "apiVersion": "v1",
            "metadata": {},
            "status": "Failure",
            "message": self.message,
            "reason": self.reason,
            "code": self.status.as_u16(),
        });
        let mut response = Response::new(
            Full::new(Bytes::from(body.to_string()))
                .map_err(|never| match never {})
                .boxed_unsync(),
        );
        *response.status_mut() = self.status;
        let headers = response.headers_mut();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if self.status == StatusCode::TOO_MANY_REQUESTS {
            headers.insert(RETRY_AFTER, HeaderValue::from_static("1"));
        }
        response
    }
}
