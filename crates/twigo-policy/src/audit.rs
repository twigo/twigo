//! The audit log (ARCHITECTURE 6.4): a JSONL file in the app-data directory,
//! mode 0600, of every write the gate sent or stopped, whoever asked, of
//! every command a person confirmed and how it ended, and of every answer to
//! a process's ask. It names what was asked and where, never a value or a
//! token.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use jiff::Timestamp;
use serde::Serialize;
use twigo_ipc::{BlockReason, Friction, Mode};

use crate::{Actor, Attributes};

/// Where entries go; nowhere for the tools and tests that own their clusters.
pub struct Audit {
    file: Option<Mutex<File>>,
}

/// One line of the log, which [`Audit::record`] stamps with its time.
#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Entry<'a> {
    /// A write the gate let out to the server, or stopped.
    Request {
        context: &'a str,
        actor: &'a str,
        verb: &'a str,
        target: &'a str,
        mode: Mode,
        /// None when the gate let it on to the connection, just above the
        /// socket; a retry below the gate is noted again, as sent again.
        blocked: Option<BlockReason>,
    },
    /// A person confirmed a command, through `friction`.
    Confirmed {
        context: &'a str,
        command: &'a str,
        target: &'a str,
        mode: Mode,
        friction: &'a Friction,
    },
    /// What became of a process's ask through the policy proxy: `once`,
    /// `lasting`, `denied`, `nobody` when no window could ask, or `withdrawn`.
    Approval {
        context: &'a str,
        actor: &'a str,
        /// As Twigo named the process: `Terminal 2`.
        process: &'a str,
        verb: &'a str,
        target: &'a str,
        mode: Mode,
        answer: &'a str,
    },
    /// A confirmed command ended: `done`, `stopped` or `failed`, as it says.
    Ended {
        context: &'a str,
        command: &'a str,
        target: &'a str,
        outcome: &'a str,
        message: &'a str,
    },
}

#[derive(Serialize)]
struct Line<'a> {
    at: Timestamp,
    #[serde(flatten)]
    entry: &'a Entry<'a>,
}

impl Audit {
    /// The log at `path`, appended to, its directory made if the app's first
    /// run has not made it yet. A file that cannot be opened logs to stderr
    /// once and keeps nothing: the log records, it guards nothing.
    pub fn open(path: &Path) -> Self {
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let opened = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| options.open(path));
        match opened {
            Ok(file) => Self {
                file: Some(Mutex::new(file)),
            },
            Err(error) => {
                eprintln!("the audit log {} cannot be opened: {error}", path.display());
                Self::off()
            }
        }
    }

    pub fn off() -> Self {
        Self { file: None }
    }

    pub fn record(&self, entry: &Entry<'_>) {
        let Some(file) = &self.file else {
            return;
        };
        let mut line = serde_json::to_vec(&Line {
            at: Timestamp::now(),
            entry,
        })
        .expect("an entry serializes");
        line.push(b'\n');
        // One write per line on a file opened to append, so lines of
        // concurrent writers never interleave.
        let written = file.lock().expect("audit lock").write_all(&line);
        if let Err(error) = written {
            eprintln!("the audit log could not be written: {error}");
        }
    }

    /// A write the gate let out or stopped; reads and the other classes are
    /// not logged.
    pub(crate) fn request(
        &self,
        context: &str,
        actor: Actor,
        attributes: &Attributes,
        mode: Mode,
        blocked: Option<BlockReason>,
    ) {
        if attributes.class != twigo_ipc::RequestClass::Write {
            return;
        }
        self.record(&Entry::Request {
            context,
            actor: actor.name(),
            verb: &attributes.verb,
            target: &attributes.target(),
            mode,
            blocked,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_a_log_in_a_directory_that_does_not_exist_yet() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("app-data/nested/audit.jsonl");
        Audit::open(&path).record(&Entry::Ended {
            context: "kind-a",
            command: "apply",
            target: "deployments/web",
            outcome: "done",
            message: "",
        });
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains(r#""event":"ended""#), "{written}");
    }
}
