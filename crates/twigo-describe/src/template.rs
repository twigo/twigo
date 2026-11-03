//! What workloads share: their pod template, as kubectl's
//! `DescribePodTemplate` prints it, and the live list of what they own.

use serde_json::Value;
use twigo_ipc::{Block, EmbeddedList, Gvr, Section};

use crate::show::{Fields, SERVICE_ACCOUNT, labels, link};
use crate::{containers, pod, text, volumes};

/// The template's labels, containers, volumes and scheduling.
pub(crate) fn section(template: &Value, namespace: Option<&str>) -> Section {
    let spec = &template["spec"];
    let mut fields = Fields::default();
    fields.maybe("Labels", labels(&template["metadata"]["labels"]));
    fields.maybe("Annotations", labels(&template["metadata"]["annotations"]));
    fields.maybe(
        "Service account",
        text(&spec["serviceAccountName"])
            .map(|name| link(SERVICE_ACCOUNT, namespace, &name, name.clone())),
    );
    fields.maybe(
        "Priority class",
        text(&spec["priorityClassName"]).map(|name| {
            link(
                ("scheduling.k8s.io", "v1", "PriorityClass"),
                None,
                &name,
                name.clone(),
            )
        }),
    );
    let mut blocks = Vec::new();
    if !fields.is_empty() {
        blocks.push(Block::Fields { fields: fields.0 });
    }
    blocks.extend(containers::block(spec, None));
    blocks.extend(volumes::block(spec, namespace));
    blocks.extend(
        pod::scheduling(spec)
            .into_iter()
            .flat_map(|section| section.blocks),
    );
    Section {
        id: "core.template".to_owned(),
        title: "Pod template".to_owned(),
        blocks,
    }
}

/// The live list of the objects of a resource in `namespace` that the
/// objects with `owners` control.
pub(crate) fn owned_list(
    id: &str,
    title: &str,
    (group, version, resource, kind): (&str, &str, &str, &str),
    namespace: Option<&str>,
    owners: Vec<String>,
) -> Section {
    Section {
        id: id.to_owned(),
        title: title.to_owned(),
        blocks: vec![Block::List(EmbeddedList {
            gvr: Gvr {
                group: group.to_owned(),
                version: version.to_owned(),
                resource: resource.to_owned(),
            },
            kind: kind.to_owned(),
            namespaced: true,
            namespace: namespace.map(str::to_owned),
            field_selector: None,
            owners: Some(owners),
        })],
    }
}

pub(crate) const PODS: (&str, &str, &str, &str) = ("", "v1", "pods", "Pod");
pub(crate) const JOBS: (&str, &str, &str, &str) = ("batch", "v1", "jobs", "Job");
