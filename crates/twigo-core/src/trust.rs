//! Kubeconfig trust (ARCHITECTURE 6.2): an exec plugin is a command chosen
//! by whoever wrote the kubeconfig, so Twigo runs one only once the person
//! has trusted its command, arguments and environment. The digests they
//! trusted live in a file of their own, which only Rust writes.

use std::collections::BTreeSet;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use twigo_ipc::{ErrorCode, IpcError};
use twigo_log::problems;

/// Bumped when the file's shape changes; a file of another version is set
/// aside, and nothing is trusted.
const VERSION: u32 = 1;

pub struct Trust {
    path: PathBuf,
    trusted: watch::Sender<Trusted>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Trusted {
    /// The person has answered the review of the first start, so a new
    /// plugin asks only when it is about to run.
    pub reviewed: bool,
    digests: BTreeSet<String>,
}

impl Trusted {
    pub fn trusts(&self, digest: &str) -> bool {
        self.digests.contains(digest)
    }
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    digests: BTreeSet<String>,
}

impl Trust {
    pub fn open(path: PathBuf) -> Self {
        let trusted = read(&path);
        Self {
            path,
            trusted: watch::Sender::new(trusted),
        }
    }

    pub fn current(&self) -> Trusted {
        self.trusted.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<Trusted> {
        self.trusted.subscribe()
    }

    /// Trusts `digests` and marks the review answered, an empty list
    /// included; nothing changes unless the file is written.
    pub fn trust(&self, digests: impl IntoIterator<Item = String>) -> io::Result<()> {
        let mut next = self.current();
        next.digests.extend(digests);
        next.reviewed = true;
        self.write(&next.digests).inspect_err(|error| {
            tracing::error!(path = %self.path.display(), %error, "could not save the trusted plugins");
        })?;
        self.trusted.send_replace(next);
        Ok(())
    }

    fn write(&self, digests: &BTreeSet<String>) -> io::Result<()> {
        let json = serde_json::to_vec_pretty(&File {
            version: VERSION,
            digests: digests.clone(),
        })
        .expect("the trust file serializes");
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut options = AtomicWriteFile::options();
        #[cfg(unix)]
        {
            use atomic_write_file::unix::OpenOptionsExt as _;
            use std::os::unix::fs::OpenOptionsExt as _;
            options.preserve_mode(false).mode(0o600);
        }
        let mut file = options.open(&self.path)?;
        file.write_all(&json)?;
        file.commit()
    }
}

fn read(path: &Path) -> Trusted {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Trusted::default(),
        Err(error) => return set_aside(path, &error),
    };
    match serde_json::from_slice::<File>(&bytes) {
        Ok(file) if file.version == VERSION => Trusted {
            reviewed: true,
            digests: file.digests,
        },
        Ok(file) => set_aside(path, &format!("version {}", file.version)),
        Err(error) => set_aside(path, &error),
    }
}

/// Trusts nothing rather than guess, and asks for the review again.
fn set_aside(path: &Path, reason: &dyn std::fmt::Display) -> Trusted {
    let aside = path.with_extension("json.unreadable");
    tracing::warn!(path = %path.display(), %reason, "the trusted plugins cannot be read, so they move to a file of their name with .unreadable");
    if let Err(error) = std::fs::rename(path, &aside) {
        tracing::error!(path = %path.display(), %error, "could not move the trusted plugins aside");
    }
    problems::report(IpcError::new(
        ErrorCode::TrustSetAside,
        "Twigo could not read the list of plugins you trusted, so it trusts none and asks again",
    ));
    Trusted::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_set_aside_is_a_problem_for_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trust.json");
        std::fs::write(&path, "{ not json").unwrap();
        problems::clear(ErrorCode::TrustSetAside);
        let trust = Trust::open(path);
        assert!(!trust.current().trusts("any"));
        assert!(
            problems::watch()
                .borrow()
                .iter()
                .any(|problem| problem.code == ErrorCode::TrustSetAside)
        );
    }

    #[test]
    fn a_list_that_cannot_be_saved_says_so_in_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("a-file");
        std::fs::write(&blocked, "").unwrap();
        let trust = Trust::open(blocked.join("trust.json"));
        let log = twigo_log::capture();

        assert!(trust.trust(["digest".to_owned()]).is_err());

        let errors: Vec<_> = log
            .lines()
            .into_iter()
            .filter(|line| line["level"] == "ERROR")
            .map(|line| line["fields"]["message"].clone())
            .collect();
        assert_eq!(errors, ["could not save the trusted plugins"]);
    }
}
