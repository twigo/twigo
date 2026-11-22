use std::io;
use std::path::Path;

/// Says that deleting `path` failed, unless there was nothing to delete.
pub(crate) fn deleted(path: &Path, result: io::Result<()>) {
    if let Err(error) = result
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(path = %path.display(), %error, "could not delete");
    }
}
