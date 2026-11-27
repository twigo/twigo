//! Shows a value of an open Secret, or a part of the revision an open Helm
//! release shows (ARCHITECTURE 3.6, 6.4): it leaves Rust only as the Reveal
//! runs, read then from the Secret as last listed or from the revision's
//! page the editor holds, and nothing is sent to the cluster.

use twigo_helm::Page;
use twigo_ipc::{ErrorCode, HelmPart, IpcError, SubscriptionId, ValueStep};
use twigo_policy::friction::Risk;
use twigo_policy::redact::{secret_value, values};

use super::shell_line;
use crate::Core;
use crate::bus::{self, Finished, Planned};
use crate::helm::ShownPage;

pub(crate) fn reveal(
    core: &Core,
    window: &str,
    object: SubscriptionId,
    key: String,
) -> Result<Planned, IpcError> {
    let (context, reading) = core.objects.with(window, object, |opened| {
        (opened.context().to_owned(), opened.reading())
    })?;
    let connection = core.policy.connection(&context);
    let secret = reading.json()?;
    let (this, window) = (core.this.clone(), window.to_owned());
    let (_, binary) = secret_value(&secret, &key)?;
    let name = secret["metadata"]["name"].as_str().unwrap_or_default();
    let namespace = secret["metadata"]["namespace"].as_str().unwrap_or_default();
    // A key holds only `-`, `.`, `_` and alphanumerics (IsConfigMapKey), so
    // it needs no escape in a Go string.
    let template = if binary {
        format!(r#"go-template={{{{index .data "{key}"}}}}"#)
    } else {
        format!(r#"go-template={{{{index .data "{key}" | base64decode}}}}"#)
    };
    let line = shell_line(&[
        "kubectl",
        "--context",
        &context,
        "get",
        "secrets",
        name,
        "-n",
        namespace,
        "-o",
        &template,
    ])?;
    Ok(Planned {
        question: format!("Reveal {key} of secret {name} in {namespace} from {context}?"),
        confirm: "Reveal value".to_owned(),
        destructive: false,
        consequences: vec![format!(
            "It shows until you hide it or close the secret{}.",
            if binary { ", as base64" } else { "" }
        )],
        affected: Vec::new(),
        command_line: Some(line),
        doing: format!("Revealing {key}"),
        command: "reveal",
        target: format!("secrets/{name} in {namespace}, key {key}"),
        writes: Vec::new(),
        context: Some(context),
        connection,
        space: None,
        risk: Risk::Reveal,
        previewed: None,
        run: bus::Run::Sends(Box::new(move |_| {
            Box::pin(async move {
                // Read as it runs, and only while the view it is for is open.
                let core = this
                    .upgrade()
                    .ok_or_else(|| IpcError::new(ErrorCode::AppQuitting, "Twigo is quitting"))?;
                let reading = core
                    .objects
                    .with(&window, object, |opened| opened.reading())?;
                let (value, binary) = secret_value(&reading.json()?, &key)?;
                Ok(Finished::Revealed { value, binary })
            })
        })),
    })
}

/// Plans with the revision the release shows, and refuses at the plan and
/// at the run once it shows another, or another Secret holds it.
pub(crate) fn reveal_helm(
    core: &Core,
    window: &str,
    release: SubscriptionId,
    revision: u32,
    part: HelmPart,
) -> Result<Planned, IpcError> {
    let (context, namespace, name, shown_page) = core.releases.with(window, release, |opened| {
        (
            opened.context().to_owned(),
            opened.namespace().to_owned(),
            opened.name().to_owned(),
            opened.shown(),
        )
    })?;
    let connection = core.policy.connection(&context);
    let ShownPage { page, secret, .. } = shown(shown_page, revision)?;
    let (value, binary) = page.revealed(&part)?;
    let words = Words::of(&part, &page);
    let release_words = format!("release {name} (revision {revision}) in {namespace}");
    let shown_revision = revision.to_string();
    let get = |verb: &str, rest: &[&str]| {
        let mut line = vec![
            "helm",
            "get",
            verb,
            &name,
            "-n",
            &namespace,
            "--kube-context",
            &context,
            "--revision",
            &shown_revision,
        ];
        line.extend(rest);
        shell_line(&line)
    };
    let command_line = match &part {
        HelmPart::Values {
            defaults: false,
            path,
        } if path.is_empty() => Some(get("values", &["-o", "json"])?),
        HelmPart::Values {
            defaults: false,
            path,
        } if prints_as_go_does(&value) => {
            let template = format!("{{{{index .Release.Config {}}}}}", index_of(path));
            Some(get("all", &["--template", &template])?)
        }
        HelmPart::Manifest => Some(get("manifest", &[])?),
        _ => None,
    };
    let (this, window) = (core.this.clone(), window.to_owned());
    Ok(Planned {
        question: format!("Reveal {} of {release_words} from {context}?", words.what),
        confirm: "Reveal".to_owned(),
        destructive: false,
        consequences: vec![format!(
            "It shows until you hide it, close the release or show another revision{}.",
            if binary { ", as base64" } else { "" }
        )],
        affected: Vec::new(),
        command_line,
        doing: format!("Revealing {}", words.what),
        command: "reveal",
        target: format!(
            "release {name} in {namespace}, revision {revision}, {}",
            words.place
        ),
        writes: Vec::new(),
        context: Some(context),
        connection,
        space: None,
        risk: Risk::Reveal,
        previewed: None,
        run: bus::Run::Sends(Box::new(move |_| {
            Box::pin(async move {
                // Read as it runs, from the revision the editor shows then.
                let core = this
                    .upgrade()
                    .ok_or_else(|| IpcError::new(ErrorCode::AppQuitting, "Twigo is quitting"))?;
                let now = shown(
                    core.releases
                        .with(&window, release, |opened| opened.shown())?,
                    revision,
                )?;
                if now.secret != secret {
                    return Err(changed(revision));
                }
                let (value, binary) = now.page.revealed(&part)?;
                Ok(Finished::Revealed { value, binary })
            })
        })),
    })
}

/// The page of `revision`, refused unless the release shows it.
fn shown(shown: Option<ShownPage>, revision: u32) -> Result<ShownPage, IpcError> {
    shown
        .filter(|shown| shown.revision == revision)
        .ok_or_else(|| changed(revision))
}

fn changed(revision: u32) -> IpcError {
    IpcError::new(
        ErrorCode::ActionObjectChanged,
        format!(
            "the release no longer shows the revision {revision} Twigo read, so it revealed nothing"
        ),
    )
}

/// How a plan names a part: in its question, and in the audit log's
/// target, which name the place and never the value.
struct Words {
    what: String,
    place: String,
}

impl Words {
    fn of(part: &HelmPart, page: &Page) -> Self {
        let (what, place) = match part {
            HelmPart::Values { defaults, path } if path.is_empty() => {
                if *defaults {
                    ("the chart's defaults".to_owned(), "defaults".to_owned())
                } else {
                    ("the values".to_owned(), "values".to_owned())
                }
            }
            HelmPart::Values { defaults, path } => {
                let path = values::shown(path);
                if *defaults {
                    (format!("the default {path}"), format!("defaults {path}"))
                } else {
                    (path.clone(), format!("values {path}"))
                }
            }
            HelmPart::Secret {
                document,
                items,
                key,
            } => {
                let secret = page
                    .manifest()
                    .secrets
                    .iter()
                    .find(|secret| secret.document == *document && secret.items == *items)
                    .map_or("", |secret| secret.name.as_str());
                (
                    format!("{key} of secret {secret} in the manifest"),
                    format!("manifest secrets/{secret} key {key}"),
                )
            }
            HelmPart::Document { document } => {
                let source = page
                    .manifest()
                    .unread
                    .iter()
                    .find(|unread| unread.document == *document)
                    .and_then(|unread| unread.source.as_deref());
                let what = match source {
                    Some(source) => format!("the document {source} in the manifest"),
                    None => format!("document {} in the manifest", u64::from(*document) + 1),
                };
                (what, format!("manifest document {document}"))
            }
            HelmPart::Manifest => (
                "all of the manifest's Secrets".to_owned(),
                "manifest".to_owned(),
            ),
            HelmPart::Notes => ("the notes".to_owned(), "notes".to_owned()),
            HelmPart::Description => ("the description".to_owned(), "description".to_owned()),
        };
        Self { what, place }
    }
}

/// Whether Go's template prints a leaf of the values as Twigo reveals it: a
/// string or a boolean, since Helm reads every number as a float, which Go
/// prints in exponent form from a million on, and prints null as
/// `<no value>`.
fn prints_as_go_does(value: &str) -> bool {
    value.starts_with('"') || value == "true" || value == "false"
}

/// The arguments of `index` that reach a path's leaf from
/// `.Release.Config`: keys as Go strings, list indexes as numbers.
fn index_of(path: &[ValueStep]) -> String {
    path.iter()
        .map(|step| match step {
            ValueStep::Key(key) => go_string(key),
            ValueStep::Index(index) => index.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `text` as a Go string literal.
fn go_string(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for c in text.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            c if c.is_control() => quoted.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests;
