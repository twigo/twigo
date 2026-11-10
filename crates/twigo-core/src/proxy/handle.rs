//! What a request meets at the proxy, in order (ARCHITECTURE 6.4): where it
//! comes from, its token, its path, its context's cluster, its identity,
//! its body, and the gate's decision, which in `guarded` may go to the
//! approval broker; then it goes on, as an ordinary request or an upgrade.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Weak};

use bytes::Bytes;
use http::header::{AUTHORIZATION, HOST, ORIGIN, UPGRADE};
use http::request::Parts;
use http::{HeaderMap, Request, Response, Uri};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use hyper::body::Incoming;
use percent_encoding::percent_decode_str;
use ring::digest::SHA256;
use twigo_ipc::BlockReason;
use twigo_kube::client::ActorClients;
use twigo_policy::{Approval, Attributes};

use super::forward::{BODY_LIMIT, ProxyBody};
use super::refusal::Refusal;
use super::splice::Upgrade;
use super::tokens::{self, Digest, Holder};
use super::{Changes, forward, headers, splice};
use crate::Core;
use crate::approvals::{Asking, Outcome, detail};

pub(super) async fn handle(
    core: Weak<Core>,
    address: SocketAddr,
    request: Request<Incoming>,
) -> Result<Response<ProxyBody>, Infallible> {
    let Some(core) = core.upgrade() else {
        return Ok(Refusal::unavailable("Twigo is quitting").into_response());
    };
    Ok(serve(&core, address, request)
        .await
        .unwrap_or_else(Refusal::into_response))
}

async fn serve(
    core: &Core,
    address: SocketAddr,
    mut request: Request<Incoming>,
) -> Result<Response<ProxyBody>, Refusal> {
    from_here(&request, address)?;
    let holder = holder(core, request.headers())?;
    let path = path(request.uri(), &holder)?;
    if core.policy.connection(&holder.context) != Some(holder.connection) {
        return Err(Refusal::moved(&holder.context));
    }
    one_identity(core, &holder, request.headers()).await?;
    let upgrade = request.headers().contains_key(UPGRADE);
    // Before the request's parts move on.
    let client = upgrade.then(|| hyper::upgrade::on(&mut request));
    let (mut parts, body) = request.into_parts();
    let body = if upgrade {
        Bytes::new()
    } else {
        read(body).await?
    };
    parts.uri = path
        .parse()
        .map_err(|_| Refusal::bad_request("the request's path is no URI"))?;
    parts.headers = headers::request(&parts.headers, upgrade);
    parts.extensions = http::Extensions::new();
    let read = Request::from_parts(parts, ());
    let attributes = Attributes::of(&read);
    let (parts, ()) = read.into_parts();

    let (clients, actor) = core.proxy.clients(core, &holder).await?;
    // Before anything is sent, so a relock meanwhile reaches a splice.
    let changes = Changes::new(&core.policy, &core.catalog.subscribe());
    let decided = decide(core, &holder, &actor, &attributes, &parts, &body, upgrade).await?;
    let sent = match client {
        Some(client) => {
            let upgrade = Upgrade {
                holder: &holder,
                clients: &clients,
                actor: &actor,
                policy: Arc::clone(&core.policy),
                changes,
                attributes,
                approval: decided.approval,
            };
            splice::upgrade(upgrade, parts, client).await
        }
        None => forward::send(&holder, &actor, parts, body, decided.approval).await,
    };
    if sent.reached
        && let Some(repeat) = decided.repeat
    {
        core.approvals.reached(&repeat);
    }
    Ok(sent.response)
}

/// A `Host` other than the proxy's own, or any `Origin`, is a web page's
/// request after a DNS rebinding, as kubectl proxy guards against
/// ([`accept-hosts`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/kubectl/pkg/proxy/proxy_server.go#L38-L45));
/// client-go sends no `Origin`.
fn from_here(request: &Request<Incoming>, address: SocketAddr) -> Result<(), Refusal> {
    let own = address.to_string();
    let mut hosts = request.headers().get_all(HOST).iter();
    let host = hosts
        .next()
        .is_some_and(|host| host.as_bytes() == own.as_bytes());
    let authority = request
        .uri()
        .authority()
        .is_none_or(|authority| authority.as_str() == own);
    if !(host && hosts.next().is_none() && authority) {
        return Err(Refusal::forbidden(format_args!(
            "the policy proxy answers only requests to {own}"
        )));
    }
    if request.headers().contains_key(ORIGIN) {
        return Err(Refusal::forbidden(
            "the policy proxy answers no request that carries an Origin, as a web page's does",
        ));
    }
    Ok(())
}

fn holder(core: &Core, headers: &HeaderMap) -> Result<Arc<Holder>, Refusal> {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| {
            Refusal::unauthorized(
                "the request carries no bearer token, which the policy proxy needs from its kubeconfig",
            )
        })?;
    core.proxy.holder(&tokens::of(token)).ok_or_else(|| {
        Refusal::unauthorized("the token is none Twigo gave, or its process has ended")
    })
}

/// The path from the API server's root, with the query: what follows the
/// token's own context's prefix. An empty, `.` or `..` segment is refused,
/// since a server or a proxy in front of it may clean the path into another
/// ([`path.Join`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/rest/request.go#L381-L392)
/// cleans `..` out of what kubectl sends): a trailing slash cleans into the
/// same path and stays.
fn path(uri: &Uri, holder: &Holder) -> Result<String, Refusal> {
    let rest = uri
        .path()
        .strip_prefix('/')
        .and_then(|path| path.strip_prefix(holder.prefix.as_str()))
        .filter(|rest| rest.is_empty() || rest.starts_with('/'))
        .ok_or_else(|| {
            Refusal::unauthorized(format_args!(
                "the token is for {}, whose paths start with /{}",
                holder.context, holder.prefix
            ))
        })?;
    let rest = if rest.is_empty() { "/" } else { rest };
    let decoded = percent_decode_str(rest).decode_utf8_lossy();
    let segments: Vec<&str> = decoded[1..].split('/').collect();
    let last = segments.len() - 1;
    let unclear = segments
        .iter()
        .enumerate()
        .any(|(at, segment)| matches!(*segment, "." | "..") || (segment.is_empty() && at != last));
    if unclear {
        return Err(Refusal::bad_request(
            "a path with an empty, . or .. segment may be cleaned into another, so Twigo sent nothing",
        ));
    }
    Ok(match uri.query() {
        Some(query) => format!("{rest}?{query}"),
        None => rest.to_owned(),
    })
}

/// `Impersonate-*` goes on, unless the context's kubeconfig acts as someone
/// already: kube appends its own headers to the request's
/// ([`ExtraHeaders`](https://github.com/kube-rs/kube/blob/5.0.0/kube-client/src/client/middleware/extra_headers.rs#L42-L45)),
/// and a request of two identities is not what the person asked for.
async fn one_identity(core: &Core, holder: &Holder, headers: &HeaderMap) -> Result<(), Refusal> {
    if !headers
        .keys()
        .any(|name| name.as_str().starts_with("impersonate-"))
    {
        return Ok(());
    }
    let contexts = core.catalog.contexts().await;
    if contexts
        .find(&holder.context)
        .is_some_and(|context| context.entries.impersonates())
    {
        return Err(Refusal::bad_request(format_args!(
            "{}'s kubeconfig acts as someone already, and the request would act as two, so Twigo sent nothing",
            holder.context
        )));
    }
    Ok(())
}

async fn read(body: Incoming) -> Result<Bytes, Refusal> {
    match Limited::new(body, BODY_LIMIT).collect().await {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(error) if error.is::<LengthLimitError>() => Err(Refusal::too_large(BODY_LIMIT)),
        Err(error) => Err(Refusal::bad_request(format_args!(
            "the request's body could not be read: {error}"
        ))),
    }
}

#[derive(Default)]
struct Decided {
    approval: Option<Approval>,
    /// The repeat a "once" covers until a request of it reaches the server.
    repeat: Option<Digest>,
}

/// The gate's decision without an approval, asked only to know whether to
/// ask the person: the request still meets the gate with whatever approval
/// the broker gives it.
async fn decide(
    core: &Core,
    holder: &Holder,
    actor: &ActorClients,
    attributes: &Attributes,
    parts: &Parts,
    body: &Bytes,
    upgrade: bool,
) -> Result<Decided, Refusal> {
    let blocked = match core
        .policy
        .authorize(&holder.context, attributes, holder.actor)
    {
        Ok(()) => return Ok(Decided::default()),
        Err(blocked) if blocked.reason == BlockReason::NoApproval => blocked,
        Err(blocked) => return Err(Refusal::blocked(&blocked)),
    };
    let header = |name: &str| {
        let value = parts.headers.get(name)?.to_str().ok()?;
        Some(value.to_owned())
    };
    let asking = Asking {
        holder,
        attributes,
        blocked,
        repeat: repeat(holder, parts, upgrade, body),
        command: header("kubectl-command"),
        impersonate: header("impersonate-user"),
    };
    let detail = detail::of(&core.approvals, &actor.api, holder, attributes, parts, body);
    match core.approvals.decide(asking, detail).await {
        Outcome::Approved { approval, repeat } => Ok(Decided {
            approval: Some(approval),
            repeat,
        }),
        Outcome::Denied(message) => Err(Refusal::forbidden(message)),
        Outcome::Decided(Ok(())) => Ok(Decided::default()),
        Outcome::Decided(Err(blocked)) => Err(Refusal::blocked(&blocked)),
        Outcome::Moved => Err(Refusal::moved(&holder.context)),
        Outcome::Ended => Err(Refusal::forbidden("the process's token was revoked")),
    }
}

/// What one answer covers for a while: the same token, path, query and body,
/// and the same method but for an upgrade, which kubectl repeats over SPDY
/// as a `POST` after a refused WebSocket `GET`
/// ([`NewFallbackExecutor`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/remotecommand/fallback.go#L53-L60)).
fn repeat(holder: &Holder, parts: &Parts, upgrade: bool, body: &Bytes) -> Digest {
    let mut digest = ring::digest::Context::new(&SHA256);
    digest.update(&holder.digest);
    let method = if upgrade {
        "upgrade"
    } else {
        parts.method.as_str()
    };
    for part in [
        method,
        parts.uri.path(),
        parts.uri.query().unwrap_or_default(),
    ] {
        digest.update(&(part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    digest.update(ring::digest::digest(&SHA256, body).as_ref());
    digest
        .finish()
        .as_ref()
        .try_into()
        .expect("SHA-256 is 32 bytes")
}
