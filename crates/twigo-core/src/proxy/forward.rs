//! An ordinary request: its body read whole, since kube's request `Body`
//! cannot stream ([`Body`](https://github.com/kube-rs/kube/blob/5.0.0/kube-client/src/client/body.rs#L33-L84)),
//! sent on the actor's api client as a proxied stream, and its answer passed
//! back frame by frame until the body ends or the process does.

use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use http::request::Parts;
use http::{Request, Response};
use http_body::{Body, Frame, SizeHint};
use http_body_util::BodyExt;
use http_body_util::combinators::UnsyncBoxBody;
use tokio_util::sync::WaitForCancellationFutureOwned;
use twigo_kube::client::{ActorClients, Permit, Proxied};
use twigo_policy::Approval;

use super::headers;
use super::refusal::Refusal;
use super::tokens::Holder;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

pub(crate) type ProxyBody = UnsyncBoxBody<Bytes, BoxError>;

/// The API server's own limit on a write's body
/// ([`MaxRequestBodyBytes`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/server/config.go#L466-L474)).
pub(super) const BODY_LIMIT: usize = 3 << 20;

/// What a request came to, and whether it counts as having reached the
/// server: all but the proxy's own `429` and a pod's stream answered other
/// than `101` do, one the gate stopped above the socket included, since the
/// relock that stopped it ends what an answer allowed.
pub(super) struct Sent {
    pub response: Response<ProxyBody>,
    pub reached: bool,
}

pub(super) async fn send(
    holder: &Holder,
    actor: &ActorClients,
    parts: Parts,
    body: Bytes,
    approval: Option<Approval>,
) -> Sent {
    let mut request = Request::from_parts(parts, kube::client::Body::from(body));
    request.extensions_mut().insert(Proxied);
    if let Some(approval) = approval {
        request.extensions_mut().insert(approval);
    }
    match actor.api.send(request).await {
        Ok(response) => Sent {
            response: passed(holder, response, None),
            reached: true,
        },
        Err(error) => failed(&holder.context, &error),
    }
}

/// The server's answer as it came, but its hop-by-hop headers, ending once
/// the process does, and holding `session`, if any, until it ends.
pub(super) fn passed(
    holder: &Holder,
    response: Response<kube::client::Body>,
    session: Option<Permit>,
) -> Response<ProxyBody> {
    let (mut parts, body) = response.into_parts();
    parts.headers = headers::response(&parts.headers);
    let body = Until {
        body,
        ended: Box::pin(holder.ended.clone().cancelled_owned()),
        _session: session,
    };
    Response::from_parts(parts, body.boxed_unsync())
}

/// What a request that got no answer from the server comes to.
pub(super) fn failed(context: &str, error: &kube::Error) -> Sent {
    let (refusal, reached) = if let Some(blocked) = twigo_kube::errors::gate(error) {
        (Refusal::blocked(blocked), true)
    } else if twigo_kube::errors::over_budget(error) {
        (full(context), false)
    } else {
        (Refusal::unreachable(error), true)
    };
    Sent {
        response: refusal.into_response(),
        reached,
    }
}

pub(super) fn full(context: &str) -> Refusal {
    Refusal::too_many(format_args!(
        "the policy proxy's streams of {context} are all in use, so it sent nothing: end a watch or a log that follows"
    ))
}

/// A response's body that ends with an error once its process's handle
/// drops, which hyper turns into a cut connection.
struct Until<B> {
    body: B,
    ended: Pin<Box<WaitForCancellationFutureOwned>>,
    _session: Option<Permit>,
}

impl<B> Body for Until<B>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        if self.ended.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Some(Err("the process's token was revoked".into())));
        }
        Pin::new(&mut self.body).poll_frame(cx).map_err(Into::into)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}
