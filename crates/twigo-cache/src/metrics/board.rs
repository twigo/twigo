//! The scopes polled for one resource of a context, and the readers that want them.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{Semaphore, watch};
use tokio::task::JoinHandle;
use twigo_ipc::{ErrorKind, MetricsState};

use super::fetch::{Failure, fetch};
use super::sample::{Sample, Samples};
use super::{Api, Context, INTERVAL, Kind, worse};
use crate::hub::Hub;

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
    /// The context's, shared by its boards: one per request under way.
    turns: Arc<Semaphore>,
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
    /// A reader asked for the scope, which restarts the task a credential failure ended.
    again: watch::Sender<()>,
    task: JoinHandle<()>,
}

impl State {
    /// The request that answers a want: the cluster's while it answers, else the want's own or,
    /// for a pod, its namespace's.
    fn serving(&self, want: &Scope) -> Option<&Request> {
        self.requests
            .get(&Scope::Cluster)
            .filter(|cluster| cluster.answers())
            .or_else(|| self.requests.get(want))
            .or_else(|| match want {
                Scope::Named { namespace, .. } => {
                    self.requests.get(&Scope::Namespace(namespace.clone()))
                }
                _ => None,
            })
    }
}

impl Request {
    /// Not answered yet counts as answering.
    fn answers(&self) -> bool {
        self.answer
            .as_ref()
            .is_none_or(|answer| answer.health == MetricsState::Ready)
    }
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
    pub(crate) fn new(
        context: &str,
        kind: Kind,
        hub: Hub,
        api: watch::Receiver<Api>,
        turns: Arc<Semaphore>,
    ) -> Self {
        Self {
            context: context.into(),
            kind,
            hub,
            api,
            turns,
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
        for want in &added {
            if let Some(request) = state.serving(want) {
                request.again.send_replace(());
            }
        }
        let member = &state.members[&id];
        for want in &added {
            for (scope, request) in &state.requests {
                let answer = request.answer.as_ref();
                if let Some(answer) = answer
                    .filter(|answer| answer.health == MetricsState::Ready && scope.covers(want))
                {
                    member.feed.lock().expect("feed lock").reset(Reset {
                        scope: scope.clone(),
                        samples: Arc::clone(&answer.samples),
                    });
                }
            }
        }
    }

    fn settled(&self, id: u64) -> bool {
        let state = self.state();
        state.members.get(&id).is_none_or(|member| {
            member.wants.scopes.iter().all(|want| {
                state
                    .serving(want)
                    .is_some_and(|request| request.answer.is_some())
            })
        })
    }

    fn sample(&self, id: u64, namespace: &str, name: &str) -> Option<Arc<Sample>> {
        let state = self.state();
        let member = state.members.get(&id)?;
        if !member.wants.hears(namespace, name) {
            return None;
        }
        state.requests.values().find_map(|request| {
            request
                .answer
                .as_ref()?
                .samples
                .get(namespace, name)
                .cloned()
        })
    }

    /// A scope covered by another has no request of its own. The cluster covers the others
    /// only while it answers, so one that is forbidden or unavailable hides no namespace.
    fn replan(self: &Arc<Self>, state: &mut State) {
        let wanted: HashSet<&Scope> = state
            .members
            .values()
            .flat_map(|member| &member.wants.scopes)
            .collect();
        let cluster = wanted.contains(&Scope::Cluster);
        let covered = cluster
            && state
                .requests
                .get(&Scope::Cluster)
                .is_none_or(Request::answers);
        let mut needed: HashSet<Scope> = HashSet::new();
        if cluster {
            needed.insert(Scope::Cluster);
        }
        if !covered {
            let namespaces: HashSet<&str> = wanted
                .iter()
                .filter_map(|scope| match scope {
                    Scope::Namespace(namespace) => Some(&**namespace),
                    _ => None,
                })
                .collect();
            needed.extend(
                wanted
                    .iter()
                    .filter(|scope| match scope {
                        Scope::Cluster => false,
                        Scope::Named { namespace, .. } => !namespaces.contains(&**namespace),
                        Scope::Namespace(_) => true,
                    })
                    .map(|scope| (*scope).clone()),
            );
        }
        state.requests.retain(|scope, _| needed.contains(scope));
        for scope in needed {
            state.requests.entry(scope.clone()).or_insert_with(|| {
                let (again, heard) = watch::channel(());
                Request {
                    answer: None,
                    again,
                    task: tokio::spawn(poll(Arc::clone(self), scope, heard)),
                }
            });
        }
    }

    pub(super) fn land(self: &Arc<Self>, scope: &Scope, health: MetricsState, samples: Samples) {
        let mut guard = self.state();
        let state = &mut *guard;
        let Some(request) = state.requests.get_mut(scope) else {
            return;
        };
        let samples = Arc::new(samples);
        let was_answering = request.answers();
        let previous = request.answer.replace(Answer {
            health,
            samples: Arc::clone(&samples),
        });
        if *scope == Scope::Cluster && was_answering != request.answers() {
            self.replan(state);
        }
        let answers = health == MetricsState::Ready;
        let reset = answers && (previous.is_none() || (*scope == Scope::Cluster && !was_answering));
        if reset {
            for member in state.members.values().filter(|m| m.wants.relates(scope)) {
                member.feed.lock().expect("feed lock").reset(Reset {
                    scope: scope.clone(),
                    samples: Arc::clone(&samples),
                });
            }
            return;
        }
        let Some(previous) = previous else {
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

    /// A scope not answered yet counts as answering, unless the API is stale. A reader that
    /// wants the cluster and namespaces too is told by the namespaces while the cluster does
    /// not answer.
    fn health(&self, state: &State, wants: &Wants) -> MetricsState {
        let stale = self.api.borrow().stale();
        let fallen_back = wants.cluster
            && wants.scopes.len() > 1
            && state
                .requests
                .get(&Scope::Cluster)
                .is_some_and(|request| !request.answers());
        wants
            .scopes
            .iter()
            .filter(|want| !(fallen_back && **want == Scope::Cluster))
            .fold(MetricsState::Ready, |worst, want| {
                let health = match state
                    .serving(want)
                    .and_then(|request| request.answer.as_ref())
                {
                    Some(answer) => answer.health,
                    None if stale => MetricsState::Unavailable,
                    None => MetricsState::Ready,
                };
                worse(worst, health)
            })
    }
}

/// A scope is asked again one interval after its last answer, whatever it was: a server that
/// refuses is not worth more requests than one that answers. Clients abandoned meanwhile are
/// followed as the hub's upstreams follow them, and a credential failure ends the run until the
/// clients are rebuilt or a reader asks for the scope anew, as a new subscription restarts one.
async fn poll(board: Arc<Board>, scope: Scope, mut again: watch::Receiver<()>) {
    let mut api = board.api.clone();
    loop {
        again.borrow_and_update();
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
                    if again.changed().await.is_err() {
                        return;
                    }
                    continue;
                }
                tokio::time::sleep(INTERVAL).await;
                continue;
            }
        };
        let fetched = {
            let _turn = board
                .turns
                .acquire()
                .await
                .expect("the semaphore stays open");
            fetch(&clients, board.kind, version, &scope).await
        };
        match fetched {
            Ok(samples) => board.land(&scope, MetricsState::Ready, samples),
            Err(Failure::Unauthorized) => {
                board.land(&scope, MetricsState::Unavailable, Samples::default());
                let mut abandoned = clients.connections().abandoned();
                tokio::select! {
                    asked = again.changed() => if asked.is_err() { return },
                    _ = abandoned.wait_for(|abandoned| *abandoned) => {}
                }
                continue;
            }
            Err(failure) => {
                let health = match failure {
                    Failure::Forbidden => MetricsState::Forbidden,
                    _ => MetricsState::Unavailable,
                };
                board.land(&scope, health, Samples::default());
            }
        }
        let mut abandoned = clients.connections().abandoned();
        tokio::select! {
            () = tokio::time::sleep(INTERVAL) => {}
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

    /// Whether every scope it wants has answered or failed once, and what the poller holds for
    /// it. The check comes first: an answer that lands between the two is in the update and
    /// counted by the next check, where one counted after the update could be left out of it.
    pub fn read(&self) -> (bool, Update) {
        self.read_with(|| {})
    }

    /// `between` runs after the check and before the drain, where a test places an answer.
    pub(super) fn read_with(&self, between: impl FnOnce()) -> (bool, Update) {
        let settled = self.context.board(self.kind).settled(self.id);
        between();
        (settled, self.drain())
    }

    /// The sample the answers hold of a key this reader wants, and none of another's.
    pub fn sample(&self, namespace: &str, name: &str) -> Option<Arc<Sample>> {
        self.context
            .board(self.kind)
            .sample(self.id, namespace, name)
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
