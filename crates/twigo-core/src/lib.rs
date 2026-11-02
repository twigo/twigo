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
use std::sync::{Arc, Weak};

use jiff::Timestamp;
use tokio::sync::watch;
use twigo_cache::hub::{Connect, Hub, Query, Resource, RowFormat};
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{ClusterVersion, ErrorKind, IpcError, ViewState};
use twigo_kube::client::{Clients, ProxyEnv};
use twigo_kube::credentials::{ExecError, OidcError, Provider, Registry, Source, Timeouts};
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
    pub hub: Hub,
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
    #[error("the context {0:?}: {1}")]
    Oidc(String, #[source] OidcError),
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
    pub fn new(data: &Path) -> Arc<Self> {
        let shell_env = watch::Sender::new(None);
        let focused = watch::Sender::new(false);
        Arc::new_cyclic(|core| Self {
            hub: Hub::new(connect(core.clone())),
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
        })
    }

    pub fn set_focused(&self, focused: bool) {
        self.focused.send_replace(focused);
    }

    /// Kills the plugins under way, as the app quits.
    pub fn shutdown(&self) {
        self.credentials.shutdown();
    }

    /// The context's clients, once the catalog and the login shell's
    /// environment are known.
    pub async fn clients(&self, context: &str) -> Result<Arc<Clients>, ClientsError> {
        let contexts = self.catalog.contexts().await;
        let Some(found) = contexts.find(context) else {
            return Err(ClientsError::NoContext(context.to_owned()));
        };
        let provider = self.provider(found)?;
        let env = self
            .proxy_env
            .subscribe()
            .wait_for(Option::is_some)
            .await
            .expect("the core outlives its subscribers")
            .clone()
            .expect("waited for");
        self.connections
            .clients(found, &env, provider)
            .await
            .map_err(|error| ClientsError::Connect(context.to_owned(), Box::new(error)))
    }

    /// Where the context's credential comes from when Twigo gets it: its
    /// exec plugin, once the person trusts it, or its oidc provider.
    fn provider(&self, context: &kubeconfig::Context) -> Result<Option<Provider>, ClientsError> {
        if let Some(oidc) = context.entries.oidc() {
            let oidc = oidc.map_err(|error| ClientsError::Oidc(context.name.clone(), error))?;
            return Ok(Some(Provider::Oidc(self.credentials.oidc(
                oidc.origin,
                &oidc.user,
                oidc.entry,
            ))));
        }
        Ok(self.plugin(context)?.map(Provider::Exec))
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
            .map_err(|e| twigo_kube::errors::request(&e))?;
        Ok(ClusterVersion {
            git_version: info.git_version,
        })
    }

    /// The namespaces of a space's context, from its namespace index
    /// (ARCHITECTURE 3.3), which lingers a while after each answer.
    pub async fn namespaces(&self, space: &str) -> Result<Vec<String>, IpcError> {
        let context = self
            .state
            .spaces()
            .into_iter()
            .find(|candidate| candidate.id == space)
            .and_then(|space| space.contexts.into_iter().next())
            .ok_or_else(|| IpcError {
                kind: ErrorKind::NotFound,
                message: format!("no space {space:?}"),
            })?;
        let mut index = self
            .hub
            .rows(Query {
                context,
                resource: Resource {
                    group: String::new(),
                    version: "v1".to_owned(),
                    resource: "namespaces".to_owned(),
                    namespaced: false,
                },
                format: RowFormat::Metadata,
                namespaces: Vec::new(),
                field_selector: None,
            })
            .await;
        match index.whole().await {
            Ok(rows) => {
                let mut names: Vec<String> =
                    rows.iter().map(|row| row.meta.name.to_string()).collect();
                names.sort();
                Ok(names)
            }
            Err(ViewState::Forbidden { verb, resource }) => Err(IpcError {
                kind: ErrorKind::Forbidden,
                message: format!("you may not {verb} {resource}"),
            }),
            Err(ViewState::Unauthorized) => Err(IpcError {
                kind: ErrorKind::Unauthorized,
                message: "no credentials for this context that the cluster accepts".to_owned(),
            }),
            Err(ViewState::Error { error }) => Err(error),
            Err(_) => Err(IpcError {
                kind: ErrorKind::Unavailable,
                message: "the cluster is unavailable".to_owned(),
            }),
        }
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
                    let proxy = ProxyEnv::from_vars(var);
                    // Published first, so a watch the retire re-opens builds
                    // with the new variables.
                    self.proxy_env.send_replace(Some(proxy.clone()));
                    self.connections.follow_env(&proxy);
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
                    self.connections.keep(listed.iter());
                }
                if contexts.changed().await.is_err() {
                    return;
                }
            }
        };
        tokio::join!(sources, seen);
    }
}

/// How the hub gets a context's clients: through the core, while it lives.
fn connect(core: Weak<Core>) -> Connect {
    Arc::new(move |context| {
        let core = core.clone();
        Box::pin(async move {
            let Some(core) = core.upgrade() else {
                return Err(IpcError {
                    kind: ErrorKind::Unavailable,
                    message: "Twigo is quitting".to_owned(),
                });
            };
            core.clients(&context)
                .await
                .map_err(|error| IpcError::from(&error))
        })
    })
}

/// A link the sign-in panel may open: https, or a plugin's own server on
/// localhost or 127.0.0.1, without a user part, which would name another
/// host.
pub fn sign_in_url(url: &str) -> Result<String, IpcError> {
    let refused = || IpcError {
        kind: twigo_ipc::ErrorKind::InvalidInput,
        message: format!("Twigo opens only sign-in links: {url}"),
    };
    let parsed: http::Uri = url.parse().map_err(|_| refused())?;
    let authority = parsed.authority().ok_or_else(refused)?;
    if authority.as_str().contains('@') {
        return Err(refused());
    }
    let local = matches!(authority.host(), "localhost" | "127.0.0.1");
    match parsed.scheme_str() {
        Some("https") => Ok(url.to_owned()),
        Some("http") if local => Ok(url.to_owned()),
        _ => Err(refused()),
    }
}

#[cfg(test)]
mod tests;
