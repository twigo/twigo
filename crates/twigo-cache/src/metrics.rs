//! Metrics (ARCHITECTURE 3.6): what `metrics.k8s.io` says pods and nodes use.
//! The API cannot be watched and sends no `resourceVersion`, so a poller of
//! its own, beside the hub, lists a scope, a namespace or the cluster, while
//! a [`Reader`] wants it, and tells each reader only the keys whose values
//! changed. A scope that fails is a state of its readers and holds no value.

mod api;
mod board;
mod fetch;
mod sample;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;
use twigo_ipc::{Discovered, MetricsState};
use twigo_kube::discovery::Cache;
use twigo_kube::kubeconfig::Fingerprint;

use crate::discovery::Follower;
use crate::hub::Hub;
use board::Board;

pub use api::{Api, GROUP, Kind};
pub use board::{Change, Reader, Reset, Scope, Update};
pub use sample::{Container, Sample, Samples};

/// What metrics-server's manifest and chart scrape at; its answers change once per scrape.
pub const INTERVAL: Duration = Duration::from_secs(15);

/// More namespaces than this, read by a list of all of them, are asked for as the cluster.
pub const CLUSTER_WIDE_ABOVE: usize = 10;

/// A reader that opens once its context is known.
pub type Opening = futures::future::BoxFuture<'static, Reader>;

#[derive(Clone)]
pub struct Poller(Arc<Inner>);

struct Inner {
    hub: Hub,
    cache: Arc<Cache>,
    contexts: Mutex<HashMap<String, Weak<Context>>>,
}

/// One context's Metrics API and the scopes polled for it, alive while a reader holds it.
pub struct Context {
    api: watch::Receiver<Api>,
    pods: Arc<Board>,
    nodes: Arc<Board>,
    follower: JoinHandle<()>,
}

impl Poller {
    pub fn new(hub: Hub, cache: Arc<Cache>) -> Self {
        Self(Arc::new(Inner {
            hub,
            cache,
            contexts: Mutex::default(),
        }))
    }

    /// The context's Metrics API, followed as long as a handle lives and shared by every list
    /// and object of the context, since the webview's own follower may not have run yet.
    pub async fn context(
        &self,
        name: &str,
        entry: watch::Receiver<Option<Fingerprint>>,
    ) -> Arc<Context> {
        if let Some(held) = self.held(name) {
            return held;
        }
        let built = Arc::new(self.build(name, entry).await);
        let mut contexts = self.0.contexts.lock().expect("poller lock");
        match contexts.get(name).and_then(Weak::upgrade) {
            Some(held) => held,
            None => {
                contexts.insert(name.to_owned(), Arc::downgrade(&built));
                built
            }
        }
    }

    fn held(&self, name: &str) -> Option<Arc<Context>> {
        self.0
            .contexts
            .lock()
            .expect("poller lock")
            .get(name)
            .and_then(Weak::upgrade)
    }

    async fn build(&self, name: &str, entry: watch::Receiver<Option<Fingerprint>>) -> Context {
        let mut follower = Follower::new(
            self.0.hub.clone(),
            Arc::clone(&self.0.cache),
            name.to_owned(),
            entry,
        )
        .await;
        let (sender, api) = watch::channel(Api::Absent);
        let follower = tokio::spawn(async move {
            loop {
                let found = match follower.next().await {
                    Discovered::Ready { .. } => follower.confirmed().map_or(Api::Absent, Api::of),
                    Discovered::Pending { .. } | Discovered::Failed { .. } => Api::Absent,
                };
                sender.send_if_modified(|api| std::mem::replace(api, found) != found);
            }
        });
        let board = |kind| Arc::new(Board::new(name, kind, self.0.hub.clone(), api.clone()));
        Context {
            pods: board(Kind::Pods),
            nodes: board(Kind::Nodes),
            api,
            follower,
        }
    }
}

impl Context {
    pub fn api(&self) -> Api {
        *self.api.borrow()
    }

    pub fn reader(self: &Arc<Self>, kind: Kind) -> Reader {
        Reader::new(Arc::clone(self), kind)
    }

    pub(crate) fn board(&self, kind: Kind) -> &Arc<Board> {
        match kind {
            Kind::Pods => &self.pods,
            Kind::Nodes => &self.nodes,
        }
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        self.follower.abort();
    }
}

/// Forbidden outranks unavailable, which outranks ready.
pub(crate) fn worse(a: MetricsState, b: MetricsState) -> MetricsState {
    use MetricsState::{Forbidden, Ready, Unavailable};
    match (a, b) {
        (Forbidden, _) | (_, Forbidden) => Forbidden,
        (Unavailable, _) | (_, Unavailable) => Unavailable,
        (Ready, Ready) => Ready,
    }
}
