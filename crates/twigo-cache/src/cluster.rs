//! What the hub learns about a context's cluster over its clients: whether
//! it streams lists, and what RBAC lets the person do. A rebuild of the clients may point them at another
//! server, so the facts go with the clients they were learnt over.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use twigo_ipc::Access;
use twigo_kube::client::Clients;

#[derive(Default)]
pub(crate) struct Cluster {
    facts: Mutex<Facts>,
}

#[derive(Default)]
struct Facts {
    clients: Weak<Clients>,
    streaming: Option<bool>,
    /// By namespace, none for all of them, and what is asked.
    may: HashMap<(Option<String>, Access), bool>,
}

impl Cluster {
    /// Whether streaming lists work, once a list has tried one (ARCHITECTURE
    /// 3.2, "Initial list").
    pub fn streaming(&self, clients: &Arc<Clients>) -> Option<bool> {
        self.facts(clients).streaming
    }

    pub fn set_streaming(&self, clients: &Arc<Clients>, streaming: bool) {
        self.facts(clients).streaming = Some(streaming);
    }

    pub fn may(
        &self,
        clients: &Arc<Clients>,
        namespace: Option<&str>,
        access: &Access,
    ) -> Option<bool> {
        self.facts(clients)
            .may
            .get(&(namespace.map(str::to_owned), access.clone()))
            .copied()
    }

    pub fn set_may(
        &self,
        clients: &Arc<Clients>,
        namespace: Option<&str>,
        access: &Access,
        may: bool,
    ) {
        self.facts(clients)
            .may
            .insert((namespace.map(str::to_owned), access.clone()), may);
    }

    fn facts(&self, clients: &Arc<Clients>) -> MutexGuard<'_, Facts> {
        let mut facts = self.facts.lock().expect("cluster lock");
        if !std::ptr::eq(facts.clients.as_ptr(), Arc::as_ptr(clients)) {
            *facts = Facts {
                clients: Arc::downgrade(clients),
                ..Facts::default()
            };
        }
        facts
    }
}
