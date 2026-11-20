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

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use jiff::Timestamp;
use serde::Serialize;
use twigo_ipc::{BlockReason, ContextAccess, Friction, Mode, ModeSource, RequestClass};

use crate::{Actor, Attributes, Change, Refused};

/// The size past which the log moves aside.
const LIMIT: u64 = 8 << 20;
/// How many logs that moved aside stay.
const KEPT: usize = 5;

/// Where entries go; nowhere for the tools and tests that own their clusters.
pub struct Audit {
    log: Option<Mutex<Log>>,
}

struct Log {
    path: PathBuf,
    file: File,
    /// Whether `file` is the one at `path`: not once a rotation moved it
    /// and no new one could be opened there.
    in_place: bool,
    /// What it holds, as far as this process knows.
    size: u64,
    limit: u64,
    kept: usize,
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
        why: Why,
    },
}

/// Why the policy refused a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Why {
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
}

impl From<&Refused> for Why {
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

impl Audit {
    /// The log at `path`, appended to, its directory made if the app's first
    /// run has not made it yet. A file that cannot be opened logs to stderr
    /// once and keeps nothing: the log records, it guards nothing.
    pub fn open(path: &Path) -> Self {
        Self::rotating(path, LIMIT, KEPT)
    }

    fn rotating(path: &Path, limit: u64, kept: usize) -> Self {
        let opened = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| create(path));
        match opened {
            Ok((file, size)) => Self {
                log: Some(Mutex::new(Log {
                    path: path.to_owned(),
                    file,
                    in_place: true,
                    size,
                    limit,
                    kept,
                })),
            },
            Err(error) => {
                eprintln!("the audit log {} cannot be opened: {error}", path.display());
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
        let mut log = log.lock().expect("audit lock");
        let size = line.len() as u64;
        if !log.in_place {
            log.reopen();
        }
        if log.in_place && log.size > 0 && log.size + size > log.limit {
            log.rotate();
        }
        // One write per line on a file opened to append, so lines of
        // concurrent writers never interleave.
        match log.file.write_all(&line) {
            Ok(()) => log.size += size,
            Err(error) => eprintln!("the audit log could not be written: {error}"),
        }
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
}

impl Log {
    /// Moves the log to `audit.1.jsonl`, each older one up by one, the
    /// oldest past `kept` overwritten, and opens a new one; a log gone from
    /// its place moves none of them. A move that fails is said on stderr and
    /// the log goes on where it is, to try again after another `limit`.
    fn rotate(&mut self) {
        self.size = 0;
        if !matches!(std::fs::exists(&self.path), Ok(false)) {
            let moved = (1..=self.kept)
                .rev()
                .map(|number| (self.numbered(number - 1), self.numbered(number)))
                .try_for_each(|(from, to)| match std::fs::rename(&from, &to) {
                    Err(error) if error.kind() == io::ErrorKind::NotFound && from != self.path => {
                        Ok(())
                    }
                    moved => moved,
                });
            if let Err(error) = moved {
                eprintln!(
                    "the audit log {} could not move aside: {error}",
                    self.path.display()
                );
                return;
            }
        }
        self.in_place = false;
        self.reopen();
    }

    /// Opens a new log at `path` for the one that left it. One that cannot
    /// be opened is said on stderr, and the lines go on to the one that left
    /// until the next line opens one.
    fn reopen(&mut self) {
        match create(&self.path) {
            Ok((file, size)) => {
                self.file = file;
                self.size = size;
                self.in_place = true;
            }
            Err(error) => eprintln!(
                "the audit log {} could not be opened anew, so this line goes to the one that left its place: {error}",
                self.path.display()
            ),
        }
    }

    /// `audit.<number>.jsonl`, and the log itself for 0.
    fn numbered(&self, number: usize) -> PathBuf {
        match number {
            0 => self.path.clone(),
            _ => self.path.with_extension(format!("{number}.jsonl")),
        }
    }
}

/// Opens `path` to append, made 0600 if it is new, with what it holds.
fn create(path: &Path) -> io::Result<(File, u64)> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    let size = file.metadata()?.len();
    Ok((file, size))
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

    fn ended(audit: &Audit, outcome: &str) {
        audit.record(&Entry::Ended {
            context: "kind-a",
            command: "apply",
            target: "deployments/web",
            outcome,
            message: "",
        });
    }

    fn outcomes(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| {
                let line: serde_json::Value = serde_json::from_str(line).unwrap();
                line["outcome"].as_str().unwrap().to_owned()
            })
            .collect()
    }

    #[test]
    fn past_its_limit_the_log_moves_aside_and_the_oldest_past_the_count_goes() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("audit.jsonl");
        let audit = Audit::rotating(&path, 1, 2);
        for outcome in ["a", "b", "c", "d"] {
            ended(&audit, outcome);
        }
        let names = |number: usize| home.path().join(format!("audit.{number}.jsonl"));
        assert_eq!(outcomes(&path), ["d"]);
        assert_eq!(outcomes(&names(1)), ["c"]);
        assert_eq!(outcomes(&names(2)), ["b"]);
        let mut files: Vec<_> = std::fs::read_dir(home.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        files.sort();
        assert_eq!(files, ["audit.1.jsonl", "audit.2.jsonl", "audit.jsonl"]);
        #[cfg(unix)]
        for file in [path, names(1), names(2)] {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{}", file.display());
        }
    }

    #[test]
    fn a_log_that_cannot_move_aside_goes_on_where_it_is() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("audit.jsonl");
        let taken = home.path().join("audit.1.jsonl");
        std::fs::create_dir(&taken).unwrap();
        std::fs::write(taken.join("kept"), "").unwrap();
        let audit = Audit::rotating(&path, 1, 1);
        for outcome in ["a", "b", "c"] {
            ended(&audit, outcome);
        }
        assert_eq!(outcomes(&path), ["a", "b", "c"]);
    }

    #[test]
    fn a_log_that_left_its_place_opens_anew_and_moves_no_older_one() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("audit.jsonl");
        let names = |number: usize| home.path().join(format!("audit.{number}.jsonl"));
        let audit = Audit::rotating(&path, 1, 4);
        ended(&audit, "a");
        ended(&audit, "b");
        {
            let mut log = audit.log.as_ref().unwrap().lock().unwrap();
            std::fs::rename(names(1), names(2)).unwrap();
            std::fs::rename(&path, names(1)).unwrap();
            log.in_place = false;
            log.size = 0;
        }
        ended(&audit, "c");
        ended(&audit, "d");
        assert_eq!(outcomes(&path), ["d"]);
        assert_eq!(outcomes(&names(1)), ["c"]);
        assert_eq!(outcomes(&names(2)), ["b"]);
        assert_eq!(outcomes(&names(3)), ["a"]);

        std::fs::remove_file(&path).unwrap();
        ended(&audit, "e");
        assert_eq!(outcomes(&path), ["e"]);
        assert_eq!(outcomes(&names(1)), ["c"]);
        assert_eq!(outcomes(&names(2)), ["b"]);
        assert_eq!(outcomes(&names(3)), ["a"]);
    }
}
