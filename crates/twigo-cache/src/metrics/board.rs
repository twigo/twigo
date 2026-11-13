//! The scopes polled for one resource of a context, and the readers that want them.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::watch;
use tokio::task::JoinHandle;
use twigo_ipc::{ErrorKind, MetricsState};

use super::fetch::{Failure, fetch};
use super::sample::{Sample, Samples};
use super::{Api, Context, INTERVAL, Kind, worse};
use crate::hub::Hub;
use crate::upstream;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Scope {
    Cluster,
    Namespace(Box<str>),
    /// One pod, asked for by `metadata.name` when no list reads its namespace.
    Named {
        namespace: Box<str>,
        name: Box<str>,
    },
}

impl Scope {
    pub fn covers(&self, other: &Scope) -> bool {
        match (self, other) {
            (Scope::Cluster, _) => true,
            (Scope::Namespace(namespace), Scope::Namespace(other)) => namespace == other,
            (
                Scope::Namespace(namespace),
                Scope::Named {
                    namespace: other, ..
                },
            ) => namespace == other,
            (Scope::Named { .. }, Scope::Named { .. }) => self == other,
            _ => false,
        }
    }

    pub fn holds(&self, namespace: &str, name: &str) -> bool {
        match self {
            Scope::Cluster => true,
            Scope::Namespace(wanted) => **wanted == *namespace,
            Scope::Named {
                namespace: wanted,
                name: pod,
            } => **wanted == *namespace && **pod == *name,
        }
    }
}

/// A scope's whole answer, from which a key it lacks has no sample.
#[derive(Debug, Clone)]
pub struct Reset {
    pub scope: Scope,
    pub samples: Arc<Samples>,
}

#[derive(Debug, Clone)]
pub struct Change {
    pub namespace: Box<str>,
    pub name: Box<str>,
    pub sample: Option<Arc<Sample>>,
}

/// Its resets are read first, then each changed key.
#[derive(Debug, Default)]
pub struct Update {
    /// None while the reader wants nothing.
    pub state: Option<MetricsState>,
    pub resets: Vec<Reset>,
    pub changes: Vec<Change>,
}

pub(crate) struct Board {
    context: Box<str>,
    kind: Kind,
    hub: Hub,
    api: watch::Receiver<Api>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    next: u64,
    members: HashMap<u64, Member>,
    requests: HashMap<Scope, Request>,
}

struct Member {
    wants: Wants,
    feed: Arc<Mutex<Pending>>,
}

#[derive(Default)]
struct Wants {
    scopes: HashSet<Scope>,
    cluster: bool,
    namespaces: HashSet<Box<str>>,
}

impl Wants {
    fn new(scopes: HashSet<Scope>) -> Self {
        Self {
            cluster: scopes.contains(&Scope::Cluster),
            namespaces: scopes
                .iter()
                .filter_map(|scope| match scope {
                    Scope::Namespace(namespace) => Some(namespace.clone()),
                    _ => None,
                })
                .collect(),
            scopes,
        }
    }

    fn hears(&self, namespace: &str, name: &str) -> bool {
        self.cluster
            || self.namespaces.contains(namespace)
            || self
                .scopes
                .iter()
                .any(|scope| matches!(scope, Scope::Named { .. }) && scope.holds(namespace, name))
    }

    fn relates(&self, scope: &Scope) -> bool {
        self.scopes
            .iter()
            .any(|wanted| scope.covers(wanted) || wanted.covers(scope))
    }
}

type Key = (Box<str>, Box<str>);

#[derive(Default)]
struct Pending {
    resets: Vec<Reset>,
    changes: HashMap<Key, Option<Arc<Sample>>>,
}

impl Pending {
    fn reset(&mut self, reset: Reset) {
        self.changes
            .retain(|(namespace, name), _| !reset.scope.holds(namespace, name));
        self.resets
            .retain(|earlier| !reset.scope.covers(&earlier.scope));
        self.resets.push(reset);
    }
}

struct Request {
    answer: Option<Answer>,
    task: JoinHandle<()>,
}

impl Drop for Request {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Answer {
    health: MetricsState,
    samples: Arc<Samples>,
}

impl Board {
    pub(crate) fn new(context: &str, kind: Kind, hub: Hub, api: watch::Receiver<Api>) -> Self {
        Self {
            context: context.into(),
            kind,
            hub,
            api,
            state: Mutex::default(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("board lock")
    }

    fn join(&self) -> (u64, Arc<Mutex<Pending>>) {
        let mut state = self.state();
        state.next += 1;
        let id = state.next;
        let feed = Arc::default();
        state.members.insert(
            id,
            Member {
                wants: Wants::default(),
                feed: Arc::clone(&feed),
            },
        );
        (id, feed)
    }

    fn leave(self: &Arc<Self>, id: u64) {
        let mut state = self.state();
        state.members.remove(&id);
        self.replan(&mut state);
    }

    fn want(self: &Arc<Self>, id: u64, scopes: HashSet<Scope>) {
        let mut guard = self.state();
        let state = &mut *guard;
        let Some(member) = state.members.get_mut(&id) else {
            return;
        };
        let added: Vec<Scope> = scopes.difference(&member.wants.scopes).cloned().collect();
        member.wants = Wants::new(scopes);
        self.replan(state);
        let member = &state.members[&id];
        for want in &added {
            for (scope, request) in &state.requests {
                if let Some(answer) = request.answer.as_ref().filter(|_| scope.covers(want)) {
                    member.feed.lock().expect("feed lock").reset(Reset {
                        scope: scope.clone(),
                        samples: Arc::clone(&answer.samples),
                    });
                }
            }
        }
    }

    /// A scope covered by another has no request of its own.
    fn replan(self: &Arc<Self>, state: &mut State) {
        let wanted: HashSet<&Scope> = state
            .members
            .values()
            .flat_map(|member| &member.wants.scopes)
            .collect();
        let needed: HashSet<Scope> = if wanted.contains(&Scope::Cluster) {
            HashSet::from([Scope::Cluster])
        } else {
            let namespaces: HashSet<&str> = wanted
                .iter()
                .filter_map(|scope| match scope {
                    Scope::Namespace(namespace) => Some(&**namespace),
                    _ => None,
                })
                .collect();
            wanted
                .iter()
                .filter(|scope| match scope {
                    Scope::Named { namespace, .. } => !namespaces.contains(&**namespace),
                    _ => true,
                })
                .map(|scope| (*scope).clone())
                .collect()
        };
        state.requests.retain(|scope, _| needed.contains(scope));
        for scope in needed {
            state
                .requests
                .entry(scope.clone())
                .or_insert_with(|| Request {
                    answer: None,
                    task: tokio::spawn(poll(Arc::clone(self), scope)),
                });
        }
    }

    fn land(&self, scope: &Scope, health: MetricsState, samples: Samples) {
        let mut guard = self.state();
        let state = &mut *guard;
        let Some(request) = state.requests.get_mut(scope) else {
            return;
        };
        let samples = Arc::new(samples);
        let previous = request.answer.replace(Answer {
            health,
            samples: Arc::clone(&samples),
        });
        let Some(previous) = previous else {
            for member in state.members.values().filter(|m| m.wants.relates(scope)) {
                member.feed.lock().expect("feed lock").reset(Reset {
                    scope: scope.clone(),
                    samples: Arc::clone(&samples),
                });
            }
            return;
        };
        let tell = |namespace: &str, name: &str, sample: Option<&Arc<Sample>>| {
            for member in state.members.values() {
                if member.wants.hears(namespace, name) {
                    member
                        .feed
                        .lock()
                        .expect("feed lock")
                        .changes
                        .insert((namespace.into(), name.into()), sample.cloned());
                }
            }
        };
        for (namespace, name, old) in previous.samples.iter() {
            match samples.get(namespace, name) {
                None => tell(namespace, name, None),
                Some(new) if new != old => tell(namespace, name, Some(new)),
                Some(_) => {}
            }
        }
        for (namespace, name, new) in samples.iter() {
            if previous.samples.get(namespace, name).is_none() {
                tell(namespace, name, Some(new));
            }
        }
    }

    /// A scope not answered yet counts as answering, unless the API is stale.
    fn health(&self, state: &State, wants: &Wants) -> MetricsState {
        let stale = self.api.borrow().stale();
        wants
            .scopes
            .iter()
            .fold(MetricsState::Ready, |worst, want| {
                let request = state
                    .requests
                    .get(want)
                    .or_else(|| state.requests.get(&Scope::Cluster))
                    .or_else(|| match want {
                        Scope::Named { namespace, .. } => {
                            state.requests.get(&Scope::Namespace(namespace.clone()))
                        }
                        _ => None,
                    });
                let health = match request.and_then(|request| request.answer.as_ref()) {
                    Some(answer) => answer.health,
                    None if stale => MetricsState::Unavailable,
                    None => MetricsState::Ready,
                };
                worse(worst, health)
            })
    }
}

/// Failures back off as the hub's upstreams do, and clients abandoned meanwhile are followed as theirs are.
async fn poll(board: Arc<Board>, scope: Scope) {
    let mut backoff = upstream::backoff();
    let mut api = board.api.clone();
    loop {
        let version = loop {
            if let Some(version) = api.borrow_and_update().version() {
                break version;
            }
            if api.changed().await.is_err() {
                return;
            }
        };
        let clients = match board.hub.clients(&board.context).await {
            Ok(clients) => clients,
            Err(error) => {
                board.land(&scope, MetricsState::Unavailable, Samples::default());
                if error.kind == ErrorKind::Unauthorized {
                    return;
                }
                tokio::time::sleep(backoff.next().expect("the backoff has no limit")).await;
                continue;
            }
        };
        let delay = match fetch(&clients, board.kind, version, &scope).await {
            Ok(samples) => {
                backoff = upstream::backoff();
                board.land(&scope, MetricsState::Ready, samples);
                INTERVAL
            }
            Err(Failure::Unauthorized) => {
                board.land(&scope, MetricsState::Unavailable, Samples::default());
                return;
            }
            Err(failure) => {
                let health = match failure {
                    Failure::Forbidden => MetricsState::Forbidden,
                    _ => MetricsState::Unavailable,
                };
                board.land(&scope, health, Samples::default());
                backoff.next().expect("the backoff has no limit")
            }
        };
        let mut abandoned = clients.connections().abandoned();
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            _ = abandoned.wait_for(|abandoned| *abandoned) => {}
        }
    }
}

pub struct Reader {
    context: Arc<Context>,
    kind: Kind,
    id: u64,
    feed: Arc<Mutex<Pending>>,
    wants: HashSet<Scope>,
}

impl Reader {
    pub(super) fn new(context: Arc<Context>, kind: Kind) -> Self {
        let (id, feed) = context.board(kind).join();
        Self {
            context,
            kind,
            id,
            feed,
            wants: HashSet::new(),
        }
    }

    pub fn api(&self) -> Api {
        self.context.api()
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// A scope no reader wants stops being polled at once, with no linger.
    pub fn want(&mut self, scopes: HashSet<Scope>) {
        if scopes != self.wants {
            self.context.board(self.kind).want(self.id, scopes.clone());
            self.wants = scopes;
        }
    }

    pub fn wants(&self) -> &HashSet<Scope> {
        &self.wants
    }

    pub fn drain(&self) -> Update {
        let board = self.context.board(self.kind);
        let state = board.state();
        let mut pending = self.feed.lock().expect("feed lock");
        let wants = state.members.get(&self.id).map(|member| &member.wants);
        Update {
            state: wants
                .filter(|wants| !wants.scopes.is_empty())
                .map(|wants| board.health(&state, wants)),
            resets: std::mem::take(&mut pending.resets),
            changes: pending
                .changes
                .drain()
                .map(|((namespace, name), sample)| Change {
                    namespace,
                    name,
                    sample,
                })
                .collect(),
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.context.board(self.kind).leave(self.id);
    }
}
