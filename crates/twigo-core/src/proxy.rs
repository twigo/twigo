//! The policy proxy (ARCHITECTURE 6.4): a loopback endpoint that child
//! processes reach a cluster through, with a kubeconfig of their own and a
//! bearer token per process and context. Every request goes through its
//! actor's clients, so the gate, the stream counter and the credential stay
//! one path; in `guarded` a write or an exec waits for the approval broker.

mod forward;
mod handle;
mod headers;
mod kubeconfig;
mod refusal;
mod server;
mod splice;
mod tls;
mod tokens;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{OnceCell, watch};
use tokio_util::sync::CancellationToken;
use twigo_ipc::{ErrorKind, IpcError};
use twigo_kube::client::{Actor, ActorClients, Clients};
use twigo_policy::Policy;

use crate::approvals::Approvals;
use crate::catalog::Contexts;
use crate::{ClientsError, Core};
pub(crate) use tokens::{Digest, Holder};

/// The proxy's endpoint, its tokens and the actors' clients it sends with.
pub(crate) struct Proxy {
    /// `proxy/` in the app's data directory, where each process's
    /// kubeconfig lives while the process does.
    dir: PathBuf,
    /// Bound for the first process the core gives a token to, then kept.
    endpoint: OnceCell<server::Endpoint>,
    /// What each token maps to, by its digest: the token itself is never
    /// kept.
    tokens: Mutex<HashMap<Digest, Arc<Holder>>>,
    processes: AtomicU64,
    /// Each actor's clients of each context.
    actors: Mutex<HashMap<(String, Actor), Built>>,
}

/// An actor's clients, with the context's clients they were built over.
struct Built {
    over: Arc<Clients>,
    actor: Arc<ActorClients>,
}

impl Proxy {
    /// Deletes what a previous run left in `dir`: the kubeconfigs of
    /// processes that ended with it, whose tokens no longer mean anything.
    pub(crate) fn new(dir: PathBuf) -> Self {
        match std::fs::remove_dir_all(&dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                eprintln!("could not delete {}: {error}", dir.display());
            }
            _ => {}
        }
        Self {
            dir,
            endpoint: OnceCell::new(),
            tokens: Mutex::default(),
            processes: AtomicU64::new(0),
            actors: Mutex::default(),
        }
    }

    fn holder(&self, digest: &Digest) -> Option<Arc<Holder>> {
        self.tokens
            .lock()
            .expect("tokens lock")
            .get(digest)
            .cloned()
    }

    fn revoke(&self, process: u64) {
        self.tokens
            .lock()
            .expect("tokens lock")
            .retain(|_, holder| holder.process != process);
    }

    /// The context's clients, as the core builds them now, and the token's
    /// actor's over them; refused once they reach another cluster than the
    /// token was given for.
    async fn clients(
        &self,
        core: &Core,
        holder: &Holder,
    ) -> Result<(Arc<Clients>, Arc<ActorClients>), refusal::Refusal> {
        let clients = core
            .clients(&holder.context)
            .await
            .map_err(|error| refusal::Refusal::unreachable(&error))?;
        if clients.connection() != Some(holder.connection) {
            return Err(refusal::Refusal::moved(&holder.context));
        }
        let key = (holder.context.clone(), holder.actor);
        let mut actors = self.actors.lock().expect("actors lock");
        if let Some(built) = actors.get(&key)
            && Arc::ptr_eq(&built.over, &clients)
        {
            return Ok((clients, Arc::clone(&built.actor)));
        }
        let actor = Arc::new(
            clients
                .actor(holder.actor)
                .map_err(|error| refusal::Refusal::unreachable(&error))?,
        );
        let built = Built {
            over: Arc::clone(&clients),
            actor: Arc::clone(&actor),
        };
        actors.insert(key, built);
        Ok((clients, actor))
    }
}

/// A process's way to the clusters through the proxy: its kubeconfig and
/// its tokens, one per context. Dropping it revokes them, deletes the file,
/// ends its streams and sessions, withdraws its asks and ends its grants.
pub struct ProxyProcess {
    id: u64,
    kubeconfig: PathBuf,
    ended: CancellationToken,
    proxy: Arc<Proxy>,
    approvals: Arc<Approvals>,
}

impl ProxyProcess {
    pub fn kubeconfig(&self) -> &Path {
        &self.kubeconfig
    }
}

impl Drop for ProxyProcess {
    fn drop(&mut self) {
        self.proxy.revoke(self.id);
        self.ended.cancel();
        self.approvals.end_process(self.id);
        if let Err(error) = std::fs::remove_file(&self.kubeconfig)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("could not delete {}: {error}", self.kubeconfig.display());
        }
    }
}

impl Core {
    /// A process's kubeconfig through the proxy (ARCHITECTURE 6.4): one
    /// context per context the catalog lists now, `context` the current one,
    /// each with a token that maps to `actor`, the process's `label`, and the
    /// `window` its asks go to; with none, every ask is denied. Async, as the
    /// endpoint it binds the first time serves on the runtime. Only a
    /// terminal, `helm` or an agent gets one: the gate lets the UI's writes
    /// through `guarded` unasked, Twigo's MCP tools read Secrets on the
    /// premise that they return only keys and sizes, and an extension
    /// reaches clusters through `host-kube`.
    pub async fn proxy_process(
        &self,
        actor: Actor,
        label: &str,
        window: Option<&str>,
        context: &str,
    ) -> Result<ProxyProcess, IpcError> {
        if !matches!(actor, Actor::Terminal | Actor::Helm | Actor::Agent) {
            return Err(IpcError::new(
                ErrorKind::InvalidInput,
                format!(
                    "only a terminal, helm or an agent reaches a cluster through the policy proxy, never the actor {}",
                    actor.name()
                ),
            ));
        }
        let contexts = self.catalog.contexts().await;
        if contexts.find(context).is_none() {
            return Err(IpcError::from(&ClientsError::NoContext(context.to_owned())));
        }
        let endpoint = self
            .proxy
            .endpoint
            .get_or_try_init(|| server::bind(self.this.clone()))
            .await
            .map_err(|error| {
                IpcError::new(
                    ErrorKind::Internal,
                    format!("the policy proxy could not listen on 127.0.0.1: {error}"),
                )
            })?;
        let id = self.proxy.processes.fetch_add(1, Ordering::Relaxed);
        let ended = CancellationToken::new();
        let (label, window): (Arc<str>, Option<Arc<str>>) = (label.into(), window.map(Into::into));
        let mut entries = Vec::new();
        let mut issued = Vec::new();
        for listed in contexts.iter() {
            // A name listed twice counts by its first, as `find` takes it.
            if entries
                .iter()
                .any(|entry: &kubeconfig::Entry| entry.name == listed.name)
            {
                continue;
            }
            let connection = listed.fingerprint.value();
            let token = tokens::Token::new();
            let holder = Holder {
                process: id,
                label: Arc::clone(&label),
                window: window.clone(),
                actor,
                context: listed.name.clone(),
                connection,
                prefix: tokens::prefix(&listed.name, connection),
                digest: token.digest(),
                ended: ended.clone(),
            };
            entries.push(kubeconfig::Entry {
                name: listed.name.clone(),
                server: format!("https://{}/{}", endpoint.address, holder.prefix),
                namespace: kubeconfig::namespace(listed),
                token,
            });
            issued.push(holder);
        }
        let path = self.proxy.dir.join(format!("process-{id}.kubeconfig"));
        let written = kubeconfig::write(&self.proxy.dir, &path, &entries, context, &endpoint.ca);
        written.map_err(|error| {
            IpcError::new(
                ErrorKind::Internal,
                format!("could not write {}: {error}", path.display()),
            )
        })?;
        let mut tokens = self.proxy.tokens.lock().expect("tokens lock");
        for holder in issued {
            tokens.insert(holder.digest, Arc::new(holder));
        }
        drop(tokens);
        Ok(ProxyProcess {
            id,
            kubeconfig: path,
            ended,
            proxy: Arc::clone(&self.proxy),
            approvals: Arc::clone(&self.approvals),
        })
    }
}

/// Ticks when what decides a proxied request may have changed: a context's
/// mode or where it comes from, or what the catalog says of a context, its
/// connection included, which no tick of the policy follows.
pub(crate) struct Changes {
    policy: watch::Receiver<u64>,
    catalog: watch::Receiver<Option<Arc<Contexts>>>,
}

impl Changes {
    /// From now on: what changed before is no tick.
    pub(crate) fn new(policy: &Policy, catalog: &watch::Receiver<Option<Arc<Contexts>>>) -> Self {
        let mut catalog = catalog.clone();
        catalog.borrow_and_update();
        Self {
            policy: policy.changes(),
            catalog,
        }
    }

    pub(crate) async fn next(&mut self) {
        tokio::select! {
            Ok(()) = self.policy.changed() => {}
            Ok(()) = self.catalog.changed() => {}
            // Both senders live as long as the core.
            else => std::future::pending().await,
        }
    }
}
