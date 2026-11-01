//! Writes refreshed oidc tokens back to the user's kubeconfig file: only
//! the two values, so its comments and layout stay, under the lock kubectl
//! takes, and by a rename, so no reader ever sees half a file.
//!
//! client-go's `ModifyConfig` creates `<file>.lock` with `O_EXCL` before it
//! writes (`tools/clientcmd/loader.go`, `lockFile`), and gives up at once if
//! the lock exists; Twigo waits a moment for it, and never removes a lock it
//! did not create.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use yaml_edit::YamlFile;

/// kubectl holds its lock for one write.
const LOCK_TRIES: u32 = 10;
const LOCK_PAUSE: Duration = Duration::from_millis(50);

#[derive(Debug, thiserror::Error)]
pub enum PersistError {
    #[error("{0} is held by another writer")]
    Locked(PathBuf),
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("the file does not parse: {0}")]
    Parse(String),
    #[error("the file no longer has this oidc user")]
    Gone,
}

/// Sets `id-token`, and `refresh-token` when the issuer rotated it, in the
/// `auth-provider` of `user` in `file`, if that still names `issuer` and
/// `client_id`.
pub fn write(
    file: &Path,
    user: &str,
    issuer: &str,
    client_id: &str,
    id_token: &str,
    refresh_token: Option<&str>,
) -> Result<(), PersistError> {
    let _lock = Lock::take(file)?;
    // Written in place of the file a symlink names, as kubectl's write
    // through the link reaches it.
    let target = fs::canonicalize(file)?;
    let text = fs::read_to_string(&target)?;
    let edited = edit(&text, user, issuer, client_id, id_token, refresh_token)?;
    replace(&target, &edited)
}

fn edit(
    text: &str,
    user: &str,
    issuer: &str,
    client_id: &str,
    id_token: &str,
    refresh_token: Option<&str>,
) -> Result<String, PersistError> {
    let file = YamlFile::from_str(text).map_err(|error| PersistError::Parse(error.to_string()))?;
    let config = file
        .documents()
        .filter_map(|document| document.as_mapping()?.get_sequence("users"))
        .flat_map(|users| users.values().collect::<Vec<_>>())
        .filter_map(|node| node.as_mapping().cloned())
        .find(|entry| scalar(entry.get("name")).as_deref() == Some(user))
        .and_then(|entry| entry.get_mapping("user"))
        .and_then(|entry| entry.get_mapping("auth-provider"))
        .filter(|provider| scalar(provider.get("name")).as_deref() == Some("oidc"))
        .and_then(|provider| provider.get_mapping("config"))
        .ok_or(PersistError::Gone)?;
    if scalar(config.get("idp-issuer-url")).as_deref() != Some(issuer)
        || scalar(config.get("client-id")).as_deref() != Some(client_id)
    {
        return Err(PersistError::Gone);
    }
    config.set("id-token", id_token);
    if let Some(refresh_token) = refresh_token {
        config.set("refresh-token", refresh_token);
    }
    Ok(file.to_string())
}

fn scalar(node: Option<yaml_edit::YamlNode>) -> Option<String> {
    Some(node?.as_scalar()?.as_string())
}

/// A temporary file beside the target, with its mode, renamed over it.
fn replace(target: &Path, text: &str) -> Result<(), PersistError> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temporary = dir.join(format!(".{name}.twigo-{}", std::process::id()));
    let written = (|| {
        let mut file = File::create(&temporary)?;
        file.set_permissions(fs::metadata(target)?.permissions())?;
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
struct Lock(PathBuf);

impl Lock {
    fn take(file: &Path) -> Result<Self, PersistError> {
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
        Err(PersistError::Locked(path))
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.0) {
            eprintln!("could not remove {}: {error}", self.0.display());
        }
    }
}
