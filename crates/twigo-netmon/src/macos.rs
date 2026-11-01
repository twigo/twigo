//! IOKit's system power notifications for wake, as Chromium's and Firefox's
//! power monitors use them, and SystemConfiguration's dynamic store for the
//! network: its global IPv4 and IPv6 state, which names the primary
//! interface, and each service's addresses. Both deliver on a dispatch
//! queue of their own, away from the main thread that tao owns.

use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicU32, Ordering};

use dispatch2::{DispatchQueue, DispatchRetained};
use objc2_core_foundation::{CFArray, CFRetained, CFString};
use objc2_io_kit::{
    IOAllowPowerChange, IODeregisterForSystemPower, IONotificationPort, IONotificationPortRef,
    IORegisterForSystemPower, IOServiceClose, io_connect_t, io_object_t, io_service_t,
    kIOMessageCanSystemSleep, kIOMessageSystemHasPoweredOn, kIOMessageSystemWillSleep,
};
use objc2_system_configuration::{SCDynamicStore, SCDynamicStoreContext};
use tokio::sync::mpsc::UnboundedSender;

use crate::Event;

const KEYS: [&str; 2] = ["State:/Network/Global/IPv4", "State:/Network/Global/IPv6"];
const PATTERNS: [&str; 1] = ["State:/Network/Service/[^/]+/IPv[46]"];

pub struct Listeners {
    power: Option<Power>,
    network: Option<Network>,
    queue: DispatchRetained<DispatchQueue>,
}

impl Listeners {
    pub fn start(events: UnboundedSender<Event>) -> Self {
        let queue = DispatchQueue::new("io.twigo.netmon", None);
        let power = Power::start(events.clone(), &queue);
        if power.is_none() {
            eprintln!("IORegisterForSystemPower failed, so a wake from sleep goes unseen");
        }
        let network = Network::start(events, &queue);
        if network.is_none() {
            eprintln!("the dynamic store refused its notifications, so network changes go unseen");
        }
        Self {
            power,
            network,
            queue,
        }
    }
}

impl Drop for Listeners {
    fn drop(&mut self) {
        if let Some(power) = &mut self.power {
            power.stop();
        }
        if let Some(network) = &self.network {
            network.stop();
        }
        // The serial queue runs callbacks already queued before this, so
        // their contexts outlive them.
        self.queue.exec_sync(|| {});
    }
}

struct Power {
    root: io_connect_t,
    port: IONotificationPortRef,
    notifier: io_object_t,
    context: NonNull<PowerContext>,
}

struct PowerContext {
    events: UnboundedSender<Event>,
    /// The root power domain's port, known only once registered.
    root: AtomicU32,
}

// SAFETY: the port and the context are touched only by the queue's callback
// and by `Listeners::drop`, which waits for the queue.
unsafe impl Send for Power {}

impl Power {
    fn start(events: UnboundedSender<Event>, queue: &DispatchQueue) -> Option<Self> {
        let context = NonNull::from(Box::leak(Box::new(PowerContext {
            events,
            root: AtomicU32::new(0),
        })));
        let mut port = ptr::null_mut();
        let mut notifier = 0;
        // SAFETY: the context lives until `Power` drops, after the queue
        // stops calling back; the out pointers are valid.
        let root = unsafe {
            IORegisterForSystemPower(
                context.as_ptr().cast(),
                &mut port,
                Some(on_power),
                &mut notifier,
            )
        };
        if root == 0 {
            // SAFETY: nothing else holds the context.
            drop(unsafe { Box::from_raw(context.as_ptr()) });
            return None;
        }
        // SAFETY: the context is valid; no callback runs before the queue is
        // set below.
        unsafe { context.as_ref() }
            .root
            .store(root, Ordering::Release);
        // SAFETY: the port came from the registration and the queue lives
        // as long as the listeners.
        unsafe { IONotificationPort::set_dispatch_queue(port, Some(queue)) };
        Some(Self {
            root,
            port,
            notifier,
            context,
        })
    }

    fn stop(&mut self) {
        // SAFETY: the notifier, the root port and the notification port
        // came from the registration, and are released once each.
        unsafe {
            IODeregisterForSystemPower(&mut self.notifier);
            IOServiceClose(self.root);
            IONotificationPort::destroy(self.port);
        }
    }
}

impl Drop for Power {
    fn drop(&mut self) {
        // SAFETY: stopped, and the queue has run out its callbacks.
        drop(unsafe { Box::from_raw(self.context.as_ptr()) });
    }
}

/// Sleep waits up to 30 s for every registered app that does not allow it.
unsafe extern "C-unwind" fn on_power(
    refcon: *mut c_void,
    _service: io_service_t,
    message: u32,
    argument: *mut c_void,
) {
    // SAFETY: the refcon is the context registered with this callback.
    let context = unsafe { &*refcon.cast::<PowerContext>() };
    if message == kIOMessageCanSystemSleep || message == kIOMessageSystemWillSleep {
        IOAllowPowerChange(context.root.load(Ordering::Acquire), argument as isize);
    } else if message == kIOMessageSystemHasPoweredOn {
        let _ = context.events.send(Event::Woke);
    }
}

struct Network {
    store: CFRetained<SCDynamicStore>,
    events: NonNull<UnboundedSender<Event>>,
}

// SAFETY: the store is thread-safe, and the sender is touched only by the
// queue's callback and freed after `Listeners::drop` waits for the queue.
unsafe impl Send for Network {}

impl Network {
    fn start(events: UnboundedSender<Event>, queue: &DispatchQueue) -> Option<Self> {
        let events = NonNull::from(Box::leak(Box::new(events)));
        let mut context = SCDynamicStoreContext {
            version: 0,
            info: events.as_ptr().cast(),
            retain: None,
            release: None,
            copyDescription: None,
        };
        let name = CFString::from_static_str("io.twigo.netmon");
        let keys: Vec<_> = KEYS
            .iter()
            .map(|key| CFString::from_static_str(key))
            .collect();
        let patterns: Vec<_> = PATTERNS
            .iter()
            .map(|p| CFString::from_static_str(p))
            .collect();
        // SAFETY: the store copies the context, whose info lives until
        // `Network` drops, after the queue stops calling back.
        let store = unsafe { SCDynamicStore::new(None, &name, Some(on_change), &mut context) };
        let started = store.filter(|store| {
            let keys = CFArray::from_retained_objects(&keys);
            let patterns = CFArray::from_retained_objects(&patterns);
            // SAFETY: both arrays hold strings; the queue lives as long as
            // the listeners.
            unsafe {
                store.set_notification_keys(Some(keys.as_ref()), Some(patterns.as_ref()))
                    && store.set_dispatch_queue(Some(queue))
            }
        });
        let Some(store) = started else {
            // SAFETY: the store never delivers, so nothing else holds it.
            drop(unsafe { Box::from_raw(events.as_ptr()) });
            return None;
        };
        Some(Self { store, events })
    }

    fn stop(&self) {
        // SAFETY: detaching the store from its queue stops its callbacks.
        unsafe { self.store.set_dispatch_queue(None) };
    }
}

impl Drop for Network {
    fn drop(&mut self) {
        // SAFETY: stopped, and the queue has run out its callbacks.
        drop(unsafe { Box::from_raw(self.events.as_ptr()) });
    }
}

unsafe extern "C-unwind" fn on_change(
    _store: NonNull<SCDynamicStore>,
    _keys: NonNull<CFArray>,
    info: *mut c_void,
) {
    // SAFETY: the info is the sender this store was created with.
    let events = unsafe { &*info.cast::<UnboundedSender<Event>>() };
    let _ = events.send(Event::NetworkChanged);
}

#[cfg(test)]
mod tests {
    use tokio::sync::mpsc;

    use super::*;

    #[test]
    fn both_listeners_register_and_stop() {
        let (events, _received) = mpsc::unbounded_channel();
        let listeners = Listeners::start(events);
        assert!(listeners.power.is_some());
        assert!(listeners.network.is_some());
    }
}
