//! A part of an object as nested keys, for kinds without a describer.

use serde_json::Value;
use twigo_ipc::{Block, Section, TreeNode};

/// The section of `value`'s entries, those in `skip` left out; none when
/// nothing is left.
pub(crate) fn section(id: &str, title: &str, value: &Value, skip: &[&str]) -> Option<Section> {
    let nodes: Vec<TreeNode> = match value {
        Value::Object(map) => map
            .iter()
            .filter(|(key, _)| !skip.contains(&key.as_str()))
            .map(|(key, value)| node(key.clone(), value))
            .collect(),
        _ => Vec::new(),
    };
    (!nodes.is_empty()).then(|| Section {
        id: id.to_owned(),
        title: title.to_owned(),
        blocks: vec![Block::Tree { nodes }],
    })
}

fn node(key: String, value: &Value) -> TreeNode {
    match value {
        Value::Object(map) if !map.is_empty() => TreeNode {
            key,
            value: None,
            children: map
                .iter()
                .map(|(key, value)| node(key.clone(), value))
                .collect(),
        },
        Value::Array(items) if !items.is_empty() => TreeNode {
            key,
            value: None,
            children: items
                .iter()
                .enumerate()
                .map(|(index, item)| node(item_key(index, item), item))
                .collect(),
        },
        Value::Object(_) => leaf(key, "{}"),
        Value::Array(_) => leaf(key, "[]"),
        Value::String(text) => leaf(key, text),
        other => leaf(key, &other.to_string()),
    }
}

fn leaf(key: String, value: &str) -> TreeNode {
    TreeNode {
        key,
        value: Some(value.to_owned()),
        children: Vec::new(),
    }
}

/// A list item's name when it has one, as containers and ports do, else
/// its index.
fn item_key(index: usize, item: &Value) -> String {
    item["name"]
        .as_str()
        .map_or_else(|| index.to_string(), str::to_owned)
}
