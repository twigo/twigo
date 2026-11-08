//! Discovery on disk, one file per cluster, so a start revalidates it with
//! its ETags instead of downloading it again.

use std::io;
use std::path::PathBuf;

use super::Discovery;
use crate::disk;

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
        disk::write_private(&self.path(cluster), &json)
    }

    fn path(&self, cluster: &str) -> PathBuf {
        disk::path(&self.dir, cluster)
    }
}
