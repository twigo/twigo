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

use tokio::sync::{Semaphore, watch};
use twigo_ipc::MetricsState;

use crate::hub::Hub;
use board::Board;

pub use api::{Api, GROUP, Kind};
pub use board::{Change, Reader, Reset, Scope, Update};
pub use sample::{Container, Sample, Samples};

/// What metrics-server's manifest and chart scrape at; its answers change once per scrape.
pub const INTERVAL: Duration = Duration::from_secs(15);

/// How long a list sorted by a metric holds its first rows for its scopes' first answers.
pub const FIRST_ANSWER: Duration = Duration::from_secs(2);

/// The requests of a context under way at once, of the UI's 28 (ARCHITECTURE 3.2), so a list
/// over many namespaces leaves the rest of them to the views and editors that wait on them.
pub const IN_FLIGHT: usize = 4;

/// A reader that opens once its context is known.
pub type Opening = futures::future::BoxFuture<'static, Reader>;

#[derive(Clone)]
pub struct Poller(Arc<Inner>);

struct Inner {
    hub: Hub,
    contexts: Mutex<HashMap<String, Weak<Context>>>,
}

/// The scopes polled for one context, alive while a reader holds it. What the context serves
/// comes from its follower, which outlives every reader ([`crate::discovery::Followers`]).
pub struct Context {
    api: watch::Receiver<Api>,
    pods: Arc<Board>,
    nodes: Arc<Board>,
}

impl Poller {
    pub fn new(hub: Hub) -> Self {
        Self(Arc::new(Inner {
            hub,
            contexts: Mutex::default(),
        }))
    }

    pub fn context(&self, name: &str, api: watch::Receiver<Api>) -> Arc<Context> {
        let mut contexts = self.0.contexts.lock().expect("poller lock");
        if let Some(held) = contexts
            .get(name)
            .and_then(Weak::upgrade)
            .filter(|held| held.api.same_channel(&api))
        {
            return held;
        }
        let turns = Arc::new(Semaphore::new(IN_FLIGHT));
        let board = |kind| {
            Arc::new(Board::new(
                name,
                kind,
                self.0.hub.clone(),
                api.clone(),
                Arc::clone(&turns),
            ))
        };
        let built = Arc::new(Context {
            pods: board(Kind::Pods),
            nodes: board(Kind::Nodes),
            api,
        });
        contexts.insert(name.to_owned(), Arc::downgrade(&built));
        built
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

/// Forbidden outranks unavailable, which outranks ready.
pub(crate) fn worse(a: MetricsState, b: MetricsState) -> MetricsState {
    use MetricsState::{Absent, Forbidden, Ready, Unavailable};
    match (a, b) {
        (Forbidden, _) | (_, Forbidden) => Forbidden,
        (Unavailable, _) | (_, Unavailable) => Unavailable,
        (Ready, _) | (_, Ready) => Ready,
        (Absent, Absent) => Absent,
    }
}
