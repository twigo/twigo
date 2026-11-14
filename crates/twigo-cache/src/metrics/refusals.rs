//! The last failure each scope of a context ended in, kept after its readers leave, so that a
//! reader of a scope that failed says so before its request answers (ARCHITECTURE 3.6).

use std::collections::HashMap;

use tokio::sync::watch;
use twigo_ipc::MetricsState;

use super::{Api, Kind, Scope};

/// One entry per scope whose last request failed, `forbidden` or `unavailable`: a scope that
/// answers, and one never asked, hold none. A pod alone is kept under its namespace, since RBAC
/// tells names apart only through `resourceNames`.
#[derive(Default)]
pub(super) struct Refusals {
    /// What the context serves of the Metrics API: the entries stand only until it changes.
    api: Option<watch::Receiver<Api>>,
    /// The clients the last failure came over: the entries stand only until they are replaced.
    clients: Option<watch::Receiver<bool>>,
    failed: HashMap<(Kind, Scope), MetricsState>,
}

fn key(scope: &Scope) -> Scope {
    match scope {
        Scope::Named { namespace, .. } => Scope::Namespace(namespace.clone()),
        other => other.clone(),
    }
}

impl Refusals {
    /// For a context built now, whose follower may serve another API than the last one did, or
    /// have changed it and back while no context lived.
    pub(super) fn follow(&mut self, api: &watch::Receiver<Api>) {
        if self.api.as_ref().is_none_or(|kept| {
            kept.has_changed().unwrap_or(false) || *kept.borrow() != *api.borrow()
        }) {
            self.failed.clear();
        }
        let mut api = api.clone();
        api.mark_unchanged();
        self.api = Some(api);
    }

    /// A change of what the context serves counts even when it came back to what it was, as
    /// metrics-server removed and installed again.
    fn stand(&mut self) {
        if let Some(api) = &mut self.api
            && api.has_changed().unwrap_or(true)
        {
            api.mark_unchanged();
            self.failed.clear();
        }
        if self
            .clients
            .as_ref()
            .is_some_and(|clients| *clients.borrow())
        {
            self.clients = None;
            self.failed.clear();
        }
    }

    /// What a request of `scope` ended in; an answer forgets the scope and those it covers.
    pub(super) fn say(
        &mut self,
        kind: Kind,
        scope: &Scope,
        state: MetricsState,
        over: Option<&watch::Receiver<bool>>,
    ) {
        self.stand();
        let key = key(scope);
        if state == MetricsState::Ready {
            self.failed
                .retain(|(of, held), _| *of != kind || !key.covers(held));
            return;
        }
        self.failed.insert((kind, key), state);
        if let Some(over) = over {
            self.clients = Some(over.clone());
        }
    }

    pub(super) fn recall(&mut self, kind: Kind, scope: &Scope) -> Option<MetricsState> {
        self.stand();
        self.failed.get(&(kind, key(scope))).copied()
    }
}
