//! What the webview may see of an object (ARCHITECTURE 3.6): managedFields
//! stay in Rust, and so do a Secret's values until a Reveal.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use twigo_ipc::{ErrorKind, IpcError};

/// Holds the whole object as last applied, a Secret's values in clear.
const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// The object as a view shows it: managedFields dropped, and for a Secret
/// each value replaced by its size and the last-applied annotation dropped.
pub fn for_view(mut object: Value) -> Value {
    let secret = object["apiVersion"] == "v1" && object["kind"] == "Secret";
    if let Some(metadata) = object["metadata"].as_object_mut() {
        metadata.remove("managedFields");
        if secret
            && let Some(annotations) = metadata
                .get_mut("annotations")
                .and_then(Value::as_object_mut)
        {
            annotations.remove(LAST_APPLIED);
        }
    }
    if secret {
        for (field, encoded) in [("data", true), ("stringData", false)] {
            let Some(values) = object.get_mut(field).and_then(Value::as_object_mut) else {
                continue;
            };
            for value in values.values_mut() {
                let bytes = match value.as_str() {
                    Some(text) if encoded => STANDARD.decode(text).map_or(0, |bytes| bytes.len()),
                    Some(text) => text.len(),
                    None => 0,
                };
                *value = Value::String(format!("<{bytes} bytes>"));
            }
        }
    }
    object
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
            ErrorKind::InvalidInput,
            "only a Secret's values are revealed".to_owned(),
        ));
    }
    let encoded = object["data"][key].as_str().ok_or_else(|| {
        IpcError::new(ErrorKind::NotFound, format!("the Secret has no key {key}"))
    })?;
    let bytes = STANDARD.decode(encoded).map_err(|error| {
        IpcError::new(
            ErrorKind::Internal,
            format!("the value of {key} is no base64: {error}"),
        )
    })?;
    Ok(match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(_) => (encoded.to_owned(), true),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

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
        assert_eq!(missing.kind, ErrorKind::NotFound);
        let config = serde_json::json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": { "password": "aHVudGVyMg==" },
        });
        let refused = secret_value(&config, "password").unwrap_err();
        assert_eq!(refused.kind, ErrorKind::InvalidInput);
    }
}
