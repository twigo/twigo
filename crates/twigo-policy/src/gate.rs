//! The gate in every actor's clients (ARCHITECTURE 6.4): a request the policy
//! blocks ends at the top of the stack, before a credential plugin runs or a
//! stream's permit is taken, and one that passed is checked again just above
//! the socket, since a mode may change while it waits below.

use std::future::{Future, ready};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use http::Request;
use tower::{BoxError, Layer, Service};

use crate::{Actor, Attributes, Policy};

/// An actor's way through the policy on one context.
#[derive(Clone)]
pub struct Gate {
    policy: Arc<Policy>,
    context: Arc<str>,
    actor: Actor,
    /// What the context's connection was when the gate was made: its clients
    /// reach that, whatever the name means later.
    connection: Option<u64>,
}

impl Gate {
    pub(crate) fn new(
        policy: Arc<Policy>,
        context: &str,
        actor: Actor,
        connection: Option<u64>,
    ) -> Self {
        Self {
            connection,
            policy,
            context: context.into(),
            actor,
        }
    }

    /// The gate of the tools and tests that own the clusters they reach.
    pub fn unrestricted() -> Self {
        Policy::open().gate("", Actor::Ui)
    }

    /// The same context's gate for another actor.
    pub fn of(&self, actor: Actor) -> Self {
        Self {
            actor,
            ..self.clone()
        }
    }

    pub fn actor(&self) -> Actor {
        self.actor
    }

    pub fn layer(&self) -> GateLayer {
        GateLayer(self.clone())
    }

    pub fn recheck(&self) -> RecheckLayer {
        RecheckLayer(self.clone())
    }

    /// Whether the request may go on; `sending` where it goes out next,
    /// which the audit log notes of a write it lets through.
    fn check(&self, attributes: &Attributes, sending: bool) -> Result<(), BoxError> {
        let decided =
            self.policy
                .authorize_built(&self.context, self.connection, attributes, self.actor);
        let audit = self.policy.audit();
        match decided {
            Ok(mode) => {
                if sending {
                    audit.request(&self.context, self.actor, attributes, mode, None);
                }
                Ok(())
            }
            Err(blocked) => {
                audit.request(
                    &self.context,
                    self.actor,
                    attributes,
                    blocked.mode,
                    Some(blocked.reason),
                );
                Err(BoxError::from(*blocked))
            }
        }
    }
}

/// What the top of the stack read of the request, for the check below, where
/// its path has the server's prefix and it may have waited.
#[derive(Clone)]
struct Read(Arc<Attributes>);

type Answer<R> = Pin<Box<dyn Future<Output = Result<R, BoxError>> + Send>>;

/// Goes at the top of a client's stack, where the path starts at the API
/// server's root.
#[derive(Clone)]
pub struct GateLayer(Gate);

impl<S> Layer<S> for GateLayer {
    type Service = Gated<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Gated {
            gate: self.0.clone(),
            inner,
        }
    }
}

#[derive(Clone)]
pub struct Gated<S> {
    gate: Gate,
    inner: S,
}

impl<S, B> Service<Request<B>> for Gated<S>
where
    S: Service<Request<B>>,
    S::Error: Into<BoxError>,
    S::Future: Send + 'static,
    S::Response: Send + 'static,
{
    type Response = S::Response;
    type Error = BoxError;
    type Future = Answer<S::Response>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        self.inner.poll_ready(cx).map_err(Into::into)
    }

    fn call(&mut self, mut request: Request<B>) -> Self::Future {
        let attributes = Attributes::of(&request);
        if let Err(blocked) = self.gate.check(&attributes, false) {
            return Box::pin(ready(Err(blocked)));
        }
        request.extensions_mut().insert(Read(Arc::new(attributes)));
        let answer = self.inner.call(request);
        Box::pin(async move { answer.await.map_err(Into::into) })
    }
}

/// Goes as low in the stack as it can, below whatever a request waits for.
#[derive(Clone)]
pub struct RecheckLayer(Gate);

impl<S> Layer<S> for RecheckLayer {
    type Service = Rechecked<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Rechecked {
            gate: self.0.clone(),
            inner,
        }
    }
}

#[derive(Clone)]
pub struct Rechecked<S> {
    gate: Gate,
    inner: S,
}

impl<S, B> Service<Request<B>> for Rechecked<S>
where
    S: Service<Request<B>>,
    S::Error: Into<BoxError>,
    S::Future: Send + 'static,
    S::Response: Send + 'static,
{
    type Response = S::Response;
    type Error = BoxError;
    type Future = Answer<S::Response>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        self.inner.poll_ready(cx).map_err(Into::into)
    }

    fn call(&mut self, request: Request<B>) -> Self::Future {
        let read = request
            .extensions()
            .get::<Read>()
            .expect("the gate at the top of the stack read the request");
        if let Err(blocked) = self.gate.check(&read.0, true) {
            return Box::pin(ready(Err(blocked)));
        }
        let answer = self.inner.call(request);
        Box::pin(async move { answer.await.map_err(Into::into) })
    }
}
