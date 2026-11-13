//! A context's discovery, followed for as long as something follows it
//! (ARCHITECTURE 3.6): what `resources_watch` sends the webview and what pod
//! and node lists and open objects read of the Metrics API come from one
//! follower, shared by all of them, which stops with the last of them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::watch;
use tokio::task::JoinHandle;
use twigo_ipc::Discovered;
use twigo_kube::discovery::Cache;
use twigo_kube::kubeconfig::Fingerprint;

use super::{Follower, Retry};
use crate::hub::Hub;
use crate::metrics::Api;

/// The follower of each context, started when something first asks for it and
/// held by the watches of the context's resources and the readers of its metrics:
/// with the last of them gone its watches and fetches stop.
pub struct Followers {
    hub: Hub,
    cache: Arc<Cache>,
    contexts: Mutex<HashMap<String, Arc<Slot>>>,
}

#[derive(Default)]
struct Slot {
    /// Never held across an await: a list's or an object's opening is polled once and then
    /// only when its webview answers, which a hidden document never does, so a lock that
    /// passed to it would keep every other asker of the context waiting.
    followed: Mutex<Weak<Followed>>,
    /// What the follower last confirmed, for the next one to begin from.
    kept: Mutex<Option<Kept>>,
}

#[derive(Clone, Copy)]
struct Kept {
    fingerprint: Fingerprint,
    api: Api,
}

impl Followers {
    pub fn new(hub: Hub, cache: Arc<Cache>) -> Self {
        Self {
            hub,
            cache,
            contexts: Mutex::default(),
        }
    }

    /// The context's follower, a new one when nobody holds it; `entry` is awaited only to
    /// start it. A new follower begins from the Metrics API's state its predecessor last
    /// confirmed under the same fingerprint, so a list opened again has its columns in its
    /// first batch, and its first answer corrects it.
    /// Askers that find none at once each build one, and the first to finish keeps its own:
    /// the others' are dropped before they run.
    pub async fn get(
        &self,
        context: &str,
        entry: impl Future<Output = watch::Receiver<Option<Fingerprint>>>,
    ) -> Arc<Followed> {
        let slot = Arc::clone(
            self.contexts
                .lock()
                .expect("followers lock")
                .entry(context.to_owned())
                .or_default(),
        );
        if let Some(followed) = slot.followed.lock().expect("followed lock").upgrade() {
            return followed;
        }
        let entry = entry.await;
        let fingerprint = *entry.borrow();
        let kept = (*slot.kept.lock().expect("kept lock"))
            .filter(|kept| Some(kept.fingerprint) == fingerprint);
        let follower = Follower::new(
            self.hub.clone(),
            Arc::clone(&self.cache),
            context.to_owned(),
            entry,
        )
        .await;
        let mut held = slot.followed.lock().expect("followed lock");
        if let Some(followed) = held.upgrade() {
            return followed;
        }
        let followed = Arc::new(Followed::start(follower, kept, Arc::clone(&slot)));
        *held = Arc::downgrade(&followed);
        followed
    }
}

pub struct Followed {
    resources: watch::Receiver<Option<Discovered>>,
    api: watch::Receiver<Api>,
    retry: Retry,
    task: JoinHandle<()>,
}

impl Followed {
    fn start(mut follower: Follower, kept: Option<Kept>, slot: Arc<Slot>) -> Self {
        let retry = follower.retry();
        let (found, resources) = watch::channel(None);
        let (served, api) = watch::channel(kept.map_or(Api::Absent, |kept| kept.api));
        let task = tokio::spawn(async move {
            // Until the cluster answers, the kept state stands for as long as the context's
            // fingerprint is the one it was kept for: neither the cluster's name, which comes
            // first, nor a failure to reach it says the cluster no longer serves it.
            let mut trusted = kept.map(|kept| kept.fingerprint);
            loop {
                let discovered = follower.next().await;
                if matches!(discovered, Discovered::Ready { .. })
                    || follower.fingerprint() != trusted
                {
                    trusted = None;
                }
                if trusted.is_none() {
                    let reached = follower.api();
                    // First, so whoever hears the resources reads what they serve.
                    served.send_if_modified(|served| std::mem::replace(served, reached) != reached);
                    *slot.kept.lock().expect("kept lock") =
                        follower.fingerprint().map(|fingerprint| Kept {
                            fingerprint,
                            api: reached,
                        });
                }
                found.send_if_modified(|found| {
                    let changed = found.as_ref() != Some(&discovered);
                    *found = Some(discovered);
                    changed
                });
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
