//! A context's discovery, followed once for the whole app (ARCHITECTURE 3.6):
//! what `resources_watch` sends the webview and what pod and node lists read
//! of the Metrics API come from one follower, so the fact is there when a list
//! opens and outlives every list.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::{OnceCell, watch};
use tokio::task::JoinHandle;
use twigo_ipc::Discovered;
use twigo_kube::discovery::Cache;
use twigo_kube::kubeconfig::Fingerprint;

use super::{Follower, Retry};
use crate::hub::Hub;
use crate::metrics::Api;

/// The follower of each context, started when it is first asked for and kept
/// while the sources list the context.
pub struct Followers {
    hub: Hub,
    cache: Arc<Cache>,
    followed: Mutex<HashMap<String, Arc<OnceCell<Arc<Followed>>>>>,
}

impl Followers {
    pub fn new(hub: Hub, cache: Arc<Cache>) -> Self {
        Self {
            hub,
            cache,
            followed: Mutex::default(),
        }
    }

    /// The context's follower; `entry` is awaited only to start it.
    pub async fn get(
        &self,
        context: &str,
        entry: impl Future<Output = watch::Receiver<Option<Fingerprint>>>,
    ) -> Arc<Followed> {
        let cell = Arc::clone(
            self.followed
                .lock()
                .expect("followers lock")
                .entry(context.to_owned())
                .or_default(),
        );
        let followed = cell
            .get_or_init(|| async {
                let follower = Follower::new(
                    self.hub.clone(),
                    Arc::clone(&self.cache),
                    context.to_owned(),
                    entry.await,
                )
                .await;
                Arc::new(Followed::start(follower))
            })
            .await;
        Arc::clone(followed)
    }

    pub fn keep(&self, listed: &HashSet<String>) {
        self.followed
            .lock()
            .expect("followers lock")
            .retain(|context, _| listed.contains(context));
    }
}

pub struct Followed {
    resources: watch::Receiver<Option<Discovered>>,
    api: watch::Receiver<Api>,
    retry: Retry,
    task: JoinHandle<()>,
}

impl Followed {
    fn start(mut follower: Follower) -> Self {
        let retry = follower.retry();
        let (found, resources) = watch::channel(None);
        let (served, api) = watch::channel(Api::Absent);
        let task = tokio::spawn(async move {
            loop {
                let discovered = follower.next().await;
                let api = match &discovered {
                    Discovered::Ready { .. } => follower.confirmed().map_or(Api::Absent, Api::of),
                    Discovered::Pending { .. } | Discovered::Failed { .. } => Api::Absent,
                };
                // First, so whoever hears the resources reads what they serve.
                served.send_if_modified(|served| std::mem::replace(served, api) != api);
                found.send_replace(Some(discovered));
            }
        });
        Self {
            resources,
            api,
            retry,
            task,
        }
    }

    pub fn api(&self) -> watch::Receiver<Api> {
        self.api.clone()
    }

    /// What one `resources_watch` sends: the resources as they stand, then each change. A
    /// follower that a failed credential stopped fetches again, as a new one would.
    pub fn follow(self: &Arc<Self>) -> Resources {
        self.retry.ask();
        Resources {
            receiver: self.resources.clone(),
            started: false,
            _followed: Arc::clone(self),
        }
    }
}

impl Drop for Followed {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct Resources {
    receiver: watch::Receiver<Option<Discovered>>,
    started: bool,
    _followed: Arc<Followed>,
}

impl Resources {
    /// What the follower knows when first asked, once it knows anything, then each change;
    /// changes that come in between are one.
    pub async fn next(&mut self) -> Discovered {
        if !self.started {
            self.started = true;
            return self
                .receiver
                .wait_for(Option::is_some)
                .await
                .expect("the follower lives as long as its handles")
                .clone()
                .expect("waited for a value");
        }
        loop {
            self.receiver
                .changed()
                .await
                .expect("the follower lives as long as its handles");
            if let Some(found) = self.receiver.borrow_and_update().clone() {
                return found;
            }
        }
    }
}

#[cfg(test)]
mod tests;
