//! What the page says around the object's name: the controller at the top
//! of its owners, and the sentence after its status word.

use serde_json::Value;
use twigo_ipc::{Finding, ObjectRef, Span};

use crate::workloads::fact;
use crate::{Fact, Found, Need, group_version, text};

/// The controller that an owner reference names.
fn controller(object: &Value) -> Option<&Value> {
    object["metadata"]["ownerReferences"]
        .as_array()?
        .iter()
        .find(|owner| owner["controller"] == true)
}

/// The ReplicaSet or Job that controls the object, by name, since the
/// Deployment or CronJob above it is that one's controller.
pub(crate) fn above(object: &Value) -> Option<Need> {
    let owner = controller(object)?;
    let (group, version) = group_version(owner);
    let resource = match (group, owner["kind"].as_str()?) {
        ("apps", "ReplicaSet") => "replicasets",
        ("batch", "Job") => "jobs",
        _ => return None,
    };
    Some(Need {
        group: group.to_owned(),
        version: version.to_owned(),
        resource: resource.to_owned(),
        namespaced: true,
        namespace: text(&object["metadata"]["namespace"]),
        field_selector: Some(format!("metadata.name={}", owner["name"].as_str()?)),
    })
}

/// The controller at the top of the object's owners: the Deployment of the
/// ReplicaSet that controls a pod, the CronJob of its Job, and else the
/// controller itself, as while the one above it is not listed.
pub(crate) fn owner(object: &Value, facts: &[Fact]) -> Option<ObjectRef> {
    let direct = controller(object)?;
    let top = above(object)
        .and_then(|need| match fact(facts, &need)? {
            Found::Listed { objects } => objects.first().and_then(controller),
            Found::Unavailable { .. } => None,
        })
        .unwrap_or(direct);
    let (group, version) = group_version(top);
    Some(ObjectRef {
        group: group.to_owned(),
        version: version.to_owned(),
        kind: text(&top["kind"])?,
        namespace: text(&object["metadata"]["namespace"]),
        name: text(&top["name"])?,
    })
}

/// The first finding's title, else what the describer says of its vitals.
pub(crate) fn sentence(findings: &[Finding], vitals: Vec<Span>) -> Vec<Span> {
    findings.first().map_or(vitals, |finding| {
        vec![Span::Text {
            text: finding.title.clone(),
        }]
    })
}
