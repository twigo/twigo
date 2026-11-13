//! What a context serves of the Metrics API, from the discovery its cluster last confirmed.

use twigo_kube::discovery::Discovery;

pub const GROUP: &str = "metrics.k8s.io";

/// kubectl's order ([`top_pod.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/cmd/top/top_pod.go#L239-L279)).
const VERSIONS: [&str; 2] = ["v1", "v1beta1"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Pods,
    Nodes,
}

impl Kind {
    pub fn resource(self) -> &'static str {
        match self {
            Kind::Pods => "pods",
            Kind::Nodes => "nodes",
        }
    }

    pub fn of(group: &str, version: &str, resource: &str) -> Option<Self> {
        match (group, version, resource) {
            ("", "v1", "pods") => Some(Kind::Pods),
            ("", "v1", "nodes") => Some(Kind::Nodes),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Api {
    /// Not served, or discovery has not answered yet.
    Absent,
    Served {
        version: &'static str,
        pods: bool,
        nodes: bool,
    },
    /// The APIService exists and its version lists no resources: metrics-server is down.
    Stale { version: &'static str },
}

impl Api {
    pub fn of(discovery: &Discovery) -> Self {
        let versions = discovery.versions(GROUP);
        let found = |wanted: &str| versions.iter().find(|found| found.version == wanted);
        for version in VERSIONS {
            if let Some(found) = found(version).filter(|found| !found.stale) {
                let served = |resource: &str| found.resources.iter().any(|found| found == resource);
                let (pods, nodes) = (served("pods"), served("nodes"));
                if pods || nodes {
                    return Api::Served {
                        version,
                        pods,
                        nodes,
                    };
                }
            }
        }
        VERSIONS
            .into_iter()
            .find(|version| found(version).is_some_and(|found| found.stale))
            .map_or(Api::Absent, |version| Api::Stale { version })
    }

    pub fn version(self) -> Option<&'static str> {
        match self {
            Api::Absent => None,
            Api::Served { version, .. } | Api::Stale { version } => Some(version),
        }
    }

    /// A stale API keeps the columns, since it will answer again.
    pub fn columns(self, kind: Kind) -> bool {
        match self {
            Api::Absent => false,
            Api::Served { pods, nodes, .. } => match kind {
                Kind::Pods => pods,
                Kind::Nodes => nodes,
            },
            Api::Stale { .. } => true,
        }
    }

    pub fn stale(self) -> bool {
        matches!(self, Api::Stale { .. })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn discovery(versions: serde_json::Value) -> Discovery {
        serde_json::from_value(json!({
            "core": { "etag": null, "list": { "items": [] } },
            "groups": {
                "etag": null,
                "list": { "items": [{ "metadata": { "name": GROUP }, "versions": versions }] },
            },
        }))
        .unwrap()
    }

    fn version(version: &str, freshness: &str, resources: &[&str]) -> serde_json::Value {
        let resources: Vec<_> = resources
            .iter()
            .map(|resource| {
                json!({
                    "resource": resource,
                    "responseKind": { "group": "", "version": "", "kind": "Metrics" },
                    "scope": "Namespaced",
                    "verbs": ["get", "list"],
                })
            })
            .collect();
        json!({ "version": version, "freshness": freshness, "resources": resources })
    }

    #[test]
    fn the_version_comes_from_discovery_v1_first() {
        let both = discovery(json!([
            version("v1beta1", "Current", &["pods", "nodes"]),
            version("v1", "Current", &["pods"]),
        ]));
        assert_eq!(
            Api::of(&both),
            Api::Served {
                version: "v1",
                pods: true,
                nodes: false
            }
        );
        let beta = discovery(json!([
            version("v1beta1", "Current", &["nodes"]),
            version("v2", "Current", &["pods", "nodes"]),
        ]));
        assert_eq!(
            Api::of(&beta),
            Api::Served {
                version: "v1beta1",
                pods: false,
                nodes: true
            }
        );
        let down_v1 = discovery(json!([
            version("v1", "Stale", &[]),
            version("v1beta1", "Current", &["pods", "nodes"]),
        ]));
        assert_eq!(
            Api::of(&down_v1),
            Api::Served {
                version: "v1beta1",
                pods: true,
                nodes: true
            }
        );
    }

    #[test]
    fn a_version_without_resources_is_stale_and_a_group_without_any_is_absent() {
        let down = discovery(json!([{ "version": "v1beta1", "freshness": "Stale" }]));
        assert_eq!(Api::of(&down), Api::Stale { version: "v1beta1" });
        assert!(Api::of(&down).columns(Kind::Pods) && Api::of(&down).columns(Kind::Nodes));
        let elsewhere = discovery(json!([version("v2", "Current", &["pods"])]));
        assert_eq!(Api::of(&elsewhere), Api::Absent);
        let other = discovery(json!([version("v1beta1", "Current", &["widgets"])]));
        assert_eq!(Api::of(&other), Api::Absent);
        let none: Discovery = serde_json::from_value(json!({
            "core": { "etag": null, "list": { "items": [] } },
            "groups": { "etag": null, "list": { "items": [] } },
        }))
        .unwrap();
        assert_eq!(Api::of(&none), Api::Absent);
        assert!(!Api::Absent.columns(Kind::Pods));
    }
}
