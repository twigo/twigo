//! What the caches keep in the app's cache directory.

use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use atomic_write_file::AtomicWriteFile;

/// The file in `dir` that holds `key`'s value, named by a digest of the key,
/// which may hold any character.
pub(crate) fn path(dir: &Path, key: &str) -> PathBuf {
    let digest = ring::digest::digest(&ring::digest::SHA256, key.as_bytes());
    let name: String = digest.as_ref()[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    dir.join(format!("{name}.json"))
}

/// Replaces the file whole or not at all, readable by its owner only: what
/// the caches hold names the cluster's custom resources.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = AtomicWriteFile::options();
    #[cfg(unix)]
    {
        use atomic_write_file::unix::OpenOptionsExt as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        options.preserve_mode(false).mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.commit()
}
