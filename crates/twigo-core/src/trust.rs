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
        self.write(&next.digests)?;
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
    eprintln!(
        "the trusted plugins in {} cannot be read ({reason}); they move to {}",
        path.display(),
        aside.display()
    );
    if let Err(error) = std::fs::rename(path, &aside) {
        eprintln!("could not move the trusted plugins aside: {error}");
    }
    Trusted::default()
}
