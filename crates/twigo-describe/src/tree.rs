//! A part of an object as nested keys, for kinds without a describer:
//! nulls and empty maps and lists say nothing and are left out, and field
//! names read as words, as kubectl's generic describer prints them.

use serde_json::Value;
use twigo_ipc::{Block, Section, TreeNode, TreeValue};

/// The section of `value`'s entries, those in `skip` left out; none when
/// nothing is left.
pub(crate) fn section(id: &str, title: &str, value: &Value, skip: &[&str]) -> Option<Section> {
    let nodes: Vec<TreeNode> = match value {
        Value::Object(map) => map
            .iter()
            .filter(|(key, _)| !skip.contains(&key.as_str()))
            .filter_map(|(key, value)| node(key.clone(), field(key), value))
            .collect(),
        _ => Vec::new(),
    };
    (!nodes.is_empty()).then(|| Section {
        id: id.to_owned(),
        title: title.to_owned(),
        blocks: vec![Block::Tree { nodes }],
    })
}

/// Maps whose keys are data, not field names: labels, selectors, a
/// ConfigMap's keys, resource names.
const DATA_MAPS: &[&str] = &[
    "annotations",
    "labels",
    "matchLabels",
    "nodeSelector",
    "selector",
    "data",
    "binaryData",
    "stringData",
    "requests",
    "limits",
    "capacity",
    "allocatable",
    "hard",
    "used",
];

fn node(key: String, label: String, value: &Value) -> Option<TreeNode> {
    let value = match value {
        Value::Null => return None,
        Value::Object(map) => {
            let data = DATA_MAPS.contains(&key.as_str());
            let entries: Vec<TreeNode> = map
                .iter()
                .filter_map(|(entry, value)| {
                    let label = if data { entry.clone() } else { field(entry) };
                    node(entry.clone(), label, value)
                })
                .collect();
            if entries.is_empty() {
                return None;
            }
            TreeValue::Map { entries }
        }
        Value::Array(items) => {
            let items: Vec<TreeNode> = items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    let key = item_key(index, item);
                    node(key.clone(), key, item)
                })
                .collect();
            if items.is_empty() {
                return None;
            }
            TreeValue::List { items }
        }
        Value::String(text) => TreeValue::Scalar { text: text.clone() },
        other => TreeValue::Scalar {
            text: other.to_string(),
        },
    };
    Some(TreeNode { key, label, value })
}

/// A list item's name when it has one, as containers and ports do, else
/// its index.
fn item_key(index: usize, item: &Value) -> String {
    item["name"]
        .as_str()
        .map_or_else(|| index.to_string(), str::to_owned)
}

/// Words kubectl and the API write in capitals, or as they are spelled.
const SPELLED: &[(&str, &str)] = &[
    ("api", "API"),
    ("cidr", "CIDR"),
    ("cidrs", "CIDRs"),
    ("cpu", "CPU"),
    ("dns", "DNS"),
    ("gid", "GID"),
    ("http", "HTTP"),
    ("https", "HTTPS"),
    ("id", "ID"),
    ("ip", "IP"),
    ("ipc", "IPC"),
    ("ips", "IPs"),
    ("json", "JSON"),
    ("linux", "Linux"),
    ("os", "OS"),
    ("pid", "PID"),
    ("qos", "QoS"),
    ("sctp", "SCTP"),
    ("se", "SE"),
    ("tcp", "TCP"),
    ("tls", "TLS"),
    ("ttl", "TTL"),
    ("udp", "UDP"),
    ("uid", "UID"),
    ("uri", "URI"),
    ("url", "URL"),
    ("uuid", "UUID"),
];

/// A field's name in words, the first capitalised: `podIPs` reads "Pod
/// IPs". A key that is no identifier, such as `kubernetes.io/hostname`,
/// stays as it is.
fn field(key: &str) -> String {
    if !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return key.to_owned();
    }
    let chars: Vec<char> = key.chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    for (index, &c) in chars.iter().enumerate() {
        let previous = index.checked_sub(1).map(|i| chars[i]);
        let next = chars.get(index + 1).copied();
        // An acronym ends before a capital that starts a word, as in
        // `IPFamily`, but keeps a plural's `s`, as in `podIPs`.
        let plural = next == Some('s')
            && chars
                .get(index + 2)
                .is_none_or(|after| after.is_ascii_uppercase());
        let starts = c.is_ascii_uppercase()
            && previous.is_some_and(|p| {
                p.is_ascii_lowercase()
                    || p.is_ascii_digit()
                    || (p.is_ascii_uppercase()
                        && next.is_some_and(|n| n.is_ascii_lowercase())
                        && !plural)
            });
        if starts && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        word.push(c);
    }
    words.push(word);
    words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            let lower = word.to_ascii_lowercase();
            if let Some((_, spelled)) = SPELLED.iter().find(|(plain, _)| *plain == lower) {
                return (*spelled).to_owned();
            }
            if index == 0 {
                let mut chars = lower.chars();
                chars
                    .next()
                    .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                    .unwrap_or_default()
            } else {
                lower
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn empty_values_are_left_out_and_named_items_keep_their_names() {
        let spec = json!({
            "containers": [{ "name": "app", "image": "pause", "env": [], "securityContext": {} }],
            "tolerations": [{ "operator": "Exists" }],
            "nodeName": null,
            "securityContext": {},
        });
        let Some(Section { blocks, .. }) = section("core.spec", "Spec", &spec, &[]) else {
            panic!("a section");
        };
        let [Block::Tree { nodes }] = &blocks[..] else {
            panic!("one tree: {blocks:?}");
        };
        let keys: Vec<&str> = nodes.iter().map(|node| node.key.as_str()).collect();
        assert_eq!(keys, ["containers", "tolerations"]);
        let TreeValue::List { items } = &nodes[0].value else {
            panic!("a list");
        };
        assert_eq!(
            (items[0].key.as_str(), items[0].label.as_str()),
            ("app", "app")
        );
        let TreeValue::Map { entries } = &items[0].value else {
            panic!("a map");
        };
        let keys: Vec<&str> = entries.iter().map(|entry| entry.key.as_str()).collect();
        assert_eq!(keys, ["image", "name"]);
        let TreeValue::List { items } = &nodes[1].value else {
            panic!("a list");
        };
        assert_eq!(items[0].key, "0");
    }

    #[test]
    fn field_names_read_as_words_and_data_keys_stay() {
        for (key, label) in [
            (
                "terminationGracePeriodSeconds",
                "Termination grace period seconds",
            ),
            ("dnsPolicy", "DNS policy"),
            ("podIPs", "Pod IPs"),
            ("hostIPC", "Host IPC"),
            ("ipFamilyPolicy", "IP family policy"),
            ("seLinuxOptions", "SE Linux options"),
            ("qosClass", "QoS class"),
            ("kubernetes.io/hostname", "kubernetes.io/hostname"),
        ] {
            assert_eq!(field(key), label, "{key}");
        }
        let spec = json!({ "nodeSelector": { "disktype": "ssd" }, "resources": { "requests": { "cpu": "10m" } } });
        let Some(Section { blocks, .. }) = section("core.spec", "Spec", &spec, &[]) else {
            panic!("a section");
        };
        let [Block::Tree { nodes }] = &blocks[..] else {
            panic!("one tree");
        };
        let TreeValue::Map { entries } = &nodes[0].value else {
            panic!("a map");
        };
        assert_eq!(
            (nodes[0].label.as_str(), entries[0].label.as_str()),
            ("Node selector", "disktype")
        );
        let TreeValue::Map { entries } = &nodes[1].value else {
            panic!("a map");
        };
        let TreeValue::Map { entries } = &entries[0].value else {
            panic!("requests");
        };
        assert_eq!(entries[0].label, "cpu");
    }
}
