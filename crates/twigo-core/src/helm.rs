//! Helm releases (ARCHITECTURE 3.6): the Secrets Helm keeps them in,
//! followed through the hub by Helm's own label, as a list of one row a
//! release, an open release's revisions, and two revisions compared.

mod fetch;
mod release;
mod releases;

use twigo_cache::batcher::Batcher;
use twigo_cache::hub::{Hub, Query, Resource, RowFormat};
use twigo_cache::request::Selectors;
use twigo_cache::view::Spec;
use twigo_ipc::{
    CompareRevisions, ComparedRevisions, Gvr, IpcError, ListBatch, ListQuery, OpenRelease,
    ReleaseBatch, ReleaseListQuery,
};

pub(crate) use release::{Opened, Showing, ShownPage};
use releases::Releases;

/// The seam of a list of releases, as `TWIGO_PANIC` names it.
const ITEM: &str = "helm releases";
/// What Helm lists its releases by (`List` in its Secrets driver).
const OWNER: &str = "owner=helm";

/// The metadata of the release Secrets of `namespaces` in `context`.
fn secrets(context: String, namespaces: Vec<String>) -> Query {
    Query {
        context,
        resource: Resource {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "secrets".to_owned(),
            namespaced: true,
        },
        format: RowFormat::Metadata,
        namespaces,
        selectors: Selectors {
            field: None,
            label: Some(OWNER.to_owned()),
        },
    }
}

/// The list of `query`'s releases in `context`, whose batches go through
/// `send` until it says the window is gone.
pub(crate) async fn list(
    hub: &Hub,
    context: String,
    query: ReleaseListQuery,
    send: impl FnMut(ListBatch) -> bool + Send + 'static,
) -> Result<Batcher, IpcError> {
    let spec = Spec::new(
        &context,
        &ListQuery {
            space: query.space,
            gvr: Gvr {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "secrets".to_owned(),
            },
            namespaced: true,
            namespaces: query.namespaces.clone(),
            label_selector: None,
            field_selector: None,
            owners: None,
            text: query.text,
            columns: query.columns,
            sort: query.sort,
            count_by: query.count_by,
            group_by: query.group_by,
            values: query.values,
        },
    )?;
    let secrets = hub.rows(secrets(context.clone(), query.namespaces)).await?;
    Ok(Batcher::spawn(
        ITEM,
        Releases::new(secrets, hub.clone(), context),
        spec,
        None,
        send,
    ))
}

/// The release `request` opens in `context`, whose batches go through
/// `send` until it says the window is gone.
pub(crate) async fn open(
    hub: &Hub,
    context: String,
    request: OpenRelease,
    send: impl FnMut(ReleaseBatch) -> bool + Send + 'static,
) -> Result<Opened, IpcError> {
    let OpenRelease {
        release,
        revision,
        parts,
    } = request;
    let secrets = hub
        .rows(secrets(context.clone(), vec![release.namespace.clone()]))
        .await?;
    let target = release::Target {
        hub: hub.clone(),
        context,
        namespace: release.namespace,
        name: release.name,
    };
    Ok(Opened::spawn(target, secrets, revision, parts, send))
}

/// Two revisions of a release in `context`, each fetched and decoded, then
/// masked for a comparison on the blocking pool.
pub(crate) async fn compare(
    hub: &Hub,
    context: &str,
    request: CompareRevisions,
) -> Result<ComparedRevisions, IpcError> {
    let namespace = &request.release.namespace;
    let [from, to] = [request.from, request.to]
        .map(|revision| fetch::secret_name(&request.release.name, revision));
    let page = |name| async move {
        fetch::decoded(hub, context, namespace, name, twigo_helm::page)
            .await
            .map_err(fetch::Failed::error)
    };
    let (from, to) = futures::try_join!(page(&from), page(&to))?;
    let part = request.part;
    Ok(twigo_panic::blocking(move || twigo_helm::compared(&from, &to, part)).await)
}

#[cfg(test)]
mod canary;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
