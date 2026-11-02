//! What the hub learns about a context's cluster over its clients: whether
//! it streams lists, and whether the person may list a resource
//! cluster-wide. A rebuild of the clients may point them at another
//! server, so the facts go with the clients they were learnt over.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use twigo_kube::client::Clients;

#[derive(Default)]
pub(crate) struct Cluster {
    facts: Mutex<Facts>,
}

#[derive(Default)]
struct Facts {
    clients: Weak<Clients>,
    streaming: Option<bool>,
    /// By group and resource.
    may_list: HashMap<(String, String), bool>,
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

    pub fn may_list(&self, clients: &Arc<Clients>, group: &str, resource: &str) -> Option<bool> {
        self.facts(clients)
            .may_list
            .get(&(group.to_owned(), resource.to_owned()))
            .copied()
    }

    pub fn set_may_list(&self, clients: &Arc<Clients>, group: &str, resource: &str, may: bool) {
        self.facts(clients)
            .may_list
            .insert((group.to_owned(), resource.to_owned()), may);
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
