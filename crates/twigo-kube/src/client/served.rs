//! Who serves a group-version, read as an actor where nothing kept knows it
//! (ARCHITECTURE 6.4): the gate takes a dry run outside kube-apiserver's own
//! groups for one only once a read says kube-apiserver serves it itself, so
//! whatever sends one reads this first. The read is a `GET`, which never
//! waits on it.

use http::Request;
use k8s_openapi::kube_aggregator::pkg::apis::apiregistration::v1::APIService;
use kube::{Api, Client};
use twigo_policy::{Attributes, Gate, Server, api_service};

/// Who serves `group/version`, as its APIService says; none when it cannot
/// be read.
pub(super) async fn server(
    api: &Client,
    gate: &Gate,
    group: &str,
    version: &str,
) -> Option<Server> {
    if let Some(server) = gate.served(group, version) {
        return Some(server);
    }
    let name = api_service(group, version);
    let read = Api::<APIService>::all(api.clone()).get(&name).await.ok()?;
    let spec = read
        .spec
        .filter(|_| read.metadata.name.as_deref() == Some(&*name))?;
    let server = match spec.service {
        None => Server::Itself,
        Some(_) => Server::Aggregated,
    };
    gate.keep(group, version, server);
    Some(server)
}

/// What the gate reads of `request`, once who serves the group-version it
/// dry-runs is read.
pub(super) async fn attributes<B>(api: &Client, gate: &Gate, request: &Request<B>) -> Attributes {
    if let Some((group, version)) = Attributes::dry_run_group(request) {
        server(api, gate, &group, &version).await;
    }
    gate.attributes(request)
}
