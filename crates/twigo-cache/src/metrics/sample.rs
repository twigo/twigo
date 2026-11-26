//! What the Metrics API answers, parsed into nanocores and bytes per container.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use jiff::Timestamp;
use serde::Deserialize;
use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use twigo_quantity::Quantity;

use super::Kind;

#[derive(Debug, Clone)]
pub struct Sample {
    /// Moves with every scrape, so a sample is not compared by it, and a poll that finds the same
    /// values keeps the sample and the time of the scrape that first read them.
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

impl Sample {
    /// Taken before an object was created, a sample is of another that had its name.
    pub fn taken_since(&self, created: Option<i64>) -> bool {
        self.sampled
            .zip(created)
            .is_none_or(|(sampled, created)| sampled.as_millisecond() >= created)
    }
}

impl PartialEq for Sample {
    fn eq(&self, other: &Self) -> bool {
        self.cpu == other.cpu && self.memory == other.memory && self.containers == other.containers
    }
}

impl Eq for Sample {}

/// By namespace, empty for a node, then name. An answer shares the names and the samples it finds
/// the same with the one before.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Samples(HashMap<Arc<str>, HashMap<Arc<str>, Arc<Sample>>>);

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

    /// `expected` sizes the table of a namespace that is new to this answer.
    fn insert(&mut self, namespace: &str, name: Arc<str>, sample: Arc<Sample>, expected: usize) {
        let samples = match self.0.get_mut(namespace) {
            Some(samples) => samples,
            None => self
                .0
                .entry(namespace.into())
                .or_insert_with(|| HashMap::with_capacity(expected)),
        };
        samples.insert(name, sample);
    }
}

#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "camelCase")]
enum Field {
    Items,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Item<'a> {
    #[serde(borrow)]
    metadata: Metadata<'a>,
    #[serde(borrow, default)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow, default, deserialize_with = "by_name")]
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
    /// Nanocores and bytes, none where they do not parse.
    #[serde(deserialize_with = "container_usage")]
    usage: Option<(i64, i64)>,
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

fn by_name<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Named<'de>>, D::Error> {
    let mut containers = Vec::<Named<'de>>::deserialize(deserializer)?;
    containers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(containers)
}

fn container_usage<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<(i64, i64)>, D::Error> {
    Usage::deserialize(deserializer).map(|parsed| usage(&parsed))
}

impl Item<'_> {
    fn sampled(&self) -> Option<Timestamp> {
        self.timestamp
            .as_deref()
            .and_then(|timestamp| timestamp.parse().ok())
    }

    /// The sample of an item, or `held` where it is the same, and none for an item the server
    /// leaves out.
    fn sample(&self, kind: Kind, held: Option<&Arc<Sample>>) -> Option<Arc<Sample>> {
        match kind {
            Kind::Nodes => {
                let (cpu, memory) = usage(self.usage.as_ref()?)?;
                if let Some(held) = held.filter(|held| held.cpu == cpu && held.memory == memory) {
                    return Some(Arc::clone(held));
                }
                Some(Arc::new(Sample {
                    sampled: self.sampled(),
                    cpu,
                    memory,
                    containers: Box::default(),
                }))
            }
            Kind::Pods => {
                if let Some(held) = held.filter(|held| self.same_as(held)) {
                    return Some(Arc::clone(held));
                }
                let mut containers = Vec::with_capacity(self.containers.len());
                for container in &self.containers {
                    let (cpu, memory) = container.usage?;
                    containers.push(Container {
                        name: container.name.as_ref().into(),
                        cpu,
                        memory,
                    });
                }
                if containers.is_empty() {
                    return None;
                }
                Some(Arc::new(Sample {
                    sampled: self.sampled(),
                    cpu: containers.iter().map(|container| container.cpu).sum(),
                    memory: containers.iter().map(|container| container.memory).sum(),
                    containers: containers.into(),
                }))
            }
        }
    }

    fn same_as(&self, sample: &Sample) -> bool {
        sample.containers.len() == self.containers.len()
            && sample
                .containers
                .iter()
                .zip(&self.containers)
                .all(|(held, container)| {
                    *held.name == *container.name
                        && container.usage == Some((held.cpu, held.memory))
                })
    }
}

/// Reads a list's items one at a time, each into its sample as it comes.
#[derive(Clone, Copy)]
struct Parser<'p> {
    kind: Kind,
    previous: Option<&'p Samples>,
}

impl<'de> Visitor<'de> for Parser<'_> {
    type Value = Samples;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a list of metrics")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Samples, A::Error> {
        let mut samples = Samples::default();
        while let Some(field) = map.next_key()? {
            match field {
                Field::Items => samples = map.next_value_seed(self)?,
                Field::Other => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(samples)
    }

    fn visit_none<E>(self) -> Result<Samples, E> {
        Ok(Samples::default())
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Samples, D::Error> {
        deserializer.deserialize_seq(self)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Samples, A::Error> {
        let mut samples = Samples::default();
        while let Some(item) = seq.next_element::<Item<'de>>()? {
            let namespace = match self.kind {
                Kind::Pods => item.metadata.namespace.as_deref().unwrap_or_default(),
                Kind::Nodes => "",
            };
            let names = self.previous.and_then(|previous| previous.0.get(namespace));
            let before = names.and_then(|names| names.get_key_value(&*item.metadata.name));
            let Some(sample) = item.sample(self.kind, before.map(|(_, sample)| sample)) else {
                continue;
            };
            let name = before.map_or_else(
                || Arc::from(&*item.metadata.name),
                |(name, _)| Arc::clone(name),
            );
            samples.insert(namespace, name, sample, names.map_or(0, HashMap::len));
        }
        Ok(samples)
    }
}

impl<'de> DeserializeSeed<'de> for Parser<'_> {
    type Value = Samples;

    /// A list that holds no item may send `null`, as Go encodes a nil slice.
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Samples, D::Error> {
        deserializer.deserialize_option(self)
    }
}

/// An item whose usage does not parse has no sample, as a pod the server leaves out. `previous`
/// is the answer before for the same scope.
pub fn parse(
    body: &[u8],
    kind: Kind,
    previous: Option<&Samples>,
) -> Result<Samples, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let samples = (&mut deserializer).deserialize_map(Parser { kind, previous })?;
    deserializer.end()?;
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn parsed(list: &serde_json::Value, kind: Kind) -> Samples {
        parse(list.to_string().as_bytes(), kind, None).unwrap()
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
        let samples = parse(PODS, Kind::Pods, None).unwrap();
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
        let samples = parse(REAL_PODS, Kind::Pods, None).unwrap();
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
        let samples = parse(NODES, Kind::Nodes, None).unwrap();
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
    fn an_answer_that_is_no_list_or_has_a_malformed_item_is_undecodable() {
        let usage = json!({ "cpu": "1m", "memory": "1Mi" });
        for body in [
            json!({ "items": [{ "containers": [] }] }),
            json!({ "items": [{ "metadata": { "name": "p" }, "containers": [{ "name": "c" }] }] }),
            json!({ "items": [{ "metadata": { "name": "p" }, "containers": [{ "usage": usage }] }] }),
            json!({ "items": [{ "metadata": { "name": "p" }, "containers": "c" }] }),
            json!({ "items": {} }),
            json!(null),
        ] {
            assert!(
                parse(body.to_string().as_bytes(), Kind::Pods, None).is_err(),
                "{body}"
            );
        }
        assert!(parse(br#"{"items":[]} x"#, Kind::Pods, None).is_err());
        assert!(parse(br#"{"items":[{"metadata":{"name":"p""#, Kind::Pods, None).is_err());
    }

    #[test]
    fn a_list_reads_whatever_the_order_of_its_keys_and_skips_what_it_does_not_know() {
        let list = br#"{
            "items": [{
                "containers": [{ "usage": { "memory": "1Mi", "cpu": "2m" }, "name": "c" }],
                "window": "15s", "extra": { "deep": [1, 2, { "x": null }] },
                "timestamp": "2026-11-13T16:00:00Z",
                "metadata": { "namespace": "a", "name": "p", "labels": { "app": "p" } }
            }],
            "metadata": {}, "apiVersion": "metrics.k8s.io/v1beta1", "kind": "PodMetricsList"
        }"#;
        let samples = parse(list, Kind::Pods, None).unwrap();
        assert_eq!(samples.len(), 1);
        let sample = samples.get("a", "p").unwrap();
        assert_eq!((sample.cpu, sample.memory), (2_000_000, 1024 * 1024));
    }

    fn pod(namespace: &str, name: &str, containers: &[(&str, &str)]) -> serde_json::Value {
        let containers: Vec<_> = containers
            .iter()
            .map(|(container, cpu)| {
                json!({ "name": container, "usage": { "cpu": cpu, "memory": "1Mi" } })
            })
            .collect();
        json!({
            "metadata": { "name": name, "namespace": namespace },
            "timestamp": "2026-11-13T16:00:00Z",
            "containers": containers,
        })
    }

    fn after(previous: &Samples, list: &serde_json::Value) -> Samples {
        parse(list.to_string().as_bytes(), Kind::Pods, Some(previous)).unwrap()
    }

    fn key<'a>(samples: &'a Samples, namespace: &str, name: &str) -> &'a Arc<str> {
        samples.0[namespace].get_key_value(name).unwrap().0
    }

    #[test]
    fn a_poll_keeps_the_sample_and_the_name_of_what_it_finds_the_same() {
        let first = parsed(
            &json!({ "items": [
                pod("a", "same", &[("x", "1m"), ("y", "2m")]),
                pod("a", "moved", &[("x", "1m")]),
                pod("a", "split", &[("x", "1m"), ("y", "2m")]),
                pod("b", "other", &[("x", "1m")]),
            ] }),
            Kind::Pods,
        );
        let mut list = json!({ "items": [
            pod("a", "same", &[("y", "2m"), ("x", "1m")]),
            pod("a", "moved", &[("x", "2m")]),
            pod("a", "split", &[("x", "2m"), ("y", "1m")]),
            pod("a", "new", &[("x", "1m")]),
            pod("b", "other", &[("x", "1m")]),
        ] });
        list["items"][0]["timestamp"] = json!("2026-11-13T16:00:15Z");
        let second = after(&first, &list);

        let (before, now) = (
            first.get("a", "same").unwrap(),
            second.get("a", "same").unwrap(),
        );
        assert!(
            Arc::ptr_eq(before, now),
            "the same values, in another order and a later scrape"
        );
        assert_eq!(
            now.sampled,
            Some("2026-11-13T16:00:00Z".parse().unwrap()),
            "of the scrape that first read them"
        );
        assert!(Arc::ptr_eq(
            key(&first, "a", "same"),
            key(&second, "a", "same")
        ));
        assert!(Arc::ptr_eq(
            first.get("b", "other").unwrap(),
            second.get("b", "other").unwrap()
        ));

        for name in ["moved", "split"] {
            let (before, now) = (
                first.get("a", name).unwrap(),
                second.get("a", name).unwrap(),
            );
            assert!(!Arc::ptr_eq(before, now), "{name}");
            assert_ne!(before, now, "{name}");
            assert!(
                Arc::ptr_eq(key(&first, "a", name), key(&second, "a", name)),
                "its name is the same"
            );
        }
        assert_eq!(
            second.get("a", "split").unwrap().cpu,
            3_000_000,
            "the same total, another split"
        );
        assert_eq!(second.len(), 5);
        assert!(first.get("a", "new").is_none() && second.get("a", "new").is_some());
    }

    #[test]
    fn a_node_that_reads_the_same_keeps_its_sample() {
        let node = |cpu: &str| {
            json!({ "items": [{
                "metadata": { "name": "n" },
                "timestamp": "2026-11-13T16:28:56Z",
                "usage": { "cpu": cpu, "memory": "1Mi" },
            }] })
        };
        let first = parsed(&node("1m"), Kind::Nodes);
        let same = parse(node("1m").to_string().as_bytes(), Kind::Nodes, Some(&first)).unwrap();
        let moved = parse(node("2m").to_string().as_bytes(), Kind::Nodes, Some(&first)).unwrap();
        assert!(Arc::ptr_eq(
            first.get("", "n").unwrap(),
            same.get("", "n").unwrap()
        ));
        assert!(!Arc::ptr_eq(
            first.get("", "n").unwrap(),
            moved.get("", "n").unwrap()
        ));
        assert_eq!(moved.get("", "n").unwrap().cpu, 2_000_000);
    }

    #[test]
    fn a_pod_that_left_and_came_back_under_its_name_is_a_new_sample() {
        let with =
            json!({ "items": [pod("a", "p", &[("x", "1m")]), pod("a", "q", &[("x", "1m")])] });
        let without = json!({ "items": [pod("a", "q", &[("x", "1m")])] });
        let first = parsed(&with, Kind::Pods);
        let gone = after(&first, &without);
        assert!(gone.get("a", "p").is_none());
        assert!(Arc::ptr_eq(
            first.get("a", "q").unwrap(),
            gone.get("a", "q").unwrap()
        ));

        let back = after(&gone, &with);
        let (before, now) = (first.get("a", "p").unwrap(), back.get("a", "p").unwrap());
        assert_eq!(before, now, "the same values");
        assert!(!Arc::ptr_eq(before, now), "from the answer it left");
        assert!(!Arc::ptr_eq(key(&first, "a", "p"), key(&back, "a", "p")));
    }

    #[test]
    fn what_the_answer_before_held_survives_neither_a_null_list_nor_a_malformed_item() {
        let first = parsed(
            &json!({ "items": [pod("a", "p", &[("x", "1m")])] }),
            Kind::Pods,
        );
        assert!(
            parse(br#"{"items":null}"#, Kind::Pods, Some(&first))
                .unwrap()
                .is_empty()
        );
        assert!(
            parse(br#"{"kind":"PodMetricsList"}"#, Kind::Pods, Some(&first))
                .unwrap()
                .is_empty()
        );
        let malformed =
            br#"{"items":[{"metadata":{"name":"p","namespace":"a"},"containers":[{"name":"x"}]}]}"#;
        assert!(parse(malformed, Kind::Pods, Some(&first)).is_err());

        let unparsed = json!({ "items": [pod("a", "p", &[("x", "lots")])] });
        assert!(
            after(&first, &unparsed).is_empty(),
            "an item that does not parse is no sample, kept or not"
        );
    }

    #[test]
    fn an_empty_answer_may_send_null_and_an_item_that_does_not_parse_has_no_sample() {
        assert!(
            parse(br#"{"items":null}"#, Kind::Pods, None)
                .unwrap()
                .is_empty()
        );
        assert!(
            parse(br#"{"kind":"PodMetricsList"}"#, Kind::Pods, None)
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
