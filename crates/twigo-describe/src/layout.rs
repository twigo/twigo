//! How a kind's page is arranged: the order of its sections, which of them
//! open until a person folds them, and which conditions its findings state.

use twigo_ipc::{Block, Condition, Finding, Fold, Section, Tone, Value as Shown};

pub(crate) struct Layout {
    /// The ids of its sections in the order the page shows them. Empty for
    /// the kind's first section, its conditions, its other sections, then
    /// Events and Metadata.
    pub order: &'static [&'static str],
    /// The sections that open for a triage, beside Diagnostics, and Events
    /// when one is a warning. Empty for the kind's first section.
    pub open: &'static [&'static str],
    /// The condition types a finding of the kind states while they are
    /// wrong; a type whose cause only some findings say is the describer's
    /// to name (`Described::explained`).
    pub explains: &'static [&'static str],
    /// The condition types that follow from what the containers do, which
    /// the Containers section and the pod's status already show: states
    /// whatever their status once the object has finished, as the kubelet
    /// writes `Initialized` True there with `PodCompleted`
    /// ([`generate.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/status/generate.go#L210-L218)),
    /// and while it runs or starts they tone the section without ever
    /// opening it.
    pub follows: &'static [&'static str],
    /// Which condition types are good news when True, when every other type
    /// is bad news: a node's, which a node-problem-detector adds to with
    /// types that are False on a healthy node. None where `TRUE_IS_BAD`
    /// lists the bad ones.
    pub good_when_true: Option<fn(&str) -> bool>,
    /// The tone of a condition whose status is Unknown: a warning where the
    /// kubelet stopped reporting, none elsewhere, where a controller has not
    /// decided yet, as a Deployment's Progressing is while it is paused or
    /// resumed ([`sync.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/controller/deployment/sync.go#L91-L100)).
    pub unknown: Tone,
}

const TRIAGE: &str = "core.diagnostics";
const EVENTS: &str = "core.events";

pub(crate) const POD: Layout = Layout {
    order: &[
        TRIAGE,
        "core.containers",
        EVENTS,
        "core.conditions",
        "core.placement",
        "core.volumes",
        "core.configuration",
        "core.metadata",
    ],
    open: &["core.containers"],
    explains: &[
        "PodScheduled",
        "PodReadyToStartContainers",
        "Initialized",
        "ContainersReady",
        "Ready",
    ],
    follows: &[
        "PodReadyToStartContainers",
        "Initialized",
        "ContainersReady",
        "Ready",
    ],
    good_when_true: None,
    unknown: Tone::Warning,
};

pub(crate) const WORKLOAD: Layout = Layout {
    order: &[
        TRIAGE,
        "core.rollout",
        "core.pods",
        EVENTS,
        "core.conditions",
        "core.template",
        "core.claims",
        "core.strategy",
        "core.metadata",
    ],
    open: &["core.rollout", "core.pods"],
    explains: &["Progressing", "ReplicaFailure", "Available"],
    follows: &[],
    good_when_true: None,
    unknown: Tone::Neutral,
};

pub(crate) const NODE: Layout = Layout {
    order: &[
        TRIAGE,
        "core.resources",
        "core.conditions",
        "core.pods",
        "core.podresources",
        EVENTS,
        "core.taints",
        "core.system",
        "core.resourceslices",
        "core.metadata",
    ],
    open: &["core.resources"],
    explains: &[
        "Ready",
        "MemoryPressure",
        "DiskPressure",
        "PIDPressure",
        "NetworkUnavailable",
    ],
    follows: &[],
    good_when_true: Some(healthy),
    unknown: Tone::Warning,
};

/// A node's `Ready` and the types that end in it, which the EKS node
/// monitoring agent adds (`KernelReady`, `NetworkingReady`, …) and sets True
/// on a healthy node, as its own health check reads them
/// ([`health.go`](https://github.com/aws/eks-node-monitoring-agent/blob/v1.7.7/e2e/monitoring/health.go#L104));
/// and the types that end in `Healthy`, which Azure's cluster health monitor
/// adds as `kubernetes.azure.com/NodeHealthy`, True when its checks pass
/// ([spec](https://github.com/Azure/cluster-health-monitor/blob/v0.0.46/spec/components/checknodehealth-controller.md?plain=1#L82-L86)).
/// An `…Unhealthy`, such as node-problem-detector's `KubeletUnhealthy`, is
/// not one of them.
fn healthy(kind: &str) -> bool {
    kind.ends_with("Ready") || kind.ends_with("Healthy")
}

pub(crate) const JOB: Layout = Layout {
    order: &[],
    open: &[],
    explains: &["Failed", "FailureTarget"],
    follows: &[],
    good_when_true: None,
    unknown: Tone::Neutral,
};

pub(crate) const OTHER: Layout = Layout {
    order: &[],
    open: &[],
    explains: &[],
    follows: &[],
    good_when_true: None,
    unknown: Tone::Neutral,
};

impl Layout {
    /// Whether a condition is wrong and nothing accounts for it: no finding
    /// states why, and the containers' state does not make it so.
    pub fn unexplained(&self, condition: &Condition) -> bool {
        wrong(condition.tone).is_some()
            && !condition.explained
            && !self.follows.contains(&condition.kind.as_str())
    }

    /// Puts the sections in the order the page shows them.
    pub fn arrange(&self, sections: &mut [Section]) {
        sections.sort_by_key(|section| {
            self.order
                .iter()
                .position(|id| *id == section.id)
                .unwrap_or(self.order.len())
        });
    }

    /// Settles each section's tone and fold. `first` is the kind's first
    /// section, which opens where the layout names none. A section that a
    /// finding is about arrives with its tone, and what is wrong in it is
    /// explained by the Diagnostics.
    pub fn settle(&self, sections: &mut [Section], first: Option<&str>) {
        for section in sections {
            let subject = section.tone.is_some();
            let bad = held(&section.blocks, None);
            section.tone = worse(section.tone, bad);
            let id = section.id.as_str();
            let open = id == TRIAGE
                || self.open.contains(&id)
                || (self.open.is_empty() && first == Some(id))
                || (id == EVENTS && bad.is_some());
            section.fold = if open {
                Fold::Open
            } else if !subject && held(&section.blocks, Some(self)).is_some() {
                Fold::Finding
            } else {
                Fold::Folded
            };
        }
    }
}

/// The worse of two tones, danger over warning; the others say nothing is
/// wrong.
fn worse(a: Option<Tone>, b: Option<Tone>) -> Option<Tone> {
    match (a, b) {
        (Some(Tone::Danger), _) | (_, Some(Tone::Danger)) => Some(Tone::Danger),
        (Some(Tone::Warning), _) | (_, Some(Tone::Warning)) => Some(Tone::Warning),
        _ => None,
    }
}

pub(crate) fn wrong(tone: Tone) -> Option<Tone> {
    matches!(tone, Tone::Danger | Tone::Warning).then_some(tone)
}

pub(crate) fn worst(findings: &[Finding]) -> Option<Tone> {
    findings
        .iter()
        .fold(None, |tone, finding| worse(tone, wrong(finding.tone)))
}

fn shown(shown: &Shown) -> Option<Tone> {
    match shown {
        Shown::Toned { tone, .. } => wrong(*tone),
        Shown::List { items } => items
            .iter()
            .fold(None, |tone, item| worse(tone, self::shown(item))),
        _ => None,
    }
}

/// The worst that the blocks say is wrong; given a layout, leaving out the
/// conditions that it finds accounted for.
fn held(blocks: &[Block], layout: Option<&Layout>) -> Option<Tone> {
    blocks.iter().fold(None, |tone, block| {
        let found = match block {
            Block::Fields { fields } => fields
                .iter()
                .fold(None, |tone, field| worse(tone, shown(&field.value))),
            Block::Table { rows, .. } => rows
                .iter()
                .flatten()
                .fold(None, |tone, cell| worse(tone, shown(cell))),
            Block::Conditions { conditions } => conditions
                .iter()
                .filter(|condition| layout.is_none_or(|layout| layout.unexplained(condition)))
                .fold(None, |tone, condition| worse(tone, wrong(condition.tone))),
            Block::Events(list) => list
                .events
                .iter()
                .any(|event| event.kind == "Warning")
                .then_some(Tone::Warning),
            Block::Containers { containers } => containers.iter().fold(None, |tone, container| {
                worse(
                    tone,
                    container.state.as_ref().and_then(|state| wrong(state.tone)),
                )
            }),
            Block::Diagnostics { findings } => worst(findings),
            Block::Data { .. } | Block::Tree { .. } | Block::List(_) => None,
        };
        worse(tone, found)
    })
}
