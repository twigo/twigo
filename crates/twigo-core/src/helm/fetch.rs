//! One revision of a release, fetched with one `GET` of its Secret through
//! the UI's clients and decoded on the blocking pool, where a panic marks
//! that revision alone. The Secret's bytes go once it is decoded.

use std::borrow::Cow;
use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use http::header::{ACCEPT, ACCEPT_ENCODING};
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kube::client::Body;
use serde::Deserialize;
use twigo_cache::encoding;
use twigo_cache::hub::Resource;
use twigo_helm::Stored;
use twigo_ipc::{ErrorCode, IpcError};
use twigo_kube::client::Clients;

/// The seam of one revision's decode, as `TWIGO_PANIC` names it.
pub(crate) const DECODE: &str = "helm decode";

/// The revision the Secret `name` of `namespace` holds, read by `decode`;
/// `helm.revision-gone` once the Secret is gone.
pub(crate) async fn decoded<T: Send + 'static>(
    clients: &Clients,
    namespace: &str,
    name: &str,
    decode: fn(&Stored<'_>) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    let body = fetched(clients, namespace, name).await?;
    twigo_panic::contain(DECODE, twigo_panic::blocking(move || read(body, decode)))
        .await
        .unwrap_or_else(|_| Err(IpcError::panicked("reading this revision")))
}

async fn fetched(clients: &Clients, namespace: &str, name: &str) -> Result<Bytes, IpcError> {
    let secrets = Resource {
        group: String::new(),
        version: "v1".to_owned(),
        resource: "secrets".to_owned(),
        namespaced: true,
    };
    let request = Request::get(secrets.object_path(Some(namespace), name)?)
        .header(ACCEPT, "application/json")
        .header(ACCEPT_ENCODING, encoding::GZIP)
        .body(Body::from(Vec::new()))
        .expect("a checked path and constant headers form a valid request");
    let failed = |error: kube::Error| twigo_kube::errors::request(&error);
    let (parts, body) = clients
        .api
        .send(request)
        .await
        .map_err(failed)?
        .into_parts();
    let body = body.collect().await.map_err(failed)?.to_bytes();
    let body = encoding::page(&parts.headers, body).map_err(|_| {
        IpcError::new(
            ErrorCode::AnswerUndecodable,
            "the server's gzip of the Secret is damaged",
        )
    })?;
    match parts.status {
        status if status.is_success() => Ok(body),
        StatusCode::NOT_FOUND => Err(IpcError::new(
            ErrorCode::HelmRevisionGone,
            format!("Helm no longer keeps the revision in {name}"),
        )),
        status => Err(failed(twigo_kube::errors::refused(status, &body))),
    }
}

/// The fields of a Secret a revision is read from.
#[derive(Deserialize)]
struct Secret<'a> {
    #[serde(default, borrow, rename = "type")]
    kind: Cow<'a, str>,
    #[serde(borrow)]
    metadata: Metadata<'a>,
    #[serde(default, borrow)]
    data: Data<'a>,
}

#[derive(Deserialize)]
struct Metadata<'a> {
    #[serde(borrow)]
    name: Cow<'a, str>,
    #[serde(borrow)]
    namespace: Cow<'a, str>,
    #[serde(default)]
    labels: BTreeMap<String, String>,
}

#[derive(Default, Deserialize)]
struct Data<'a> {
    #[serde(default, borrow)]
    release: Option<Cow<'a, str>>,
}

/// The Secret's JSON, its `data.release` with the API's base64 taken off and
/// the body dropped before `decode` reads it.
fn read<T>(body: Bytes, decode: fn(&Stored<'_>) -> Result<T, IpcError>) -> Result<T, IpcError> {
    let undecodable = |what: &str| IpcError::new(ErrorCode::AnswerUndecodable, what.to_owned());
    let secret: Secret<'_> = serde_json::from_slice(&body).map_err(|error| {
        undecodable(&format!(
            "the Secret is not one Twigo can read: it breaks at line {}, column {}",
            error.line(),
            error.column()
        ))
    })?;
    let release = secret
        .data
        .release
        .map(|text| STANDARD.decode(text.as_bytes()))
        .transpose()
        .map_err(|_| undecodable("the server sent the Secret's release in no base64"))?;
    let (name, namespace, kind) = (
        secret.metadata.name.into_owned(),
        secret.metadata.namespace.into_owned(),
        secret.kind.into_owned(),
    );
    let labels = secret.metadata.labels;
    drop(body);
    decode(&Stored {
        name: &name,
        namespace: &namespace,
        kind: &kind,
        labels: &labels,
        release: release.as_deref(),
    })
}
