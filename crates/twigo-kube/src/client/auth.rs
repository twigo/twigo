//! The credential Twigo gets on each request (ARCHITECTURE 6.2): its token
//! as the bearer, a plugin's certificate offered at the next handshake, and
//! on a 401 one new credential and one retry. client-go only refreshes for
//! the next request (`plugin/pkg/client/auth/exec/exec.go`, `RoundTrip`).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use http::header::AUTHORIZATION;
use http::{HeaderValue, Request, Response, StatusCode};
use kube::client::Body;
use secrecy::ExposeSecret;
use tower::{BoxError, Layer, Service, ServiceExt};

use super::connections::Connections;
use super::identity::Identity;
use super::retry::copy;
use crate::credentials::{Credential, Provider};

#[derive(Clone)]
pub struct AuthLayer {
    provider: Provider,
    identity: Arc<Identity>,
    /// Retired when the certificate changes, as client-go closes the
    /// connections the old one opened.
    connections: Option<Connections>,
}

impl AuthLayer {
    pub fn new(
        provider: Provider,
        identity: Arc<Identity>,
        connections: Option<Connections>,
    ) -> Self {
        Self {
            provider,
            identity,
            connections,
        }
    }

    async fn authorize<B>(&self, request: &mut Request<B>) -> Result<Arc<Credential>, BoxError> {
        let credential = self.provider.credential().await?;
        if let Some(token) = &credential.token {
            let mut value = HeaderValue::try_from(format!("Bearer {}", token.expose_secret()))?;
            value.set_sensitive(true);
            request.headers_mut().insert(AUTHORIZATION, value);
        }
        if self.identity.offer(&credential)?
            && let Some(connections) = &self.connections
        {
            connections.retire();
        }
        Ok(credential)
    }
}

impl<S> Layer<S> for AuthLayer {
    type Service = Auth<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Auth {
            layer: self.clone(),
            inner,
        }
    }
}

#[derive(Clone)]
pub struct Auth<S> {
    layer: AuthLayer,
    inner: S,
}

impl<S, R> Service<Request<Body>> for Auth<S>
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

    fn call(&mut self, mut request: Request<Body>) -> Self::Future {
        let layer = self.layer.clone();
        let inner = self.inner.clone();
        Box::pin(async move {
            // Before the body is sent, which takes its bytes.
            let again = copy(&request);
            let used = layer.authorize(&mut request).await?;
            let response = inner.clone().oneshot(request).await.map_err(Into::into)?;
            if response.status() != StatusCode::UNAUTHORIZED {
                return Ok(response);
            }
            layer.provider.reject(&used);
            let Some(mut again) = again else {
                return Ok(response);
            };
            layer.authorize(&mut again).await?;
            inner.oneshot(again).await.map_err(Into::into)
        })
    }
}
