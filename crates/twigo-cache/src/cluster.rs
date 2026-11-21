//! What the hub learns about a context's cluster over its clients: which
//! group-versions page their lists, and what RBAC lets the person do. A
//! rebuild of the clients may point them at another server, so the facts go
//! with the clients they were learnt over.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use tokio::time::Instant;

use twigo_ipc::Access;
use twigo_kube::client::Clients;

/// How long RBAC's no holds before it is asked again, so a RoleBinding
/// granted since counts; a yes holds, as the server still decides.
pub(crate) const REFUSED_FOR: Duration = Duration::from_secs(30);

/// How long the namespaces a person may list a resource in hold once they
/// are resolved, so each list of all namespaces opened meanwhile reads them
/// and asks nothing. The first list after that reads them anyway, and they
/// are resolved again for the lists after it.
pub(crate) const RESOLVED_FOR: Duration = Duration::from_secs(300);

/// What "all namespaces" of a resource came to for a person who may not list
/// it cluster-wide.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Resolved {
    /// The namespaces they may list it in, sorted.
    pub allowed: Vec<String>,
    /// How many of the cluster's namespaces that leaves out.
    pub omitted: u32,
}

/// What [`Cluster::resolved`] finds.
pub(crate) struct Kept {
    pub resolved: Resolved,
    /// It is past [`RESOLVED_FOR`], and the asker is the one to resolve it
    /// again.
    pub renew: bool,
}

/// What all namespaces of a resource came to, and until when it is read as
/// it is.
struct Memo {
    resolved: Resolved,
    /// From then on the first list that reads it resolves it again.
    due: Instant,
    /// Someone resolves it again.
    renewing: bool,
}

/// What a review asks: the namespace, none for every namespace, and the access.
type Asked = (Option<String>, Access);

/// Why a review has no answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unanswered {
    /// The server rejects the credentials, or their plugin fails: asking again
    /// by itself would run the plugin again.
    Unauthorized,
    /// The server refuses the review itself, as it will every time.
    Refused,
    /// A 429, a 5xx, a timeout or a connection that broke: it may answer later.
    Failed,
}

/// A review under way, whose answer every asker of it takes.
type Review = Shared<BoxFuture<'static, Result<bool, Unanswered>>>;

#[derive(Default)]
pub(crate) struct Cluster {
    facts: Mutex<Facts>,
}

#[derive(Default)]
struct Facts {
    clients: Weak<Clients>,
    /// The group-versions, each by its group and version, whose streaming
    /// lists were refused or came uncompressed; an APIService serves one.
    paged: HashSet<(String, String)>,
    /// By namespace, none for all of them, and what is asked: the answer,
    /// and when it came.
    may: HashMap<Asked, (bool, Instant)>,
    /// The reviews under way, by what they ask, which each asker of the same
    /// waits for instead of sending its own.
    reviewing: HashMap<Asked, Review>,
    /// By group and resource, what its all namespaces came to.
    resolved: HashMap<(String, String), Memo>,
}

impl Cluster {
    /// Whether a list of the group-version asks for a stream: until one
    /// failed to give it (ARCHITECTURE 3.2, "Initial list").
    pub fn streams(&self, clients: &Arc<Clients>, group: &str, version: &str) -> bool {
        !self
            .facts(clients)
            .paged
            .contains(&(group.to_owned(), version.to_owned()))
    }

    /// The group-version's lists come in pages from now on.
    pub fn page(&self, clients: &Arc<Clients>, group: &str, version: &str) {
        self.facts(clients)
            .paged
            .insert((group.to_owned(), version.to_owned()));
    }

    /// Whether RBAC lets the person do `access` in `namespace`, or with none
    /// in every namespace: the answer kept, else the one `ask` sends, which
    /// every asker of the same review shares while it is under way. Only an
    /// answer is kept. A review runs to its end whoever waits for it, so an
    /// asker that leaves never parks it with its request slot held.
    pub async fn review(
        self: &Arc<Self>,
        clients: &Arc<Clients>,
        namespace: Option<&str>,
        access: &Access,
        ask: impl FnOnce() -> BoxFuture<'static, Result<bool, Unanswered>>,
    ) -> Result<bool, Unanswered> {
        let asked: Asked = (namespace.map(str::to_owned), access.clone());
        let review = {
            let mut facts = self.facts(clients);
            if let Some(&(may, at)) = facts.may.get(&asked)
                && (may || at.elapsed() < REFUSED_FOR)
            {
                return Ok(may);
            }
            facts
                .reviewing
                .entry(asked.clone())
                .or_insert_with(|| {
                    let (cluster, clients, ask) = (Arc::clone(self), Arc::clone(clients), ask());
                    let review = tokio::spawn(async move {
                        let may = ask.await;
                        let mut facts = cluster.facts(&clients);
                        facts.reviewing.remove(&asked);
                        if let Ok(may) = may {
                            facts.may.insert(asked, (may, Instant::now()));
                        }
                        may
                    });
                    async move { review.await.expect("a review ends with an answer") }
                        .boxed()
                        .shared()
                })
                .clone()
        };
        review.await
    }

    /// What all namespaces of the resource `access` names came to, if it is
    /// kept. A set of namespaces stays past [`RESOLVED_FOR`] and is read by
    /// every asker, the first of whom resolves it again; a refusal, which no
    /// namespace is allowed, lasts [`REFUSED_FOR`], as a review's no.
    pub fn resolved(&self, clients: &Arc<Clients>, access: &Access) -> Option<Kept> {
        let mut facts = self.facts(clients);
        let memo = facts
            .resolved
            .get_mut(&(access.group.clone(), access.resource.clone()))?;
        let due = Instant::now() >= memo.due;
        if memo.resolved.allowed.is_empty() {
            return (!due).then(|| Kept {
                resolved: memo.resolved.clone(),
                renew: false,
            });
        }
        let renew = due && !std::mem::replace(&mut memo.renewing, true);
        Some(Kept {
            resolved: memo.resolved.clone(),
            renew,
        })
    }

    /// What every question of a resolution answered replaces what was kept.
    pub fn set_resolved(&self, clients: &Arc<Clients>, access: &Access, resolved: Resolved) {
        let kept = if resolved.allowed.is_empty() {
            REFUSED_FOR
        } else {
            RESOLVED_FOR
        };
        self.facts(clients).resolved.insert(
            (access.group.clone(), access.resource.clone()),
            Memo {
                resolved,
                due: Instant::now() + kept,
                renewing: false,
            },
        );
    }

    /// A resolution that did not answer every question leaves the set it
    /// renews as it is, for the next list to resolve again. With none, its
    /// guess, which counts what did not answer as allowed, is kept, due at
    /// once.
    pub fn set_unsettled(&self, clients: &Arc<Clients>, access: &Access, guess: Option<Resolved>) {
        let mut facts = self.facts(clients);
        let key = (access.group.clone(), access.resource.clone());
        match facts.resolved.get_mut(&key) {
            Some(memo) if !memo.resolved.allowed.is_empty() => memo.renewing = false,
            _ => {
                if let Some(resolved) = guess {
                    facts.resolved.insert(
                        key,
                        Memo {
                            resolved,
                            due: Instant::now(),
                            renewing: false,
                        },
                    );
                }
            }
        }
    }

    pub fn forget_resolved(&self, clients: &Arc<Clients>, access: &Access) {
        self.facts(clients)
            .resolved
            .remove(&(access.group.clone(), access.resource.clone()));
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
