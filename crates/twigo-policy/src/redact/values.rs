//! A Helm release's values, the person's or the chart's defaults, as JSON
//! text: keys, booleans and nulls as stored, every string and number as
//! `<N bytes>`, N the length of its text in UTF-8, a number's as stored.
//! Keys come in the stored order: Helm writes them sorted by their bytes, as
//! Go's `encoding/json` sorts a map's keys, and a `BTreeMap` of `String`s
//! keeps that order.

use std::collections::BTreeMap;
use std::fmt::Write;

use serde_json::value::RawValue;
use twigo_ipc::{ErrorCode, IpcError, ValueStep};

use super::Held;

/// The values with every string and number masked.
pub fn masked(values: &Held<Box<RawValue>>) -> String {
    let mut text = String::new();
    write(&values.0, None, &mut text);
    text
}

/// Two revisions' values masked so that a value that differs from its
/// counterpart, the value at the same path on the other side, reads
/// `<N bytes, changed>` on both; a value with no counterpart reads as
/// [`masked`] writes it.
pub fn compared(from: &Held<Box<RawValue>>, to: &Held<Box<RawValue>>) -> (String, String) {
    let (mut before, mut after) = (String::new(), String::new());
    write(&from.0, Some(Some(&to.0)), &mut before);
    write(&to.0, Some(Some(&from.0)), &mut after);
    (before, after)
}

/// What `path` holds, everything under it as JSON text as Helm stored it;
/// an empty path is the whole document, and a path that names nothing is
/// `helm.no-value`.
pub fn revealed(values: &Held<Box<RawValue>>, path: &[ValueStep]) -> Result<String, IpcError> {
    let mut at: &RawValue = &values.0;
    for (depth, step) in path.iter().enumerate() {
        let next = match (Node::of(at), step) {
            (Node::Map(map), ValueStep::Key(key)) => map.get(key).copied(),
            (Node::List(items), ValueStep::Index(index)) => items.get(*index as usize).copied(),
            _ => None,
        };
        at = next.ok_or_else(|| {
            IpcError::new(
                ErrorCode::HelmNoValue,
                format!("the values hold nothing at {}", shown(&path[..=depth])),
            )
        })?;
    }
    Ok(at.get().to_owned())
}

/// A path as people read it: `image.tag`, `extra[1]`.
fn shown(path: &[ValueStep]) -> String {
    let mut text = String::new();
    for step in path {
        match step {
            ValueStep::Key(key) if text.is_empty() => text.push_str(key),
            ValueStep::Key(key) => {
                text.push('.');
                text.push_str(key);
            }
            ValueStep::Index(index) => {
                let _ = write!(text, "[{index}]");
            }
        }
    }
    text
}

/// A value of the stored JSON, one level deep.
enum Node<'a> {
    Map(BTreeMap<String, &'a RawValue>),
    List(Vec<&'a RawValue>),
    /// A string's text.
    Text(String),
    /// A number as stored.
    Number(&'a str),
    /// `true`, `false` or `null`.
    Clear(&'a str),
}

impl<'a> Node<'a> {
    /// The node `raw` is. Its text is JSON that serde_json has read once
    /// already, so reading it again does not fail; were it to, the node is
    /// an empty map, which shows nothing of it.
    fn of(raw: &'a RawValue) -> Self {
        let text = raw.get();
        match text.as_bytes().first() {
            Some(b'{') => Node::Map(serde_json::from_str(text).unwrap_or_default()),
            Some(b'[') => Node::List(serde_json::from_str(text).unwrap_or_default()),
            Some(b'"') => Node::Text(serde_json::from_str(text).unwrap_or_default()),
            Some(b't' | b'f' | b'n') => Node::Clear(text),
            _ => Node::Number(text),
        }
    }

    /// The length a mask gives a string or a number; none for the rest.
    fn masked_length(&self) -> Option<usize> {
        match self {
            Node::Text(text) => Some(text.len()),
            Node::Number(text) => Some(text.len()),
            _ => None,
        }
    }
}

/// Writes `raw` masked. `other` is None outside a comparison, and in one its
/// counterpart, None where it has none.
fn write(raw: &RawValue, other: Option<Option<&RawValue>>, out: &mut String) {
    let node = Node::of(raw);
    let counterpart = other.flatten().map(Node::of);
    match node {
        Node::Map(map) => {
            let theirs = match &counterpart {
                Some(Node::Map(theirs)) => Some(theirs),
                _ => None,
            };
            out.push('{');
            for (index, (key, value)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::Value::from(key.as_str()).to_string());
                out.push(':');
                let counterpart = other.map(|_| theirs.and_then(|map| map.get(key).copied()));
                write(value, counterpart, out);
            }
            out.push('}');
        }
        Node::List(items) => {
            let theirs = match &counterpart {
                Some(Node::List(theirs)) => Some(theirs),
                _ => None,
            };
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                let counterpart = other.map(|_| theirs.and_then(|items| items.get(index).copied()));
                write(item, counterpart, out);
            }
            out.push(']');
        }
        Node::Clear(text) => out.push_str(text),
        Node::Text(_) | Node::Number(_) => {
            let bytes = node.masked_length().unwrap_or_default();
            let changed = counterpart.is_some_and(|theirs| !same(&node, &theirs));
            if changed {
                let _ = write!(out, "\"<{bytes} bytes, changed>\"");
            } else {
                let _ = write!(out, "\"<{bytes} bytes>\"");
            }
        }
    }
}

/// Whether a masked leaf equals its counterpart.
fn same(leaf: &Node<'_>, other: &Node<'_>) -> bool {
    match (leaf, other) {
        (Node::Text(a), Node::Text(b)) => a == b,
        (Node::Number(a), Node::Number(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held(text: &str) -> Held<Box<RawValue>> {
        Held::new(RawValue::from_string(text.to_owned()).unwrap())
    }

    #[test]
    fn strings_and_numbers_are_masked_and_the_rest_kept() {
        let values = held(
            r#"{"b":{"password":"hunter2","port":5432,"on":true,"off":null},"a":["x<y",1.5e3],"é":"ü"}"#,
        );
        assert_eq!(
            masked(&values),
            r#"{"a":["<3 bytes>","<5 bytes>"],"b":{"off":null,"on":true,"password":"<7 bytes>","port":"<4 bytes>"},"é":"<2 bytes>"}"#
        );
        assert_eq!(masked(&held("null")), "null");
    }

    #[test]
    fn a_value_that_changed_is_marked_on_both_sides_and_one_alone_is_not() {
        let from = held(
            r#"{"same":"a","changed":"old","size":"abc","gone":"x","list":[1,2],"shape":"s"}"#,
        );
        let to = held(
            r#"{"same":"a","changed":"new","size":"abcd","added":"y","list":[1,3,4],"shape":{"s":"s"}}"#,
        );
        let (before, after) = compared(&from, &to);
        assert_eq!(
            before,
            r#"{"changed":"<3 bytes, changed>","gone":"<1 bytes>","list":["<1 bytes>","<1 bytes, changed>"],"same":"<1 bytes>","shape":"<1 bytes, changed>","size":"<3 bytes, changed>"}"#
        );
        assert_eq!(
            after,
            r#"{"added":"<1 bytes>","changed":"<3 bytes, changed>","list":["<1 bytes>","<1 bytes, changed>","<1 bytes>"],"same":"<1 bytes>","shape":{"s":"<1 bytes>"},"size":"<4 bytes, changed>"}"#
        );
    }

    #[test]
    fn a_path_reveals_what_is_under_it_as_stored_and_nothing_else() {
        let values = held(r#"{"db":{"password":"hunter2","hosts":["a","b<"]},"n":1e3}"#);
        let key = |key: &str| ValueStep::Key(key.to_owned());
        assert_eq!(revealed(&values, &[]).unwrap(), values.0.get());
        assert_eq!(
            revealed(&values, &[key("db"), key("password")]).unwrap(),
            r#""hunter2""#
        );
        assert_eq!(
            revealed(&values, &[key("db"), key("hosts"), ValueStep::Index(1)]).unwrap(),
            r#""b<""#
        );
        assert_eq!(revealed(&values, &[key("n")]).unwrap(), "1e3");
        for nothing in [
            vec![key("db"), key("user")],
            vec![key("db"), key("hosts"), ValueStep::Index(2)],
            vec![key("db"), ValueStep::Index(0)],
            vec![key("db"), key("hosts"), key("0")],
            vec![key("n"), key("x")],
        ] {
            let refused = revealed(&values, &nothing).unwrap_err();
            assert_eq!(refused.code, ErrorCode::HelmNoValue, "{nothing:?}");
        }
    }
}
