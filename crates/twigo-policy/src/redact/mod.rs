//! What the webview may see of an object and of a Helm release
//! (ARCHITECTURE 3.6): managedFields stay in Rust, and so do a Secret's
//! values, a release's values and the Secrets of its manifest until a
//! Reveal, while texts that may quote them are scrubbed of them.

use std::borrow::Cow;

use base64::Engine;
use base64::alphabet;
use base64::engine::GeneralPurpose;
use base64::engine::general_purpose::PAD;
use serde_json::Value;
use twigo_ipc::{ErrorCode, IpcError};

mod held;
pub mod manifest;
mod scrub;
pub mod values;

pub use held::{Held, Size};
pub use scrub::{HIDDEN, revealed_text, scrub, scrubbed, scrubbed_text, secret_values};

/// Holds the whole object as last applied, a Secret's values in clear.
const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// The object as a view shows it: managedFields dropped, for a Secret each
/// value replaced by its size and the last-applied annotation dropped, and
/// for a ConfigMap that holds a Helm release its `release` replaced by its
/// size and the last-applied annotation dropped.
pub fn for_view(object: Value) -> Value {
    let release = holds_helm_release(&object);
    for_view_as(object, release)
}

/// [`for_view`] of one version of an object, masking the `release` of a
/// ConfigMap where `release` says that a version of it holds a Helm
/// release, as each side of an edit's diff does, so that an edit that
/// drops or changes `owner: helm` shows no release.
pub fn for_view_as(mut object: Value, release: bool) -> Value {
    if let Some(metadata) = object.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.remove("managedFields");
    }
    if object["apiVersion"] == "v1" && object["kind"] == "Secret" {
        mask_secret(&mut object);
    } else if release && config_map(&object) {
        if let Some(release) = object
            .get_mut("data")
            .and_then(|data| data.get_mut("release"))
        {
            *release = Value::String(mask(release.as_str().map_or(0, str::len) as u64));
        }
        drop_last_applied(&mut object);
    }
    object
}

/// Whether `object` is a ConfigMap that Helm's ConfigMap driver keeps a
/// release in, whose `release` holds the release's values and manifest as
/// a Secret's would.
pub fn holds_helm_release(object: &Value) -> bool {
    config_map(object) && object["metadata"]["labels"]["owner"] == "helm"
}

fn config_map(object: &Value) -> bool {
    object["apiVersion"] == "v1" && object["kind"] == "ConfigMap"
}

/// A Secret with each value replaced by its size and the last-applied
/// annotation dropped.
fn mask_secret(secret: &mut Value) {
    mask_secret_with(secret, |_| false, |_, _| false);
}

/// [`mask_secret`], each value that `changed` picks, and each `data` or
/// `stringData` masked whole that `changed_whole` picks, reading
/// `<N bytes, changed>`.
fn mask_secret_with(
    secret: &mut Value,
    changed: impl Fn(&Entry<'_>) -> bool,
    changed_whole: impl Fn(Field, &Value) -> bool,
) {
    let masks: Vec<(Field, String, String)> = entries(secret)
        .map(|entry| {
            let mask = marked(entry.bytes(), changed(&entry));
            (entry.field, entry.key.to_owned(), mask)
        })
        .collect();
    for (field, key, mask) in masks {
        secret[field.name()][key] = Value::String(mask);
    }
    let whole: Vec<(Field, String)> = loose(secret)
        .map(|(field, value)| {
            let bytes = text(value).len() as u64;
            (field, marked(bytes, changed_whole(field, value)))
        })
        .collect();
    for (field, mask) in whole {
        secret[field.name()] = Value::String(mask);
    }
    drop_last_applied(secret);
}

fn drop_last_applied(object: &mut Value) {
    if let Some(annotations) = object
        .get_mut("metadata")
        .and_then(|metadata| metadata.get_mut("annotations"))
        .and_then(Value::as_object_mut)
    {
        annotations.remove(LAST_APPLIED);
    }
}

fn mask(bytes: u64) -> String {
    format!("<{bytes} bytes>")
}

fn marked(bytes: u64, changed: bool) -> String {
    if changed {
        format!("<{bytes} bytes, changed>")
    } else {
        mask(bytes)
    }
}

/// Where a Secret keeps a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    /// In base64.
    Data,
    /// As text, which the server writes over `data`.
    StringData,
}

impl Field {
    pub fn name(self) -> &'static str {
        match self {
            Field::Data => "data",
            Field::StringData => "stringData",
        }
    }
}

/// One value of a Secret, which has no `Debug`, as it would print the value.
#[derive(Clone, Copy)]
pub struct Entry<'a> {
    pub field: Field,
    pub key: &'a str,
    pub value: &'a Value,
}

impl Entry<'_> {
    /// Its size in bytes. A value of `data` counts the bytes its base64
    /// stands for, from its length, never decoded; one that is no base64,
    /// which the API server never serves and only a release's manifest can
    /// hold, counts its text, as its Reveal shows it.
    pub fn bytes(&self) -> u64 {
        let text = self.text();
        match self.field {
            Field::Data => decoded_len(&text).unwrap_or(text.len()) as u64,
            Field::StringData => text.len() as u64,
        }
    }
}

impl<'a> Entry<'a> {
    /// The value's text: a string's, none for null, and the JSON of any
    /// other value.
    pub fn text(&self) -> Cow<'a, str> {
        text(self.value)
    }
}

/// A value's text: a string's, none for null, and the JSON of any other
/// value, which only a release's manifest can hold.
fn text(value: &Value) -> Cow<'_, str> {
    match value {
        Value::String(text) => Cow::Borrowed(text),
        Value::Null => Cow::Borrowed(""),
        other => Cow::Owned(other.to_string()),
    }
}

/// Go's `base64.StdEncoding`: padding wanted, the bits after the last byte
/// unchecked.
const GO_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    PAD.with_decode_allow_trailing_bits(true),
);

/// The bytes `text` stands for as Go's `base64.StdEncoding` decodes it,
/// which the API server reads a Secret's `data` with and Helm the release
/// it stores; None for text it refuses. Go's decoder skips `\r` and `\n`
/// wherever they stand, as in a value written over several lines
/// ([base64.go](https://github.com/golang/go/blob/go1.27.1/src/encoding/base64/base64.go#L307-L401)).
pub fn decode_base64(text: &[u8]) -> Option<Vec<u8>> {
    let line_break = |byte: &u8| matches!(byte, b'\r' | b'\n');
    let text = if text.iter().any(line_break) {
        Cow::Owned(
            text.iter()
                .copied()
                .filter(|byte| !line_break(byte))
                .collect(),
        )
    } else {
        Cow::Borrowed(text)
    };
    GO_BASE64.decode(&*text).ok()
}

/// How many bytes [`decode_base64`] gives of `text`, from its symbols and
/// padding, with nothing allocated; None where it gives none.
fn decoded_len(text: &str) -> Option<usize> {
    let (mut symbols, mut padding) = (0, 0);
    for byte in text.bytes() {
        match byte {
            b'\r' | b'\n' => {}
            b'=' => padding += 1,
            _ if padding > 0 => return None,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => symbols += 1,
            _ => return None,
        }
    }
    ((symbols + padding) % 4 == 0 && padding <= 2).then_some(symbols * 3 / 4)
}

/// A Secret's values: those of `data`, then those of `stringData`, each in
/// the order of its keys.
pub fn entries(secret: &Value) -> impl Iterator<Item = Entry<'_>> {
    [Field::Data, Field::StringData]
        .into_iter()
        .flat_map(move |field| {
            secret[field.name()]
                .as_object()
                .into_iter()
                .flatten()
                .map(move |(key, value)| Entry { field, key, value })
        })
}

/// A `data` or `stringData` that is neither a map nor null, which only a
/// release's manifest can hold, and which a mask hides whole.
fn loose(secret: &Value) -> impl Iterator<Item = (Field, &Value)> {
    [Field::Data, Field::StringData]
        .into_iter()
        .filter_map(move |field| {
            secret
                .get(field.name())
                .filter(|value| !value.is_object() && !value.is_null())
                .map(|value| (field, value))
        })
}

/// What a Secret holds: each value of `data` and `stringData`, and either
/// one whole where it is not a map.
fn contents(secret: &Value) -> impl Iterator<Item = (Field, &Value)> {
    entries(secret)
        .map(|entry| (entry.field, entry.value))
        .chain(loose(secret))
}

/// Whether `text` reads as what [`for_view`] puts in place of a Secret's
/// value, as a mask left where a value should be.
pub fn is_mask(text: &str) -> bool {
    text.strip_prefix('<')
        .and_then(|rest| rest.strip_suffix(" bytes>"))
        .is_some_and(|size| !size.is_empty() && size.bytes().all(|byte| byte.is_ascii_digit()))
}

/// A Secret's value of `key` (ARCHITECTURE 3.6): its text, or its base64 when
/// it is not UTF-8, and whether it is; refused for any other kind.
pub fn secret_value(object: &Value, key: &str) -> Result<(String, bool), IpcError> {
    if object["apiVersion"] != "v1" || object["kind"] != "Secret" {
        return Err(IpcError::new(
            ErrorCode::SecretNotASecret,
            "only a Secret's values are revealed".to_owned(),
        ));
    }
    value_of(object, key)
}

/// A Secret's value of `key` as [`secret_value`] gives it: `stringData`'s,
/// which the server writes over `data`, else `data`'s decoded, or as written
/// when it is no base64, which only a release's manifest can hold.
fn value_of(secret: &Value, key: &str) -> Result<(String, bool), IpcError> {
    let entry = entries(secret)
        .filter(|entry| entry.key == key)
        .last()
        .ok_or_else(|| {
            IpcError::new(
                ErrorCode::SecretNoKey,
                format!("the Secret has no key {key}"),
            )
        })?;
    let text = entry.text();
    if entry.field == Field::StringData {
        return Ok((text.into_owned(), false));
    }
    Ok(
        match decode_base64(text.as_bytes()).map(String::from_utf8) {
            Some(Ok(decoded)) => (decoded, false),
            Some(Err(_)) => (text.into_owned(), true),
            None => (text.into_owned(), false),
        },
    )
}

/// `text` with each of `names` that stands in it as a whole token replaced by
/// what `with` makes of the name's index, so that a short name does not garble
/// the words around it.
///
/// The longest of the names that start at one place wins, and a replacement is
/// never read again, so a name that an earlier replacement spells is not
/// replaced inside it.
pub fn whole_tokens_replaced<N: AsRef<str>>(
    text: &str,
    names: &[N],
    mut with: impl FnMut(usize) -> String,
) -> String {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut found = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let name = name.as_ref();
        let (Some(first), Some(last)) = (name.chars().next(), name.chars().next_back()) else {
            continue;
        };
        for (start, _) in text.match_indices(name) {
            let end = start + name.len();
            let joins_word = (word(first) && text[..start].chars().next_back().is_some_and(word))
                || (word(last) && text[end..].chars().next().is_some_and(word));
            if !joins_word {
                found.push((start, end, index));
            }
        }
    }
    found.sort_by_key(|&(start, end, _)| (start, std::cmp::Reverse(end)));
    let mut replaced = String::with_capacity(text.len());
    let mut from = 0;
    for (start, end, index) in found {
        if start < from {
            continue;
        }
        replaced.push_str(&text[from..start]);
        replaced.push_str(&with(index));
        from = end;
    }
    replaced.push_str(&text[from..]);
    replaced
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_name_is_replaced_only_as_a_whole_token_and_the_longest_wins() {
        let names = ["prod", "prod-eu", "eu"];
        let replaced =
            whole_tokens_replaced("prod-eu, prod, prods, a-eu eu_1 eu.", &names, |index| {
                format!("<{index}>")
            });
        assert_eq!(replaced, "<1>, <0>, prods, a-<2> eu_1 <2>.");
    }

    #[test]
    fn a_replacement_is_not_read_again() {
        let names = ["prod", "context"];
        let replaced = whole_tokens_replaced("prod", &names, |_| "<context-1>".to_owned());
        assert_eq!(replaced, "<context-1>");
    }

    #[test]
    fn a_secret_keeps_its_keys_and_sizes_only() {
        let shown = for_view(json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": "db",
                "annotations": {
                    LAST_APPLIED: "{\"data\":{\"password\":\"aHVudGVyMg==\"}}",
                    "team": "payments",
                },
                "managedFields": [{ "manager": "kubectl" }],
            },
            "data": { "password": "aHVudGVyMg==" },
            "stringData": { "token": "hunter2" },
        }));
        let text = shown.to_string();
        assert!(
            !text.contains("hunter2") && !text.contains("aHVudGVyMg"),
            "{text}"
        );
        assert_eq!(shown["data"]["password"], "<7 bytes>");
        assert_eq!(shown["stringData"]["token"], "<7 bytes>");
        assert_eq!(
            shown["metadata"]["annotations"],
            json!({ "team": "payments" })
        );
        assert!(shown["metadata"].get("managedFields").is_none());
    }

    #[test]
    fn a_value_counts_what_its_base64_stands_for_without_decoding_it() {
        let shown = for_view(json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "data": { "one": "aA==", "two": "aGk=", "three": "aGkh", "empty": "", "bad": "not base64!", "lines": "aHVu\ndGVyMg==\n" },
        }));
        assert_eq!(
            shown["data"],
            json!({
                "one": "<1 bytes>",
                "two": "<2 bytes>",
                "three": "<3 bytes>",
                "empty": "<0 bytes>",
                "bad": "<11 bytes>",
                "lines": "<7 bytes>",
            })
        );
    }

    #[test]
    fn a_value_of_data_reads_as_the_api_server_decodes_it() {
        let secret = json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "data": { "lines": "aHVu\r\ndGVyMg==\n", "loose": "aGl=", "short": "aGk" },
        });
        assert_eq!(
            secret_value(&secret, "lines").unwrap(),
            ("hunter2".to_owned(), false)
        );
        assert_eq!(
            secret_value(&secret, "loose").unwrap(),
            ("hi".to_owned(), false),
            "Go leaves the bits after the last byte unchecked"
        );
        assert_eq!(
            secret_value(&secret, "short").unwrap(),
            ("aGk".to_owned(), false),
            "Go wants the padding"
        );
        assert_eq!(for_view(secret)["data"]["short"], "<3 bytes>");
    }

    #[test]
    fn a_mask_is_only_what_a_view_writes_for_a_value() {
        for mask in ["<7 bytes>", "<0 bytes>", "<12345 bytes>"] {
            assert!(is_mask(mask), "{mask}");
        }
        for not in [
            "<bytes>",
            "< bytes>",
            "<7 byte>",
            "7 bytes>",
            "<x bytes>",
            "hunter2",
        ] {
            assert!(!is_mask(not), "{not}");
        }
    }

    #[test]
    fn a_secret_gains_no_field_it_lacks() {
        let shown = for_view(json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": { "name": "empty" },
            "type": "Opaque",
        }));
        assert_eq!(
            shown,
            json!({
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": { "name": "empty" },
                "type": "Opaque",
            })
        );
    }

    #[test]
    fn other_kinds_keep_their_data_and_annotations() {
        let config = json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {
                "name": "settings",
                "annotations": { LAST_APPLIED: "{}" },
                "managedFields": [{ "manager": "kubectl" }],
            },
            "data": { "mode": "fast" },
        });
        let shown = for_view(config.clone());
        assert_eq!(shown["data"], config["data"]);
        assert_eq!(
            shown["metadata"]["annotations"],
            config["metadata"]["annotations"]
        );
        assert!(shown["metadata"].get("managedFields").is_none());
    }

    #[test]
    fn a_secret_reveals_its_text_or_the_base64_of_its_bytes() {
        let secret = serde_json::json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "data": { "password": "aHVudGVyMg==", "key.der": "MIIBCgKCAQEA/w==" },
        });
        let value = secret_value(&secret, "password").unwrap();
        assert_eq!(value, ("hunter2".to_owned(), false));
        let value = secret_value(&secret, "key.der").unwrap();
        assert_eq!(value, ("MIIBCgKCAQEA/w==".to_owned(), true));
        let missing = secret_value(&secret, "token").unwrap_err();
        assert_eq!(missing.code, ErrorCode::SecretNoKey);
        let written = serde_json::json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "data": { "both": "aHVudGVyMg==", "bad": "not base64!" },
            "stringData": { "both": "typed", "token": "s3cret" },
        });
        let value = secret_value(&written, "token").unwrap();
        assert_eq!(value, ("s3cret".to_owned(), false));
        let value = secret_value(&written, "both").unwrap();
        assert_eq!(value, ("typed".to_owned(), false), "stringData wins");
        let value = secret_value(&written, "bad").unwrap();
        assert_eq!(value, ("not base64!".to_owned(), false));
        let config = serde_json::json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": { "password": "aHVudGVyMg==" },
        });
        let refused = secret_value(&config, "password").unwrap_err();
        assert_eq!(refused.code, ErrorCode::SecretNotASecret);
    }
}
