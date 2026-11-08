//! What goes with deleted objects (ARCHITECTURE 6.5). The garbage collector
//! deletes an object once every owner it names is gone, so what goes is
//! each object whose owners are all among those deleted, and in turn what
//! those own. Twigo reads the objects the core's controllers make, by the
//! kind that makes them, as metadata only: no write leaves before the
//! person confirms.

use std::collections::{HashMap, HashSet};

use http::header::ACCEPT;
use serde::Deserialize;
use twigo_ipc::{IpcError, ObjectRef};
use twigo_kube::client::Clients;

use super::{kind_words, plural};

/// A kind the core's controllers make.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Made {
    group: &'static str,
    version: &'static str,
    resource: &'static str,
    kind: &'static str,
}

const REPLICA_SETS: Made = Made {
    group: "apps",
    version: "v1",
    resource: "replicasets",
    kind: "ReplicaSet",
};
const PODS: Made = Made {
    group: "",
    version: "v1",
    resource: "pods",
    kind: "Pod",
};
const REVISIONS: Made = Made {
    group: "apps",
    version: "v1",
    resource: "controllerrevisions",
    kind: "ControllerRevision",
};
const CLAIMS: Made = Made {
    group: "",
    version: "v1",
    resource: "persistentvolumeclaims",
    kind: "PersistentVolumeClaim",
};
const JOBS: Made = Made {
    group: "batch",
    version: "v1",
    resource: "jobs",
    kind: "Job",
};
const SLICES: Made = Made {
    group: "discovery.k8s.io",
    version: "v1",
    resource: "endpointslices",
    kind: "EndpointSlice",
};

/// What each kind's controller makes, by its group and resource: a
/// StatefulSet's claims are its own once its retention policy deletes them.
fn made_by(group: &str, resource: &str) -> &'static [Made] {
    match (group, resource) {
        ("apps", "deployments") => &[REPLICA_SETS],
        ("apps", "replicasets") | ("batch", "jobs") => &[PODS],
        ("apps", "statefulsets") => &[PODS, REVISIONS, CLAIMS],
        ("apps", "daemonsets") => &[PODS, REVISIONS],
        ("batch", "cronjobs") => &[JOBS],
        ("", "services") => &[SLICES],
        _ => &[],
    }
}

/// An object that is deleted, of a namespaced resource.
pub(crate) struct Deleted<'a> {
    pub group: &'a str,
    pub resource: &'a str,
    pub namespace: &'a str,
    pub uid: &'a str,
}

/// What follows the deleted objects, in the order found, and the kinds Twigo
/// could not read to say: `Twigo cannot list replica sets in web, so it
/// cannot say what goes with it.`
pub(crate) struct Dependents {
    pub objects: Vec<ObjectRef>,
    pub unknown: Vec<String>,
}

pub(crate) async fn dependents(clients: &Clients, deleted: &[Deleted<'_>]) -> Dependents {
    let mut going: HashSet<String> = deleted.iter().map(|object| object.uid.to_owned()).collect();
    let mut needed: Vec<(Made, String)> = deleted
        .iter()
        .flat_map(|object| {
            made_by(object.group, object.resource)
                .iter()
                .map(|made| (*made, object.namespace.to_owned()))
        })
        .collect();
    let mut lists: HashMap<(Made, String), Vec<Item>> = HashMap::new();
    let mut found = Vec::new();
    let mut unknown = Vec::new();
    loop {
        for (made, namespace) in std::mem::take(&mut needed) {
            let key = (made, namespace);
            if lists.contains_key(&key) {
                continue;
            }
            let items = match list(clients, &key.0, &key.1).await {
                Ok(items) => items,
                Err(_) => {
                    unknown.push(format!(
                        "Twigo cannot list {} in {}, so it cannot say which go with it.",
                        plural(&kind_words(key.0.kind)),
                        key.1
                    ));
                    Vec::new()
                }
            };
            lists.insert(key, items);
        }
        let mut added = false;
        for ((made, namespace), items) in &lists {
            for item in items {
                let owned = !item.owners.is_empty()
                    && item.owners.iter().all(|owner| going.contains(&owner.uid));
                if owned && going.insert(item.uid.clone()) {
                    found.push(ObjectRef {
                        group: made.group.to_owned(),
                        version: made.version.to_owned(),
                        kind: made.kind.to_owned(),
                        namespace: Some(namespace.clone()),
                        name: item.name.clone(),
                    });
                    needed.extend(
                        made_by(made.group, made.resource)
                            .iter()
                            .map(|child| (*child, namespace.clone())),
                    );
                    added = true;
                }
            }
        }
        if !added {
            return Dependents {
                objects: found,
                unknown,
            };
        }
    }
}

struct Item {
    name: String,
    uid: String,
    owners: Vec<Owner>,
}

#[derive(Deserialize)]
struct Owner {
    uid: String,
}

#[derive(Deserialize)]
struct List {
    /// `null` when empty: kube-apiserver v1.37.1 lists no objects as metadata
    /// with a nil slice, which Go encodes so.
    items: Option<Vec<Listed>>,
    metadata: ListMeta,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListMeta {
    #[serde(rename = "continue", default)]
    next: Option<String>,
}

#[derive(Deserialize)]
struct Listed {
    metadata: Meta,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    name: String,
    uid: String,
    #[serde(default)]
    owner_references: Vec<Owner>,
}

/// The objects of a kind in a namespace, as metadata, a page at a time.
async fn list(clients: &Clients, made: &Made, namespace: &str) -> Result<Vec<Item>, IpcError> {
    let base = if made.group.is_empty() {
        format!("/api/{}", made.version)
    } else {
        format!("/apis/{}/{}", made.group, made.version)
    };
    let collection = format!("{base}/namespaces/{namespace}/{}", made.resource);
    let mut items = Vec::new();
    let mut next: Option<String> = None;
    loop {
        let query = {
            let mut query = form_urlencoded::Serializer::new(String::new());
            query.append_pair("limit", "500");
            if let Some(token) = &next {
                query.append_pair("continue", token);
            }
            query.finish()
        };
        let request = http::Request::get(format!("{collection}?{query}"))
            .header(
                ACCEPT,
                "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1",
            )
            .body(Vec::new())
            .expect("a collection's path makes a request");
        let page: List = clients
            .api
            .request(request)
            .await
            .map_err(|error| twigo_kube::errors::request(&error))?;
        items.extend(page.items.into_iter().flatten().map(|listed| Item {
            name: listed.metadata.name,
            uid: listed.metadata.uid,
            owners: listed.metadata.owner_references,
        }));
        match page.metadata.next.filter(|token| !token.is_empty()) {
            Some(token) => next = Some(token),
            None => return Ok(items),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::List;

    #[test]
    fn a_list_of_no_objects_as_metadata_has_none() {
        let list: List = serde_json::from_str(
            r#"{"kind":"PartialObjectMetadataList","apiVersion":"meta.k8s.io/v1","metadata":{"resourceVersion":"49774"},"items":null}"#,
        )
        .unwrap();
        assert!(list.items.into_iter().flatten().next().is_none());
    }
}
