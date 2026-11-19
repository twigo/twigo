//! What workloads share: their pod template, as kubectl's
//! `DescribePodTemplate` prints it, and the live list of what they own.

use serde_json::Value;
use twigo_ipc::{Block, EmbeddedList, Gvr, Section};

use crate::show::{Fields, SERVICE_ACCOUNT, Summary, labels, link, plain, section as shown};
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
    let mut scheduling = pod::scheduling(spec);
    if let Some(scheduler) = text(&spec["schedulerName"]).filter(|name| name != "default-scheduler")
    {
        scheduling.add("Scheduler", plain(scheduler));
    }
    if !scheduling.is_empty() {
        blocks.push(Block::Fields {
            fields: scheduling.0,
        });
    }
    blocks.extend(pod::affinity(spec));
    Section {
        summary: images_summary(spec),
        ..shown("core.template", "Pod template", blocks)
    }
}

/// What the template runs: its one image with its tag, or how many
/// containers it has.
fn images_summary(spec: &Value) -> Vec<twigo_ipc::Span> {
    let containers = spec["containers"].as_array().map_or(&[][..], Vec::as_slice);
    match containers {
        [only] => {
            let image = only["image"].as_str().unwrap_or_default();
            let (reference, _) = image.split_once('@').unwrap_or((image, ""));
            Summary::default()
                .part(reference.rsplit('/').next().unwrap_or(reference))
                .done()
        }
        _ => Summary::default()
            .count(containers.len(), "container")
            .done(),
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
    shown(
        id,
        title,
        vec![Block::List(EmbeddedList {
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
    )
}

pub(crate) const PODS: (&str, &str, &str, &str) = ("", "v1", "pods", "Pod");
pub(crate) const JOBS: (&str, &str, &str, &str) = ("batch", "v1", "jobs", "Job");
