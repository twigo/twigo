//! An upgrade: a pod's exec, attach and port-forward, over WebSocket or SPDY,
//! or the proxy of a pod, a service or a node. It takes a session of the
//! context's budget, or a `429` when they are all in use, goes on the actor's
//! sessions client with an empty body, and on a `101` the two upgraded
//! connections are spliced, holding the session, as
//! kube's own `connect` takes the server's
//! ([`connect`](https://github.com/kube-rs/kube/blob/5.0.0/kube-client/src/client/mod.rs#L240-L275)).
//! Either direction's end ends both, as kube-apiserver's proxy does
//! ([`tryUpgrade`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apimachinery/pkg/util/proxy/upgradeaware.go#L403-L455)),
//! and so do the process's handle dropping, its context naming another
//! cluster, and a mode that now refuses its class whatever any approval says.

use std::sync::Arc;
use std::time::Duration;

use http::request::Parts;
use http::{Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Empty};
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use tokio::io::AsyncWriteExt;
use twigo_ipc::BlockReason;
use twigo_kube::client::{Actor, ActorClients, Class, Clients, Permit};
use twigo_policy::{Approval, Attributes, Policy};

use super::forward::{Sent, failed, passed, revoked};
use super::refusal::Refusal;
use super::server::Writing;
use super::tokens::Holder;
use super::{Changes, headers};

/// How long a spliced side gets to take its end.
const SHUTDOWN: Duration = Duration::from_secs(1);

/// What an upgrade reaches: the requests whose `Upgrade` the proxy passes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Reach {
    /// A pod's exec, attach or port-forward, which kubectl sends as a `GET`
    /// and again as a `POST`, and of which nothing runs before the kubelet's
    /// `101`
    /// ([`ServeExec`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/cri-streaming/pkg/streaming/remotecommand/exec.go#L40-L48)).
    Stream,
    /// The `proxy` subresource of a pod, a service or a node, whose answer,
    /// whatever it is, comes from the backend the request reached.
    Proxy,
}

impl Reach {
    /// None for a request that carries `Upgrade` but may not upgrade.
    pub(super) fn of(method: &Method, attributes: &Attributes) -> Option<Self> {
        if !matches!(*method, Method::GET | Method::POST) {
            return None;
        }
        if attributes.opens_a_pod_stream() {
            return Some(Self::Stream);
        }
        let proxy = attributes.path.starts_with("/api/")
            && matches!(attributes.verb.as_str(), "get" | "create")
            && matches!(
                attributes.resource.as_deref(),
                Some("pods" | "services" | "nodes")
            )
            && attributes.subresource.as_deref() == Some("proxy");
        proxy.then_some(Self::Proxy)
    }
}

pub(super) struct Upgrade<'a> {
    pub holder: &'a Holder,
    pub writing: &'a Writing,
    pub clients: &'a Clients,
    pub actor: &'a ActorClients,
    pub policy: Arc<Policy>,
    pub changes: Changes,
    pub attributes: Attributes,
    pub reach: Reach,
    pub approval: Option<Approval>,
}

pub(super) async fn upgrade(upgrade: Upgrade<'_>, parts: Parts, client: OnUpgrade) -> Sent {
    let Upgrade {
        holder,
        writing,
        clients,
        actor,
        policy,
        changes,
        attributes,
        reach,
        approval,
    } = upgrade;
    let Some(permit) = clients.try_admit(Class::Session, holder.actor) else {
        let refusal = Refusal::too_many(format_args!(
            "the sessions of {} are all in use, so Twigo sent nothing: close an exec, an attach or a port-forward",
            holder.context
        ));
        return Sent {
            response: refusal.into_response(),
            reached: false,
        };
    };
    let mut request = Request::from_parts(parts, kube::client::Body::empty());
    if let Some(approval) = approval {
        request.extensions_mut().insert(approval);
    }
    let sent = tokio::select! {
        biased;
        () = holder.ended.cancelled() => return revoked(),
        sent = actor.sessions.send(request) => sent,
    };
    let mut response = match sent {
        Ok(response) => response,
        Err(error) => return failed(&holder.context, &error),
    };
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        return Sent {
            response: passed(holder, writing, response, Some(permit)),
            reached: reach == Reach::Proxy,
        };
    }
    let server = hyper::upgrade::on(&mut response);
    let mut switched = Response::new(Empty::new().map_err(|never| match never {}).boxed_unsync());
    *switched.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    *switched.headers_mut() = headers::switched(response.headers());
    let ends = Ends {
        policy,
        changes,
        context: holder.context.clone(),
        connection: holder.connection,
        actor: holder.actor,
        attributes,
    };
    let ended = holder.ended.clone();
    let stop = async move {
        tokio::select! {
            () = ended.cancelled() => {}
            () = ends.refused() => {}
        }
    };
    tokio::spawn(splice(client, server, permit, stop));
    Sent {
        response: switched,
        reached: true,
    }
}

/// Copies both ways until either direction ends or `stop` does, holding the
/// session, then shuts both sides down: the client's TLS ends with its
/// `close_notify`, which it reads as an end rather than a cut.
async fn splice(
    client: OnUpgrade,
    server: OnUpgrade,
    _session: Permit,
    stop: impl Future<Output = ()>,
) {
    let mut stop = std::pin::pin!(stop);
    let upgraded = tokio::select! {
        upgraded = async { tokio::try_join!(client, server) } => upgraded,
        () = &mut stop => return,
    };
    let Ok((client, server)) = upgraded else {
        return;
    };
    let (mut from_client, mut to_client) = tokio::io::split(TokioIo::new(client));
    let (mut from_server, mut to_server) = tokio::io::split(TokioIo::new(server));
    tokio::select! {
        _ = tokio::io::copy(&mut from_client, &mut to_server) => {}
        _ = tokio::io::copy(&mut from_server, &mut to_client) => {}
        () = stop => {}
    }
    // A peer that reads nothing would hold a shutdown forever.
    let _ = tokio::time::timeout(SHUTDOWN, async {
        tokio::join!(to_client.shutdown(), to_server.shutdown())
    })
    .await;
}

/// What ends a splice from outside.
struct Ends {
    policy: Arc<Policy>,
    changes: Changes,
    context: String,
    connection: u64,
    actor: Actor,
    attributes: Attributes,
}

impl Ends {
    /// Returns once the context names another cluster, or its mode refuses
    /// the splice's class whatever any approval says: a relock to
    /// `read-only` ends a terminal's exec, while `guarded` ends none.
    async fn refused(mut self) {
        loop {
            self.changes.next().await;
            if self.policy.connection(&self.context) != Some(self.connection) {
                return;
            }
            if let Err(blocked) = self
                .policy
                .authorize(&self.context, &self.attributes, self.actor)
                && blocked.reason != BlockReason::NoApproval
            {
                return;
            }
        }
    }
}
