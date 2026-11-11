//! A terminal's own directory, `terminals/<n>/` in the app's data directory,
//! and what Twigo writes into it: the startup files that set the terminal's
//! `KUBECONFIG` after the shell's own, and for a kubeconfig terminal Twigo's
//! file, a whole kubeconfig that holds a copy of the context's own entry and
//! makes it current. kubectl writes back to the first file that names an
//! entry, so a namespace set for the current context lands here, not in the
//! user's file; `az` refuses a file without the three lists, and `gcloud`
//! moves one aside.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use kube::config::NamedContext;
use serde_json::json;

/// Deleted with the terminal.
pub(super) struct Directory(PathBuf);

impl Directory {
    /// `root/<n>/`, only the user may enter either.
    pub(super) fn create(root: &Path, n: u64) -> io::Result<Self> {
        let mut builder = DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(root)?;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
        let dir = root.join(n.to_string());
        DirBuilder::new().mode(0o700).create(&dir)?;
        Ok(Self(dir))
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }

    /// Twigo's file, written whole before anything gives out its path,
    /// which only the user may read.
    pub(super) fn kubeconfig(&self, context: &NamedContext) -> io::Result<PathBuf> {
        let config = json!({
            "apiVersion": "v1",
            "kind": "Config",
            "clusters": [],
            "users": [],
            "contexts": [context],
            "current-context": context.name,
        });
        self.write(
            "kubeconfig",
            &serde_json::to_vec_pretty(&config).expect("JSON"),
        )
    }

    /// `name` in the directory, written whole before the shell starts,
    /// which only the user may read.
    pub(super) fn write(&self, name: &str, contents: &[u8]) -> io::Result<PathBuf> {
        let path = self.0.join(name);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        Ok(path)
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && error.kind() != io::ErrorKind::NotFound
        {
            eprintln!("could not delete {}: {error}", self.0.display());
        }
    }
}

/// What a previous run left: the directories of terminals that ended with it.
pub(super) fn wipe(root: &Path) {
    if let Err(error) = fs::remove_dir_all(root)
        && error.kind() != io::ErrorKind::NotFound
    {
        eprintln!("could not delete {}: {error}", root.display());
    }
}

#[cfg(test)]
mod tests {
    use kube::config::{Context, Kubeconfig};

    use super::*;

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn twigo_s_file_holds_the_context_s_own_entry_and_empty_lists_only_the_user_reads() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().join("terminals");
        let context = NamedContext {
            name: "kind-a".to_owned(),
            context: Some(Context {
                cluster: "kind-a-cluster".to_owned(),
                user: Some("kind-a-user".to_owned()),
                namespace: Some("apps".to_owned()),
                extensions: None,
                ..Context::default()
            }),
            ..NamedContext::default()
        };
        let directory = Directory::create(&root, 7).unwrap();
        let file = directory.kubeconfig(&context).unwrap();
        assert_eq!(file, root.join("7").join("kubeconfig"));
        assert_eq!(
            (mode(&root), mode(&root.join("7")), mode(&file)),
            (0o700, 0o700, 0o600)
        );
        let text = fs::read_to_string(&file).unwrap();
        let read: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(read["clusters"], json!([]));
        assert_eq!(read["users"], json!([]));
        let config = Kubeconfig::from_yaml(&text).unwrap();
        assert_eq!(config.current_context.as_deref(), Some("kind-a"));
        assert_eq!(
            (config.api_version.as_deref(), config.kind.as_deref()),
            (Some("v1"), Some("Config"))
        );
        let copied = config.contexts[0].context.as_ref().unwrap();
        assert_eq!(copied.cluster, "kind-a-cluster");
        assert_eq!(copied.user.as_deref(), Some("kind-a-user"));
        assert_eq!(copied.namespace.as_deref(), Some("apps"));
        drop(directory);
        assert!(!root.join("7").exists());
        assert!(root.exists());
    }
}
