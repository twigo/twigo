use std::sync::{Arc, Mutex, PoisonError};

use twigo_ipc::KeyboardLayout;

use crate::{Error, MainThread, platform};

type Callback = Box<dyn Fn(&KeyboardLayout) + Send + Sync>;

/// A subscriber's callback, called under its lock, until its subscription
/// empties it.
type Slot = Arc<Mutex<Option<Callback>>>;

/// The process's one view of the active layout. The platform observer
/// publishes into it; subscribers read it from any thread.
pub(crate) struct Shared {
    state: Mutex<State>,
}

struct State {
    layout: Option<KeyboardLayout>,
    subscribers: Vec<(u64, Slot)>,
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
        let subscribers: Vec<Slot> = {
            let mut state = self.state.lock().expect("layout lock");
            if state.layout.as_ref() == Some(&layout) {
                return;
            }
            state.layout = Some(layout.clone());
            state.subscribers.iter().map(|(_, s)| s.clone()).collect()
        };
        for subscriber in subscribers {
            if let Some(on_change) = &*subscriber.lock().unwrap_or_else(PoisonError::into_inner) {
                on_change(&layout);
            }
        }
    }

    fn is_started(&self) -> bool {
        self.state.lock().expect("layout lock").layout.is_some()
    }

    fn subscribe(&'static self, on_change: Callback) -> (KeyboardLayout, Subscription) {
        let mut state = self.state.lock().expect("layout lock");
        let id = state.next_id;
        state.next_id += 1;
        state
            .subscribers
            .push((id, Arc::new(Mutex::new(Some(on_change)))));
        let layout = state
            .layout
            .clone()
            .expect("a watch exists only after its first layout");
        (layout, Subscription { shared: self, id })
    }

    fn unsubscribe(&self, id: u64) {
        let slot = {
            let mut state = self.state.lock().expect("layout lock");
            let at = state.subscribers.iter().position(|(other, _)| *other == id);
            at.map(|at| state.subscribers.remove(at).1)
        };
        if let Some(slot) = slot {
            *slot.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
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
        self.0.subscribe(Box::new(on_change))
    }
}

/// Stops its callback when dropped: once `drop` returns, the callback never
/// runs again, so `drop` waits for a call in progress and must not run inside
/// the callback itself.
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
        let (current, _subscription) = SHARED.subscribe(Box::new(on_change));
        SHARED.publish(layout("ua"));
        SHARED.publish(layout("ua"));
        SHARED.publish(layout("de"));
        assert_eq!(current.id, "us");
        assert_eq!(*seen.lock().unwrap(), ["ua", "de"]);
    }

    #[test]
    fn dropping_a_subscription_waits_for_its_running_callback() {
        static SHARED: Shared = Shared::new();
        SHARED.publish(layout("us"));
        let done = Arc::new(Mutex::new(false));
        let (enter, entered) = std::sync::mpsc::channel();
        let finished = done.clone();
        let (_, subscription) = SHARED.subscribe(Box::new(move |_: &KeyboardLayout| {
            enter.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            *finished.lock().unwrap() = true;
        }));
        let publisher = std::thread::spawn(|| SHARED.publish(layout("ua")));
        entered.recv().unwrap();
        drop(subscription);
        assert!(*done.lock().unwrap());
        publisher.join().unwrap();
    }

    #[test]
    fn a_dropped_subscription_hears_nothing() {
        static SHARED: Shared = Shared::new();
        SHARED.publish(layout("us"));
        let (dropped, on_change) = recorder();
        let (_, subscription) = SHARED.subscribe(Box::new(on_change));
        let (kept, on_change) = recorder();
        let (_, _kept) = SHARED.subscribe(Box::new(on_change));
        drop(subscription);
        SHARED.publish(layout("ua"));
        assert!(dropped.lock().unwrap().is_empty());
        assert_eq!(*kept.lock().unwrap(), ["ua"]);
    }
}
