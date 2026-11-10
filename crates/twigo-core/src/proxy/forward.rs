//! An ordinary request: its body read whole, since kube's request `Body`
//! cannot stream ([`Body`](https://github.com/kube-rs/kube/blob/5.0.0/kube-client/src/client/body.rs#L33-L84)),
//! sent on the actor's api client as a proxied stream, and its answer passed
//! back frame by frame until the body ends, the process does, or, for what
//! reaches into a pod or a node, a relock that refuses it, either of which
//! ends the connection that writes it.

use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use http::request::Parts;
use http::{Request, Response};
use http_body::{Body, Frame, SizeHint};
use http_body_util::BodyExt;
use http_body_util::combinators::UnsyncBoxBody;
use tokio_util::sync::{CancellationToken, DropGuard};
use twigo_kube::client::{ActorClients, Permit, Proxied};
use twigo_policy::Approval;

use super::refusal::Refusal;
use super::server::{Answer, Writing};
use super::tokens::Holder;
use super::{Ends, headers};

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
    writing: &Writing,
    actor: &ActorClients,
    parts: Parts,
    body: Bytes,
    approval: Option<Approval>,
    ends: Ends,
) -> Sent {
    let mut request = Request::from_parts(parts, kube::client::Body::from(body));
    request.extensions_mut().insert(Proxied);
    if let Some(approval) = approval {
        request.extensions_mut().insert(approval);
    }
    let sent = tokio::select! {
        biased;
        () = holder.ended.cancelled() => return revoked(),
        sent = actor.api.send(request) => sent,
    };
    match sent {
        Ok(response) => Sent {
            response: passed(holder, writing, response, None, ends),
            reached: true,
        },
        Err(error) => failed(&holder.context, &error),
    }
}

/// The server's answer as it came, but its hop-by-hop headers, holding
/// `session`, if any, until it ends; its connection ends once the process
/// does, and, if it reaches into a pod or a node, once `ends` says.
pub(super) fn passed(
    holder: &Holder,
    writing: &Writing,
    response: Response<kube::client::Body>,
    session: Option<Permit>,
    ends: Ends,
) -> Response<ProxyBody> {
    let (mut parts, body) = response.into_parts();
    parts.headers = headers::response(&parts.headers);
    let ended = holder.ended.child_token();
    let relock = ends.reaches_in().then(|| {
        let (done, ending) = (CancellationToken::new(), ended.clone());
        let watching = done.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = watching.cancelled() => {}
                () = ends.refused() => ending.cancel(),
            }
        });
        done.drop_guard()
    });
    let body = Passed {
        body,
        _session: session,
        _answer: writing.answer(&ended),
        _relock: relock,
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

/// What a request comes to whose process ended before it was sent or while
/// it was: a request accepted before the handle dropped goes out after
/// nothing, and gets no answer of the server's.
pub(super) fn revoked() -> Sent {
    Sent {
        response: Refusal::revoked().into_response(),
        reached: true,
    }
}

pub(super) fn full(context: &str) -> Refusal {
    Refusal::too_many(format_args!(
        "the policy proxy's streams of {context} are all in use, so it sent nothing: end a watch or a log that follows"
    ))
}

/// A passed answer's body, with what it holds while it runs.
struct Passed<B> {
    body: B,
    _session: Option<Permit>,
    _answer: Answer,
    /// Ends the wait for a relock that would end it.
    _relock: Option<DropGuard>,
}

impl<B> Body for Passed<B>
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
        Pin::new(&mut self.body).poll_frame(cx).map_err(Into::into)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}
