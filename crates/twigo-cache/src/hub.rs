//! The watch hub (ARCHITECTURE 3.2): one upstream per context, resource,
//! scope, server-side selectors and form, shared by every subscription.
//!
//! - An upstream counts its subscriptions and lingers for [`LINGER`] after
//!   the last leaves, so going back and forth costs nothing.
//! - When a watch waits for the context's budget, the least recently used
//!   idle upstream of the context is evicted; with none, the watch stays
//!   `queued`.
//! - A subscription to a few namespaces gets an upstream per namespace;
//!   to every namespace, or more than [`NAMESPACES`], one cluster-wide
//!   upstream when the person may list the resource cluster-wide, filtered
//!   by namespace in Rust.
//! - Hysteresis: a cluster-wide upstream serves narrower subscriptions too,
//!   without holding it. Once it has lingered, they move to upstreams per
//!   namespace, keeping its rows until theirs are listed.

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, select_all};
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use kube::Api;
use kube::api::PostParams;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use twigo_ipc::ViewState;

use crate::cluster::Cluster;
use crate::decode::Decode;
use crate::meta::MetaDecoder;
use crate::object::{Object, ObjectDecoder};
use crate::request::Format;
use crate::store::Item;
use crate::table::{Column, Row, TableDecoder};
use crate::upstream::{self, Env, Spec, Upstream};

pub use crate::upstream::Connect;

/// How long an upstream outlives its last subscription.
pub const LINGER: Duration = Duration::from_secs(60);
/// More namespaces than this share one cluster-wide upstream.
pub const NAMESPACES: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Resource {
    /// Empty for the core group.
    pub group: String,
    pub version: String,
    /// The plural, such as `pods`.
    pub resource: String,
    pub namespaced: bool,
}

impl Resource {
    fn path(&self, scope: &Scope) -> String {
        let base = if self.group.is_empty() {
            format!("/api/{}", self.version)
        } else {
            format!("/apis/{}/{}", self.group, self.version)
        };
        match scope {
            Scope::Cluster => format!("{base}/{}", self.resource),
            Scope::Namespace(namespace) => {
                format!("{base}/namespaces/{namespace}/{}", self.resource)
            }
        }
    }

    /// As kubectl names it: `pods`, `deployments.apps`.
    fn name(&self) -> String {
        if self.group.is_empty() {
            self.resource.clone()
        } else {
            format!("{}.{}", self.resource, self.group)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowFormat {
    Table,
    Metadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    pub context: String,
    pub resource: Resource,
    pub format: RowFormat,
    /// Empty for every namespace.
    pub namespaces: Vec<String>,
    pub field_selector: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Scope {
    Cluster,
    Namespace(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    context: String,
    resource: Resource,
    format: Format,
    scope: Scope,
    field_selector: Option<String>,
}

impl Key {
    fn with_scope(&self, scope: Scope) -> Self {
        Key {
            scope,
            ..self.clone()
        }
    }

    fn spec(&self) -> Spec {
        Spec {
            context: self.context.clone(),
            path: self.resource.path(&self.scope),
            format: self.format,
            field_selector: self.field_selector.clone(),
            resource: self.resource.name(),
        }
    }
}

#[derive(Clone)]
pub struct Hub {
    inner: Arc<Inner>,
}

struct Inner {
    connect: Connect,
    clusters: Mutex<HashMap<String, Arc<Cluster>>>,
    registry: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    entries: HashMap<Key, Entry>,
    next_borrower: u64,
}

struct Entry {
    upstream: Arc<dyn Any + Send + Sync>,
    state: watch::Receiver<ViewState>,
    task: JoinHandle<()>,
    subscribers: usize,
    /// Subscriptions it serves without being held, each told to move off
    /// once it has lingered.
    borrowers: HashMap<u64, Arc<dyn Fn() + Send + Sync>>,
    /// Since when nothing holds it.
    idle_since: Option<Instant>,
    /// Counts its lingers, so a timer of an earlier one does nothing.
    linger: u64,
    /// It has lingered out while subscriptions borrowed it.
    expired: bool,
    /// Its watch waits for the budget, and whether an eviction was made
    /// for it.
    queued: bool,
    served: bool,
}

impl Entry {
    fn failed(&self) -> bool {
        failed(&self.state.borrow())
    }

    /// Nothing shows it: evictable.
    fn idle(&self) -> bool {
        self.subscribers == 0 && self.borrowers.is_empty()
    }
}

fn failed(state: &ViewState) -> bool {
    matches!(
        state,
        ViewState::Forbidden { .. } | ViewState::Unauthorized | ViewState::Error { .. }
    )
}

impl Hub {
    pub fn new(connect: Connect) -> Self {
        Self {
            inner: Arc::new(Inner {
                connect,
                clusters: Mutex::default(),
                registry: Mutex::default(),
            }),
        }
    }

    /// The rows of a resource in the query's namespaces.
    pub async fn rows(&self, query: Query) -> Subscription<Row> {
        let format = match query.format {
            RowFormat::Table => Format::Table,
            RowFormat::Metadata => Format::Metadata,
        };
        let key = Key {
            context: query.context.clone(),
            resource: query.resource.clone(),
            format,
            scope: Scope::Cluster,
            field_selector: query.field_selector.clone(),
        };
        // A cluster-scoped resource has no namespaces to filter by.
        let namespaces: &[String] = if query.resource.namespaced {
            &query.namespaces
        } else {
            &[]
        };
        let cluster_wide =
            namespaces.is_empty() || (namespaces.len() > NAMESPACES && self.may_list(&query).await);
        let mut subscription = Subscription::new(key.clone(), namespaces);
        if cluster_wide {
            let part = self.hold(&key, subscription.filter());
            subscription.set_parts(vec![part]);
        } else if let Some(part) = self.borrow(&key, &subscription) {
            subscription.set_parts(vec![part]);
            // It may have lingered out before the part was in place.
            if self.inner.expired(&key) {
                let moving = Arc::downgrade(&subscription.inner);
                tokio::spawn(move_off(moving, self.clone(), key));
            }
        } else {
            let parts = self.per_namespace(&key, namespaces);
            subscription.set_parts(parts);
        }
        subscription
    }

    /// An object, followed by an Object upstream for its editor.
    pub fn object(
        &self,
        context: &str,
        resource: Resource,
        namespace: Option<String>,
        name: &str,
    ) -> Subscription<Object> {
        let key = Key {
            context: context.to_owned(),
            resource,
            format: Format::Object,
            scope: namespace.map_or(Scope::Cluster, Scope::Namespace),
            field_selector: Some(format!("metadata.name={name}")),
        };
        let mut subscription = Subscription::new(key.clone(), &[]);
        let part = self.hold(&key, None);
        subscription.set_parts(vec![part]);
        subscription
    }

    /// The scope of the upstream behind each key held, for tests.
    #[cfg(test)]
    fn scopes(&self) -> Vec<Scope> {
        let registry = self.inner.registry();
        let mut scopes: Vec<Scope> = registry
            .entries
            .keys()
            .map(|key| key.scope.clone())
            .collect();
        scopes.sort_by_key(|scope| format!("{scope:?}"));
        scopes
    }

    fn per_namespace<T: Item>(&self, key: &Key, namespaces: &[String]) -> Vec<Part<T>>
    where
        Self: Spawn<T>,
    {
        namespaces
            .iter()
            .map(|namespace| self.hold(&key.with_scope(Scope::Namespace(namespace.clone())), None))
            .collect()
    }

    /// Holds the upstream of `key`, started if there is none or if it
    /// failed.
    fn hold<T: Item>(&self, key: &Key, filter: Option<Arc<HashSet<String>>>) -> Part<T>
    where
        Self: Spawn<T>,
    {
        let mut abort = None;
        let upstream = {
            let mut registry = self.inner.registry();
            match registry.entries.get_mut(key) {
                Some(entry) => {
                    entry.subscribers += 1;
                    entry.idle_since = None;
                    entry.expired = false;
                    let upstream = Arc::clone(&entry.upstream)
                        .downcast::<Upstream<T>>()
                        .expect("a key's form fixes its upstream's items");
                    if entry.failed() {
                        let task = self.spawn(key, Arc::clone(&upstream));
                        abort = Some(std::mem::replace(&mut entry.task, task));
                    }
                    upstream
                }
                None => {
                    let upstream = Arc::new(Upstream::<T>::new());
                    let entry = Entry {
                        upstream: Arc::clone(&upstream) as Arc<dyn Any + Send + Sync>,
                        state: upstream.state(),
                        task: self.spawn(key, Arc::clone(&upstream)),
                        subscribers: 1,
                        borrowers: HashMap::new(),
                        idle_since: None,
                        linger: 0,
                        expired: false,
                        queued: false,
                        served: false,
                    };
                    registry.entries.insert(key.clone(), entry);
                    upstream
                }
            }
        };
        if let Some(task) = abort {
            task.abort();
        }
        Part {
            upstream,
            filter,
            guard: Guard::Hold {
                hub: Arc::downgrade(&self.inner),
                key: key.clone(),
            },
        }
    }

    /// A part served by the running cluster-wide upstream of `key`, if
    /// there is one that has not failed or lingered out.
    fn borrow<T: Item>(&self, key: &Key, subscription: &Subscription<T>) -> Option<Part<T>>
    where
        Self: Spawn<T>,
    {
        let mut registry = self.inner.registry();
        let id = registry.next_borrower;
        let entry = registry
            .entries
            .get_mut(key)
            .filter(|entry| !entry.failed() && !entry.expired)?;
        let upstream = Arc::clone(&entry.upstream)
            .downcast::<Upstream<T>>()
            .expect("a key's form fixes its upstream's items");
        let moving = Arc::downgrade(&subscription.inner);
        let hub = self.clone();
        let from = key.clone();
        entry.borrowers.insert(
            id,
            Arc::new(move || {
                tokio::spawn(move_off(moving.clone(), hub.clone(), from.clone()));
            }),
        );
        registry.next_borrower += 1;
        drop(registry);
        Some(Part {
            upstream,
            filter: subscription.filter(),
            guard: Guard::Borrow {
                hub: Arc::downgrade(&self.inner),
                key: key.clone(),
                id,
            },
        })
    }

    /// Whether the person may list the query's resource cluster-wide: one
    /// SelfSubjectAccessReview, kept with the context's clients.
    async fn may_list(&self, query: &Query) -> bool {
        let Ok(clients) = (self.inner.connect)(query.context.clone()).await else {
            return false;
        };
        let cluster = self.inner.cluster(&query.context);
        let resource = &query.resource;
        if let Some(may) = cluster.may_list(&clients, &resource.group, &resource.resource) {
            return may;
        }
        let review = SelfSubjectAccessReview {
            spec: SelfSubjectAccessReviewSpec {
                resource_attributes: Some(ResourceAttributes {
                    verb: Some("list".to_owned()),
                    group: Some(resource.group.clone()),
                    resource: Some(resource.resource.clone()),
                    ..ResourceAttributes::default()
                }),
                ..SelfSubjectAccessReviewSpec::default()
            },
            ..SelfSubjectAccessReview::default()
        };
        let reviews = Api::<SelfSubjectAccessReview>::all(clients.api.clone());
        match reviews.create(&PostParams::default(), &review).await {
            Ok(answer) => {
                let may = answer.status.is_some_and(|status| status.allowed);
                cluster.set_may_list(&clients, &resource.group, &resource.resource, may);
                may
            }
            Err(_) => false,
        }
    }
}

/// Starts the run of an upstream with the decoder of its items.
trait Spawn<T> {
    fn spawn(&self, key: &Key, upstream: Arc<Upstream<T>>) -> JoinHandle<()>;
}

impl Spawn<Row> for Hub {
    fn spawn(&self, key: &Key, upstream: Arc<Upstream<Row>>) -> JoinHandle<()> {
        match key.format {
            Format::Table => self.start(key, TableDecoder::new(), upstream),
            Format::Metadata => self.start(key, MetaDecoder, upstream),
            Format::Object => unreachable!("an Object upstream keeps objects"),
        }
    }
}

impl Spawn<Object> for Hub {
    fn spawn(&self, key: &Key, upstream: Arc<Upstream<Object>>) -> JoinHandle<()> {
        self.start(key, ObjectDecoder, upstream)
    }
}

impl Hub {
    fn start<D: Decode>(
        &self,
        key: &Key,
        decoder: D,
        upstream: Arc<Upstream<D::Item>>,
    ) -> JoinHandle<()>
    where
        D::Item: Item,
    {
        let hub = Arc::downgrade(&self.inner);
        let waiting = key.clone();
        let env = Env {
            connect: Arc::clone(&self.inner.connect),
            cluster: self.inner.cluster(&key.context),
            waiting: Arc::new(move |queued| {
                if let Some(hub) = hub.upgrade() {
                    hub.waiting(&waiting, queued);
                }
            }),
        };
        tokio::spawn(upstream::run(env, key.spec(), decoder, upstream))
    }
}

impl Inner {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().expect("hub lock")
    }

    fn cluster(&self, context: &str) -> Arc<Cluster> {
        let mut clusters = self.clusters.lock().expect("clusters lock");
        Arc::clone(clusters.entry(context.to_owned()).or_default())
    }

    fn expired(&self, key: &Key) -> bool {
        self.registry()
            .entries
            .get(key)
            .is_some_and(|entry| entry.expired)
    }

    /// A watch of `key` waits for the budget, or stops waiting.
    fn waiting(&self, key: &Key, queued: bool) {
        let mut registry = self.registry();
        let evicted = {
            let Some(entry) = registry.entries.get_mut(key) else {
                return;
            };
            entry.queued = queued;
            entry.served = false;
            if !queued {
                return;
            }
            evict(&mut registry, key)
        };
        if let Some(entry) = registry.entries.get_mut(key) {
            entry.served = evicted.is_some();
        }
        drop(registry);
        if let Some(task) = evicted {
            task.abort();
        }
    }

    fn release(self: &Arc<Self>, key: &Key) {
        let mut registry = self.registry();
        let Some(entry) = registry.entries.get_mut(key) else {
            return;
        };
        entry.subscribers -= 1;
        if entry.subscribers > 0 {
            return;
        }
        entry.idle_since = Some(Instant::now());
        entry.linger += 1;
        let linger = entry.linger;
        let hub = Arc::downgrade(self);
        let expiring = key.clone();
        tokio::spawn(async move {
            tokio::time::sleep(LINGER).await;
            if let Some(hub) = hub.upgrade() {
                hub.expire(&expiring, linger);
            }
        });
        // A watch that waits for the budget takes this one's place at once.
        let evicted = if entry.idle() && !entry.queued {
            let waiting = registry.entries.iter_mut().find(|(other, entry)| {
                other.context == key.context && entry.queued && !entry.served
            });
            match waiting {
                Some((_, entry)) => {
                    entry.served = true;
                    registry.entries.remove(key).map(|entry| entry.task)
                }
                None => None,
            }
        } else {
            None
        };
        drop(registry);
        if let Some(task) = evicted {
            task.abort();
        }
    }

    fn expire(&self, key: &Key, linger: u64) {
        let mut registry = self.registry();
        let Some(entry) = registry.entries.get_mut(key) else {
            return;
        };
        if entry.subscribers > 0 || entry.linger != linger {
            return;
        }
        if entry.borrowers.is_empty() {
            let task = registry.entries.remove(key).map(|entry| entry.task);
            drop(registry);
            if let Some(task) = task {
                task.abort();
            }
            return;
        }
        entry.expired = true;
        let moves: Vec<_> = entry.borrowers.values().cloned().collect();
        drop(registry);
        for move_off in moves {
            move_off();
        }
    }

    fn unborrow(&self, key: &Key, id: u64) {
        let mut registry = self.registry();
        let Some(entry) = registry.entries.get_mut(key) else {
            return;
        };
        entry.borrowers.remove(&id);
        let gone = entry.expired && entry.idle();
        let task = gone
            .then(|| registry.entries.remove(key).map(|entry| entry.task))
            .flatten();
        drop(registry);
        if let Some(task) = task {
            task.abort();
        }
    }
}

/// Removes the least recently used idle upstream that holds a watch in the
/// context of `waiting`, and gives its task to abort once the lock is let
/// go.
fn evict(registry: &mut Registry, waiting: &Key) -> Option<JoinHandle<()>> {
    let victim = registry
        .entries
        .iter()
        .filter(|(key, entry)| {
            key.context == waiting.context && *key != waiting && entry.idle() && !entry.queued
        })
        .min_by_key(|(_, entry)| entry.idle_since)
        .map(|(key, _)| key.clone())?;
    registry.entries.remove(&victim).map(|entry| entry.task)
}

/// What a subscription's part holds of its upstream.
enum Guard {
    Hold { hub: Weak<Inner>, key: Key },
    Borrow { hub: Weak<Inner>, key: Key, id: u64 },
}

impl Drop for Guard {
    fn drop(&mut self) {
        match self {
            Guard::Hold { hub, key } => {
                if let Some(hub) = hub.upgrade() {
                    hub.release(key);
                }
            }
            Guard::Borrow { hub, key, id } => {
                if let Some(hub) = hub.upgrade() {
                    hub.unborrow(key, *id);
                }
            }
        }
    }
}

struct Part<T> {
    upstream: Arc<Upstream<T>>,
    /// The namespaces a cluster-wide upstream serves this subscription.
    filter: Option<Arc<HashSet<String>>>,
    guard: Guard,
}

impl<T> Part<T> {
    fn borrowed_from(&self, key: &Key) -> bool {
        matches!(&self.guard, Guard::Borrow { key: borrowed, .. } if borrowed == key)
    }
}

/// A view's subscription: the upstreams its namespaces need, whose rows
/// it reads as one.
pub struct Subscription<T> {
    inner: Arc<SubscriptionInner<T>>,
    seen: Seen,
}

struct SubscriptionInner<T> {
    key: Key,
    namespaces: Vec<String>,
    parts: Mutex<Vec<Part<T>>>,
    /// Counts the times the parts changed.
    swapped: watch::Sender<u64>,
}

/// What [`Subscription::changed`] has seen of each part.
struct Seen {
    swapped: watch::Receiver<u64>,
    parts: Vec<(watch::Receiver<ViewState>, watch::Receiver<u64>)>,
}

impl<T: Item> Subscription<T> {
    fn new(key: Key, namespaces: &[String]) -> Self {
        let swapped = watch::Sender::new(0);
        Self {
            seen: Seen {
                swapped: swapped.subscribe(),
                parts: Vec::new(),
            },
            inner: Arc::new(SubscriptionInner {
                key,
                namespaces: namespaces.to_vec(),
                parts: Mutex::default(),
                swapped,
            }),
        }
    }

    fn filter(&self) -> Option<Arc<HashSet<String>>> {
        (!self.inner.namespaces.is_empty())
            .then(|| Arc::new(self.inner.namespaces.iter().cloned().collect()))
    }

    fn set_parts(&mut self, parts: Vec<Part<T>>) {
        *self.inner.parts() = parts;
        self.seen.refresh(&self.inner);
    }

    /// The state of the subscription: its least ready part's.
    pub fn state(&self) -> ViewState {
        let parts = self.inner.parts();
        combine(
            parts
                .iter()
                .map(|part| part.upstream.state().borrow().clone()),
        )
    }

    /// Its rows, from every part.
    pub fn items(&self) -> Vec<Arc<T>> {
        let parts = self.inner.parts();
        let mut items = Vec::new();
        for part in parts.iter() {
            items.extend(part.upstream.store.items(|item| {
                match &part.filter {
                    Some(namespaces) => item
                        .meta()
                        .namespace
                        .as_deref()
                        .is_some_and(|namespace| namespaces.contains(namespace)),
                    None => true,
                }
            }));
        }
        items
    }

    /// Waits for a change of its rows, its columns or its state.
    pub async fn changed(&mut self) {
        if self.seen.swapped.has_changed().unwrap_or(false) {
            self.seen.refresh(&self.inner);
            return;
        }
        let mut waits: Vec<BoxFuture<'_, ()>> = Vec::new();
        waits.push(
            async {
                if self.seen.swapped.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
            .boxed(),
        );
        for (state, version) in &mut self.seen.parts {
            waits.push(
                async {
                    tokio::select! {
                        changed = state.changed() => if changed.is_err() { std::future::pending::<()>().await },
                        changed = version.changed() => if changed.is_err() { std::future::pending::<()>().await },
                    }
                }
                .boxed(),
            );
        }
        select_all(waits).await;
        if self.seen.swapped.has_changed().unwrap_or(false) {
            self.seen.refresh(&self.inner);
        }
    }
}

impl Seen {
    /// Marks the parts as they are now as seen.
    fn refresh<T: Item>(&mut self, subscription: &SubscriptionInner<T>) {
        self.swapped.borrow_and_update();
        self.parts = subscription
            .parts()
            .iter()
            .map(|part| {
                let mut state = part.upstream.state();
                let mut version = part.upstream.store.version();
                state.borrow_and_update();
                version.borrow_and_update();
                (state, version)
            })
            .collect();
    }
}

impl Subscription<Row> {
    /// The columns of a Table upstream.
    pub fn columns(&self) -> Option<Arc<[Column]>> {
        let parts = self.inner.parts();
        parts.iter().find_map(|part| part.upstream.store.columns())
    }
}

impl<T> SubscriptionInner<T> {
    fn parts(&self) -> MutexGuard<'_, Vec<Part<T>>> {
        self.parts.lock().expect("subscription lock")
    }
}

/// Moves off the cluster-wide upstream of `from` to upstreams per
/// namespace, once those are listed; nothing if the subscription ends
/// first.
async fn move_off<T: Item>(subscription: Weak<SubscriptionInner<T>>, hub: Hub, from: Key)
where
    Hub: Spawn<T>,
{
    let Some((parts, mut swapped)) = subscription.upgrade().map(|subscription| {
        let parts = hub.per_namespace(&subscription.key, &subscription.namespaces);
        (parts, subscription.swapped.subscribe())
    }) else {
        return;
    };
    let mut states: Vec<_> = parts.iter().map(|part| part.upstream.state()).collect();
    let listed = async {
        for state in &mut states {
            // Ends with the upstream, which the part holds.
            let _ = state
                .wait_for(|state| {
                    matches!(state, ViewState::Ready | ViewState::Stale) || failed(state)
                })
                .await;
        }
    };
    let ended = async { while swapped.changed().await.is_ok() {} };
    tokio::select! {
        () = listed => {}
        () = ended => return,
    }
    let Some(subscription) = subscription.upgrade() else {
        return;
    };
    let replaced = {
        let mut held = subscription.parts();
        let Some(at) = held.iter().position(|part| part.borrowed_from(&from)) else {
            return;
        };
        let replaced = held.remove(at);
        held.extend(parts);
        replaced
    };
    subscription.swapped.send_modify(|swaps| *swaps += 1);
    drop(replaced);
}

/// The least ready of the parts' states; syncing parts add up.
fn combine(states: impl Iterator<Item = ViewState>) -> ViewState {
    let rank = |state: &ViewState| match state {
        ViewState::Ready => 0,
        ViewState::Stale => 1,
        ViewState::Relisting => 2,
        ViewState::Syncing { .. } => 3,
        ViewState::Connecting => 4,
        ViewState::Queued => 5,
        ViewState::Forbidden { .. } => 6,
        ViewState::Unauthorized => 7,
        ViewState::Error { .. } => 8,
    };
    let mut worst = ViewState::Ready;
    let mut loaded = 0u32;
    for state in states {
        if let ViewState::Syncing { loaded: some } = state {
            loaded = loaded.saturating_add(some);
        }
        if rank(&state) > rank(&worst) {
            worst = state;
        }
    }
    match worst {
        ViewState::Syncing { .. } => ViewState::Syncing { loaded },
        worst => worst,
    }
}

#[cfg(test)]
mod live;
#[cfg(test)]
mod tests;
