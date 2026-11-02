//! The kinds whose objects a controller of another kind owns, for the
//! Related tab: their owner references point back at it.

/// A kind of owned object and its resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Owned {
    /// Empty for the core group.
    pub group: &'static str,
    pub version: &'static str,
    pub resource: &'static str,
    pub kind: &'static str,
}

const PODS: Owned = Owned {
    group: "",
    version: "v1",
    resource: "pods",
    kind: "Pod",
};
const REPLICA_SETS: Owned = Owned {
    group: "apps",
    version: "v1",
    resource: "replicasets",
    kind: "ReplicaSet",
};
const CONTROLLER_REVISIONS: Owned = Owned {
    group: "apps",
    version: "v1",
    resource: "controllerrevisions",
    kind: "ControllerRevision",
};
const JOBS: Owned = Owned {
    group: "batch",
    version: "v1",
    resource: "jobs",
    kind: "Job",
};
const ENDPOINT_SLICES: Owned = Owned {
    group: "discovery.k8s.io",
    version: "v1",
    resource: "endpointslices",
    kind: "EndpointSlice",
};

const OWNED: &[(&str, &str, &[Owned])] = &[
    ("apps", "Deployment", &[REPLICA_SETS]),
    ("apps", "ReplicaSet", &[PODS]),
    ("apps", "StatefulSet", &[PODS, CONTROLLER_REVISIONS]),
    ("apps", "DaemonSet", &[PODS, CONTROLLER_REVISIONS]),
    ("batch", "Job", &[PODS]),
    ("batch", "CronJob", &[JOBS]),
    ("", "Service", &[ENDPOINT_SLICES]),
];

/// What objects of `group` and `kind` own, in their own namespace.
pub fn owned(group: &str, kind: &str) -> &'static [Owned] {
    OWNED
        .iter()
        .find(|(g, k, _)| *g == group && *k == kind)
        .map_or(&[], |(_, _, owned)| owned)
}
