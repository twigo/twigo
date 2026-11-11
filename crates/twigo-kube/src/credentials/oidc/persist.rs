//! Writes refreshed oidc tokens back to the user's kubeconfig file: only
//! the two values, so its comments and layout stay, under the lock kubectl
//! takes, and by a rename, so no reader ever sees half a file.

use std::fs;
use std::path::Path;
use std::str::FromStr;

use yaml_edit::YamlFile;

use crate::kubeconfig::write::{Lock, WriteError, replace};

#[derive(Debug, thiserror::Error)]
pub enum PersistError {
    #[error(transparent)]
    Write(#[from] WriteError),
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
    let target = fs::canonicalize(file).map_err(WriteError::from)?;
    let text = fs::read_to_string(&target).map_err(WriteError::from)?;
    let edited = edit(&text, user, issuer, client_id, id_token, refresh_token)?;
    Ok(replace(&target, &edited)?)
}

fn edit(
    text: &str,
    user: &str,
    issuer: &str,
    client_id: &str,
    id_token: &str,
    refresh_token: Option<&str>,
) -> Result<String, PersistError> {
    let file = YamlFile::from_str(text).map_err(|error| WriteError::Parse(error.to_string()))?;
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
