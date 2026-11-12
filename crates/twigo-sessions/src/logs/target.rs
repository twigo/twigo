//! What a logs session follows (ARCHITECTURE 4.6): a pod, or the pods a
//! workload controls, a Deployment's through its ReplicaSets and a
//! CronJob's through its Jobs.

use twigo_cache::hub::Resource;
use twigo_ipc::{ErrorKind, IpcError, LogTarget};

use crate::pods::{Reach, Target, resource_name};

/// The kinds a logs tab follows, by group and resource.
const KINDS: &[(&str, &str, Reach)] = &[
    ("", "pods", Reach::Pod),
    ("apps", "deployments", Reach::Through("apps", "replicasets")),
    ("apps", "replicasets", Reach::Owns),
    ("apps", "statefulsets", Reach::Owns),
    ("apps", "daemonsets", Reach::Owns),
    ("batch", "jobs", Reach::Owns),
    ("batch", "cronjobs", Reach::Through("batch", "jobs")),
];

/// Refuses the kinds that have no pods of their own to follow.
pub fn target(target: &LogTarget) -> Result<Target, IpcError> {
    let gvr = &target.gvr;
    let reach = KINDS
        .iter()
        .find(|(group, resource, _)| *group == gvr.group && *resource == gvr.resource)
        .map(|(_, _, reach)| *reach)
        .ok_or_else(|| {
            IpcError::new(
                ErrorKind::InvalidInput,
                format!(
                    "{} has no logs: a logs tab follows a pod, or the pods of a workload",
                    resource_name(&gvr.group, &gvr.resource)
                ),
            )
        })?;
    if target.namespace.is_empty() {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            format!("{} names no namespace", target.name),
        ));
    }
    Ok(Target::new(
        reach,
        Resource {
            group: gvr.group.clone(),
            version: gvr.version.clone(),
            resource: gvr.resource.clone(),
            namespaced: true,
        },
        target.namespace.clone(),
        target.name.clone(),
    ))
}

#[cfg(test)]
mod tests {
    use twigo_ipc::Gvr;

    use super::*;

    fn target(group: &str, resource: &str) -> Result<Target, IpcError> {
        super::target(&LogTarget {
            space: "kind-test".to_owned(),
            gvr: Gvr {
                group: group.to_owned(),
                version: "v1".to_owned(),
                resource: resource.to_owned(),
            },
            namespace: "shop".to_owned(),
            name: "api".to_owned(),
        })
    }

    #[test]
    fn a_pod_or_a_workload_has_logs() {
        for (group, resource, _) in KINDS {
            assert!(target(group, resource).is_ok(), "{resource}");
        }
        let refused = target("", "services").unwrap_err();
        assert_eq!(refused.kind, ErrorKind::InvalidInput);
        assert!(
            refused.message.starts_with("services has no logs"),
            "{}",
            refused.message
        );
        assert!(target("apps", "pods").is_err());
    }

    #[test]
    fn a_target_without_a_namespace_is_refused() {
        let refused = super::target(&LogTarget {
            space: "kind-test".to_owned(),
            gvr: Gvr {
                group: String::new(),
                version: "v1".to_owned(),
                resource: "pods".to_owned(),
            },
            namespace: String::new(),
            name: "api".to_owned(),
        })
        .unwrap_err();
        assert_eq!(refused.kind, ErrorKind::InvalidInput);
        assert_eq!(refused.message, "api names no namespace");
    }
}
