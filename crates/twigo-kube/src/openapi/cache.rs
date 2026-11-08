//! OpenAPI documents on disk, one file per URL, so a document is downloaded
//! once for as long as the cluster serves it.

use std::io;
use std::path::PathBuf;

use bytes::Bytes;

use crate::disk;

#[derive(Debug, Clone)]
pub struct Cache {
    dir: PathBuf,
}

impl Cache {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The document stored under `url`, if any. What a file holds is not
    /// trusted: the caller checks it against the hash in `url`.
    pub(super) fn load(&self, url: &str) -> io::Result<Option<Bytes>> {
        match std::fs::read(disk::path(&self.dir, url)) {
            Ok(document) => Ok(Some(document.into())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(super) fn store(&self, url: &str, document: &[u8]) -> io::Result<()> {
        disk::write_private(&disk::path(&self.dir, url), document)
    }
}
