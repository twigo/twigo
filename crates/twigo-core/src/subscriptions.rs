//! The list subscriptions of every window (ARCHITECTURE 2.1, "Multiple
//! windows"): keyed by the window and the subscription, so a window
//! reaches only its own, and closing or reloading one drops its own.

use std::collections::HashMap;
use std::sync::Mutex;

use twigo_cache::batcher::Batcher;
use twigo_ipc::{ErrorKind, IpcError, SubscriptionId};

#[derive(Default)]
pub struct Lists {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next: u32,
    windows: HashMap<String, Window>,
}

#[derive(Default)]
struct Window {
    /// Counts the drops, so a subscription that a dropped page asked for
    /// and that answers after the drop is not kept.
    generation: u64,
    lists: HashMap<SubscriptionId, Batcher>,
}

/// Where a window stood when it asked for a subscription.
pub struct Ticket {
    window: String,
    generation: u64,
}

fn missing(id: SubscriptionId) -> IpcError {
    IpcError {
        kind: ErrorKind::NotFound,
        message: format!("no list subscription {}", id.0),
    }
}

impl Lists {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("lists lock")
    }

    /// Taken before a subscription is built, which may wait on the network,
    /// as the command starts to run: a request the old page sent just
    /// before a reload but that starts after it is kept until the window's
    /// next drop.
    pub fn ticket(&self, window: &str) -> Ticket {
        let generation = self
            .inner()
            .windows
            .get(window)
            .map_or(0, |held| held.generation);
        Ticket {
            window: window.to_owned(),
            generation,
        }
    }

    /// Keeps the batcher, unless its window was dropped since the ticket.
    pub fn keep(&self, ticket: Ticket, batcher: Batcher) -> Result<SubscriptionId, IpcError> {
        let mut inner = self.inner();
        inner.next += 1;
        let id = SubscriptionId(inner.next);
        let window = inner.windows.entry(ticket.window).or_default();
        if window.generation != ticket.generation {
            return Err(IpcError {
                kind: ErrorKind::Unavailable,
                message: "the page that asked for the list is gone".to_owned(),
            });
        }
        window.lists.insert(id, batcher);
        Ok(id)
    }

    pub fn with(
        &self,
        window: &str,
        id: SubscriptionId,
        act: impl FnOnce(&Batcher),
    ) -> Result<(), IpcError> {
        let inner = self.inner();
        let batcher = inner
            .windows
            .get(window)
            .and_then(|held| held.lists.get(&id))
            .ok_or_else(|| missing(id))?;
        act(batcher);
        Ok(())
    }

    pub fn remove(&self, window: &str, id: SubscriptionId) -> Result<(), IpcError> {
        let removed = self
            .inner()
            .windows
            .get_mut(window)
            .and_then(|held| held.lists.remove(&id))
            .ok_or_else(|| missing(id))?;
        drop(removed);
        Ok(())
    }

    /// Drops every subscription of a window that reloads or closes.
    pub fn drop_window(&self, window: &str) {
        let dropped = {
            let mut inner = self.inner();
            let held = inner.windows.entry(window.to_owned()).or_default();
            held.generation += 1;
            std::mem::take(&mut held.lists)
        };
        drop(dropped);
    }
}
