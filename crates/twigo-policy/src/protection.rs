//! The person's protection (ARCHITECTURE 4.8, 6.4): the mode they chose for
//! each context and the type they marked it as, in `protection.json` in the
//! app-data directory. Only Rust writes it, atomically and for the person
//! alone, and only a confirmed plan of the command bus or the answer to a
//! process's ask changes it.
//!
//! It reads closed, as the admin's policy file does, and is read once, as
//! the app starts: a file that cannot be read keeps `read-only` every
//! context the admin's policy file sets no mode for, and takes no change
//! until the next start, so it is never written over and a newer build's
//! file outlives a downgrade.
//!
//! ```json
//! {
//!   "version": 1,
//!   "modes": { "prod-eu": "read-write" },
//!   "environments": { "prod-eu": "production", "kind-a": null }
//! }
//! ```

use std::collections::BTreeMap;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use twigo_ipc::{Environment, ErrorCode, IpcError, Mode, ModeSource};
use twigo_log::problems;

use crate::Refused;
use crate::file::unparsed;

/// Bumped when the file's shape changes.
const VERSION: u32 = 1;

/// What the person chose, by context.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Choices {
    pub modes: BTreeMap<String, Mode>,
    /// None says it has no type, whatever its kubeconfig says.
    pub environments: BTreeMap<String, Option<Environment>>,
}

/// A key nothing reads would be a choice that does not hold, so an unknown
/// one makes the file unreadable, as a value that does not read back does.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u32,
    modes: BTreeMap<String, Mode>,
    environments: BTreeMap<String, Option<Environment>>,
}

/// The version alone, read first, so that a file of another version says
/// so rather than where its keys do not read.
#[derive(Deserialize)]
struct Version {
    version: u32,
}

pub struct Protection {
    /// None for a policy that keeps the choices nowhere.
    path: Option<PathBuf>,
    /// The choices, or why the file cannot be read in words that quote
    /// nothing of it.
    read: Result<Choices, String>,
}

impl Protection {
    /// Reads the file at `path`: a missing one holds no choices.
    pub fn read(path: &Path) -> Self {
        let read = match std::fs::read(path) {
            Ok(bytes) => parse(&bytes),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Choices::default()),
            Err(error) => Err(error.kind().to_string()),
        };
        if let Err(reason) = &read {
            tracing::error!(path = %path.display(), %reason, "could not read the person's protection, so every context the policy file sets no mode for is read-only");
            problems::report(IpcError::new(
                ErrorCode::ProtectionUnreadable,
                "Twigo could not read protection.json, which holds the modes and types you set, so every context an admin's policy file sets no mode for is read-only until you restore or remove that file and restart Twigo",
            ));
        }
        Self {
            path: Some(path.to_owned()),
            read,
        }
    }

    /// Keeps no choice anywhere: the tools' and tests' that own their
    /// clusters.
    pub(crate) fn nowhere() -> Self {
        Self {
            path: None,
            read: Ok(Choices::default()),
        }
    }

    /// Where the policy keeps the choices, and what it read for the policy
    /// to hold.
    pub(crate) fn open(self) -> (Kept, Result<Choices, String>) {
        (Kept { path: self.path }, self.read)
    }
}

/// Where the policy keeps the person's choices.
pub(crate) struct Kept {
    path: Option<PathBuf>,
}

impl Kept {
    /// What a context the admin's policy file sets no mode for is while
    /// the file cannot be read for `reason`.
    pub(crate) fn unreadable(&self, reason: &str) -> (Mode, ModeSource) {
        (
            Mode::ReadOnly,
            ModeSource::ProtectionUnreadable {
                file: self.file(),
                reason: reason.to_owned(),
            },
        )
    }

    /// Why a change is refused while the file cannot be read.
    pub(crate) fn refused(&self) -> Refused {
        Refused::ProtectionUnreadable(self.file())
    }

    /// Writes `choices`, which the policy holds only once the file holds
    /// them.
    pub(crate) fn keep(&self, choices: &Choices) -> Result<(), Refused> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let json = json(choices);
        let Err(error) = write(path, &json) else {
            return Ok(());
        };
        // The save's last step, the directory's fsync, comes after the
        // rename, so a failed save may have put the file in place.
        if std::fs::read(path).is_ok_and(|held| held == json) {
            tracing::warn!(path = %path.display(), %error, "the save of the person's protection failed, but the file holds what it wrote");
            return Ok(());
        }
        tracing::error!(path = %path.display(), %error, "could not save the person's protection");
        Err(Refused::Unsaved(self.file(), error.kind()))
    }

    fn file(&self) -> String {
        self.path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_default()
    }
}

#[cfg(any(test, feature = "test-util"))]
impl Protection {
    /// Holds `choices` and keeps them nowhere, for the tests that start
    /// from what a person chose.
    pub fn holding(choices: Choices) -> Self {
        Self {
            read: Ok(choices),
            ..Self::nowhere()
        }
    }
}

#[cfg(any(test, feature = "test-util"))]
impl Default for Protection {
    fn default() -> Self {
        Self::nowhere()
    }
}

fn parse(bytes: &[u8]) -> Result<Choices, String> {
    let unread = |error: serde_json::Error| unparsed(&error, "Twigo's protection file");
    let Version { version } = serde_json::from_slice(bytes).map_err(unread)?;
    if version != VERSION {
        return Err("it is of a version this Twigo does not know".to_owned());
    }
    let File {
        modes,
        environments,
        ..
    } = serde_json::from_slice(bytes).map_err(unread)?;
    Ok(Choices {
        modes,
        environments,
    })
}

fn json(choices: &Choices) -> Vec<u8> {
    serde_json::to_vec_pretty(&File {
        version: VERSION,
        modes: choices.modes.clone(),
        environments: choices.environments.clone(),
    })
    .expect("maps of strings and plain enums serialize to JSON")
}

fn write(path: &Path, json: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = AtomicWriteFile::options();
    #[cfg(unix)]
    {
        use atomic_write_file::unix::OpenOptionsExt as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        // It names the user's clusters.
        options.preserve_mode(false).mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(json)?;
    file.commit()
}
