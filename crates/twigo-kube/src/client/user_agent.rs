//! Twigo's product in every request's `User-Agent` (ARCHITECTURE 6.4), so
//! the cluster's own audit log tells Twigo's requests, and whose they are,
//! from another client's.

use std::task::{Context, Poll};

use http::Request;
use http::header::{HeaderValue, USER_AGENT};
use tower::{Layer, Service};
use twigo_policy::Actor;

#[derive(Clone)]
pub(super) struct UserAgentLayer(HeaderValue);

impl UserAgentLayer {
    /// `twigo/<version> (<actor>)`.
    pub(super) fn of(actor: Actor) -> Self {
        let product = format!("twigo/{} ({})", env!("CARGO_PKG_VERSION"), actor.name());
        Self(HeaderValue::from_str(&product).expect("a version and a name in ASCII"))
    }
}

impl<S> Layer<S> for UserAgentLayer {
    type Service = UserAgent<S>;

    fn layer(&self, inner: S) -> Self::Service {
        UserAgent {
            product: self.0.clone(),
            inner,
        }
    }
}

#[derive(Clone)]
pub(super) struct UserAgent<S> {
    product: HeaderValue,
    inner: S,
}

impl<S, B> Service<Request<B>> for UserAgent<S>
where
    S: Service<Request<B>>,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = S::Future;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }

    /// After the products of a `User-Agent` the request came with, as a
    /// process sends it through the policy proxy, since a `User-Agent` is a
    /// list of them
    /// ([RFC 9110 10.1.5](https://www.rfc-editor.org/rfc/rfc9110#section-10.1.5)),
    /// and alone on one that came with none.
    fn call(&mut self, mut request: Request<B>) -> S::Future {
        let headers = request.headers_mut();
        let mut value = Vec::new();
        for came in headers.get_all(USER_AGENT) {
            value.extend_from_slice(came.as_bytes());
            value.push(b' ');
        }
        value.extend_from_slice(self.product.as_bytes());
        let value = HeaderValue::from_bytes(&value).expect("header values joined by spaces");
        headers.insert(USER_AGENT, value);
        self.inner.call(request)
    }
}
