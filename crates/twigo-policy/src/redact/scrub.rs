//! Text that may quote a Secret's values, such as a refusal of an edit, a
//! release's notes or a revision's description, with each of them taken out.

use std::collections::BTreeSet;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Number, Value};
use twigo_ipc::{IpcError, Scrubbed};

use super::{Field, Held, contents, decode_base64, holds_helm_release, whole_tokens_replaced};

/// What takes the place of a value in a text.
pub const HIDDEN: &str = "<hidden>";

/// Takes every value in `secrets` out of `text`, where it stands as a whole
/// token, so that a short value does not garble the words around it. A value
/// with no letter or digit is no token, as it cannot be told from the
/// punctuation and the spaces around it. For a Secret each patched object a
/// refusal quotes goes whole, as no token matches what the server wrote of
/// its values: JSON, HTML characters escaped, quoted again as a string
/// ([`applyPatchToCurrentObject`]'s `field.Invalid`).
///
/// [`applyPatchToCurrentObject`]: https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/patch.go#L356-L358
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let text = if secrets.is_empty() {
        text.to_owned()
    } else {
        without_quoted_objects(text)
    };
    let tokens: Vec<&String> = secrets
        .iter()
        .filter(|value| value.chars().any(char::is_alphanumeric))
        .collect();
    whole_tokens_replaced(&text, &tokens, |_| HIDDEN.to_owned())
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

/// `text` with the object of each `patch: Invalid value: "…"` left out:
/// Helm joins the refusals of every object an upgrade could not update
/// with ` && `
/// ([client.go](https://github.com/helm/helm/blob/v4.3.2/pkg/kube/client.go#L654)).
fn without_quoted_objects(text: &str) -> String {
    const OPENING: &str = "patch: Invalid value: \"";
    let mut kept = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(OPENING).map(|at| at + OPENING.len())
        && let Some(end) = closing_quote(&rest[start..])
    {
        kept.push_str(&rest[..start - 1]);
        kept.push_str(HIDDEN);
        rest = &rest[start + end + 1..];
    }
    kept.push_str(rest);
    kept
}

/// Where the quoted string whose text starts `text` ends: its closing
/// quote's index.
fn closing_quote(text: &str) -> Option<usize> {
    let mut escaped = false;
    for (index, c) in text.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => return Some(index),
            _ => {}
        }
    }
    None
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
/// `stringData`, encoded and decoded, and the `release` of a ConfigMap that
/// holds a Helm release, the longest first, so that what a refusal echoes is
/// covered before any answer shows how the server stored it; none of any
/// other kind. Booleans and nulls carry no secret. A value whose text reads
/// as a number comes in each of that number's spellings too, since a
/// template may print the value it came from as a float where the Secret
/// holds it quoted, or the other way round.
pub fn secret_values(objects: &[&Value]) -> Vec<String> {
    let mut values = BTreeSet::new();
    for object in objects {
        if holds_helm_release(object) {
            values.extend(object["data"]["release"].as_str().map(str::to_owned));
            continue;
        }
        if object["kind"] != "Secret" {
            continue;
        }
        for (field, value) in contents(object) {
            let mut texts = Vec::new();
            scalars(value, &mut texts);
            for text in texts {
                let stored = match field {
                    Field::StringData => {
                        values.insert(STANDARD.encode(&text));
                        Some(text.clone())
                    }
                    Field::Data => decode_base64(text.as_bytes())
                        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
                };
                if let Some(stored) = stored {
                    if let Ok(number) = stored.parse::<Number>() {
                        values.extend(spellings(&number));
                    }
                    values.insert(stored);
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

/// The strings and numbers in `value`, at any depth, as text: a number in
/// each spelling it may be printed in.
fn scalars(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::String(text) => found.push(text.clone()),
        Value::Number(number) => found.extend(spellings(number)),
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

/// A number as serde_json writes it, as Go's `%v` prints it as a float64,
/// which Helm's templates print a value read from YAML as, such as
/// `1.234567e+06`, as Go's `encoding/json` writes it, which `toJson` prints
/// and a refusal of an object Helm sent quotes, such as
/// `1152921504606847000` for 2^60, and as its integer digits where it is
/// whole, as `| int64` prints it.
fn spellings(number: &Number) -> Vec<String> {
    let mut spellings = vec![number.to_string()];
    if let Some(float) = number.as_f64().filter(|float| float.is_finite()) {
        spellings.push(go_float(float));
        spellings.push(go_json(float));
        if float.fract() == 0.0 && float.abs() < 1e21 {
            spellings.push(format!("{float:.0}"));
        }
    }
    spellings.dedup();
    spellings
}

/// Go's `%v` of a float64: its shortest digits, with an exponent of at
/// least two digits where it is under -4 or 6 and over
/// ([ftoa.go](https://github.com/golang/go/blob/go1.27.1/src/internal/strconv/ftoa.go#L347-L373)).
fn go_float(float: f64) -> String {
    let (sign, digits, exponent) = shortest(float);
    if float == 0.0 {
        format!("{sign}0")
    } else if (-4..6).contains(&exponent) {
        fixed(sign, &digits, exponent)
    } else {
        exponential(sign, &digits, exponent, 2)
    }
}

/// Go's `encoding/json` of a float64: its shortest digits without an
/// exponent from 1e-6 to under 1e21, else with one of at least one digit
/// ([encode.go](https://github.com/golang/go/blob/go1.27.1/src/encoding/json/encode.go#L583-L599)).
fn go_json(float: f64) -> String {
    let (sign, digits, exponent) = shortest(float);
    if float == 0.0 {
        format!("{sign}0")
    } else if (1e-6..1e21).contains(&float.abs()) {
        fixed(sign, &digits, exponent)
    } else {
        exponential(sign, &digits, exponent, 1)
    }
}

/// The sign, the shortest digits that read back as `float`, the nearest
/// of them and a tie to the even, as Go rounds them, and the exponent of
/// the first: Rust's `{:e}` gives as many digits but rounds a tie up, and
/// its `{:.*e}` rounds the exact value, a tie to the even.
fn shortest(float: f64) -> (&'static str, String, i32) {
    let (_, digits, _) = scientific(&format!("{float:e}"));
    scientific(&format!("{float:.*e}", digits.len() - 1))
}

/// `digits` with the point where `exponent` puts it, padded with zeros.
fn fixed(sign: &str, digits: &str, exponent: i32) -> String {
    if exponent < 0 {
        let zeros = "0".repeat(usize::try_from(-exponent - 1).unwrap_or(0));
        return format!("{sign}0.{zeros}{digits}");
    }
    let point = usize::try_from(exponent + 1).unwrap_or(0);
    if point >= digits.len() {
        format!("{sign}{digits}{}", "0".repeat(point - digits.len()))
    } else {
        format!("{sign}{}.{}", &digits[..point], &digits[point..])
    }
}

/// `digits` as `d.ddde+XX`, its exponent of at least `width` digits.
fn exponential(sign: &str, digits: &str, exponent: i32, width: usize) -> String {
    let (first, rest) = digits.split_at(1);
    let point = if rest.is_empty() { "" } else { "." };
    let at = if exponent < 0 { '-' } else { '+' };
    format!(
        "{sign}{first}{point}{rest}e{at}{:0width$}",
        exponent.unsigned_abs()
    )
}

/// Rust's `{:e}` of a float: its sign, its digits and its exponent.
fn scientific(written: &str) -> (&'static str, String, i32) {
    let (mantissa, exponent) = written.split_once('e').expect("Rust writes an exponent");
    let (sign, mantissa) = mantissa
        .strip_prefix('-')
        .map_or(("", mantissa), |mantissa| ("-", mantissa));
    let exponent = exponent.parse().expect("Rust writes a whole exponent");
    (sign, mantissa.replace('.', ""), exponent)
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
        let secrets = secret_values(&[&json!({
            "kind": "Secret",
            "stringData": { "token": "typed-value" },
        })]);
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
        assert!(
            secret_values(&[&json!({ "kind": "ConfigMap", "data": { "k": "v1" } })]).is_empty(),
            "only a Secret's values"
        );
    }

    #[test]
    fn a_number_is_spelled_as_go_prints_it() {
        let printed = [
            (0.0, "0"),
            (1.5, "1.5"),
            (0.1, "0.1"),
            (123_456.0, "123456"),
            (999_999.0, "999999"),
            (1_000_000.0, "1e+06"),
            (1_234_567.0, "1.234567e+06"),
            (-1_234_567.0, "-1.234567e+06"),
            (1_234_567.8, "1.2345678e+06"),
            (4_294_967_296.0, "4.294967296e+09"),
            (1e21, "1e+21"),
            (1e100, "1e+100"),
            (0.0001, "0.0001"),
            (0.000_123, "0.000123"),
            (1e-5, "1e-05"),
            (5e-324, "5e-324"),
            (1.797_693_134_862_315_7e308, "1.7976931348623157e+308"),
            (25_864_340_602_886.812, "2.5864340602886812e+13"),
            (830_985_716_167_268.25, "8.309857161672682e+14"),
        ];
        for (value, go) in printed {
            assert_eq!(go_float(value), go, "{value:e}");
        }
        let written = [
            (0.0, "0"),
            (0.1, "0.1"),
            (1_234_567.0, "1234567"),
            (1e20, "100000000000000000000"),
            (1_152_921_504_606_846_976.0, "1152921504606847000"),
            (1e21, "1e+21"),
            (1.5e300, "1.5e+300"),
            (0.000_001, "0.000001"),
            (-0.000_001_234, "-0.000001234"),
            (1e-7, "1e-7"),
            (1.5e-10, "1.5e-10"),
            (830_985_716_167_268.25, "830985716167268.2"),
        ];
        for (value, go) in written {
            assert_eq!(go_json(value), go, "{value:e}");
        }
    }

    #[test]
    fn a_number_is_scrubbed_in_each_spelling_it_is_printed_in() {
        let secrets = secret_values(&[&json!({
            "kind": "Secret",
            "stringData": { "pin": 1_234_567.0, "port": 5432, "n": 1_152_921_504_606_846_976.0 },
        })]);
        assert_eq!(
            scrub(
                "PIN 1.234567e+06, got &value.valueUnstructured{Value:1234567}, port 5432, n {Value:1152921504606847000}.",
                &secrets
            ),
            format!(
                "PIN {HIDDEN}, got &value.valueUnstructured{{Value:{HIDDEN}}}, port {HIDDEN}, n {{Value:{HIDDEN}}}."
            )
        );
    }

    #[test]
    fn a_number_a_secret_holds_as_text_is_scrubbed_in_each_spelling_of_it() {
        for (secret, notes) in [
            (
                json!({ "stringData": { "pin": "1234567" } }),
                "Your PIN is 1.234567e+06.",
            ),
            (
                json!({ "data": { "pin": "MTIzNDU2Nw==" } }),
                "Your PIN is 1.234567e+06.",
            ),
            (
                json!({ "stringData": { "pin": "1.234567e+06" } }),
                "Your PIN is 1234567.",
            ),
        ] {
            let mut secret = secret;
            secret["kind"] = json!("Secret");
            let secrets = secret_values(&[&secret]);
            assert_eq!(
                scrub(notes, &secrets),
                format!("Your PIN is {HIDDEN}."),
                "{secret}"
            );
        }
    }

    #[test]
    fn each_quoted_object_of_refusals_joined_goes() {
        let quoted = |name: &str, value: &str| {
            format!(
                r#"cannot patch "{name}" with kind Secret:  "" is invalid: patch: Invalid value: "{{\"data\":{{\"k\":\"{value}\"}},\"kind\":\"Secret\"}}": illegal base64 data at input byte 3"#
            )
        };
        let message = format!(
            "Upgrade \"app\" failed: {} && {}",
            quoted("one", "not base64!"),
            quoted("two", "bGl2ZS1vbmx5")
        );
        let scrubbed = scrub(&message, &["unrelated".to_owned()]);
        assert_eq!(
            scrubbed,
            format!(
                r#"Upgrade "app" failed: cannot patch "one" with kind Secret:  "" is invalid: patch: Invalid value: {HIDDEN}: illegal base64 data at input byte 3 && cannot patch "two" with kind Secret:  "" is invalid: patch: Invalid value: {HIDDEN}: illegal base64 data at input byte 3"#
            )
        );
    }

    #[test]
    fn a_value_with_no_letter_or_digit_is_no_token() {
        let secrets = vec!["hunter2".to_owned(), "/".to_owned(), " ".to_owned()];
        assert_eq!(
            scrub(
                "Open http://example.com/login/ and log in with hunter2.",
                &secrets
            ),
            format!("Open http://example.com/login/ and log in with {HIDDEN}.")
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
