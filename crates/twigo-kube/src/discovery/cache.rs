//! Discovery on disk, one file per cluster, so a start revalidates it with
//! its ETags instead of downloading it again.

use std::io::{self, Write as _};
use std::path::PathBuf;

use atomic_write_file::AtomicWriteFile;

use super::Discovery;

pub struct Cache {
    dir: PathBuf,
}

impl Cache {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The cluster's discovery as last stored, if any; a file that cannot
    /// be read is an error, though the next store replaces it. `cluster`
    /// names it as `Clients::cluster` does.
    pub fn load(&self, cluster: &str) -> io::Result<Option<Discovery>> {
        let json = match std::fs::read(self.path(cluster)) {
            Ok(json) => json,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        serde_json::from_slice(&json)
            .map(Some)
            .map_err(io::Error::other)
    }

    pub fn store(&self, cluster: &str, discovery: &Discovery) -> io::Result<()> {
        let json = serde_json::to_vec(discovery).expect("discovery serializes");
        std::fs::create_dir_all(&self.dir)?;
        let mut options = AtomicWriteFile::options();
        #[cfg(unix)]
        {
            use atomic_write_file::unix::OpenOptionsExt as _;
            use std::os::unix::fs::OpenOptionsExt as _;
            // It names the cluster's custom resources.
            options.preserve_mode(false).mode(0o600);
        }
        let mut file = options.open(self.path(cluster))?;
        file.write_all(&json)?;
        file.commit()
    }

    /// Named by a digest of the cluster's name, which may hold any
    /// character.
    fn path(&self, cluster: &str) -> PathBuf {
        let digest = ring::digest::digest(&ring::digest::SHA256, cluster.as_bytes());
        let name: String = digest.as_ref()[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        self.dir.join(format!("{name}.json"))
    }
}
