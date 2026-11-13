//! What the Metrics API answers, parsed into nanocores and bytes per container.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use jiff::Timestamp;
use serde::Deserialize;
use twigo_quantity::Quantity;

use super::Kind;
use crate::decode::nullable;

#[derive(Debug, Clone)]
pub struct Sample {
    /// Moves with every scrape, so a sample is not compared by it.
    pub sampled: Option<Timestamp>,
    /// Nanocores; a pod's is the sum over its containers, as kubectl sums them
    /// ([`metrics_printer.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/metricsutil/metrics_printer.go#L188-L202)).
    pub cpu: i64,
    pub memory: i64,
    /// By name, since the server lists them in no stable order.
    pub containers: Box<[Container]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Container {
    pub name: Box<str>,
    pub cpu: i64,
    pub memory: i64,
}

impl PartialEq for Sample {
    fn eq(&self, other: &Self) -> bool {
        self.cpu == other.cpu && self.memory == other.memory && self.containers == other.containers
    }
}

impl Eq for Sample {}

/// By namespace, empty for a node, then name.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Samples(HashMap<Box<str>, HashMap<Box<str>, Arc<Sample>>>);

impl Samples {
    pub fn get(&self, namespace: &str, name: &str) -> Option<&Arc<Sample>> {
        self.0.get(namespace)?.get(name)
    }

    pub fn len(&self) -> usize {
        self.0.values().map(HashMap::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.0.values().all(HashMap::is_empty)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str, &Arc<Sample>)> {
        self.0.iter().flat_map(|(namespace, samples)| {
            samples
                .iter()
                .map(move |(name, sample)| (&**namespace, &**name, sample))
        })
    }

    fn insert(&mut self, namespace: &str, name: &str, sample: Sample) {
        let samples = match self.0.get_mut(namespace) {
            Some(samples) => samples,
            None => self.0.entry(namespace.into()).or_default(),
        };
        samples.insert(name.into(), Arc::new(sample));
    }
}

#[derive(Deserialize)]
struct List<'a> {
    #[serde(borrow, default, deserialize_with = "nullable")]
    items: Vec<Item<'a>>,
}

#[derive(Deserialize)]
struct Item<'a> {
    #[serde(borrow)]
    metadata: Metadata<'a>,
    #[serde(borrow, default)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    containers: Vec<Named<'a>>,
    #[serde(borrow, default)]
    usage: Option<Usage<'a>>,
}

#[derive(Deserialize)]
struct Metadata<'a> {
    #[serde(borrow)]
    name: Cow<'a, str>,
    #[serde(borrow, default)]
    namespace: Option<Cow<'a, str>>,
}

#[derive(Deserialize)]
struct Named<'a> {
    #[serde(borrow)]
    name: Cow<'a, str>,
    #[serde(borrow)]
    usage: Usage<'a>,
}

#[derive(Deserialize)]
struct Usage<'a> {
    #[serde(borrow)]
    cpu: Cow<'a, str>,
    #[serde(borrow)]
    memory: Cow<'a, str>,
}

fn usage(usage: &Usage<'_>) -> Option<(i64, i64)> {
    let cpu = i64::try_from(Quantity::parse(&usage.cpu)?.nano()).ok()?;
    let memory = i64::try_from(Quantity::parse(&usage.memory)?.value()).ok()?;
    Some((cpu, memory))
}

impl Item<'_> {
    fn sample(&self, kind: Kind) -> Option<Sample> {
        let sampled = self
            .timestamp
            .as_deref()
            .and_then(|timestamp| timestamp.parse().ok());
        match kind {
            Kind::Nodes => {
                let (cpu, memory) = usage(self.usage.as_ref()?)?;
                Some(Sample {
                    sampled,
                    cpu,
                    memory,
                    containers: Box::default(),
                })
            }
            Kind::Pods => {
                let mut containers = Vec::with_capacity(self.containers.len());
                for container in &self.containers {
                    let (cpu, memory) = usage(&container.usage)?;
                    containers.push(Container {
                        name: container.name.as_ref().into(),
                        cpu,
                        memory,
                    });
                }
                if containers.is_empty() {
                    return None;
                }
                containers.sort_by(|a, b| a.name.cmp(&b.name));
                Some(Sample {
                    sampled,
                    cpu: containers.iter().map(|container| container.cpu).sum(),
                    memory: containers.iter().map(|container| container.memory).sum(),
                    containers: containers.into(),
                })
            }
        }
    }
}

/// An item whose usage does not parse has no sample, as a pod the server leaves out.
pub fn parse(body: &[u8], kind: Kind) -> Result<Samples, serde_json::Error> {
    let list: List<'_> = serde_json::from_slice(body)?;
    let mut samples = Samples::default();
    for item in &list.items {
        if let Some(sample) = item.sample(kind) {
            let namespace = match kind {
                Kind::Pods => item.metadata.namespace.as_deref().unwrap_or_default(),
                Kind::Nodes => "",
            };
            samples.insert(namespace, &item.metadata.name, sample);
        }
    }
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn parsed(list: &serde_json::Value, kind: Kind) -> Samples {
        parse(list.to_string().as_bytes(), kind).unwrap()
    }

    #[test]
    fn a_pod_is_the_sum_of_its_containers_in_nanocores_and_bytes() {
        let list = json!({
            "kind": "PodMetricsList",
            "apiVersion": "metrics.k8s.io/v1beta1",
            "metadata": {},
            "items": [{
                "metadata": { "name": "multi", "namespace": "a" },
                "timestamp": "2026-11-13T16:19:28Z",
                "window": "24.661s",
                "containers": [
                    { "name": "second", "usage": { "cpu": "50172044n", "memory": "432Ki" } },
                    { "name": "main", "usage": { "cpu": "0", "memory": "204Ki" } },
                    { "name": "sidecar", "usage": { "cpu": "1500u", "memory": "40Mi" } },
                ],
            }],
        });
        let samples = parsed(&list, Kind::Pods);
        let sample = samples.get("a", "multi").unwrap();
        assert_eq!(sample.cpu, 50_172_044 + 1_500_000);
        assert_eq!(sample.memory, (432 + 204) * 1024 + 40 * 1024 * 1024);
        assert_eq!(
            sample.sampled,
            Some("2026-11-13T16:19:28Z".parse().unwrap())
        );
        let names: Vec<&str> = sample.containers.iter().map(|c| &*c.name).collect();
        assert_eq!(names, ["main", "second", "sidecar"], "by name");
        assert_eq!(sample.containers[0].cpu, 0, "a bare 0 is a zero, a sample");
        assert!(samples.get("b", "multi").is_none());
    }

    const PODS: &[u8] = include_bytes!("../../tests/fixtures/metrics-pods.json");
    const REAL_PODS: &[u8] = include_bytes!("../../tests/fixtures/metrics-pods-kube-system.json");
    const NODES: &[u8] = include_bytes!("../../tests/fixtures/metrics-nodes.json");

    fn items(list: &[u8]) -> usize {
        let list: serde_json::Value = serde_json::from_slice(list).unwrap();
        list["items"].as_array().unwrap().len()
    }

    #[test]
    fn a_recorded_list_of_kwok_pods_reads_as_what_their_annotations_say() {
        let samples = parse(PODS, Kind::Pods).unwrap();
        assert_eq!(samples.len(), items(PODS));
        let near = |value: i64, wanted: i64| (value - wanted).abs() < wanted / 100;
        let web = samples.get("record-metrics", "web").unwrap();
        assert!(near(web.cpu, 100_000_000), "{web:?}");
        assert_eq!(web.memory, 40 * 1024 * 1024);
        let multi = samples.get("record-metrics", "multi").unwrap();
        let names: Vec<&str> = multi.containers.iter().map(|c| &*c.name).collect();
        assert_eq!(names, ["a", "b"]);
        assert!(near(multi.cpu, 100_000_000), "the sum of two: {multi:?}");
        assert_eq!(multi.memory, 2 * 20 * 1024 * 1024);
        assert!(multi.sampled.is_some());
    }

    #[test]
    fn a_recorded_list_of_real_pods_reads_all_its_items() {
        let samples = parse(REAL_PODS, Kind::Pods).unwrap();
        assert_eq!(samples.len(), items(REAL_PODS));
        let etcd = samples
            .iter()
            .find(|(_, name, _)| name.starts_with("etcd-"))
            .map(|(_, _, sample)| sample)
            .expect("etcd, which runs on the node kind starts");
        assert!(etcd.cpu > 0 && etcd.memory > 1024 * 1024, "{etcd:?}");
    }

    #[test]
    fn a_recorded_list_of_nodes_reads_all_its_items_without_a_namespace() {
        let samples = parse(NODES, Kind::Nodes).unwrap();
        assert_eq!(samples.len(), items(NODES));
        let kwok = samples.get("", "kwok-node-0").unwrap();
        assert!(kwok.cpu > 0 && kwok.memory > 0 && kwok.containers.is_empty());
        assert!(
            samples
                .iter()
                .any(|(_, name, _)| name.ends_with("-control-plane"))
        );
    }

    #[test]
    fn a_node_has_its_own_usage_and_no_namespace() {
        let list = json!({
            "items": [{
                "metadata": { "name": "node-1" },
                "timestamp": "2026-11-13T16:28:56Z",
                "usage": { "cpu": "277147502n", "memory": "2509700Ki" },
            }],
        });
        let samples = parsed(&list, Kind::Nodes);
        let sample = samples.get("", "node-1").unwrap();
        assert_eq!((sample.cpu, sample.memory), (277_147_502, 2_569_932_800));
        assert!(sample.containers.is_empty());
    }

    #[test]
    fn samples_are_equal_by_value_whatever_the_order_or_the_time() {
        let item = |containers: serde_json::Value, timestamp: &str| {
            json!({
                "items": [{
                    "metadata": { "name": "p", "namespace": "a", "creationTimestamp": timestamp },
                    "timestamp": timestamp,
                    "containers": containers,
                }],
            })
        };
        let usage = |name: &str, cpu: &str| json!({ "name": name, "usage": { "cpu": cpu, "memory": "1Mi" } });
        let first = parsed(
            &item(
                json!([usage("a", "1m"), usage("b", "2m")]),
                "2026-11-13T16:00:00Z",
            ),
            Kind::Pods,
        );
        let again = parsed(
            &item(
                json!([usage("b", "2m"), usage("a", "1m")]),
                "2026-11-13T16:00:15Z",
            ),
            Kind::Pods,
        );
        assert_eq!(first, again);
        let moved = parsed(
            &item(
                json!([usage("a", "2m"), usage("b", "1m")]),
                "2026-11-13T16:00:15Z",
            ),
            Kind::Pods,
        );
        assert_ne!(first, moved, "the same total, another split");
    }

    #[test]
    fn an_empty_answer_may_send_null_and_an_item_that_does_not_parse_has_no_sample() {
        assert!(parse(br#"{"items":null}"#, Kind::Pods).unwrap().is_empty());
        assert!(
            parse(br#"{"kind":"PodMetricsList"}"#, Kind::Pods)
                .unwrap()
                .is_empty()
        );
        let list = json!({
            "items": [
                { "metadata": { "name": "bad", "namespace": "a" },
                  "containers": [{ "name": "c", "usage": { "cpu": "lots", "memory": "1Mi" } }] },
                { "metadata": { "name": "none", "namespace": "a" }, "containers": [] },
                { "metadata": { "name": "fine", "namespace": "a" },
                  "containers": [{ "name": "c", "usage": { "cpu": "1m", "memory": "1Mi" } }] },
            ],
        });
        let samples = parsed(&list, Kind::Pods);
        assert_eq!(samples.len(), 1);
        assert!(samples.get("a", "fine").is_some());
    }
}
