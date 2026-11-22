//! The audit log (ARCHITECTURE 6.4): a JSONL file in the app-data directory,
//! mode 0600, of the requests the gate sent or stopped, or the policy proxy
//! stopped itself, every class but a read of an actor other than the UI and
//! the UI's writes, of every command a person confirmed and how it ended,
//! and of every answer to a process's ask but a type that marks its context.
//! It names what was asked and where, never a value or a token. Past
//! [`LIMIT`] it moves to `audit.1.jsonl`, the older ones up by one, and
//! [`KEPT`] of them stay.
//!
//! It also records each change of a context's protection, a command's, the
//! type an unmarked ask's answer gave, or the catalog's, each unlock's end,
//! each credential plugin a person trusted, and each command of a person's
//! that the policy refused before anything was sent.

use std::path::Path;

use jiff::Timestamp;
use serde::Serialize;
use twigo_ipc::{
    BlockReason, Blocked, ContextAccess, ErrorCode, Friction, IpcError, Mode, ModeSource,
    RequestClass,
};
use twigo_log::{Failure, Limits, Rotating, problems};

use crate::{Actor, Attributes, Change, Refused};

/// The size past which the log moves aside, and how many logs that moved
/// aside stay.
const LIMITS: Limits = Limits {
    size: 8 << 20,
    kept: 5,
};

/// Where entries go; nowhere for the tools and tests that own their clusters.
pub struct Audit {
    log: Option<Rotating>,
}

/// One line of the log, which [`Audit::record`] stamps with its time.
#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Entry<'a> {
    /// A request the gate let out to the server, or it or the policy proxy
    /// stopped.
    Request {
        context: &'a str,
        actor: &'a str,
        verb: &'a str,
        target: &'a str,
        class: RequestClass,
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
    /// A change of a context's protection: what the context was before and
    /// is after, a lock that a person's mode sets aside named in its source.
    Protection {
        context: &'a str,
        change: &'a Change,
        before: &'a ContextAccess,
        after: &'a ContextAccess,
        by: By<'a>,
    },
    /// An unlock ended before a person changed the context: by a relock
    /// (`command`), by its time (`time`), or as the context named another
    /// cluster (`moved`) or none (`unlisted`).
    Relocked { context: &'a str, by: &'a str },
    /// What the catalog says of a context changed its mode, its source or
    /// its type, with no command: its kubeconfig was edited, its provider's
    /// lock came or went, or a source listed it or stopped listing it.
    Catalog {
        context: &'a str,
        before: &'a ContextAccess,
        after: &'a ContextAccess,
    },
    /// A person trusted a credential plugin: its digest and the program it
    /// runs, none where no context lists it now; never its arguments or
    /// environment, which may hold tokens.
    Trusted {
        digest: &'a str,
        program: Option<&'a str>,
    },
    /// The policy refused a command of a person's before anything was sent,
    /// named as `confirmed` names one. `mode` and `source` are what the
    /// policy read of the context.
    Refused {
        context: &'a str,
        command: &'a str,
        target: &'a str,
        mode: Mode,
        source: &'a ModeSource,
        why: Why<'a>,
    },
}

/// Why the policy refused a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Why<'a> {
    /// The gate stopped one of the command's writes.
    Gate { reason: BlockReason },
    /// The admin's policy file sets the context's mode.
    PolicyFile,
    /// An unlock of a context that is not locked.
    NotLocked,
    /// No source lists the context.
    Unlisted,
    /// What the context lets through changed since the plan.
    Changed,
    /// The context now asks for more friction than the plan went through.
    Friction {
        planned: &'a Friction,
        now: &'a Friction,
    },
}

impl From<&Refused> for Why<'_> {
    fn from(refused: &Refused) -> Self {
        match refused {
            Refused::PolicyFile(..) | Refused::PolicyFileUnreadable(_) => Self::PolicyFile,
            Refused::NotLocked(..) => Self::NotLocked,
            Refused::Unlisted(_) => Self::Unlisted,
            Refused::Changed(_) => Self::Changed,
        }
    }
}

/// Who changed a context's protection.
#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum By<'a> {
    /// A plan of the command bus the person confirmed through `friction`.
    Plan { friction: &'a Friction },
    /// The person's answer to the ask of a process through the policy
    /// proxy, named as an approval names it.
    Ask { actor: &'a str, process: &'a str },
}

#[derive(Serialize)]
struct Line<'a> {
    at: Timestamp,
    #[serde(flatten)]
    entry: &'a Entry<'a>,
}

/// The diagnostics log holds what the open file could not do, since a
/// launched app's stderr reaches nobody.
fn unrecorded(failure: &Failure<'_>) {
    tracing::error!(path = %failure.path.display(), error = %failure.error, "the audit log {}", failure.what);
    problems::report(IpcError::new(
        ErrorCode::AuditUnwritten,
        "The audit log could not be written, so some of what Twigo sent to a cluster is not recorded",
    ));
}

impl Audit {
    /// The log at `path`, appended to, its directory made if the app's first
    /// run has not made it yet. A file that cannot be opened is logged and
    /// keeps nothing: the log records, it guards nothing.
    pub fn open(path: &Path) -> Self {
        match Rotating::open(path, LIMITS, unrecorded) {
            Ok(log) => Self { log: Some(log) },
            Err(error) => {
                tracing::error!(path = %path.display(), %error, "the audit log cannot be opened, so nothing is recorded");
                problems::report(IpcError::new(
                    ErrorCode::AuditOff,
                    "The audit log could not be opened, so Twigo records none of what it sends to a cluster",
                ));
                Self::off()
            }
        }
    }

    pub fn off() -> Self {
        Self { log: None }
    }

    pub fn record(&self, entry: &Entry<'_>) {
        let Some(log) = &self.log else {
            return;
        };
        let mut line = serde_json::to_vec(&Line {
            at: Timestamp::now(),
            entry,
        })
        .expect("an entry serializes");
        line.push(b'\n');
        log.append(&line);
    }

    /// A request the gate let out or stopped, or the policy proxy stopped on
    /// the policy's word before it met the gate: of an actor other than the
    /// UI every class but a read, and of the UI its writes, as the command bus
    /// logs its commands.
    pub fn request(
        &self,
        context: &str,
        actor: Actor,
        attributes: &Attributes,
        mode: Mode,
        blocked: Option<BlockReason>,
    ) {
        let logged = match (actor, attributes.class) {
            (_, RequestClass::Read) => false,
            (Actor::Ui, class) => class == RequestClass::Write,
            _ => true,
        };
        if !logged {
            return;
        }
        self.record(&Entry::Request {
            context,
            actor: actor.name(),
            verb: &attributes.verb,
            target: &attributes.target(),
            class: attributes.class,
            mode,
            blocked,
        });
    }

    /// The gate refused a command of a person's before it sent anything.
    pub fn gate_refused(&self, context: &str, command: &str, target: &str, blocked: &Blocked) {
        self.record(&Entry::Refused {
            context,
            command,
            target,
            mode: blocked.mode,
            source: &blocked.source,
            why: Why::Gate {
                reason: blocked.reason,
            },
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

    fn listed(code: ErrorCode) -> bool {
        problems::watch()
            .borrow()
            .iter()
            .any(|problem| problem.code == code)
    }

    #[test]
    fn a_log_that_cannot_open_is_a_problem_the_window_is_told() {
        let home = tempfile::tempdir().unwrap();
        let blocked = home.path().join("blocked");
        std::fs::write(&blocked, "").unwrap();
        problems::clear(ErrorCode::AuditOff);
        Audit::open(&blocked.join("audit.jsonl"));
        assert!(listed(ErrorCode::AuditOff));
    }

    #[test]
    fn a_log_that_cannot_move_aside_says_so_in_the_diagnostics_log_at_error() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("audit.jsonl");
        std::fs::write(&path, vec![b'\n'; LIMITS.size as usize]).unwrap();
        std::fs::write(home.path().join("audit.4.jsonl"), "").unwrap();
        let oldest = home.path().join("audit.5.jsonl");
        std::fs::create_dir(&oldest).unwrap();
        std::fs::write(oldest.join("kept"), "").unwrap();

        let events = twigo_log::capture();
        problems::clear(ErrorCode::AuditUnwritten);
        Audit::open(&path).record(&Entry::Ended {
            context: "kind-a",
            command: "apply",
            target: "deployments/web",
            outcome: "done",
            message: "",
        });
        assert!(listed(ErrorCode::AuditUnwritten));

        let [event] = &events.lines()[..] else {
            panic!("one event: {:?}", events.lines());
        };
        assert_eq!(event["level"], "ERROR");
        assert_eq!(event["target"], "twigo_policy::audit");
        assert_eq!(
            event["fields"]["message"],
            "the audit log could not move aside"
        );
        assert_eq!(event["fields"]["path"], path.to_str().unwrap());
        assert!(
            event["fields"]["error"]
                .as_str()
                .is_some_and(|error| !error.is_empty())
        );
    }
}
