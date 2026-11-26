//! One list of the Metrics API: the plain JSON, since the Table has no namespace, containers or time, gzipped.

use http::header::{ACCEPT, ACCEPT_ENCODING};
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kube::client::Body;
use twigo_kube::client::Clients;

use super::sample::{self, Samples};
use super::{GROUP, Kind, Scope};
use crate::encoding;
use crate::hub::{Resource, Scope as Path};
use crate::request::field_value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Failure {
    /// A `503` whose body is plain text and no Status, a `404` or a failed connection.
    Unavailable,
    /// A `200` that Twigo cannot decode: what the server wrote is no list of samples, or its gzip is
    /// broken. Unlike the others it is no state of the cluster, and says so in the log.
    Undecodable,
    Forbidden,
    /// A retry would only run the credential plugin again.
    Unauthorized,
}

fn uri(kind: Kind, version: &str, scope: &Scope) -> String {
    let resource = Resource {
        group: GROUP.to_owned(),
        version: version.to_owned(),
        resource: kind.resource().to_owned(),
        namespaced: kind == Kind::Pods,
    };
    match scope {
        Scope::Cluster => resource.path(&Path::Cluster),
        Scope::Namespace(namespace) => resource.path(&Path::Namespace(namespace.to_string())),
        Scope::Named { namespace, name } => {
            let selector = format!("metadata.name={}", field_value(name));
            let query = form_urlencoded::Serializer::new(String::new())
                .append_pair("fieldSelector", &selector)
                .finish();
            format!(
                "{}?{query}",
                resource.path(&Path::Namespace(namespace.to_string()))
            )
        }
    }
}

pub(super) async fn fetch(
    clients: &Clients,
    kind: Kind,
    version: &str,
    scope: &Scope,
    previous: Option<&Samples>,
) -> Result<Samples, Failure> {
    let request = Request::get(uri(kind, version, scope))
        .header(ACCEPT, "application/json")
        .header(ACCEPT_ENCODING, encoding::GZIP)
        .body(Body::from(Vec::new()))
        .expect("a path and constant headers form a valid request");
    let response = clients.api.send(request).await.map_err(|error| {
        if twigo_kube::errors::no_credential(&error) {
            Failure::Unauthorized
        } else {
            Failure::Unavailable
        }
    })?;
    let (parts, body) = response.into_parts();
    match parts.status {
        StatusCode::OK => {}
        StatusCode::FORBIDDEN => return Err(Failure::Forbidden),
        StatusCode::UNAUTHORIZED => return Err(Failure::Unauthorized),
        _ => return Err(Failure::Unavailable),
    }
    let body = body
        .collect()
        .await
        .map_err(|_| Failure::Unavailable)?
        .to_bytes();
    let body = encoding::page(&parts.headers, body).map_err(|_| Failure::Undecodable)?;
    sample::parse(&body, kind, previous).map_err(|_| Failure::Undecodable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_is_a_path_and_a_pod_alone_a_field_selector() {
        assert_eq!(
            uri(Kind::Pods, "v1beta1", &Scope::Cluster),
            "/apis/metrics.k8s.io/v1beta1/pods"
        );
        assert_eq!(
            uri(Kind::Pods, "v1", &Scope::Namespace("a".into())),
            "/apis/metrics.k8s.io/v1/namespaces/a/pods"
        );
        assert_eq!(
            uri(Kind::Nodes, "v1beta1", &Scope::Cluster),
            "/apis/metrics.k8s.io/v1beta1/nodes"
        );
        assert_eq!(
            uri(
                Kind::Pods,
                "v1beta1",
                &Scope::Named {
                    namespace: "a".into(),
                    name: "web,0=1".into()
                }
            ),
            "/apis/metrics.k8s.io/v1beta1/namespaces/a/pods?fieldSelector=metadata.name%3Dweb%5C%2C0%5C%3D1"
        );
    }
}
