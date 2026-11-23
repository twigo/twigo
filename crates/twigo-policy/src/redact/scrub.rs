//! Text that may quote a Secret's values, such as a refusal of an edit, a
//! release's notes or a revision's description, with each of them taken out.

use std::collections::BTreeSet;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use twigo_ipc::{IpcError, Scrubbed};

use super::{Field, Held, contents, decoded, whole_tokens_replaced};

/// What takes the place of a value in a text.
pub const HIDDEN: &str = "<hidden>";

/// Takes every value in `secrets` out of `text`, where it stands as a whole
/// token, so that a short value does not garble the words around it. For a
/// Secret the patched object a refusal quotes goes whole, as no token matches
/// what the server wrote of its values: JSON, HTML characters escaped, quoted
/// again as a string ([`applyPatchToCurrentObject`]'s `field.Invalid`).
///
/// [`applyPatchToCurrentObject`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/patch.go#L356-L358
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let text = if secrets.is_empty() {
        text.to_owned()
    } else {
        without_quoted_object(text)
    };
    whole_tokens_replaced(&text, secrets, |_| HIDDEN.to_owned())
}

/// A release's notes or a revision's description scrubbed of `values`, its
/// Secrets' values, as [`scrub`] scrubs a refusal.
pub fn scrubbed_text(text: &Held<String>, values: &Held<Vec<String>>) -> Scrubbed {
    let scrubbed = scrub(&text.0, &values.0);
    Scrubbed {
        hidden: scrubbed != text.0,
        text: scrubbed,
    }
}

/// A release's notes or a revision's description, whole, for a Reveal;
/// None where it is empty.
pub fn revealed_text(text: &Held<String>) -> Option<String> {
    (!text.0.is_empty()).then(|| text.0.clone())
}

impl Held<Vec<String>> {
    /// The values of both.
    pub fn joined(mut self, other: Self) -> Self {
        self.0.extend(other.0);
        self
    }
}

/// `text` with the object of a `patch: Invalid value: "…"` left out.
fn without_quoted_object(text: &str) -> String {
    const OPENING: &str = "patch: Invalid value: \"";
    let Some(start) = text.find(OPENING).map(|at| at + OPENING.len()) else {
        return text.to_owned();
    };
    let mut escaped = false;
    for (index, c) in text[start..].char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => {
                return format!(
                    "{}{HIDDEN}{}",
                    &text[..start - 1],
                    &text[start + index + 1..]
                );
            }
            _ => {}
        }
    }
    text.to_owned()
}

/// `error` with its message scrubbed of `secrets`; for a Secret the causes
/// keep only their reason and field, as each cause's message quotes the
/// patched object in a spelling no value matches: the object's JSON, HTML
/// characters escaped, quoted again as a string ([`NewInvalid`] writes a
/// cause's `ErrorBody()` and the message's `Error()`, which `scrub` cuts
/// only at `patch: Invalid value: "`).
///
/// [`NewInvalid`]: https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apimachinery/pkg/api/errors/errors.go#L284-L312
pub fn scrubbed(mut error: IpcError, secrets: &[String]) -> IpcError {
    error.message = scrub(&error.message, secrets);
    if !secrets.is_empty() {
        for cause in error
            .server
            .iter_mut()
            .flat_map(|server| &mut server.causes)
        {
            cause.message.clear();
        }
    }
    error
}

/// Every string and number a Secret of `objects` holds in `data` and
/// `stringData`, encoded and decoded, the longest first, so that what a
/// refusal echoes is covered before any answer shows how the server stored
/// it. Booleans and nulls carry no secret.
pub fn secret_values(objects: &[&Value]) -> Vec<String> {
    let mut values = BTreeSet::new();
    for object in objects {
        for (field, value) in contents(object) {
            let mut texts = Vec::new();
            scalars(value, &mut texts);
            for text in texts {
                match field {
                    Field::StringData => {
                        values.insert(STANDARD.encode(&text));
                    }
                    Field::Data => {
                        if let Some(bytes) = decoded(&text) {
                            values.insert(String::from_utf8_lossy(&bytes).into_owned());
                        }
                    }
                }
                values.insert(text);
            }
        }
    }
    let mut values: Vec<String> = values
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect();
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    values
}

/// The strings and numbers in `value`, at any depth, as text.
fn scalars(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::String(text) => found.push(text.clone()),
        Value::Number(number) => found.push(number.to_string()),
        Value::Array(items) => {
            for item in items {
                scalars(item, found);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                scalars(item, found);
            }
        }
        Value::Bool(_) | Value::Null => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn scrubbing_takes_a_value_only_as_a_whole_token() {
        let secrets = vec!["a".to_owned(), "hunter2".to_owned(), "x=".to_owned()];
        assert_eq!(
            scrub("a a-bcd spat a_b ahunter2 hunter2 at x= cx=", &secrets),
            format!("{HIDDEN} {HIDDEN}-bcd spat a_b ahunter2 {HIDDEN} at {HIDDEN} cx=")
        );
    }

    #[test]
    fn a_refusal_that_quotes_the_patched_object_loses_it_for_a_secret() {
        let message = r#""" is invalid: patch: Invalid value: "{\"data\":{\"bad\":\"@@@\"},\"stringData\":{\"k\":\"sec\\\"ret\\nnl\\u003ctag\\u003e\"},\"type\":\"Opaque\"}": illegal base64 data at input byte 0"#;
        assert_eq!(
            scrub(message, &["sec\"ret\nnl<tag>".to_owned()]),
            format!(
                "\"\" is invalid: patch: Invalid value: {HIDDEN}: illegal base64 data at input byte 0"
            )
        );
        assert_eq!(
            scrub(message, &[]),
            message,
            "only a Secret has values to hide"
        );
        assert_eq!(
            scrub("no quoted object here", &["x".to_owned()]),
            "no quoted object here"
        );
    }

    #[test]
    fn a_secret_s_values_are_scrubbed_encoded_and_decoded() {
        let secret = json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "data": { "password": "aHVudGVyMg==" },
            "stringData": { "token": "s3cret" },
        });
        let secrets = secret_values(&[&secret]);
        let text = scrub("bad aHVudGVyMg== and hunter2 and s3cret", &secrets);
        assert_eq!(text, format!("bad {HIDDEN} and {HIDDEN} and {HIDDEN}"));
    }

    #[test]
    fn a_value_of_string_data_is_scrubbed_as_the_server_would_store_it() {
        let secrets = secret_values(&[&json!({ "stringData": { "token": "typed-value" } })]);
        assert_eq!(
            scrub("token is dHlwZWQtdmFsdWU=", &secrets),
            format!("token is {HIDDEN}")
        );
    }

    #[test]
    fn every_string_and_number_a_secret_holds_is_scrubbed_however_it_is_written() {
        let secret = json!({
            "kind": "Secret",
            "data": { "lines": "aHVu\ndGVyMg==\n" },
            "stringData": { "pin": 123_456, "on": true, "hosts": ["db-one"] },
        });
        let secrets = secret_values(&[&secret]);
        assert_eq!(
            scrub("Log in with hunter2 and 123456 at db-one, true.", &secrets),
            format!("Log in with {HIDDEN} and {HIDDEN} at {HIDDEN}, true.")
        );
        let loose = json!({ "kind": "Secret", "data": "aHVudGVyMg==", "stringData": ["s3cret"] });
        assert_eq!(
            scrub("hunter2 or s3cret", &secret_values(&[&loose])),
            format!("{HIDDEN} or {HIDDEN}")
        );
    }

    #[test]
    fn notes_say_whether_a_value_was_taken_out() {
        let values =
            Held::new(vec!["s3cret".to_owned()]).joined(Held::new(vec!["hunter2".to_owned()]));
        let notes = Held::new("Log in with hunter2, or s3cret2.".to_owned());
        assert_eq!(
            scrubbed_text(&notes, &values),
            Scrubbed {
                text: format!("Log in with {HIDDEN}, or s3cret2."),
                hidden: true,
            }
        );
        let plain = Held::new("Nothing secret.".to_owned());
        assert!(!scrubbed_text(&plain, &values).hidden);
    }
}
