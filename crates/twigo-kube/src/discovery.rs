//! Aggregated discovery (ARCHITECTURE 3.6): what a cluster serves, from
//! `/api` and `/apis` in one request each, revalidated with their ETags.

mod cache;

use http::header::{ACCEPT, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use http::{HeaderValue, Request, StatusCode};
use http_body_util::BodyExt;
use kube::Client;
use kube::client::{APIGroupDiscoveryList, Body};
use kube::core::Status;
use serde::{Deserialize, Serialize};
use twigo_ipc::{ErrorKind, Gvr, IpcError, Resource};

pub use cache::Cache;

/// client-go's (`discovery_client.go`, `acceptDiscoveryFormats`): a server
/// without aggregated discovery answers with its legacy form instead of
/// 406, so one check of the answer's type catches it, as it does an
/// answer from a proxy that dropped the header.
const ACCEPT_AGGREGATED: &str =
    "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json";

#[derive(Debug, Clone, Copy)]
enum Root {
    Core,
    Groups,
}

impl Root {
    fn path(self) -> &'static str {
        match self {
            Root::Core => "/api",
            Root::Groups => "/apis",
        }
    }
}

/// A root's answer, with the ETag that revalidates it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Document {
    /// Quoted, as the server sent it.
    etag: Option<String>,
    list: APIGroupDiscoveryList,
}

/// The cluster's discovery: the core group from `/api`, the others from
/// `/apis`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Discovery {
    core: Document,
    groups: Document,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Request(#[from] kube::Error),
    #[error(
        "the server did not answer aggregated discovery, which Twigo needs: {path} came as {content_type:?}"
    )]
    NotAggregated {
        path: &'static str,
        content_type: String,
    },
    #[error("{path} answered with discovery Twigo cannot read: {source}")]
    Decode {
        path: &'static str,
        #[source]
        source: serde_json::Error,
    },
}

impl From<&Error> for IpcError {
    fn from(error: &Error) -> Self {
        match error {
            Error::Request(error) => crate::errors::request(error),
            Error::NotAggregated { .. } | Error::Decode { .. } => IpcError {
                kind: ErrorKind::Unavailable,
                message: error.to_string(),
            },
        }
    }
}

impl Discovery {
    /// Discovery from the server, or `None` when it still answers as
    /// `cached`, whose ETags it is asked with.
    pub async fn refresh(client: &Client, cached: Option<&Self>) -> Result<Option<Self>, Error> {
        let core_cached = cached.map(|cached| &cached.core);
        let groups_cached = cached.map(|cached| &cached.groups);
        let (core, groups) = tokio::try_join!(
            fetch(client, Root::Core, core_cached),
            fetch(client, Root::Groups, groups_cached),
        )?;
        if core.is_none() && groups.is_none() {
            return Ok(None);
        }
        let kept = |fetched: Option<Document>, cached: Option<&Document>| {
            fetched
                .or_else(|| cached.cloned())
                .expect("only a root asked with a cached ETag answers 304")
        };
        Ok(Some(Self {
            core: kept(core, core_cached),
            groups: kept(groups, groups_cached),
        }))
    }

    /// The resources a client may list, those it cannot watch included,
    /// which the hub lists again instead (ARCHITECTURE 3.2), each at its
    /// group's most preferred version that serves it, as client-go's
    /// `ServerPreferredResources` picks them; subresources aside.
    pub fn resources(&self) -> Vec<Resource> {
        let mut seen = std::collections::HashSet::new();
        let mut resources = Vec::new();
        let groups = self.core.list.items.iter().chain(&self.groups.list.items);
        for group in groups {
            let name = group
                .metadata
                .as_ref()
                .and_then(|meta| meta.name.as_deref())
                .unwrap_or_default();
            for version in &group.versions {
                let Some(version_name) = version.version.as_deref() else {
                    continue;
                };
                for resource in &version.resources {
                    let (Some(plural), Some(kind)) = (
                        resource.resource.as_deref(),
                        resource
                            .response_kind
                            .as_ref()
                            .and_then(|kind| kind.kind.as_deref()),
                    ) else {
                        continue;
                    };
                    if !resource.verbs.iter().any(|verb| verb == "list") {
                        continue;
                    }
                    if !seen.insert((name, plural)) {
                        continue;
                    }
                    resources.push(Resource {
                        gvr: Gvr {
                            group: name.to_owned(),
                            version: version_name.to_owned(),
                            resource: plural.to_owned(),
                        },
                        kind: kind.to_owned(),
                        singular: resource
                            .singular_resource
                            .clone()
                            .filter(|singular| !singular.is_empty())
                            .unwrap_or_else(|| kind.to_lowercase()),
                        short_names: resource.short_names.clone(),
                        namespaced: resource.scope.as_deref() == Some("Namespaced"),
                    });
                }
            }
        }
        resources
    }
}

/// A root's discovery, or `None` when the server answers `cached`'s ETag
/// with 304.
async fn fetch(
    client: &Client,
    root: Root,
    cached: Option<&Document>,
) -> Result<Option<Document>, Error> {
    let path = root.path();
    let mut request = Request::get(path)
        .header(ACCEPT, ACCEPT_AGGREGATED)
        .body(Body::from(Vec::new()))
        .expect("a constant path and headers form a valid request");
    if let Some(etag) = cached.and_then(|cached| cached.etag.as_deref())
        && let Ok(etag) = HeaderValue::from_str(etag)
    {
        request.headers_mut().insert(IF_NONE_MATCH, etag);
    }
    let response = client.send(request).await?;
    let status = response.status();
    if status == StatusCode::NOT_MODIFIED && cached.is_some() {
        return Ok(None);
    }
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value: &HeaderValue| value.to_str().ok())
            .map(str::to_owned)
    };
    let content_type = header(CONTENT_TYPE).unwrap_or_default();
    let etag = header(ETAG);
    let body = response.into_body().collect().await?.to_bytes();
    if status.is_client_error() || status.is_server_error() {
        return Err(Error::Request(api_error(status, &body)));
    }
    if !aggregated(&content_type) {
        return Err(Error::NotAggregated { path, content_type });
    }
    let list = serde_json::from_slice(&body).map_err(|source| Error::Decode { path, source })?;
    Ok(Some(Document { etag, list }))
}

/// The status a refused request answers with, as kube's
/// `handle_api_errors` reads it, which `Client::send` leaves to its caller.
fn api_error(status: StatusCode, body: &[u8]) -> kube::Error {
    let status = serde_json::from_slice::<Status>(body).unwrap_or_else(|_| {
        Status::failure(&String::from_utf8_lossy(body), "Failed to parse error data")
            .with_code(status.as_u16())
    });
    kube::Error::Api(status.boxed())
}

/// Whether a media type names `APIGroupDiscoveryList` of
/// `apidiscovery.k8s.io/v2`, whatever the order of its parameters.
fn aggregated(content_type: &str) -> bool {
    let mut parts = content_type.split(';').map(str::trim);
    if !parts
        .next()
        .is_some_and(|essence| essence.eq_ignore_ascii_case("application/json"))
    {
        return false;
    }
    let params: Vec<(&str, &str)> = parts.filter_map(|part| part.split_once('=')).collect();
    ["g=apidiscovery.k8s.io", "v=v2", "as=APIGroupDiscoveryList"]
        .iter()
        .all(|wanted| {
            let (name, value) = wanted.split_once('=').expect("name=value");
            params.contains(&(name, value))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregated_media_types() {
        assert!(aggregated(
            "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList"
        ));
        assert!(aggregated(
            "application/json; as=APIGroupDiscoveryList; v=v2; g=apidiscovery.k8s.io"
        ));
        assert!(!aggregated("application/json"));
        assert!(!aggregated(
            "application/json;g=apidiscovery.k8s.io;v=v2beta1;as=APIGroupDiscoveryList"
        ));
        assert!(!aggregated(""));
    }
}
