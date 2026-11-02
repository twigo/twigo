//! What the webview may see of an object (ARCHITECTURE 3.6): managedFields
//! stay in Rust, and so do a Secret's values.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

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
            let Some(values) = object[field].as_object_mut() else {
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
}
