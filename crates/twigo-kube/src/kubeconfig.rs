//! The kubeconfig source of the catalog (ARCHITECTURE 5.5): the files kubectl
//! reads, merged by its rules, with each context's `twigo` extension and
//! fingerprint.

mod fingerprint;
#[cfg(test)]
mod tests;
mod watch;

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kube::config::{Kubeconfig, KubeconfigError, NamedAuthInfo, NamedCluster, NamedContext};
use serde::Deserialize;
use twigo_ipc::ContextColor;

use crate::credentials::{Exec, ExecError, OidcEntry, OidcError, token_or_basic};

pub use fingerprint::Fingerprint;
pub use watch::Watch;

/// The name of the kubeconfig extension Twigo reads and never writes.
const EXTENSION: &str = "twigo";

/// The files contexts come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sources {
    files: Vec<PathBuf>,
    /// Only `kind-*` and `kwok-*` contexts count.
    test_only: bool,
}

impl Sources {
    /// kubectl's files: those `KUBECONFIG` lists when it is set and not
    /// empty, else `~/.kube/config`, as client-go's loading rules read them.
    /// A relative path is taken from the current directory, as kubectl
    /// takes it.
    pub fn kubectl(kubeconfig: Option<&OsStr>, home: Option<&Path>) -> Self {
        let files = match kubeconfig.filter(|list| !list.is_empty()) {
            Some(list) => {
                let mut files: Vec<PathBuf> = Vec::new();
                for file in std::env::split_paths(list) {
                    if file.as_os_str().is_empty() {
                        continue;
                    }
                    let file = absolute(file);
                    if !files.contains(&file) {
                        files.push(file);
                    }
                }
                files
            }
            None => home
                .map(|home| home.join(".kube").join("config"))
                .into_iter()
                .collect(),
        };
        Self {
            files,
            test_only: false,
        }
    }

    /// One file, and only its `kind-*` and `kwok-*` contexts: the mode
    /// development, tests and the bench run in, so that nothing they start
    /// reads another cluster.
    pub fn explicit(file: PathBuf) -> Self {
        Self {
            files: vec![absolute(file)],
            test_only: true,
        }
    }

    pub fn files(&self) -> &[PathBuf] {
        &self.files
    }

    /// Reads and merges the files. A missing file is skipped, as kubectl
    /// skips it; one that cannot be read or parsed is skipped and reported.
    pub fn load(&self) -> Catalog {
        let mut merged = Kubeconfig::default();
        let mut failures = Vec::new();
        // The file each user entry comes from: the first that names it, as
        // kubectl's merge keeps it, and where its refreshed tokens go.
        let mut origins: HashMap<String, PathBuf> = HashMap::new();
        for file in &self.files {
            let config = match Kubeconfig::read_from(file) {
                Ok(config) => config,
                Err(KubeconfigError::ReadConfig(error, _))
                    if error.kind() == ErrorKind::NotFound =>
                {
                    continue;
                }
                Err(error) => {
                    failures.push(FileFailure::new(file, &error));
                    continue;
                }
            };
            let users: Vec<String> = config.auth_infos.iter().map(|u| u.name.clone()).collect();
            merged = match merged.clone().merge(config) {
                Ok(next) => {
                    for user in users {
                        origins.entry(user).or_insert_with(|| file.clone());
                    }
                    next
                }
                Err(error) => {
                    failures.push(FileFailure::new(file, &error));
                    continue;
                }
            };
        }
        let contexts = merged
            .contexts
            .iter()
            .filter(|named| !self.test_only || is_test_context(&named.name))
            .map(|named| Context::new(named, &merged, &origins))
            .collect();
        Catalog { contexts, failures }
    }
}

fn absolute(file: PathBuf) -> PathBuf {
    std::path::absolute(&file).unwrap_or(file)
}

fn is_test_context(name: &str) -> bool {
    name.starts_with("kind-") || name.starts_with("kwok-")
}

/// The contexts of the merged kubeconfig, in its order.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Catalog {
    pub contexts: Vec<Context>,
    /// Files that exist but could not be read or merged; their contexts are
    /// missing.
    pub failures: Vec<FileFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Context {
    pub name: String,
    pub color: Option<ContextColor>,
    /// Where the context goes among the others, lowest first.
    pub order: Option<i64>,
    pub fingerprint: Fingerprint,
    /// Why no connection can be made, when the kubeconfig already says.
    pub problem: Option<Problem>,
    pub entries: Entries,
}

impl Context {
    fn new(named: &NamedContext, merged: &Kubeconfig, origins: &HashMap<String, PathBuf>) -> Self {
        let entry = named.context.as_ref();
        let cluster_name = entry.map(|context| context.cluster.as_str());
        let user_name = entry.and_then(|context| context.user.as_deref());
        let cluster = cluster_name.and_then(|name| merged.clusters.iter().find(|c| c.name == name));
        let user = user_name.and_then(|name| merged.auth_infos.iter().find(|u| u.name == name));
        let problem = match (cluster_name, cluster, user_name, user) {
            (None, ..) => Some(Problem::NoContext),
            (Some(name), None, ..) => Some(Problem::MissingCluster(name.to_owned())),
            (_, _, Some(name), None) => Some(Problem::MissingUser(name.to_owned())),
            _ => None,
        };
        let extension = Extension::of(named);
        Self {
            name: named.name.clone(),
            color: extension.color,
            order: extension.order,
            fingerprint: Fingerprint::of(named, cluster, user),
            problem,
            entries: Entries::new(
                named,
                cluster,
                user,
                user_name.and_then(|name| origins.get(name)).cloned(),
            ),
        }
    }
}

/// A context's context, cluster and user entries, as a kubeconfig of their
/// own whose current context it is: what its clients are built from.
#[derive(Debug, Clone)]
pub struct Entries {
    config: Arc<Kubeconfig>,
    /// The file the user entry comes from.
    user_file: Option<PathBuf>,
}

impl Entries {
    fn new(
        named: &NamedContext,
        cluster: Option<&NamedCluster>,
        user: Option<&NamedAuthInfo>,
        user_file: Option<PathBuf>,
    ) -> Self {
        Self {
            config: Arc::new(Kubeconfig {
                current_context: Some(named.name.clone()),
                contexts: vec![named.clone()],
                clusters: cluster.into_iter().cloned().collect(),
                auth_infos: user.into_iter().cloned().collect(),
                ..Kubeconfig::default()
            }),
            user_file,
        }
    }

    pub fn kubeconfig(&self) -> Kubeconfig {
        Kubeconfig::clone(&self.config)
    }

    pub fn proxy_url(&self) -> Option<&str> {
        let cluster = self.config.clusters.first()?.cluster.as_ref()?;
        cluster.proxy_url.as_deref()
    }

    /// The user entry's `auth-provider: oidc`, with its file of origin.
    pub fn oidc(&self) -> Option<Result<OidcUser, OidcError>> {
        let user = self.config.auth_infos.first()?;
        let info = user.auth_info.as_ref()?;
        let provider = info.auth_provider.as_ref()?;
        // A token or basic auth in the entry wins, as in client-go.
        if provider.name != "oidc" || token_or_basic(info) {
            return None;
        }
        Some(OidcEntry::of(&provider.config).map(|entry| OidcUser {
            origin: self.user_file.clone(),
            user: user.name.clone(),
            entry,
        }))
    }

    /// The user entry's exec plugin, if it names one that the entry's other
    /// credentials do not override.
    pub fn exec(&self) -> Result<Option<Exec>, ExecError> {
        let Some(user) = self.config.auth_infos.first() else {
            return Ok(None);
        };
        let Some(auth) = &user.auth_info else {
            return Ok(None);
        };
        let cluster = self
            .config
            .clusters
            .first()
            .and_then(|named| named.cluster.clone())
            .unwrap_or_default();
        Exec::of(&user.name, auth, &cluster)
    }
}

/// A user entry's `auth-provider: oidc`.
pub struct OidcUser {
    /// The file the entry comes from, where refreshed tokens go.
    pub origin: Option<PathBuf>,
    pub user: String,
    pub entry: OidcEntry,
}

/// kube's kubeconfig types compare only in kube's own tests.
impl PartialEq for Entries {
    fn eq(&self, other: &Self) -> bool {
        self.user_file == other.user_file
            && (Arc::ptr_eq(&self.config, &other.config)
                || serde_json::to_value(&*self.config).ok()
                    == serde_json::to_value(&*other.config).ok())
    }
}

impl Eq for Entries {}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Problem {
    #[error("the context entry is empty")]
    NoContext,
    #[error("no kubeconfig defines the cluster {0:?}")]
    MissingCluster(String),
    #[error("no kubeconfig defines the user {0:?}")]
    MissingUser(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFailure {
    pub file: PathBuf,
    pub message: String,
}

impl FileFailure {
    fn new(file: &Path, error: &KubeconfigError) -> Self {
        Self {
            file: file.to_owned(),
            message: error.to_string(),
        }
    }
}

/// The `twigo` extension of a context. Each field is read on its own, so a
/// value Twigo does not know drops only that field.
#[derive(Default)]
struct Extension {
    color: Option<ContextColor>,
    order: Option<i64>,
}

impl Extension {
    fn of(named: &NamedContext) -> Self {
        let Some(value) = named
            .context
            .as_ref()
            .and_then(|context| context.extensions.as_ref())
            .and_then(|extensions| extensions.iter().find(|e| e.name == EXTENSION))
            .map(|extension| &extension.extension)
        else {
            return Self::default();
        };
        Self {
            color: field(value, "color"),
            order: field(value, "order"),
        }
    }
}

fn field<T: for<'de> Deserialize<'de>>(value: &serde_json::Value, name: &str) -> Option<T> {
    T::deserialize(value.get(name)?).ok()
}
