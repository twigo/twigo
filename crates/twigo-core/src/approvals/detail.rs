//! What an ask shows of what its request would do (`ApprovalDetail`): a
//! write of a resource itself is dry-run through the same actor's clients
//! and compared with the live object, both sides as an apply's diff shows
//! them, a Secret's values masked and none of the server's words about it
//! shown; a delete shows its propagation, an exec what it runs. The dry run goes only to
//! groups kube-apiserver serves itself: an aggregated server that ignored
//! `dryRun` would perform the write before the person answers, as the gate
//! lets `dryRun=All` through as a dry run.

use std::collections::HashMap;
use std::sync::Mutex;

use bytes::Bytes;
use http::header::{ACCEPT, HeaderValue};
use http::request::Parts;
use http::{Method, Request};
use jiff::{SignedDuration, Timestamp};
use kube::Client;
use serde_json::Value;
use twigo_ipc::{ApprovalDetail, NoDiff, RequestClass};
use twigo_policy::Attributes;

use super::Approvals;
use crate::actions::{send, side};
use crate::proxy::Holder;

/// The largest body an ask shows as sent.
const SHOWN_BODY: usize = 4 << 10;
/// How long whether kube-apiserver serves a group/version itself is kept.
const SERVED_FOR: SignedDuration = SignedDuration::from_mins(5);
/// What an ask says in place of the server's words about a Secret, its
/// refusal's or its warnings': a refusal of a patch quotes the patched
/// Secret whole
/// ([`applyPatchToCurrentObject`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/patch.go#L334-L358)),
/// values the request never named among them, so no list of values can say
/// what to take out.
const UNSAID: &str = "Twigo does not show its words, which may quote the Secret's values";

/// Whether kube-apiserver serves each group/version itself, by context,
/// connection and APIService.
#[derive(Default)]
pub(crate) struct Served(Mutex<HashMap<(String, u64, String), Read>>);

#[derive(Clone, Copy)]
struct Read {
    /// By the wall clock, which runs on while the machine sleeps.
    until: Timestamp,
    itself: bool,
}

pub(crate) async fn of(
    approvals: &Approvals,
    api: &Client,
    holder: &Holder,
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
        match diff(approvals, api, holder, parts, body, secret).await {
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
    approvals: &Approvals,
    api: &Client,
    holder: &Holder,
    parts: &Parts,
    body: &Bytes,
    secret: bool,
) -> Result<ApprovalDetail, NoDiff> {
    let dry_run = dry_run(parts, body);
    let class = Attributes::of(&dry_run).class;
    if !matches!(class, RequestClass::DryRun | RequestClass::SecretRead) {
        // The reviews of authorization.k8s.io answer whatever `dryRun`
        // says.
        return Err(NoDiff::NotAResource);
    }
    if let Some((group, version)) = group_version(parts.uri.path()) {
        approvals.served.itself(api, holder, group, version).await?;
    }
    let (result, mut warnings) = send(api, dry_run).await.map_err(|error| {
        let message = match &error {
            _ if secret => UNSAID.to_owned(),
            kube::Error::Api(status) if !status.message.is_empty() => status.message.clone(),
            _ => error.to_string(),
        };
        NoDiff::Refused { message }
    })?;
    if secret && !warnings.is_empty() {
        warnings = vec![UNSAID.to_owned()];
    }
    let live = if parts.method == Method::POST {
        Value::Null
    } else {
        live(api, parts).await
    };
    Ok(ApprovalDetail::Diff {
        live: side(live),
        result: side(result),
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

/// The group and version of a path outside the core group.
fn group_version(path: &str) -> Option<(&str, &str)> {
    let mut segments = path.trim_start_matches('/').split('/');
    match (segments.next(), segments.next(), segments.next()) {
        (Some("apis"), Some(group), Some(version)) => Some((group, version)),
        _ => None,
    }
}

impl Served {
    /// Whether kube-apiserver serves `group/version` itself: its APIService
    /// names no `spec.service`
    /// ([`APIServiceSpec`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/kube-aggregator/pkg/apis/apiregistration/v1/types.go#L51-L57)),
    /// read as the actor and kept a while; `Unverified` when it cannot be
    /// read.
    async fn itself(
        &self,
        api: &Client,
        holder: &Holder,
        group: &str,
        version: &str,
    ) -> Result<(), NoDiff> {
        let key = (
            holder.context.clone(),
            holder.connection,
            format!("{version}.{group}"),
        );
        let kept = self.0.lock().expect("served lock").get(&key).copied();
        let itself = match kept {
            Some(read) if Timestamp::now() < read.until => read.itself,
            _ => {
                let path = format!("/apis/apiregistration.k8s.io/v1/apiservices/{}", key.2);
                let request = Request::get(path).body(Vec::new()).expect("a path");
                let (service, _) = send(api, request).await.map_err(|_| NoDiff::Unverified)?;
                let itself = service["spec"]["service"].is_null();
                let until = Timestamp::now()
                    .saturating_add(SERVED_FOR)
                    .unwrap_or(Timestamp::MAX);
                let read = Read { until, itself };
                self.0.lock().expect("served lock").insert(key, read);
                itself
            }
        };
        if itself {
            Ok(())
        } else {
            Err(NoDiff::Aggregated)
        }
    }
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
        assert_eq!(Attributes::of(&dry).class, RequestClass::DryRun);
        let create = parts(Method::POST, "/api/v1/namespaces/a/configmaps");
        assert_eq!(
            dry_run(&create, &Bytes::new()).uri(),
            "/api/v1/namespaces/a/configmaps?dryRun=All"
        );
        assert_eq!(
            group_version("/apis/apps/v1/namespaces/a/deployments"),
            Some(("apps", "v1"))
        );
        assert_eq!(group_version("/api/v1/namespaces/a/configmaps"), None);
    }
}
