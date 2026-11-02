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
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use twigo_ipc::{ErrorKind, IpcError, ViewState};
use twigo_kube::client::Clients;

use crate::cluster::Cluster;
use crate::decode::Decode;
use crate::meta::MetaDecoder;
use crate::object::{Object, ObjectDecoder};
use crate::request::Format;
use crate::store::{Drained, Feed, Item, RowKey};
use crate::table::{Column, Row, TableDecoder};
use crate::upstream::{self, Env, Spec, Upstream};

pub use crate::upstream::{Connect, RETRY_WITHIN};

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

/// What a path segment keeps as it is: the unreserved characters of
/// RFC 3986, which every Kubernetes name is made of.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// A name that can be no path segment, as Kubernetes' own
/// `IsValidPathSegmentName` refuses it: the API server decodes `%2F`
/// before it routes, so escaping would not keep it in its segment.
fn segment(name: &str) -> Result<(), IpcError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '%']) {
        return Err(IpcError {
            kind: ErrorKind::InvalidInput,
            message: format!("{name:?} can be no name in a request's path"),
        });
    }
    Ok(())
}

impl Resource {
    fn check(&self) -> Result<(), IpcError> {
        if !self.group.is_empty() {
            segment(&self.group)?;
        }
        segment(&self.version)?;
        segment(&self.resource)
    }

    /// Its collection's path, each name escaped.
    fn path(&self, scope: &Scope) -> String {
        let segment = |name: &str| utf8_percent_encode(name, SEGMENT).to_string();
        let base = if self.group.is_empty() {
            format!("/api/{}", segment(&self.version))
        } else {
            format!("/apis/{}/{}", segment(&self.group), segment(&self.version))
        };
        let resource = segment(&self.resource);
        match scope {
            Scope::Cluster => format!("{base}/{resource}"),
            Scope::Namespace(namespace) => {
                format!("{base}/namespaces/{}/{resource}", segment(namespace))
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
    /// Numbers every linger, so the timer of one that ended does nothing,
    /// in this entry or in one created for the same key since.
    next_linger: u64,
    /// Numbers every run, so what an aborted one says when it goes is not
    /// taken for its successor's.
    next_run: u64,
}

struct Entry {
    upstream: Arc<dyn Running>,
    state: watch::Receiver<ViewState>,
    task: JoinHandle<()>,
    run: u64,
    subscribers: usize,
    /// Subscriptions it serves without being held, each told to move off
    /// once it has lingered.
    borrowers: HashMap<u64, Arc<dyn Fn() + Send + Sync>>,
    /// Since when nothing holds it.
    idle_since: Option<Instant>,
    linger: u64,
    /// It has lingered out while subscriptions borrowed it.
    expired: bool,
    /// Since when its watch waits for the budget, and whether an eviction
    /// was made for it.
    queued: Option<Instant>,
    served: bool,
}

impl Entry {
    fn failed(&self) -> bool {
        failed(&self.state.borrow())
    }

    /// Nothing shows it.
    fn idle(&self) -> bool {
        self.subscribers == 0 && self.borrowers.is_empty()
    }

    /// Evicting it frees a watch.
    fn evictable(&self) -> bool {
        self.idle() && self.upstream.watching()
    }
}

/// What the registry asks of an upstream, whatever its items.
trait Running: Send + Sync {
    fn watching(&self) -> bool;
    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;
}

impl<T: Item> Running for Upstream<T> {
    fn watching(&self) -> bool {
        Upstream::watching(self)
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
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

    /// The context's clients, as its upstreams get them.
    pub async fn clients(&self, context: &str) -> Result<Arc<Clients>, IpcError> {
        (self.inner.connect)(context.to_owned()).await
    }

    /// The rows of a resource in the query's namespaces, unless a name
    /// can be no path segment.
    pub async fn rows(&self, query: Query) -> Result<Subscription<Row>, IpcError> {
        query.resource.check()?;
        for namespace in &query.namespaces {
            segment(namespace)?;
        }
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
        // A cluster-scoped resource has no namespaces to filter by, and a
        // namespace named twice gets one part.
        let mut namespaces = if query.resource.namespaced {
            query.namespaces.clone()
        } else {
            Vec::new()
        };
        namespaces.sort();
        namespaces.dedup();
        let namespaces = &namespaces[..];
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
        Ok(subscription)
    }

    /// An object, followed by an Object upstream for its editor, unless a
    /// name can be no path segment.
    pub fn object(
        &self,
        context: &str,
        resource: Resource,
        namespace: Option<String>,
        name: &str,
    ) -> Result<Subscription<Object>, IpcError> {
        resource.check()?;
        if let Some(namespace) = &namespace {
            segment(namespace)?;
        }
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
        Ok(subscription)
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

    /// Holds the upstream of `key`, started if there is none or if its run
    /// ended, as rejected credentials end it.
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
                        .into_any()
                        .downcast::<Upstream<T>>()
                        .expect("a key's form fixes its upstream's items");
                    if upstream.ended() {
                        upstream.restart();
                        registry.next_run += 1;
                        let run = registry.next_run;
                        let Some(entry) = registry.entries.get_mut(key) else {
                            unreachable!("found under the same lock");
                        };
                        entry.run = run;
                        let task = self.spawn(key, Arc::clone(&upstream), run);
                        abort = Some(std::mem::replace(&mut entry.task, task));
                    }
                    upstream
                }
                None => {
                    let upstream = Arc::new(Upstream::<T>::new());
                    registry.next_run += 1;
                    let run = registry.next_run;
                    let entry = Entry {
                        upstream: Arc::clone(&upstream) as Arc<dyn Running>,
                        state: upstream.state(),
                        task: self.spawn(key, Arc::clone(&upstream), run),
                        run,
                        subscribers: 1,
                        borrowers: HashMap::new(),
                        idle_since: None,
                        linger: 0,
                        expired: false,
                        queued: None,
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
            feed: upstream.store.feed(),
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
            .into_any()
            .downcast::<Upstream<T>>()
            .expect("a key's form fixes its upstream's items");
        let moving = Arc::downgrade(&subscription.inner);
        let hub = Arc::downgrade(&self.inner);
        let from = key.clone();
        entry.borrowers.insert(
            id,
            Arc::new(move || {
                if let Some(inner) = hub.upgrade() {
                    let hub = Hub { inner };
                    tokio::spawn(move_off(moving.clone(), hub, from.clone()));
                }
            }),
        );
        registry.next_borrower += 1;
        drop(registry);
        Some(Part {
            feed: upstream.store.feed(),
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
    fn spawn(&self, key: &Key, upstream: Arc<Upstream<T>>, run: u64) -> JoinHandle<()>;
}

impl Spawn<Row> for Hub {
    fn spawn(&self, key: &Key, upstream: Arc<Upstream<Row>>, run: u64) -> JoinHandle<()> {
        match key.format {
            Format::Table => self.start(key, TableDecoder::new(), upstream, run),
            Format::Metadata => self.start(key, MetaDecoder, upstream, run),
            Format::Object => unreachable!("an Object upstream keeps objects"),
        }
    }
}

impl Spawn<Object> for Hub {
    fn spawn(&self, key: &Key, upstream: Arc<Upstream<Object>>, run: u64) -> JoinHandle<()> {
        self.start(key, ObjectDecoder, upstream, run)
    }
}

impl Hub {
    fn start<D: Decode>(
        &self,
        key: &Key,
        decoder: D,
        upstream: Arc<Upstream<D::Item>>,
        run: u64,
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
                    hub.waiting(&waiting, run, queued);
                }
            }),
        };
        tokio::spawn(upstream::run(env, key.spec(), decoder, upstream))
    }
}

impl Drop for Inner {
    /// Its upstreams go with it.
    fn drop(&mut self) {
        let registry = self.registry.get_mut().expect("hub lock");
        for entry in registry.entries.values() {
            entry.task.abort();
        }
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

    /// A watch of `key`'s `run` waits for the budget, or stops waiting.
    fn waiting(&self, key: &Key, run: u64, queued: bool) {
        let mut registry = self.registry();
        let Some(entry) = registry
            .entries
            .get_mut(key)
            .filter(|entry| entry.run == run)
        else {
            return;
        };
        entry.queued = queued.then(Instant::now);
        entry.served = false;
        if !queued {
            return;
        }
        if entry.idle() {
            // Nobody shows it: it would take a watch from one that is shown.
            let task = registry.entries.remove(key).map(|entry| entry.task);
            drop(registry);
            if let Some(task) = task {
                task.abort();
            }
            return;
        }
        let evicted = evict(&mut registry, &key.context);
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
        if entry.borrowers.is_empty() && entry.queued.is_some() {
            // Nobody shows it, and it would take the next free watch from
            // one that is shown.
            let task = registry.entries.remove(key).map(|entry| entry.task);
            drop(registry);
            if let Some(task) = task {
                task.abort();
            }
            return;
        }
        entry.idle_since = Some(Instant::now());
        registry.next_linger += 1;
        let linger = registry.next_linger;
        if let Some(entry) = registry.entries.get_mut(key) {
            entry.linger = linger;
        }
        let hub = Arc::downgrade(self);
        let expiring = key.clone();
        tokio::spawn(async move {
            tokio::time::sleep(LINGER).await;
            if let Some(hub) = hub.upgrade() {
                hub.expire(&expiring, linger);
            }
        });
        let evicted = make_way(&mut registry, key);
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
        let task = if entry.idle() && (entry.expired || entry.queued.is_some()) {
            serve(&mut registry, &key.context, key);
            registry.entries.remove(key).map(|entry| entry.task)
        } else {
            make_way(&mut registry, key)
        };
        drop(registry);
        if let Some(task) = task {
            task.abort();
        }
    }
}

/// For a watch of `context` that waits for the budget, removes the least
/// recently used idle upstream that holds a watch there, and gives its
/// task to abort once the lock is let go.
fn evict(registry: &mut Registry, context: &str) -> Option<JoinHandle<()>> {
    let victim = registry
        .entries
        .iter()
        .filter(|(key, entry)| key.context == context && entry.evictable())
        .min_by_key(|(_, entry)| entry.idle_since)
        .map(|(key, _)| key.clone())?;
    serve(registry, context, &victim);
    registry.entries.remove(&victim).map(|entry| entry.task)
}

/// An upstream that just went idle makes way for a watch of its context
/// that waits for the budget.
fn make_way(registry: &mut Registry, key: &Key) -> Option<JoinHandle<()>> {
    let evictable = registry.entries.get(key).is_some_and(Entry::evictable);
    if !(evictable && serve(registry, &key.context, key)) {
        return None;
    }
    registry.entries.remove(key).map(|entry| entry.task)
}

/// Marks the watch of `context` that has waited longest, and no eviction
/// served yet, as the one the watch `freed` holds goes to: the counter
/// admits waiters in order. Says whether one waits; nothing does if
/// `freed` holds no watch.
fn serve(registry: &mut Registry, context: &str, freed: &Key) -> bool {
    if !registry
        .entries
        .get(freed)
        .is_some_and(|entry| entry.upstream.watching())
    {
        return false;
    }
    let first = registry
        .entries
        .iter_mut()
        .filter(|(key, entry)| key.context == context && entry.queued.is_some() && !entry.served)
        .min_by_key(|(_, entry)| entry.queued);
    match first {
        Some((_, entry)) => {
            entry.served = true;
            true
        }
        None => false,
    }
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
    /// What changed in the upstream's store since [`Subscription::drain`].
    feed: Feed,
    guard: Guard,
}

impl<T> Part<T> {
    fn borrowed_from(&self, key: &Key) -> bool {
        matches!(&self.guard, Guard::Borrow { key: borrowed, .. } if borrowed == key)
    }
}

impl<T: Item> Part<T> {
    fn serves(&self, item: &T) -> bool {
        match &self.filter {
            Some(namespaces) => item
                .meta()
                .namespace
                .as_deref()
                .is_some_and(|namespace| namespaces.contains(namespace)),
            None => true,
        }
    }

    fn items(&self) -> Vec<Arc<T>> {
        self.upstream.store.items(|item| self.serves(item))
    }
}

/// What changed in a subscription's rows since it was last drained.
pub enum Delta<T> {
    /// Every row, which replaces what the reader holds, and the columns of
    /// a Table upstream: the first drain, and the one after a relist, new
    /// columns or new parts.
    Reset {
        rows: Vec<Arc<T>>,
        columns: Option<Arc<[Column]>>,
    },
    Changed {
        upserted: Vec<Arc<T>>,
        /// Rows gone, and rows of namespaces the subscription does not
        /// show, which it never held.
        removed: Vec<RowKey>,
    },
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

    /// Every part has held a whole list since it started, so the rows are
    /// all there, if maybe stale.
    pub fn listed(&self) -> bool {
        self.inner.parts().iter().all(|part| part.upstream.listed())
    }

    /// Its rows once every part has listed them, if maybe stale since; or
    /// the state that refuses them, or `stale` when a first list has
    /// failed for two of the longest backoffs.
    pub async fn whole(&mut self) -> Result<Vec<Arc<T>>, ViewState> {
        loop {
            let state = self.state();
            match state {
                ViewState::Forbidden { .. } | ViewState::Unauthorized | ViewState::Error { .. } => {
                    return Err(state);
                }
                _ if self.listed() => return Ok(self.items()),
                ViewState::Stale => {
                    let tried = tokio::time::timeout(2 * RETRY_WITHIN, async {
                        while self.state() == ViewState::Stale {
                            self.changed().await;
                        }
                    });
                    if tried.await.is_err() {
                        return Err(ViewState::Stale);
                    }
                }
                ViewState::Ready
                | ViewState::Relisting
                | ViewState::Queued
                | ViewState::Connecting
                | ViewState::Syncing { .. } => self.changed().await,
            }
        }
    }

    /// Its rows, from every part.
    pub fn items(&self) -> Vec<Arc<T>> {
        self.inner.parts().iter().flat_map(Part::items).collect()
    }

    /// What changed in its rows since the last drain: each part's changes
    /// coalesced by key, or every row once any part was reset, as a new
    /// part always is. Each part's rows are read under its store's lock
    /// together with its feed, so the feed holds what the reader holds: a
    /// second read of the items would see changes the feed then drops.
    pub fn drain(&self) -> Delta<T> {
        let parts = self.inner.parts();
        let drained: Vec<_> = parts
            .iter()
            .map(|part| part.upstream.store.drain(&part.feed))
            .collect();
        if drained.iter().any(|d| matches!(d, Drained::Reset { .. })) {
            let (mut rows, mut columns) = (Vec::new(), None);
            for (part, drained) in parts.iter().zip(drained) {
                let drained = match drained {
                    Drained::Changed(_) => part.upstream.store.reread(&part.feed),
                    reset => reset,
                };
                let Drained::Reset {
                    items,
                    columns: read,
                } = drained
                else {
                    unreachable!("a reread resets");
                };
                columns = columns.or(read);
                rows.extend(items.into_iter().filter(|item| part.serves(item)));
            }
            return Delta::Reset { rows, columns };
        }
        let (mut upserted, mut removed) = (Vec::new(), Vec::new());
        for (part, drained) in parts.iter().zip(drained) {
            let Drained::Changed(changes) = drained else {
                unreachable!("no part was reset");
            };
            for (key, item) in changes {
                match item {
                    Some(item) if part.serves(&item) => upserted.push(item),
                    _ => removed.push(key),
                }
            }
        }
        Delta::Changed { upserted, removed }
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
        // A swap may be what woke it, and its parts' receivers are the old
        // ones until then.
        self.seen.refresh(&self.inner);
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
    let listed = async {
        for part in &parts {
            // A refusal moves it too: the cluster-wide upstream would show
            // what these may not list. `listed` takes the upstream's lock,
            // which its updates hold while they send: never read it while
            // the state is borrowed.
            let mut state = part.upstream.state();
            loop {
                let refused = failed(&state.borrow_and_update());
                if refused || part.upstream.listed() {
                    break;
                }
                // Ends with the upstream, which the part holds.
                if state.changed().await.is_err() {
                    break;
                }
            }
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
pub(crate) mod live;
#[cfg(test)]
mod tests;
