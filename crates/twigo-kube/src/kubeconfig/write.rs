//! Writing a user's kubeconfig as kubectl lets another writer in: under its
//! `<file>.lock`, and by a rename, so no reader ever sees half a file.
//!
//! client-go's `ModifyConfig` creates `<file>.lock` with `O_EXCL` before it
//! writes ([`lockFile`]), and gives up at once if the lock exists; Twigo
//! waits a moment for it, and never removes a lock it did not create.
//!
//! [`lockFile`]: https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/clientcmd/loader.go#L472-L489

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use yaml_edit::YamlError;

/// kubectl holds its lock for one write.
const LOCK_TRIES: u32 = 10;
const LOCK_PAUSE: Duration = Duration::from_millis(50);

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("{0} is held by another writer")]
    Locked(PathBuf),
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("the file does not parse{}", at(.line, .column))]
    Parse {
        line: Option<usize>,
        column: Option<usize>,
    },
    #[error("the file holds no mapping")]
    NoMapping,
}

fn at(line: &Option<usize>, column: &Option<usize>) -> String {
    match (line, column) {
        (Some(line), Some(column)) => format!(" at line {line}, column {column}"),
        _ => String::new(),
    }
}

impl From<YamlError> for WriteError {
    /// By where the fault is, never what yaml-edit says of it: its message
    /// can quote the text around the fault, a token among it.
    fn from(error: YamlError) -> Self {
        let (line, column) = match error {
            YamlError::Parse { line, column, .. } => (line, column),
            _ => (None, None),
        };
        Self::Parse { line, column }
    }
}

/// A temporary file beside the target, with the target's mode, or 0600 for
/// a target that does not exist, renamed over it.
pub(crate) fn replace(target: &Path, text: &str) -> Result<(), WriteError> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or_default();
    let temporary = dir.join(format!(".{name}.twigo-{}-{nanos}", std::process::id()));
    let written = (|| {
        // A new file, never one a link at that name points to.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let permissions = match fs::metadata(target) {
            Ok(metadata) => metadata.permissions(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                std::os::unix::fs::PermissionsExt::from_mode(0o600)
            }
            Err(error) => return Err(error),
        };
        file.set_permissions(permissions)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, target)
    })();
    if written.is_err() {
        // Nothing to undo if it was never created.
        let _ = fs::remove_file(&temporary);
    }
    Ok(written?)
}

/// kubectl's `<file>.lock`, removed on drop.
pub(crate) struct Lock(PathBuf);

impl Lock {
    pub(crate) fn take(file: &Path) -> Result<Self, WriteError> {
        let mut name = file.as_os_str().to_owned();
        name.push(".lock");
        let path = PathBuf::from(name);
        for _ in 0..LOCK_TRIES {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Self(path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    std::thread::sleep(LOCK_PAUSE);
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(WriteError::Locked(path))
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.0) {
            tracing::warn!(path = %self.0.display(), %error, "could not remove the lock file");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr as _;

    use yaml_edit::YamlFile;

    use super::*;

    #[test]
    fn a_file_that_does_not_parse_is_named_by_its_place_and_not_by_the_text_around_it() {
        let text = "a: 1\n--- \nb\n... token-SECRET\n";
        let error = YamlFile::from_str(text).unwrap_err();
        assert!(error.to_string().contains("token-SECRET"), "{error}");
        assert_eq!(
            WriteError::from(error).to_string(),
            "the file does not parse at line 4, column 5"
        );
    }
}
