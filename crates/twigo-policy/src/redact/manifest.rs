//! A Helm release's manifest, or a hook's, with its Secrets masked: split
//! as Helm splits it, each document read alone, as Helm's own reader takes
//! the last of a repeated key, every `kind: Secret` at the root of a
//! document or inside `items` at any depth masked as an open Secret is, and
//! only those documents written again, with their `# Source:` line; every
//! other document goes byte for byte. A document Twigo cannot read gives
//! only its `# Source:` line, a line that says so and where its reader
//! stopped, since the reader's own words quote the document.

use std::collections::BTreeMap;

use serde_json::Value;
use twigo_ipc::{DataEntry, ErrorCode, IpcError, ManifestSecret, ReleaseManifest, UnreadDocument};

use super::{Entry, Field, Held, decoded, entries, mask_secret_with, secret_values, value_of};

/// What [`masked`] gives.
pub struct Masked {
    pub manifest: ReleaseManifest,
    /// What its documents make, in their order: each document Twigo read
    /// that names a kind, and in place of one that holds `items`, its items,
    /// as Helm's builder creates them.
    pub objects: Vec<Head>,
    /// The values of its Secrets, for the scrubbing of texts.
    pub values: Held<Vec<String>>,
}

/// An object of a manifest, as its document names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
}

/// The manifest with its Secrets masked; its text ends in a line feed, as
/// `helm get manifest` prints it.
pub fn masked(manifest: &Held<String>) -> Masked {
    let read = read_all(&manifest.0);
    let values = Held::new(secret_values(
        &read
            .iter()
            .flat_map(|(_, read)| read.secrets())
            .collect::<Vec<_>>(),
    ));
    let mut objects = Vec::new();
    for (_, read) in &read {
        if let Read::Parsed { value, .. } = read {
            heads(value, &mut objects);
        }
    }
    Masked {
        manifest: written(&manifest.0, read, None),
        objects,
        values,
    }
}

/// Two revisions' manifests masked so that a value of a Secret that differs
/// from the same key of its counterpart, the Secret of the same namespace
/// and name on the other side, reads `<N bytes, changed>` on both.
pub fn compared(from: &Held<String>, to: &Held<String>) -> (String, String) {
    let (from_read, to_read) = (read_all(&from.0), read_all(&to.0));
    let (from_values, to_values) = (stored(&from_read), stored(&to_read));
    let before = written(&from.0, from_read, Some(&to_values)).text;
    let after = written(&to.0, to_read, Some(&from_values)).text;
    (before, after)
}

/// One key of a Secret of the manifest, as [`ManifestSecret`] places it:
/// its text, or its base64 when it is not UTF-8, and whether it is;
/// `helm.no-value` for a place that holds no such key.
pub fn secret(
    manifest: &Held<String>,
    document: u32,
    items: &[u32],
    key: &str,
) -> Result<(String, bool), IpcError> {
    let no_value = || {
        IpcError::new(
            ErrorCode::HelmNoValue,
            format!("the manifest holds no Secret with the key {key} there"),
        )
    };
    let value = split(&manifest.0)
        .into_iter()
        .nth(document as usize)
        .and_then(|document| parse(document.text).ok())
        .ok_or_else(no_value)?;
    let secret = within(&value, items)
        .filter(|secret| secret["kind"] == "Secret")
        .ok_or_else(no_value)?;
    value_of(secret, key).map_err(|_| no_value())
}

/// A document of the manifest that Twigo could not read, whole;
/// `helm.no-value` for any other.
pub fn document(manifest: &Held<String>, document: u32) -> Result<String, IpcError> {
    split(&manifest.0)
        .into_iter()
        .nth(document as usize)
        .filter(|document| parse(document.text).is_err())
        .map(|document| document.text.to_owned())
        .ok_or_else(|| {
            IpcError::new(
                ErrorCode::HelmNoValue,
                format!("document {document} of the manifest is not one Twigo could not read"),
            )
        })
}

/// A document as Helm's `SplitManifests` gives it, by its place in the
/// manifest: from its first character after the white space that leads it
/// to its last before the white space that ends it.
struct Document<'a> {
    start: usize,
    end: usize,
    text: &'a str,
}

/// The documents Helm's `SplitManifests` gives
/// ([v4.3.2](https://github.com/helm/helm/blob/v4.3.2/pkg/release/v1/util/manifest.go#L37-L70)):
/// the text after its leading white space is cut at each line that starts
/// with `---` and the spaces and tabs after it, `(?m)^---[ \t]*`, and the
/// pieces that are only white space are dropped.
fn split(manifest: &str) -> Vec<Document<'_>> {
    let bytes = manifest.as_bytes();
    let first = manifest.len() - manifest.trim_start().len();
    let lines = std::iter::once(first).chain(
        (first..bytes.len())
            .filter(|&at| bytes[at] == b'\n')
            .map(|at| at + 1),
    );
    let mut pieces = Vec::new();
    let mut piece = first;
    for start in lines.filter(|&at| manifest[at..].starts_with("---")) {
        let mut end = start + 3;
        while bytes
            .get(end)
            .is_some_and(|&byte| byte == b' ' || byte == b'\t')
        {
            end += 1;
        }
        pieces.push(piece..start);
        piece = end;
    }
    pieces.push(piece..manifest.len());
    pieces
        .into_iter()
        .filter_map(|piece| {
            let text = &manifest[piece.clone()];
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            let start = piece.start + (text.len() - text.trim_start().len());
            let end = start + trimmed.len();
            Some(Document {
                start,
                end,
                text: &manifest[start..end],
            })
        })
        .collect()
}

/// Reads a document alone, as Helm's reader does: sigs.k8s.io/yaml over
/// go-yaml v2, which keeps the last of a repeated key
/// ([decode.go](https://github.com/yaml/go-yaml/blob/v2.4.4/decode.go#L685-L691)).
/// A failure gives where the reader stopped, the line and column in the
/// document, when it says.
fn parse(text: &str) -> Result<Value, Option<(u64, u64)>> {
    let options = serde_saphyr::options! {
        duplicate_keys: serde_saphyr::DuplicateKeyPolicy::LastWins,
    };
    serde_saphyr::from_str_with_options(text, options).map_err(|error| {
        error
            .location()
            .map(|location| (location.line(), location.column()))
    })
}

enum Read {
    Parsed {
        value: Value,
        /// The places of its Secrets, by their indexes through `items`.
        secrets: Vec<Vec<u32>>,
    },
    Unread(Option<(u64, u64)>),
}

impl Read {
    fn secrets(&self) -> impl Iterator<Item = &Value> {
        let (value, places) = match self {
            Read::Parsed { value, secrets } => (Some(value), secrets.as_slice()),
            Read::Unread(_) => (None, &[][..]),
        };
        places.iter().filter_map(move |place| within(value?, place))
    }
}

fn read_all(manifest: &str) -> Vec<(Document<'_>, Read)> {
    split(manifest)
        .into_iter()
        .map(|document| {
            let read = match parse(document.text) {
                Ok(value) => {
                    let mut secrets = Vec::new();
                    places(&value, &mut Vec::new(), &mut secrets);
                    Read::Parsed { value, secrets }
                }
                Err(at) => Read::Unread(at),
            };
            (document, read)
        })
        .collect()
}

/// Where the Secrets of a document stand: the document itself, and any
/// element of `items` at any depth.
fn places(value: &Value, path: &mut Vec<u32>, found: &mut Vec<Vec<u32>>) {
    if value["kind"] == "Secret" {
        found.push(path.clone());
    }
    for (index, item) in value["items"].as_array().into_iter().flatten().enumerate() {
        path.push(index as u32);
        places(item, path, found);
        path.pop();
    }
}

/// The objects a document makes: the items of one that holds `items`,
/// Helm's builder flattening any such document whatever its kind
/// ([client.go](https://github.com/helm/helm/blob/v4.3.2/pkg/kube/client.go#L539-L546)),
/// else the document itself where it names a kind.
fn heads(value: &Value, objects: &mut Vec<Head>) {
    if let Some(items) = value["items"].as_array() {
        for item in items {
            heads(item, objects);
        }
        return;
    }
    let text = |value: &Value| value.as_str().map(str::to_owned);
    if let Some(kind) = text(&value["kind"]) {
        objects.push(Head {
            api_version: text(&value["apiVersion"]).unwrap_or_default(),
            kind,
            name: text(&value["metadata"]["name"]).unwrap_or_default(),
            namespace: text(&value["metadata"]["namespace"]),
        });
    }
}

fn within<'v>(value: &'v Value, path: &[u32]) -> Option<&'v Value> {
    path.iter()
        .try_fold(value, |value, &index| value["items"].get(index as usize))
}

fn within_mut<'v>(value: &'v mut Value, path: &[u32]) -> Option<&'v mut Value> {
    path.iter().try_fold(value, |value, &index| {
        value.get_mut("items")?.get_mut(index as usize)
    })
}

/// A Secret by the namespace and name its document gives it.
type Name = (Option<String>, String);

/// The bytes each key of each Secret holds as the server would store them,
/// `stringData` over `data`, for a comparison.
type Stored = BTreeMap<Name, BTreeMap<String, Vec<u8>>>;

fn name(secret: &Value) -> Name {
    let metadata = &secret["metadata"];
    (
        metadata["namespace"].as_str().map(str::to_owned),
        metadata["name"].as_str().unwrap_or_default().to_owned(),
    )
}

fn bytes(entry: &Entry<'_>) -> Vec<u8> {
    let text = entry.text();
    match entry.field {
        Field::StringData => text.as_bytes().to_vec(),
        Field::Data => decoded(&text).unwrap_or_else(|| text.as_bytes().to_vec()),
    }
}

fn stored(read: &[(Document<'_>, Read)]) -> Stored {
    let mut stored = Stored::new();
    for secret in read.iter().flat_map(|(_, read)| read.secrets()) {
        let keys = stored.entry(name(secret)).or_default();
        for entry in entries(secret) {
            keys.insert(entry.key.to_owned(), bytes(&entry));
        }
    }
    stored
}

/// The manifest written again: each document that holds a Secret from its
/// value masked, and in a comparison marked where `counterparts` differ;
/// each document Twigo could not read as its `# Source:` line and a line
/// that says so; every other one as it stands.
fn written(
    manifest: &str,
    read: Vec<(Document<'_>, Read)>,
    counterparts: Option<&Stored>,
) -> ReleaseManifest {
    let mut text = String::with_capacity(manifest.len() + 1);
    let mut lines = 1;
    let mut from = 0;
    let (mut secrets, mut unread) = (Vec::new(), Vec::new());
    for (index, (document, read)) in read.into_iter().enumerate() {
        let between = &manifest[from..document.start];
        lines += between.matches('\n').count();
        text.push_str(between);
        let line = lines as u32;
        let source = document
            .text
            .lines()
            .next()
            .and_then(|first| first.strip_prefix("# Source: "));
        let shown = match read {
            Read::Parsed {
                value,
                secrets: places,
            } if !places.is_empty() => {
                let rewritten = rewritten(value, &places, counterparts, |place, secret| {
                    secrets.push(ManifestSecret {
                        document: index as u32,
                        items: place.to_vec(),
                        name: name(secret).1,
                        namespace: name(secret).0,
                        line,
                        entries: data_entries(secret),
                    });
                });
                match rewritten {
                    Some(yaml) => Some(match source {
                        Some(source) => format!("# Source: {source}\n{yaml}"),
                        None => yaml,
                    }),
                    None => Some(unreadable(source, None)),
                }
            }
            Read::Parsed { .. } => None,
            Read::Unread(at) => {
                unread.push(UnreadDocument {
                    document: index as u32,
                    line,
                    source: source.map(str::to_owned),
                });
                Some(unreadable(source, at))
            }
        };
        let shown = shown.as_deref().unwrap_or(document.text);
        lines += shown.matches('\n').count();
        text.push_str(shown);
        from = document.end;
    }
    text.push_str(&manifest[from..]);
    text.push('\n');
    ReleaseManifest {
        text,
        secrets,
        unread,
    }
}

/// A document's value with each Secret at `places` masked, as YAML without
/// its last line feed; `each` sees every Secret before it is masked. None
/// when the YAML cannot be written, which only a value the reader could not
/// have given would cause.
fn rewritten(
    mut value: Value,
    places: &[Vec<u32>],
    counterparts: Option<&Stored>,
    mut each: impl FnMut(&[u32], &Value),
) -> Option<String> {
    for place in places {
        let Some(secret) = within_mut(&mut value, place) else {
            continue;
        };
        each(place, secret);
        let theirs = counterparts.and_then(|stored| stored.get(&name(secret)));
        mask_secret_with(secret, |entry| {
            theirs
                .and_then(|keys| keys.get(entry.key))
                .is_some_and(|other| *other != bytes(entry))
        });
    }
    let yaml = serde_saphyr::to_string(&value).ok()?;
    Some(yaml.trim_end().to_owned())
}

fn unreadable(source: Option<&str>, at: Option<(u64, u64)>) -> String {
    let said = match at {
        Some((line, column)) => {
            format!("# Twigo could not read this document (line {line}, column {column}).")
        }
        None => "# Twigo could not read this document.".to_owned(),
    };
    match source {
        Some(source) => format!("# Source: {source}\n{said}"),
        None => said,
    }
}

/// A Secret's keys with their sizes, a key in both `data` and `stringData`
/// once, as `stringData`'s.
fn data_entries(secret: &Value) -> Vec<DataEntry> {
    let mut keyed = BTreeMap::new();
    for entry in entries(secret) {
        let binary = entry.field == Field::Data
            && decoded(&entry.text()).is_some_and(|bytes| std::str::from_utf8(&bytes).is_err());
        keyed.insert(
            entry.key,
            DataEntry {
                key: entry.key.to_owned(),
                bytes: entry.bytes(),
                binary,
            },
        );
    }
    keyed.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"---
# Source: demo/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: db
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"stringData":{"password":"pw-in-annotation"}}'
# a comment that names pw-in-comment
stringData:
  password: "pw-string-data"
  port: 5432
data:
  token: "dG9rZW4tZmlyc3Q="
  token: "dG9rZW4tbGFzdA=="
  key.der: "MIIBCgKCAQEA/w=="

---
# Source: demo/templates/config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name:   spaced   # kept as written
data:
  greeting: "hello"
---   
# Source: demo/templates/list.yaml
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Secret
    metadata: {name: listed, namespace: other}
    stringData: {listed: pw-in-a-list}
  - apiVersion: v1
    kind: List
    items:
      - kind: "\x53ecret"
        metadata: {name: deeper}
        data: {deep: cHctaW4tYS1saXN0LW9mLWxpc3Rz}
      - apiVersion: v1
        kind: Service
        metadata: {name: svc}
---
# Source: demo/templates/broken.yaml
kind: Secret
stringData: {broken: pw-unread
"#;

    fn held(text: &str) -> Held<String> {
        Held::new(text.to_owned())
    }

    fn line(text: &str, number: u32) -> &str {
        text.lines().nth(number as usize - 1).unwrap()
    }

    #[test]
    fn every_secret_is_masked_and_every_other_document_kept_byte_for_byte() {
        let Masked {
            manifest,
            objects,
            values,
        } = masked(&held(MANIFEST));
        let text = &manifest.text;
        for value in [
            "pw-in-annotation",
            "pw-in-comment",
            "pw-string-data",
            "5432",
            "dG9rZW4t",
            "token-first",
            "token-last",
            "MIIBCgKCAQEA",
            "pw-in-a-list",
            "cHctaW4tYS1saXN0LW9mLWxpc3Rz",
            "pw-in-a-list-of-lists",
            "pw-unread",
        ] {
            assert!(!text.contains(value), "{value} in {text}");
        }
        assert!(
            text.contains(
                "\n\n---\n# Source: demo/templates/config.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name:   spaced   # kept as written\ndata:\n  greeting: \"hello\"\n---   \n# Source: demo/templates/list.yaml\n"
            ),
            "{text}"
        );
        assert!(
            text.ends_with(
                "\n---\n# Source: demo/templates/broken.yaml\n# Twigo could not read this document (line 3, column 13).\n\n"
            ),
            "{text}"
        );

        let places: Vec<(u32, &[u32], &str, Option<&str>)> = manifest
            .secrets
            .iter()
            .map(|secret| {
                (
                    secret.document,
                    secret.items.as_slice(),
                    secret.name.as_str(),
                    secret.namespace.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            places,
            [
                (0, &[][..], "db", None),
                (2, &[0][..], "listed", Some("other")),
                (2, &[1, 0][..], "deeper", None),
            ]
        );
        for secret in &manifest.secrets {
            assert!(
                line(text, secret.line).starts_with("# Source: "),
                "{secret:?}"
            );
        }
        assert_eq!(
            manifest.secrets[0].entries,
            [
                DataEntry {
                    key: "key.der".to_owned(),
                    bytes: 10,
                    binary: true
                },
                DataEntry {
                    key: "password".to_owned(),
                    bytes: 14,
                    binary: false
                },
                DataEntry {
                    key: "port".to_owned(),
                    bytes: 4,
                    binary: false
                },
                DataEntry {
                    key: "token".to_owned(),
                    bytes: 10,
                    binary: false
                },
            ]
        );
        assert_eq!(
            manifest.unread,
            [UnreadDocument {
                document: 3,
                line: manifest.unread[0].line,
                source: Some("demo/templates/broken.yaml".to_owned())
            }]
        );
        assert_eq!(
            line(text, manifest.unread[0].line),
            "# Source: demo/templates/broken.yaml"
        );
        let kinds: Vec<(&str, &str)> = objects
            .iter()
            .map(|head| (head.kind.as_str(), head.name.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                ("Secret", "db"),
                ("ConfigMap", "spaced"),
                ("Secret", "listed"),
                ("Secret", "deeper"),
                ("Service", "svc")
            ]
        );
        assert!(
            values.0.contains(&"token-last".to_owned())
                && values.0.contains(&"pw-in-a-list-of-lists".to_owned())
        );
    }

    #[test]
    fn a_secret_s_value_that_changed_is_marked_on_both_sides() {
        let from = held(
            "---\n# Source: a.yaml\nkind: Secret\nmetadata: {name: db}\nstringData: {same: one, changed: old, gone: x, moved: m}\n---\n# Source: b.yaml\nkind: Secret\nmetadata: {name: db, namespace: other}\nstringData: {changed: old}\n",
        );
        let to = held(
            "---\n# Source: c.yaml\nkind: List\nitems:\n- kind: Secret\n  metadata: {name: db}\n  data: {same: b25l, changed: bmV3, added: eQ==}\n  stringData: {moved: m}\n---\n# Source: b.yaml\nkind: Secret\nmetadata: {name: db, namespace: other}\nstringData: {changed: old}\n",
        );
        let (before, after) = compared(&from, &to);
        assert!(before.contains("changed: <3 bytes, changed>\n  gone: <1 bytes>\n  moved: <1 bytes>\n  same: <3 bytes>\n"), "{before}");
        assert!(
            after.contains(
                "added: <1 bytes>\n    changed: <3 bytes, changed>\n    same: <3 bytes>\n"
            ),
            "{after}"
        );
        assert!(
            after.contains("stringData:\n    moved: <1 bytes>\n"),
            "{after}"
        );
        assert_eq!(
            before.matches("changed: <3 bytes>").count(),
            1,
            "the Secret of another namespace is its own: {before}"
        );
        for text in [&before, &after] {
            for value in ["old", "new", "bmV3", "b25l"] {
                assert!(!text.contains(&format!(": {value}")), "{value} in {text}");
            }
        }
    }

    #[test]
    fn a_data_or_string_data_that_is_no_map_is_masked_whole() {
        let Masked {
            manifest, values, ..
        } = masked(&held(
            "---\n# Source: a.yaml\nkind: Secret\nmetadata: {name: a}\ndata: aHVudGVyMg==\nstringData:\n- s3cret\n",
        ));
        assert_eq!(
            manifest.text,
            "---\n# Source: a.yaml\ndata: <12 bytes>\nkind: Secret\nmetadata:\n  name: a\nstringData: <10 bytes>\n\n"
        );
        assert!(
            values.0.contains(&"hunter2".to_owned()) && values.0.contains(&"s3cret".to_owned())
        );
    }

    #[test]
    fn a_value_written_over_several_lines_is_the_value_it_decodes_to() {
        let from = held(
            "---\n# Source: a.yaml\nkind: Secret\nmetadata: {name: db}\ndata:\n  password: |\n    aHVu\n    dGVyMg==\n  key.der: |\n    MIIBCgKC\n    AQEA/w==\n",
        );
        let to = held(
            "---\n# Source: a.yaml\nkind: Secret\nmetadata: {name: db}\ndata: {password: aHVudGVyMg==, key.der: MIIBCgKCAQEA/w==}\n",
        );
        let (before, after) = compared(&from, &to);
        assert!(
            !before.contains("changed") && !after.contains("changed"),
            "{before}"
        );
        assert_eq!(
            masked(&from).manifest.secrets[0].entries,
            [
                DataEntry {
                    key: "key.der".to_owned(),
                    bytes: 10,
                    binary: true
                },
                DataEntry {
                    key: "password".to_owned(),
                    bytes: 7,
                    binary: false
                },
            ]
        );
        assert_eq!(
            secret(&from, 0, &[], "password").unwrap(),
            ("hunter2".to_owned(), false)
        );
    }

    #[test]
    fn a_reveal_answers_the_key_its_address_names_and_nothing_else() {
        let manifest = held(MANIFEST);
        let shown = |document, items: &[u32], key| secret(&manifest, document, items, key);
        assert_eq!(
            shown(0, &[], "password").unwrap(),
            ("pw-string-data".to_owned(), false)
        );
        assert_eq!(shown(0, &[], "port").unwrap(), ("5432".to_owned(), false));
        assert_eq!(
            shown(0, &[], "token").unwrap(),
            ("token-last".to_owned(), false)
        );
        assert_eq!(
            shown(0, &[], "key.der").unwrap(),
            ("MIIBCgKCAQEA/w==".to_owned(), true)
        );
        assert_eq!(
            shown(2, &[0], "listed").unwrap(),
            ("pw-in-a-list".to_owned(), false)
        );
        assert_eq!(
            shown(2, &[1, 0], "deep").unwrap(),
            ("pw-in-a-list-of-lists".to_owned(), false)
        );
        for (document, items, key) in [
            (0, &[][..], "user"),
            (1, &[][..], "greeting"),
            (2, &[][..], "listed"),
            (2, &[1][..], "deep"),
            (2, &[1, 1][..], "deep"),
            (3, &[][..], "broken"),
            (4, &[][..], "password"),
        ] {
            let refused = shown(document, items, key).unwrap_err();
            assert_eq!(
                refused.code,
                ErrorCode::HelmNoValue,
                "{document} {items:?} {key}"
            );
        }
        assert_eq!(
            super::document(&manifest, 3).unwrap(),
            "# Source: demo/templates/broken.yaml\nkind: Secret\nstringData: {broken: pw-unread"
        );
        for read in [0, 1, 4] {
            let refused = super::document(&manifest, read).unwrap_err();
            assert_eq!(refused.code, ErrorCode::HelmNoValue, "{read}");
        }
    }
}
