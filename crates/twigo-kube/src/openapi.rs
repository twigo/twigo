//! OpenAPI v3 (ARCHITECTURE 3.6): the document of one group/version, fetched
//! when something first needs it, kept on disk, and read as the JSON Schema
//! of a kind for the YAML editor ([`Document::json_schema`]) or as the shapes
//! the server merges a kind by ([`Document::shape`]).
//!
//! # What the hash covers
//!
//! `GET /openapi/v3` lists each group/version with a `serverRelativeURL` that
//! ends in `?hash=`. The hash is the document's ETag: the upper-case hex
//! SHA-512 of the JSON the server serves for it ([`computeETag`], over the
//! bytes `jsonCache` marshals, [`newOpenAPIV3Group`]), and it is the same
//! JSON that the protobuf form is served from, so it covers nothing else. A
//! request that carries another hash is redirected to the current one, and
//! only a request that carries the current one is answered with
//! `Cache-Control: public, immutable` ([`HandleGroupVersion`]).
//!
//! So the bytes under a URL with its hash are the one document that hash
//! names, however long ago they were stored and from whichever cluster: a
//! document that changed has another hash, hence another URL, and two
//! clusters share a file only when their documents are byte for byte the
//! same. That holds for every document the API server lists, as the
//! aggregator serves the index by merging those of the services behind it
//! and answers a document by passing the request, `?hash=` included, to the
//! service that listed it ([`getOpenAPIV3Root`], [`handleGroupVersion`]); a
//! service without OpenAPI v3 is converted from v2 and served by a handler of
//! the same kind ([`updateAPIServiceSpecLocked`]).
//!
//! Twigo does not take the server's word for it: a document is stored only
//! when its bytes hash to the hash in its URL, and a stored one is used only
//! when they still do, so a server that answers something else under a hash,
//! or a file that was damaged, is never used.
//!
//! The index itself changes with every document, so it is asked for on each
//! [`Document::load`] and never kept: a CRD's change gives its group a new
//! hash, and the next load sees it.
//!
//! [`computeETag`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/handler3/handler.go#L121-L126
//! [`newOpenAPIV3Group`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/handler3/handler.go#L82-L105
//! [`HandleGroupVersion`]: https://github.com/kubernetes/kube-openapi/blob/d427ff9ee9ad05f5da435abbb7c5929cb713ac56/pkg/handler3/handler.go#L223-L289
//! [`getOpenAPIV3Root`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kube-aggregator/pkg/controllers/openapiv3/aggregator/aggregator.go#L237-L255
//! [`handleGroupVersion`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kube-aggregator/pkg/controllers/openapiv3/aggregator/aggregator.go#L270-L295
//! [`updateAPIServiceSpecLocked`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kube-aggregator/pkg/controllers/openapiv3/aggregator/aggregator.go#L165-L196
//!
//! # Memory
//!
//! A [`Document`] keeps only the schemas of its `components`, not the paths
//! that make most of the bytes, and whoever loads one drops it when its
//! answer is made: the core's memory budget (ARCHITECTURE 3.8) has no room
//! for the documents of every group/version a person has edited.

mod cache;
mod schema;
mod shape;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use bytes::Bytes;
use http::header::ACCEPT;
use http::{Request, StatusCode, Uri};
use http_body_util::BodyExt;
use kube::Client;
use kube::client::Body;
use kube::core::GroupVersionKind;
use serde::Deserialize;
use serde_json::{Map, Value};
use twigo_ipc::{ErrorKind, IpcError};

use crate::errors;

pub use cache::Cache;
pub use shape::{ListType, Node};

const INDEX: &str = "/openapi/v3";

/// The schemas of one group/version's OpenAPI v3 document.
#[derive(Debug)]
pub struct Document {
    schemas: Map<String, Value>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Request(#[from] kube::Error),
    #[error("the server serves no OpenAPI document for {0}")]
    NotListed(String),
    #[error(
        "the server lists {0:?} as an OpenAPI document, which is no address of one with a hash"
    )]
    Address(String),
    #[error("the server answered {0} with something other than the document its hash names")]
    Unverified(String),
    #[error("the OpenAPI document of {0} changed again while Twigo asked for it")]
    Changing(String),
    #[error("{document} is no OpenAPI document Twigo can read: {source}")]
    Decode {
        document: String,
        #[source]
        source: serde_json::Error,
    },
}

impl From<&Error> for IpcError {
    fn from(error: &Error) -> Self {
        match error {
            Error::Request(error) => errors::request(error),
            Error::NotListed(_) => IpcError::new(ErrorKind::NotFound, error.to_string()),
            Error::Address(_)
            | Error::Unverified(_)
            | Error::Changing(_)
            | Error::Decode { .. } => IpcError::new(ErrorKind::Unavailable, error.to_string()),
        }
    }
}

#[derive(Deserialize)]
struct Index {
    paths: BTreeMap<String, Listed>,
}

#[derive(Deserialize)]
struct Listed {
    #[serde(rename = "serverRelativeURL")]
    server_relative_url: String,
}

#[derive(Deserialize)]
struct Whole {
    #[serde(default)]
    components: Components,
}

#[derive(Default, Deserialize)]
struct Components {
    #[serde(default)]
    schemas: Map<String, Value>,
}

impl Document {
    /// The document of a group/version, from `cache` or else from the server,
    /// which stores it there. `group` is empty for the core group.
    pub async fn load(
        client: &Client,
        cache: &Cache,
        group: &str,
        version: &str,
    ) -> Result<Self, Error> {
        let path = if group.is_empty() {
            format!("api/{version}")
        } else {
            format!("apis/{group}/{version}")
        };
        // The document of a group/version that changes between the index and
        // its fetch is redirected to its new hash, which the index lists by
        // then.
        for _ in 0..2 {
            let url = listed(client, &path).await?;
            if let Some(document) = fetch(client, cache, &url).await? {
                let parsed =
                    tokio::task::spawn_blocking(move || serde_json::from_slice::<Whole>(&document))
                        .await
                        .expect("reading a document does not panic");
                return parsed
                    .map(|whole| Self {
                        schemas: whole.components.schemas,
                    })
                    .map_err(|source| Error::Decode {
                        document: url,
                        source,
                    });
            }
        }
        Err(Error::Changing(path))
    }

    /// The JSON Schema (draft-07) of a kind for the YAML editor, or `None`
    /// when the document has no such kind. The kind is the root, `apiVersion`
    /// and `kind` are held to its values, and the definitions it reaches
    /// come under `definitions`.
    pub fn json_schema(&self, gvk: &GroupVersionKind) -> Option<String> {
        schema::of(self, gvk)
    }

    /// A cursor at the kind's root, or `None` when the document has no such
    /// kind.
    pub fn shape(&self, gvk: &GroupVersionKind) -> Option<Node<'_>> {
        let (_, root) = self.kind(gvk)?;
        Some(Node::definition(self, root))
    }

    /// The definition that declares the kind, by `x-kubernetes-group-version-kind`.
    fn kind(&self, gvk: &GroupVersionKind) -> Option<(&str, &Map<String, Value>)> {
        self.schemas
            .iter()
            .filter_map(|(name, schema)| Some((name.as_str(), schema.as_object()?)))
            .find(|(_, schema)| declares(schema, gvk))
    }
}

fn declares(schema: &Map<String, Value>, gvk: &GroupVersionKind) -> bool {
    let named = |entry: &Value, field: &str, wanted: &str| entry[field].as_str() == Some(wanted);
    schema
        .get("x-kubernetes-group-version-kind")
        .and_then(Value::as_array)
        .is_some_and(|kinds| {
            kinds.iter().any(|entry| {
                named(entry, "group", &gvk.group)
                    && named(entry, "version", &gvk.version)
                    && named(entry, "kind", &gvk.kind)
            })
        })
}

/// The address of a group/version's document, from the index.
async fn listed(client: &Client, path: &str) -> Result<String, Error> {
    let (_, body) = get(client, Uri::from_static(INDEX)).await?;
    let index: Index = serde_json::from_slice(&body).map_err(|source| Error::Decode {
        document: INDEX.to_owned(),
        source,
    })?;
    index
        .paths
        .into_iter()
        .find(|(listed, _)| listed == path)
        .map(|(_, listed)| listed.server_relative_url)
        .ok_or_else(|| Error::NotListed(path.to_owned()))
}

/// The bytes of the document at `url`, or `None` when the server redirected
/// the request, since it names a hash that is no longer the document's.
async fn fetch(client: &Client, cache: &Cache, url: &str) -> Result<Option<Bytes>, Error> {
    let address = || Error::Address(url.to_owned());
    let uri: Uri = url.parse().map_err(|_| address())?;
    let hash = uri
        .query()
        .and_then(|query| {
            form_urlencoded::parse(query.as_bytes())
                .find(|(name, _)| name == "hash")
                .map(|(_, hash)| hash.into_owned())
        })
        .filter(|_| uri.path().starts_with("/openapi/v3/"))
        .ok_or_else(address)?;

    let stored = {
        let (cache, url, hash) = (cache.clone(), url.to_owned(), hash.clone());
        tokio::task::spawn_blocking(move || {
            let document = cache.load(&url)?.filter(|document| names(&hash, document));
            Ok::<_, std::io::Error>(document)
        })
        .await
        .expect("reading a file does not panic")
    };
    match stored {
        Ok(Some(document)) => return Ok(Some(document)),
        Ok(None) => {}
        Err(error) => eprintln!("could not read the cached OpenAPI document {url}: {error}"),
    }

    let (status, document) = get(client, uri).await?;
    if status == StatusCode::MOVED_PERMANENTLY {
        return Ok(None);
    }
    if !names(&hash, &document) {
        return Err(Error::Unverified(url.to_owned()));
    }
    let stored = {
        let (cache, url, document) = (cache.clone(), url.to_owned(), document.clone());
        tokio::task::spawn_blocking(move || cache.store(&url, &document))
            .await
            .expect("writing a file does not panic")
    };
    if let Err(error) = stored {
        eprintln!("could not cache the OpenAPI document {url}: {error}");
    }
    Ok(Some(document))
}

/// A successful answer's body, or a redirect, which `Client::send` leaves to
/// its caller.
async fn get(client: &Client, uri: Uri) -> Result<(StatusCode, Bytes), Error> {
    let request = Request::get(uri)
        .header(ACCEPT, "application/json")
        .body(Body::from(Vec::new()))
        .expect("a parsed address and a constant header form a valid request");
    let response = client.send(request).await?;
    let status = response.status();
    let body = response.into_body().collect().await?.to_bytes();
    if status != StatusCode::MOVED_PERMANENTLY && !status.is_success() {
        return Err(Error::Request(errors::refused(status, &body)));
    }
    Ok((status, body))
}

/// Whether `document` is the one that `hash` names.
fn names(hash: &str, document: &[u8]) -> bool {
    let digest = ring::digest::digest(&ring::digest::SHA512, document);
    let hex: String = digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    hex.eq_ignore_ascii_case(hash)
}
