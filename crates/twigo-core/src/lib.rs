//! App services: the catalog, spaces, the state store and each context's
//! clients, which the Tauri app turns into commands.

pub mod catalog;
pub mod connections;
mod errors;
pub mod state;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use tokio::sync::watch;
use twigo_env::Status;
use twigo_ipc::{ClusterVersion, IpcError};
use twigo_kube::client::{Clients, ProxyEnv};
use twigo_netmon::Event;

use catalog::Catalog;
use connections::Connections;
use state::State;

pub struct Core {
    pub state: State,
    pub catalog: Catalog,
    pub connections: Connections,
    /// None until the login shell's environment is known.
    proxy_env: watch::Sender<Option<ProxyEnv>>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientsError {
    #[error("no source lists the context {0:?}")]
    NoContext(String),
    #[error("the context {0:?}: {1}")]
    Connect(String, #[source] Box<connections::Error>),
}

impl Core {
    pub fn new(state_file: PathBuf) -> Self {
        Self {
            state: State::open(state_file),
            catalog: Catalog::default(),
            connections: Connections::default(),
            proxy_env: watch::Sender::new(None),
        }
    }

    /// The context's clients, once the catalog and the login shell's
    /// environment are known.
    pub async fn clients(&self, context: &str) -> Result<Arc<Clients>, ClientsError> {
        let contexts = self.catalog.contexts().await;
        let Some(found) = contexts.find(context) else {
            return Err(ClientsError::NoContext(context.to_owned()));
        };
        let env = self
            .proxy_env
            .subscribe()
            .wait_for(Option::is_some)
            .await
            .expect("the core outlives its subscribers")
            .clone()
            .expect("waited for");
        self.connections
            .clients(found, &env)
            .await
            .map_err(|error| ClientsError::Connect(context.to_owned(), Box::new(error)))
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
