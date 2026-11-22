//! Helm releases as a list (ARCHITECTURE 3.6): the Secrets Helm keeps them
//! in, followed through the hub by Helm's own label, and one row a release.

mod releases;

use twigo_cache::batcher::Batcher;
use twigo_cache::hub::{Hub, Query, Resource, RowFormat};
use twigo_cache::request::Selectors;
use twigo_cache::view::Spec;
use twigo_ipc::{Gvr, IpcError, ListBatch, ListQuery, ReleaseListQuery};

use releases::Releases;

/// The seam of a list of releases, as `TWIGO_PANIC` names it.
const ITEM: &str = "helm releases";
/// What Helm lists its releases by (`List` in its Secrets driver).
const OWNER: &str = "owner=helm";

/// The list of `query`'s releases in `context`, whose batches go through
/// `send` until it says the window is gone.
pub(crate) async fn list(
    hub: &Hub,
    context: String,
    query: ReleaseListQuery,
    send: impl FnMut(ListBatch) -> bool + Send + 'static,
) -> Result<Batcher, IpcError> {
    let secrets = Gvr {
        group: String::new(),
        version: "v1".to_owned(),
        resource: "secrets".to_owned(),
    };
    let spec = Spec::new(
        &context,
        &ListQuery {
            space: query.space,
            gvr: secrets.clone(),
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
    let secrets = hub
        .rows(Query {
            context,
            resource: Resource {
                group: secrets.group,
                version: secrets.version,
                resource: secrets.resource,
                namespaced: true,
            },
            format: RowFormat::Metadata,
            namespaces: query.namespaces,
            selectors: Selectors {
                field: None,
                label: Some(OWNER.to_owned()),
            },
        })
        .await?;
    Ok(Batcher::spawn(
        ITEM,
        Releases::new(secrets),
        spec,
        None,
        send,
    ))
}

#[cfg(test)]
mod tests;
