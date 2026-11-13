//! What an open pod or node uses (ARCHITECTURE 3.6, 4.3): the sample the
//! poller holds for its list's row, against what the pod's spec requests
//! and limits, or the node allocates.

use serde_json::Value;
use twigo_cache::metrics::{Container, Kind, Sample};
use twigo_ipc::{ContainerUsage, Measure, MetricsState, Usage};
use twigo_quantity::Quantity;

const DECLARED: [&str; 3] = ["initContainers", "containers", "ephemeralContainers"];

/// A pod without a sample uses nothing known, which is no zero.
pub fn usage(kind: Kind, object: &Value, sample: Option<&Sample>, state: MetricsState) -> Usage {
    let (cpu, memory, containers) = match kind {
        Kind::Pods => pod(object, sample),
        Kind::Nodes => node(object, sample),
    };
    Usage {
        state,
        sampled: sample
            .and_then(|sample| sample.sampled)
            .map(|sampled| sampled.to_string()),
        cpu,
        memory,
        containers,
    }
}

/// What an open object is told once its context stops serving its resource: no figures.
pub fn absent() -> Usage {
    Usage {
        state: MetricsState::Absent,
        sampled: None,
        cpu: Measure::default(),
        memory: Measure::default(),
        containers: Vec::new(),
    }
}

fn nanocores(quantity: Quantity) -> Option<i64> {
    i64::try_from(quantity.nano()).ok()
}

fn bytes(quantity: Quantity) -> Option<i64> {
    i64::try_from(quantity.value()).ok()
}

fn quantity(from: &Value, class: &str, resource: &str) -> Option<Quantity> {
    Quantity::parse(from[class][resource].as_str()?)
}

fn node(object: &Value, sample: Option<&Sample>) -> (Measure, Measure, Vec<ContainerUsage>) {
    let allocatable = |resource| quantity(&object["status"], "allocatable", resource);
    (
        Measure {
            used: sample.map(|sample| sample.cpu),
            allocatable: allocatable("cpu").and_then(nanocores),
            ..Measure::default()
        },
        Measure {
            used: sample.map(|sample| sample.memory),
            allocatable: allocatable("memory").and_then(bytes),
            ..Measure::default()
        },
        Vec::new(),
    )
}

/// The pod's request and limit are sums only where every container counted in its usage has
/// one, since a sum over some would put the pod's whole usage against part of what it may use.
fn pod(object: &Value, sample: Option<&Sample>) -> (Measure, Measure, Vec<ContainerUsage>) {
    let Some(sample) = sample else {
        return (Measure::default(), Measure::default(), Vec::new());
    };
    let spec = &object["spec"];
    let declared: Vec<&Value> = DECLARED
        .iter()
        .flat_map(|list| spec[list].as_array().into_iter().flatten())
        .collect();
    let mut sampled: Vec<(&Container, Option<&Value>)> = sample
        .containers
        .iter()
        .map(|container| {
            let found = declared
                .iter()
                .find(|declared| declared["name"] == *container.name)
                .copied();
            (container, found)
        })
        .collect();
    let position = |name: &str| {
        declared
            .iter()
            .position(|declared| declared["name"] == name)
            .unwrap_or(declared.len())
    };
    sampled.sort_by_key(|(container, _)| (position(&container.name), container.name.clone()));

    let measure = |used: i64,
                   from: Option<&Value>,
                   resource: &str,
                   read: fn(Quantity) -> Option<i64>| Measure {
        used: Some(used),
        request: from
            .and_then(|from| quantity(&from["resources"], "requests", resource))
            .and_then(read),
        limit: from
            .and_then(|from| quantity(&from["resources"], "limits", resource))
            .and_then(read),
        allocatable: None,
    };
    let containers: Vec<ContainerUsage> = sampled
        .iter()
        .map(|(container, from)| ContainerUsage {
            name: container.name.to_string(),
            cpu: measure(container.cpu, *from, "cpu", nanocores),
            memory: measure(container.memory, *from, "memory", bytes),
        })
        .collect();
    let total = |used: i64, pick: fn(&ContainerUsage) -> Measure| {
        let sum = |field: fn(&Measure) -> Option<i64>| {
            containers.iter().try_fold(0i64, |sum, container| {
                sum.checked_add(field(&pick(container))?)
            })
        };
        Measure {
            used: Some(used),
            request: sum(|measure| measure.request),
            limit: sum(|measure| measure.limit),
            allocatable: None,
        }
    };
    (
        total(sample.cpu, |container| container.cpu),
        total(sample.memory, |container| container.memory),
        containers,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn sample(containers: &[(&str, i64, i64)]) -> Sample {
        Sample {
            sampled: Some("2026-11-13T16:19:28Z".parse().unwrap()),
            cpu: containers.iter().map(|(_, cpu, _)| cpu).sum(),
            memory: containers.iter().map(|(_, _, memory)| memory).sum(),
            containers: containers
                .iter()
                .map(|(name, cpu, memory)| Container {
                    name: (*name).into(),
                    cpu: *cpu,
                    memory: *memory,
                })
                .collect(),
        }
    }

    fn pod_of(spec: serde_json::Value) -> Value {
        json!({ "kind": "Pod", "metadata": { "name": "p" }, "spec": spec })
    }

    #[test]
    fn a_pod_is_its_containers_in_its_own_order_against_what_each_may_use() {
        let pod = pod_of(json!({
            "initContainers": [{
                "name": "sidecar",
                "restartPolicy": "Always",
                "resources": { "requests": { "cpu": "100m", "memory": "64Mi" }, "limits": { "cpu": "200m", "memory": "128Mi" } },
            }],
            "containers": [
                { "name": "web", "resources": { "requests": { "cpu": "1", "memory": "1Gi" }, "limits": { "cpu": "2", "memory": "2Gi" } } },
                { "name": "worker", "resources": { "requests": { "cpu": "500m", "memory": "512Mi" }, "limits": { "cpu": "1", "memory": "1Gi" } } },
            ],
        }));
        let sampled = sample(&[
            ("worker", 3_000_000, 5),
            ("web", 40_000_000, 7),
            ("sidecar", 1, 2),
        ]);
        let usage = usage(Kind::Pods, &pod, Some(&sampled), MetricsState::Ready);
        let names: Vec<&str> = usage.containers.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["sidecar", "web", "worker"],
            "the pod's order, sidecars among them"
        );
        assert_eq!(usage.sampled.as_deref(), Some("2026-11-13T16:19:28Z"));
        assert_eq!(
            usage.cpu,
            Measure {
                used: Some(43_000_001),
                request: Some(1_600_000_000),
                limit: Some(3_200_000_000),
                allocatable: None,
            },
            "the sum of the sampled containers, against the sum of theirs"
        );
        assert_eq!(usage.memory.request, Some((64 + 1024 + 512) * 1024 * 1024));
        assert_eq!(usage.containers[1].cpu.request, Some(1_000_000_000));
        assert_eq!(
            usage.containers[1].memory.limit,
            Some(2 * 1024 * 1024 * 1024)
        );
    }

    #[test]
    fn a_pod_with_one_container_lacking_a_limit_has_no_pod_limit() {
        let pod = pod_of(json!({
            "containers": [
                { "name": "a", "resources": { "requests": { "cpu": "1" }, "limits": { "cpu": "2" } } },
                { "name": "b", "resources": { "requests": { "cpu": "1" } } },
            ],
        }));
        let sampled = sample(&[("a", 10, 1), ("b", 20, 1)]);
        let usage = usage(Kind::Pods, &pod, Some(&sampled), MetricsState::Ready);
        assert_eq!(usage.cpu.used, Some(30));
        assert_eq!(usage.cpu.request, Some(2_000_000_000));
        assert_eq!(usage.cpu.limit, None, "a limit that only some have");
        assert_eq!(usage.containers[0].cpu.limit, Some(2_000_000_000));
        assert_eq!(usage.containers[1].cpu.limit, None);
        assert_eq!(usage.memory.request, None, "none has a memory request");
    }

    #[test]
    fn only_the_containers_with_a_sample_count_and_those_the_spec_lacks_come_last() {
        let pod = pod_of(json!({
            "containers": [
                { "name": "a", "resources": { "requests": { "cpu": "1" } } },
                { "name": "idle", "resources": { "requests": { "cpu": "1" } } },
            ],
        }));
        let sampled = sample(&[("ephemeral-debug", 5, 5), ("a", 10, 1)]);
        let usage = usage(Kind::Pods, &pod, Some(&sampled), MetricsState::Ready);
        let names: Vec<&str> = usage.containers.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["a", "ephemeral-debug"]);
        assert_eq!(usage.cpu.used, Some(15), "every sampled container is used");
        assert_eq!(usage.cpu.request, None, "one of them has none");
    }

    #[test]
    fn a_pod_without_a_sample_uses_nothing_known() {
        let pod = pod_of(
            json!({ "containers": [{ "name": "a", "resources": { "requests": { "cpu": "1" } } }] }),
        );
        let usage = usage(Kind::Pods, &pod, None, MetricsState::Ready);
        assert_eq!(usage.state, MetricsState::Ready);
        assert_eq!(usage.sampled, None);
        assert_eq!(usage.cpu, Measure::default());
        assert_eq!(usage.memory, Measure::default());
        assert!(usage.containers.is_empty());
    }

    #[test]
    fn a_node_uses_what_it_allocates_of() {
        let node = json!({
            "kind": "Node",
            "status": { "allocatable": { "cpu": "16", "memory": "16355060Ki" } },
        });
        let sampled = sample(&[]);
        let usage = usage(
            Kind::Nodes,
            &node,
            Some(&Sample {
                cpu: 277_147_502,
                memory: 2_569_932_800,
                ..sampled
            }),
            MetricsState::Unavailable,
        );
        assert_eq!(usage.state, MetricsState::Unavailable);
        assert_eq!(
            usage.cpu,
            Measure {
                used: Some(277_147_502),
                request: None,
                limit: None,
                allocatable: Some(16_000_000_000),
            }
        );
        assert_eq!(usage.memory.allocatable, Some(16_355_060 * 1024));
        assert!(usage.containers.is_empty());
        let none = super::usage(Kind::Nodes, &node, None, MetricsState::Ready);
        assert_eq!(none.cpu.used, None);
        assert_eq!(
            none.cpu.allocatable,
            Some(16_000_000_000),
            "known without a sample"
        );
    }
}
