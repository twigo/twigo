//! One retry of a request the server never processed (ARCHITECTURE 3.2).
//! RFC 9113 8.7 lets a client retry those, whatever their method: streams
//! above the last one a GOAWAY names, and streams refused with
//! REFUSED_STREAM. hyper retries neither.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use h2::Reason;
use http::{Request, Response};
use kube::client::Body;
use tower::{BoxError, Layer, Service, ServiceExt};

#[derive(Clone, Copy)]
pub struct RetryLayer;

impl<S> Layer<S> for RetryLayer {
    type Service = Retry<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Retry(inner)
    }
}

#[derive(Clone)]
pub struct Retry<S>(S);

impl<S, R> Service<Request<Body>> for Retry<S>
where
    S: Service<Request<Body>, Response = Response<R>> + Clone + Send + 'static,
    S::Future: Send,
    S::Error: Into<BoxError>,
    R: Send + 'static,
{
    type Response = Response<R>;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, BoxError>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        // Readiness is the inner service's, awaited per attempt.
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let inner = self.0.clone();
        Box::pin(async move {
            let again = copy(&request);
            match inner.clone().oneshot(request).await.map_err(Into::into) {
                Err(error) if unprocessed(&*error) => match again {
                    Some(request) => inner.oneshot(request).await.map_err(Into::into),
                    None => Err(error),
                },
                done => done,
            }
        })
    }
}

/// None for a streamed body, which cannot be sent twice; kube buffers every
/// body it builds.
pub(super) fn copy(request: &Request<Body>) -> Option<Request<Body>> {
    let mut copy = Request::new(request.body().try_clone()?);
    *copy.method_mut() = request.method().clone();
    *copy.uri_mut() = request.uri().clone();
    *copy.version_mut() = request.version();
    *copy.headers_mut() = request.headers().clone();
    *copy.extensions_mut() = request.extensions().clone();
    Some(copy)
}

/// h2 gives the GOAWAY as their error only to the streams above its last
/// stream id, whatever its code, and to those opened after it; the streams
/// below run on until they end or the connection closes under them.
pub(super) fn unprocessed(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(h2) = error.downcast_ref::<h2::Error>() {
            return h2.is_remote()
                && (h2.is_go_away()
                    || (h2.is_reset() && h2.reason() == Some(Reason::REFUSED_STREAM)));
        }
        source = error.source();
    }
    false
}
