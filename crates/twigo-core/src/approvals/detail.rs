//! What an ask shows of what its request would do (`ApprovalDetail`): a
//! write of a resource itself is dry-run through the same actor's clients
//! and compared with the live object, both sides as an apply's diff shows
//! them, a Secret's values masked and none of the server's words about it
//! shown; a delete shows its propagation, an exec what it runs. The dry run
//! goes only where the gate takes it for one, to a group-version
//! kube-apiserver serves itself: an aggregated server that ignored `dryRun`
//! would perform the write before the person answers.

use bytes::Bytes;
use http::header::{ACCEPT, HeaderValue};
use http::request::Parts;
use http::{Method, Request};
use kube::Client;
use serde_json::Value;
use twigo_ipc::{ApprovalDetail, IpcError, NoDiff, RequestClass};
use twigo_kube::client::{ActorClients, Server};
use twigo_policy::Attributes;

use crate::actions::{send, sides};

/// The largest body an ask shows as sent.
const SHOWN_BODY: usize = 4 << 10;
/// What an ask says in place of the server's words about a Secret, its
/// refusal's or its warnings': a refusal of a patch quotes the patched
/// Secret whole
/// ([`applyPatchToCurrentObject`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/patch.go#L334-L358)),
/// values the request never named among them, so no list of values can say
/// what to take out.
const UNSAID: &str = "Twigo does not show its words, which may quote the Secret's values";

pub(crate) async fn of(
    actor: &ActorClients,
    attributes: &Attributes,
    parts: &Parts,
    body: &Bytes,
) -> ApprovalDetail {
    if attributes.deletes {
        let body: Option<Value> = serde_json::from_slice(body).ok();
        let options = match attributes.subresource.as_deref() {
            Some("eviction") => body.as_ref().map(|body| &body["deleteOptions"]),
            _ => body.as_ref(),
        };
        let propagation = options
            .and_then(|options| options["propagationPolicy"].as_str())
            .map(str::to_owned);
        return ApprovalDetail::Delete { propagation };
    }
    let reason = if attributes.class == RequestClass::Exec {
        match session(attributes, parts) {
            Some(session) => return session,
            None => NoDiff::Subresource,
        }
    } else if attributes.resource.is_none() {
        NoDiff::NotAResource
    } else if attributes.subresource.is_some() {
        NoDiff::Subresource
    } else {
        let secret = attributes.resource.as_deref() == Some("secrets");
        match diff(actor, parts, body, secret).await {
            Ok(diff) => return diff,
            Err(reason) => reason,
        }
    };
    let shown = attributes.resource.as_deref() != Some("secrets") && body.len() <= SHOWN_BODY;
    ApprovalDetail::Unknown {
        reason,
        body: shown
            .then(|| String::from_utf8(body.to_vec()).ok())
            .flatten()
            .filter(|body| !body.is_empty()),
    }
}

/// What a `pods/exec` or `pods/attach` runs or joins, from its query, as
/// kubectl puts it there.
fn session(attributes: &Attributes, parts: &Parts) -> Option<ApprovalDetail> {
    let core_pods =
        parts.uri.path().starts_with("/api/") && attributes.resource.as_deref() == Some("pods");
    if !core_pods || !matches!(attributes.subresource.as_deref(), Some("exec" | "attach")) {
        return None;
    }
    let query = parts.uri.query().unwrap_or_default();
    let values = |name: &'static str| {
        form_urlencoded::parse(query.as_bytes())
            .filter(move |(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    // As the API server reads a boolean parameter: its first value, false
    // only when `0` or `false` in any case.
    let flag = |name| {
        values(name)
            .next()
            .is_some_and(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
    };
    Some(ApprovalDetail::Session {
        container: values("container").next(),
        command: values("command").collect(),
        tty: flag("tty"),
        stdin: flag("stdin"),
    })
}

async fn diff(
    actor: &ActorClients,
    parts: &Parts,
    body: &Bytes,
    secret: bool,
) -> Result<ApprovalDetail, NoDiff> {
    let dry_run = dry_run(parts, body);
    if let Some((group, version)) = Attributes::dry_run_group(&dry_run) {
        match actor.server(&group, &version).await {
            Some(Server::Itself) => {}
            Some(Server::Aggregated) => return Err(NoDiff::Aggregated),
            None => return Err(NoDiff::Unverified),
        }
    }
    let class = actor.attributes(&dry_run).await.class;
    if !matches!(class, RequestClass::DryRun | RequestClass::SecretRead) {
        // The reviews of authorization.k8s.io answer whatever `dryRun`
        // says.
        return Err(NoDiff::NotAResource);
    }
    let api = &actor.api;
    let (result, mut warnings) = send(api, dry_run).await.map_err(|error| {
        let refused = twigo_kube::errors::request(&error);
        NoDiff::Refused {
            error: if secret {
                IpcError::new(refused.code, UNSAID)
            } else {
                refused
            },
        }
    })?;
    if secret && !warnings.is_empty() {
        warnings = vec![UNSAID.to_owned()];
    }
    let live = if parts.method == Method::POST {
        Value::Null
    } else {
        live(api, parts).await
    };
    let (live, result) = sides(live, result, false);
    Ok(ApprovalDetail::Diff {
        live,
        result,
        warnings,
    })
}

/// The same request with `dryRun=All`, asking for JSON.
fn dry_run(parts: &Parts, body: &Bytes) -> Request<Vec<u8>> {
    let uri = &parts.uri;
    let path = match uri.query() {
        Some(query) => format!("{}?{query}&dryRun=All", uri.path()),
        None => format!("{}?dryRun=All", uri.path()),
    };
    let mut request = Request::new(body.to_vec());
    *request.method_mut() = parts.method.clone();
    *request.uri_mut() = path.parse().expect("the request's path with a parameter");
    *request.headers_mut() = parts.headers.clone();
    request
        .headers_mut()
        .insert(ACCEPT, HeaderValue::from_static("application/json"));
    request
}

/// The object as it is, as the request's identity reads it; none when it
/// does not exist, as before a create, or cannot be read.
async fn live(api: &Client, parts: &Parts) -> Value {
    let mut request = Request::new(Vec::new());
    *request.uri_mut() = parts.uri.path().parse().expect("the request's path");
    let headers = request.headers_mut();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    for (name, value) in &parts.headers {
        if name.as_str().starts_with("impersonate-") {
            headers.append(name, value.clone());
        }
    }
    send(api, request)
        .await
        .map_or(Value::Null, |(object, _)| object)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(method: Method, uri: &str) -> Parts {
        Request::builder()
            .method(method)
            .uri(uri)
            .body(())
            .unwrap()
            .into_parts()
            .0
    }

    #[test]
    fn an_exec_shows_what_it_runs_and_an_attach_what_it_joins() {
        let exec = parts(
            Method::GET,
            "/api/v1/namespaces/a/pods/p/exec?command=sh&command=-c&command=echo%20hi&container=app&stdin=true&stdout=true&tty=false",
        );
        let attributes = Attributes::of(&Request::from_parts(exec.clone(), ()));
        assert_eq!(
            session(&attributes, &exec),
            Some(ApprovalDetail::Session {
                container: Some("app".to_owned()),
                command: vec!["sh".to_owned(), "-c".to_owned(), "echo hi".to_owned()],
                tty: false,
                stdin: true,
            })
        );
        let attach = parts(Method::POST, "/api/v1/namespaces/a/pods/p/attach?tty=1");
        let attributes = Attributes::of(&Request::from_parts(attach.clone(), ()));
        assert_eq!(
            session(&attributes, &attach),
            Some(ApprovalDetail::Session {
                container: None,
                command: Vec::new(),
                tty: true,
                stdin: false,
            })
        );
        let node = parts(Method::GET, "/api/v1/nodes/n/proxy/exec/a/p/c");
        let attributes = Attributes::of(&Request::from_parts(node.clone(), ()));
        assert_eq!(session(&attributes, &node), None);
    }

    #[test]
    fn a_dry_run_is_the_same_request_with_its_parameter() {
        let patch = parts(
            Method::PATCH,
            "/apis/apps/v1/namespaces/a/deployments/d?fieldManager=kubectl",
        );
        let dry = dry_run(&patch, &Bytes::from_static(b"{}"));
        assert_eq!(
            dry.uri(),
            "/apis/apps/v1/namespaces/a/deployments/d?fieldManager=kubectl&dryRun=All"
        );
        assert_eq!(Attributes::dry_run_group(&dry), None);
        let create = parts(Method::POST, "/api/v1/namespaces/a/configmaps");
        let dry = dry_run(&create, &Bytes::new());
        assert_eq!(dry.uri(), "/api/v1/namespaces/a/configmaps?dryRun=All");
        assert_eq!(Attributes::of(&dry).class, RequestClass::DryRun);
    }
}
