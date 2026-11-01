//! App services: the catalog, spaces, the state store and each context's
//! clients, which the Tauri app turns into commands.

mod auth;
pub mod catalog;
pub mod connections;
mod errors;
pub mod state;
pub mod trust;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use tokio::sync::watch;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{ClusterVersion, IpcError};
use twigo_kube::client::{Clients, ProxyEnv};
use twigo_kube::credentials::{ExecError, Registry, Source, Timeouts};
use twigo_kube::kubeconfig;
use twigo_netmon::Event;

pub use auth::AuthFollower;
use catalog::Catalog;
use connections::Connections;
use state::State;
use trust::Trust;

pub struct Core {
    pub state: State,
    pub catalog: Catalog,
    pub connections: Connections,
    pub trust: Trust,
    credentials: Registry,
    /// Whether a Twigo window has the focus, which a plugin that may ask
    /// the person to sign in waits for.
    focused: watch::Sender<bool>,
    /// Both None until the login shell's environment is known.
    proxy_env: watch::Sender<Option<ProxyEnv>>,
    shell_env: watch::Sender<Option<Arc<ShellEnv>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientsError {
    #[error("no source lists the context {0:?}")]
    NoContext(String),
    #[error("the context {0:?}: {1}")]
    Invalid(String, #[source] ExecError),
    #[error("Twigo runs {1} for the context {0:?} only once you trust it")]
    Untrusted(String, String),
    #[error("the context {0:?} has no credential plugin")]
    NoPlugin(String),
    #[error("the context {0:?}: {1}")]
    Connect(String, #[source] Box<connections::Error>),
}

impl Core {
    /// The core whose state and trusted plugins live in `data`, the app's
    /// data directory.
    pub fn new(data: &Path) -> Self {
        let shell_env = watch::Sender::new(None);
        let focused = watch::Sender::new(false);
        Self {
            state: State::open(data.join("state.json")),
            catalog: Catalog::default(),
            connections: Connections::default(),
            trust: Trust::open(data.join("trust.json")),
            credentials: Registry::new(
                shell_env.subscribe(),
                focused.subscribe(),
                Timeouts::default(),
            ),
            focused,
            proxy_env: watch::Sender::new(None),
            shell_env,
        }
    }

    pub fn set_focused(&self, focused: bool) {
        self.focused.send_replace(focused);
    }

    /// The context's clients, once the catalog and the login shell's
    /// environment are known.
    pub async fn clients(&self, context: &str) -> Result<Arc<Clients>, ClientsError> {
        let contexts = self.catalog.contexts().await;
        let Some(found) = contexts.find(context) else {
            return Err(ClientsError::NoContext(context.to_owned()));
        };
        let plugin = self.plugin(found)?;
        let env = self
            .proxy_env
            .subscribe()
            .wait_for(Option::is_some)
            .await
            .expect("the core outlives its subscribers")
            .clone()
            .expect("waited for");
        self.connections
            .clients(found, &env, plugin)
            .await
            .map_err(|error| ClientsError::Connect(context.to_owned(), Box::new(error)))
    }

    /// The context's exec plugin, once the person trusts it.
    fn plugin(&self, context: &kubeconfig::Context) -> Result<Option<Arc<Source>>, ClientsError> {
        let exec = context
            .entries
            .exec()
            .map_err(|error| ClientsError::Invalid(context.name.clone(), error))?;
        let Some(exec) = exec else {
            return Ok(None);
        };
        if !self.trust.current().trusts(&exec.trust_digest()) {
            return Err(ClientsError::Untrusted(
                context.name.clone(),
                exec.command().to_owned(),
            ));
        }
        Ok(Some(self.credentials.source(exec)))
    }

    async fn trusted_plugin(&self, context: &str) -> Result<Arc<Source>, ClientsError> {
        let contexts = self.catalog.contexts().await;
        let found = contexts
            .find(context)
            .ok_or_else(|| ClientsError::NoContext(context.to_owned()))?;
        self.plugin(found)?
            .ok_or_else(|| ClientsError::NoPlugin(context.to_owned()))
    }

    /// Runs the context's plugin now: how the person signs in.
    pub async fn sign_in(&self, context: &str) -> Result<(), IpcError> {
        let plugin = self
            .trusted_plugin(context)
            .await
            .map_err(|e| IpcError::from(&e))?;
        plugin.sign_in();
        Ok(())
    }

    /// Ends the run of the context's plugin.
    pub async fn cancel_sign_in(&self, context: &str) -> Result<(), IpcError> {
        let plugin = self
            .trusted_plugin(context)
            .await
            .map_err(|e| IpcError::from(&e))?;
        plugin.cancel();
        Ok(())
    }

    pub async fn cluster_version(&self, context: &str) -> Result<ClusterVersion, IpcError> {
        let clients = self
            .clients(context)
            .await
            .map_err(|e| IpcError::from(&e))?;
        let info = clients
            .api
            .apiserver_version()
            .await
            .map_err(|e| errors::request(&e))?;
        Ok(ClusterVersion {
            git_version: info.git_version,
        })
    }

    /// Retires every connection on wake, and those whose route moved on a
    /// network change (ARCHITECTURE 3.2); never returns.
    pub async fn follow_network(&self, mut watch: twigo_netmon::Watch) {
        while let Some(event) = watch.next().await {
            match event {
                Event::Woke => self.connections.retire(),
                Event::NetworkChanged => self.connections.retire_moved(),
            }
        }
    }

    /// Follows the catalog's sources and the login shell's proxy variables,
    /// and tells the state store and the connections which contexts the
    /// sources list; never returns. In the explicit mode (ARCHITECTURE 5.5)
    /// `explicit` is the only source; otherwise the sources come from the
    /// login shell's environment, as `status` follows it, read again
    /// whenever it is resolved.
    pub async fn run(&self, mut status: watch::Receiver<Status>, explicit: Option<PathBuf>) {
        let sources = async {
            if let Some(file) = &explicit {
                self.catalog
                    .follow(catalog::sources(Some(file.clone()), None, None));
            }
            loop {
                let env = match &*status.borrow_and_update() {
                    Status::Resolving => None,
                    Status::Resolved(env) | Status::Failed { env, .. } => Some(env.clone()),
                };
                if let Some(env) = env {
                    let var = |name: &str| env.get(name)?.to_str().map(str::to_owned);
                    self.proxy_env.send_replace(Some(ProxyEnv::from_vars(var)));
                    self.shell_env.send_replace(Some(Arc::clone(&env)));
                    if explicit.is_none() {
                        let home = env.get("HOME").map(Path::new);
                        self.catalog
                            .follow(catalog::sources(None, env.get("KUBECONFIG"), home));
                    }
                }
                if status.changed().await.is_err() {
                    return;
                }
            }
        };
        let seen = async {
            let mut contexts = self.catalog.subscribe();
            loop {
                let listed = contexts.borrow_and_update().clone();
                if let Some(listed) = listed {
                    let names: HashSet<String> = listed.iter().map(|c| c.name.clone()).collect();
                    self.state.saw(&names, Timestamp::now());
                    self.connections.keep(&names);
                }
                if contexts.changed().await.is_err() {
                    return;
                }
            }
        };
        tokio::join!(sources, seen);
    }
}

#[cfg(test)]
mod tests;
