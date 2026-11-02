//! The subscriptions of every window, its lists or its open objects
//! (ARCHITECTURE 2.1, "Multiple windows"): keyed by the window and the
//! subscription, so a window reaches only its own, and closing or reloading
//! one drops its own.

use std::collections::HashMap;
use std::sync::Mutex;

use twigo_ipc::{ErrorKind, IpcError, SubscriptionId};

/// Each held `T` ends its subscription when dropped.
pub struct Subscriptions<T> {
    what: &'static str,
    inner: Mutex<Inner<T>>,
}

struct Inner<T> {
    next: u32,
    windows: HashMap<String, Window<T>>,
}

struct Window<T> {
    /// Counts the drops, so a subscription that a dropped page asked for
    /// and that answers after the drop is not kept.
    generation: u64,
    held: HashMap<SubscriptionId, T>,
}

impl<T> Default for Window<T> {
    fn default() -> Self {
        Self {
            generation: 0,
            held: HashMap::new(),
        }
    }
}

/// Where a window stood when it asked for a subscription.
pub struct Ticket {
    window: String,
    generation: u64,
}

impl<T> Subscriptions<T> {
    /// `what` names a subscription in errors, such as "list".
    pub fn new(what: &'static str) -> Self {
        Self {
            what,
            inner: Mutex::new(Inner {
                next: 0,
                windows: HashMap::new(),
            }),
        }
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner<T>> {
        self.inner.lock().expect("subscriptions lock")
    }

    fn missing(&self, id: SubscriptionId) -> IpcError {
        IpcError {
            kind: ErrorKind::NotFound,
            message: format!("no {} subscription {}", self.what, id.0),
        }
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
            .map_or(0, |window| window.generation);
        Ticket {
            window: window.to_owned(),
            generation,
        }
    }

    /// Keeps `held`, unless its window was dropped since the ticket.
    pub fn keep(&self, ticket: Ticket, held: T) -> Result<SubscriptionId, IpcError> {
        let mut inner = self.inner();
        inner.next += 1;
        let id = SubscriptionId(inner.next);
        let window = inner.windows.entry(ticket.window).or_default();
        if window.generation != ticket.generation {
            return Err(IpcError {
                kind: ErrorKind::Unavailable,
                message: format!("the page that asked for the {} is gone", self.what),
            });
        }
        window.held.insert(id, held);
        Ok(id)
    }

    pub fn with<R>(
        &self,
        window: &str,
        id: SubscriptionId,
        act: impl FnOnce(&T) -> R,
    ) -> Result<R, IpcError> {
        let inner = self.inner();
        let held = inner
            .windows
            .get(window)
            .and_then(|window| window.held.get(&id))
            .ok_or_else(|| self.missing(id))?;
        Ok(act(held))
    }

    pub fn remove(&self, window: &str, id: SubscriptionId) -> Result<(), IpcError> {
        let removed = self
            .inner()
            .windows
            .get_mut(window)
            .and_then(|window| window.held.remove(&id))
            .ok_or_else(|| self.missing(id))?;
        drop(removed);
        Ok(())
    }

    /// Drops every subscription of a window that reloads or closes.
    pub fn drop_window(&self, window: &str) {
        let dropped = {
            let mut inner = self.inner();
            let window = inner.windows.entry(window.to_owned()).or_default();
            window.generation += 1;
            std::mem::take(&mut window.held)
        };
        drop(dropped);
    }
}
