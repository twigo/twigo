//! "Report a Problem" (ARCHITECTURE 4.10): the facts of this run and the last
//! lines of its log, with the names, paths, tokens and addresses in them
//! hidden here, in Rust, so that the webview never holds the log as written.
//! Nothing here sends anything: the link it builds is opened by the app, and
//! the text is the person's to copy or save.

mod issue;
mod log;
mod redact;
#[cfg(test)]
mod tests;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use twigo_ipc::{ErrorCode, Fact, FactId, IpcError, OpenIssue, OpenedIssue, Report};
use twigo_kube::kubeconfig::named;
use twigo_log::Facts;

use crate::Core;
use redact::{Kind, Known, Name};

/// The file name a report is offered under: `twigo-report-<date>.txt`, with
/// the date of the person's day.
pub fn file_name() -> String {
    format!(
        "twigo-report-{}.txt",
        jiff::Zoned::now().strftime("%Y-%m-%d")
    )
}

pub async fn write(text: &str, path: &Path) -> Result<(), IpcError> {
    tokio::fs::write(path, text).await.map_err(|error| {
        IpcError::new(
            ErrorCode::FileUnwritten,
            format!("could not write {}: {error}", path.display()),
        )
    })
}

impl Core {
    /// The report of this run: its facts, and the last lines of the log files
    /// (the run's, then the previous run's) as they were written, hidden by
    /// what the catalog and the state name now. It sends no request: the
    /// Kubernetes versions are those the calls of this run already got.
    pub async fn report(&self, facts: &Facts, files: &[PathBuf]) -> Report {
        let (known, versions) = (self.known(), self.connections.versions());
        let (facts, files) = (facts.clone(), files.to_vec());
        twigo_panic::joined(
            tokio::task::spawn_blocking(move || assemble(&facts, &files, &versions, known)).await,
        )
    }

    /// The link of the new-issue form for the facts the person left ticked
    /// and what they wrote, which stays under 6,000 characters, and what it
    /// left out to.
    pub async fn report_issue(
        &self,
        facts: &Facts,
        files: &[PathBuf],
        request: OpenIssue,
    ) -> (String, OpenedIssue) {
        let (known, versions) = (self.known(), self.connections.versions());
        let (facts, files) = (facts.clone(), files.to_vec());
        twigo_panic::joined(
            tokio::task::spawn_blocking(move || {
                let mut stated = stated(&facts, &files, &versions, &known.homes);
                stated.retain(|fact| request.facts.contains(&fact.id));
                issue::link(
                    &stated,
                    request.title.as_deref(),
                    request.description.as_deref(),
                )
            })
            .await,
        )
    }

    fn known(&self) -> Known {
        let mut known = Known::default();
        let mut name = |text: &str, kind, canonical: &str| {
            known.names.push(Name {
                text: text.to_owned(),
                kind,
                canonical: canonical.to_owned(),
            });
        };
        if let Some(contexts) = self.catalog.current() {
            for context in contexts.iter() {
                name(&context.name, Kind::Context, &context.name);
                let (cluster, user) = context.entries.names();
                if let Some(cluster) = cluster {
                    name(cluster, Kind::Cluster, cluster);
                }
                if let Some(user) = user {
                    name(user, Kind::User, user);
                }
                if let Some(namespace) = &context.namespace {
                    name(namespace, Kind::Namespace, namespace);
                }
                if let Some(server) = &context.server {
                    for text in server_names(server) {
                        name(&text, Kind::Server, server);
                    }
                }
            }
        }
        for space in self.state.spaces() {
            name(&space.id, Kind::Context, &space.id);
            for context in &space.contexts {
                name(context, Kind::Context, context);
            }
        }

        let shell = self.shell_env.borrow().clone();
        let mut homes: Vec<PathBuf> = std::env::home_dir().into_iter().collect();
        homes.extend(
            shell
                .as_ref()
                .and_then(|env| env.get("HOME"))
                .map(PathBuf::from),
        );
        for home in homes {
            let text = home.to_string_lossy().trim_end_matches('/').to_owned();
            if text.is_empty() || known.homes.contains(&text) {
                continue;
            }
            known.homes.push(text);
            if let Some(account) = home.file_name() {
                known.accounts.push(account.to_string_lossy().into_owned());
            }
        }
        for variable in ["USER", "LOGNAME", "USERNAME"] {
            let from_shell = shell.as_ref().and_then(|env| env.get(variable));
            let from_process = std::env::var_os(variable);
            for account in [from_shell.map(ToOwned::to_owned), from_process]
                .into_iter()
                .flatten()
            {
                known.accounts.push(account.to_string_lossy().into_owned());
            }
        }
        known.accounts.retain(|account| !account.is_empty());
        known.accounts.sort();
        known.accounts.dedup();
        known
    }
}

/// An API server's address as a person writes it: the URL, its host with the
/// port and its host.
fn server_names(server: &str) -> Vec<String> {
    let mut names = vec![server.to_owned()];
    if let Ok(uri) = server.parse::<http::Uri>() {
        names.extend(
            uri.authority()
                .map(|authority| authority.as_str().to_owned()),
        );
        names.extend(uri.host().map(str::to_owned));
    }
    names
}

fn assemble(facts: &Facts, files: &[PathBuf], versions: &BTreeSet<String>, known: Known) -> Report {
    let facts_stated = stated(facts, files, versions, &known.homes);
    let (log, hidden) = log::render(&log::tail(files), known);
    Report {
        facts: facts_stated,
        log,
        hidden,
    }
}

fn stated(
    facts: &Facts,
    files: &[PathBuf],
    versions: &BTreeSet<String>,
    homes: &[String],
) -> Vec<Fact> {
    let mut stated = vec![
        fact(
            FactId::Twigo,
            "Twigo",
            format!("{} ({})", facts.version, short(&facts.commit)),
            false,
        ),
        fact(
            FactId::System,
            "System",
            if facts.os_version == "Unknown" {
                format!("{} ({})", facts.os, facts.arch)
            } else {
                format!("{} {} ({})", facts.os, facts.os_version, facts.arch)
            },
            false,
        ),
        fact(
            FactId::Engine,
            "Engine",
            match &facts.engine_version {
                Some(version) => format!("{} {version}", facts.engine),
                None => facts.engine.to_owned(),
            },
            false,
        ),
    ];
    if !versions.is_empty() {
        let versions: Vec<&str> = versions.iter().map(String::as_str).collect();
        stated.push(fact(
            FactId::Kubernetes,
            "Kubernetes",
            versions.join(", "),
            true,
        ));
    }
    if let Some(panic) = log::last_panic(files) {
        let when = if panic.this_run {
            "this run"
        } else {
            "a previous run"
        };
        stated.push(fact(
            FactId::LastPanic,
            "Last panic",
            format!("{} ({when})", place(&panic.location, homes)),
            true,
        ));
    }
    stated
}

fn fact(id: FactId, label: &str, value: String, optional: bool) -> Fact {
    Fact {
        id,
        label: label.to_owned(),
        value,
        optional,
    }
}

/// The first seven digits of a commit hash; `local build` stays whole.
fn short(commit: &str) -> &str {
    if commit.len() > 7 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        &commit[..7]
    } else {
        commit
    }
}

/// A panic's `file:line:column` with a file under a home folder named from
/// `~`, as a dependency's is.
fn place(location: &str, homes: &[String]) -> String {
    let mut parts = location.rsplitn(3, ':');
    let (Some(column), Some(line), Some(file)) = (parts.next(), parts.next(), parts.next()) else {
        return location.to_owned();
    };
    let file = homes
        .iter()
        .map(|home| named(Some(Path::new(home)), Path::new(file)))
        .find(|named| named.starts_with('~'))
        .unwrap_or_else(|| file.to_owned());
    format!("{file}:{line}:{column}")
}
