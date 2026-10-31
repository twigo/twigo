use std::sync::{Arc, Mutex};

use twigo_ipc::KeyboardLayout;

use crate::{Error, MainThread, platform};

type Callback = Arc<dyn Fn(&KeyboardLayout) + Send + Sync>;

/// The process's one view of the active layout. The platform observer
/// publishes into it; subscribers read it from any thread.
pub(crate) struct Shared {
    state: Mutex<State>,
}

struct State {
    layout: Option<KeyboardLayout>,
    subscribers: Vec<(u64, Callback)>,
    next_id: u64,
}

impl Shared {
    pub(crate) const fn new() -> Self {
        Self {
            state: Mutex::new(State {
                layout: None,
                subscribers: Vec::new(),
                next_id: 0,
            }),
        }
    }

    /// Records the active layout and, if it changed, hands it to every
    /// subscriber.
    pub(crate) fn publish(&self, layout: KeyboardLayout) {
        let subscribers: Vec<Callback> = {
            let mut state = self.state.lock().expect("layout lock");
            if state.layout.as_ref() == Some(&layout) {
                return;
            }
            state.layout = Some(layout.clone());
            state.subscribers.iter().map(|(_, s)| s.clone()).collect()
        };
        for subscriber in subscribers {
            subscriber(&layout);
        }
    }

    fn is_started(&self) -> bool {
        self.state.lock().expect("layout lock").layout.is_some()
    }

    fn subscribe(&'static self, on_change: Callback) -> (KeyboardLayout, Subscription) {
        let mut state = self.state.lock().expect("layout lock");
        let id = state.next_id;
        state.next_id += 1;
        state.subscribers.push((id, on_change));
        let layout = state
            .layout
            .clone()
            .expect("a watch exists only after its first layout");
        (layout, Subscription { shared: self, id })
    }

    fn unsubscribe(&self, id: u64) {
        let mut state = self.state.lock().expect("layout lock");
        state.subscribers.retain(|(other, _)| *other != id);
    }
}

static ACTIVE: Shared = Shared::new();

/// Follows the active keyboard layout for the rest of the process.
#[derive(Clone, Copy)]
pub struct LayoutWatch(&'static Shared);

impl LayoutWatch {
    /// Reads the active layout and starts following it. The OS observer is
    /// installed once per process; later calls share it.
    pub fn start(main: MainThread) -> Result<Self, Error> {
        if !ACTIVE.is_started() {
            platform::observe(main, &ACTIVE)?;
        }
        Ok(Self(&ACTIVE))
    }

    /// The active layout, and a subscription that hands every later one to
    /// `on_change`, on the thread the OS reports it on, until it is dropped.
    pub fn subscribe(
        &self,
        on_change: impl Fn(&KeyboardLayout) + Send + Sync + 'static,
    ) -> (KeyboardLayout, Subscription) {
        self.0.subscribe(Arc::new(on_change))
    }
}

/// Stops its callback when dropped.
pub struct Subscription {
    shared: &'static Shared,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.shared.unsubscribe(self.id);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use super::*;

    fn layout(id: &str) -> KeyboardLayout {
        KeyboardLayout {
            id: id.into(),
            keys: BTreeMap::new(),
        }
    }

    fn recorder() -> (
        Arc<Mutex<Vec<String>>>,
        impl Fn(&KeyboardLayout) + Send + Sync,
    ) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (seen, move |l: &KeyboardLayout| {
            sink.lock().unwrap().push(l.id.clone());
        })
    }

    #[test]
    fn a_subscriber_gets_the_current_layout_then_every_change() {
        static SHARED: Shared = Shared::new();
        SHARED.publish(layout("us"));
        let (seen, on_change) = recorder();
        let (current, _subscription) = SHARED.subscribe(Arc::new(on_change));
        SHARED.publish(layout("ua"));
        SHARED.publish(layout("ua"));
        SHARED.publish(layout("de"));
        assert_eq!(current.id, "us");
        assert_eq!(*seen.lock().unwrap(), ["ua", "de"]);
    }

    #[test]
    fn a_dropped_subscription_hears_nothing() {
        static SHARED: Shared = Shared::new();
        SHARED.publish(layout("us"));
        let (dropped, on_change) = recorder();
        let (_, subscription) = SHARED.subscribe(Arc::new(on_change));
        let (kept, on_change) = recorder();
        let (_, _kept) = SHARED.subscribe(Arc::new(on_change));
        drop(subscription);
        SHARED.publish(layout("ua"));
        assert!(dropped.lock().unwrap().is_empty());
        assert_eq!(*kept.lock().unwrap(), ["ua"]);
    }
}
