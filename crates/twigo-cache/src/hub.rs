//! The watch hub (ARCHITECTURE 3.2): one upstream per context, resource,
//! scope, server-side selectors and form, shared by every subscription.
//!
//! - An upstream counts its subscriptions and lingers for [`LINGER`] after
//!   the last leaves, so going back and forth costs nothing.
//! - When a watch waits for the context's budget, the least recently used
//!   idle upstream of the context is evicted; with none, the watch stays
//!   `queued`.
//! - A subscription to a few namespaces gets an upstream per namespace;
//!   to more than four, one cluster-wide upstream when the person may list
//!   the resource cluster-wide, filtered by namespace in Rust.
//! - A subscription to every namespace gets that upstream too, whole; else
//!   an upstream per namespace where a review allows listing the resource,
//!   a set kept with the clients for five minutes, and the cluster's own
//!   refusal when there is none. It has no part, and says what it waits on,
//!   until what it reads is settled.
//! - Hysteresis: a cluster-wide upstream serves narrower subscriptions too,
//!   without holding it. Once it has lingered, they move to upstreams per
//!   namespace, keeping its rows until theirs are listed.
//! - A list shows the rows of each part that has listed and is not refused,
//!   whatever the others are ([`Subscription::drain_shown`]); what needs
//!   every part, such as an object's page, reads their least ready state
//!   ([`combine`]).

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, select_all};
use futures::{FutureExt, StreamExt};
use jiff::Timestamp;
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use kube::Api;
use kube::api::PostParams;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use twigo_ipc::{self as ipc, Access, ErrorCode, ErrorKind, IpcError, PartState, Parts, ViewState};
use twigo_kube::client::Clients;

use crate::cluster::{Cluster, Resolved};
use crate::decode::Decode;
use crate::meta::MetaDecoder;
use crate::object::{Object, ObjectDecoder};
use crate::request::{Collection, Format, field_value};
use crate::store::{Drained, Feed, Item, RowKey};
use crate::table::{Column, Row, TableDecoder};
use crate::upstream::{self, Clock, Env, Failure, Spec, Upstream};

pub use crate::upstream::{Connect, RETRY_WITHIN, backoff};

/// How long an upstream outlives its last subscription.
pub const LINGER: Duration = Duration::from_secs(60);
/// More namespaces than this share one cluster-wide upstream.
const NAMESPACES: usize = 4;
/// The reviews of all namespaces that are under way at once.
const REVIEWS: usize = 8;
/// How long a reader that needs a whole list waits for a stale upstream to
/// answer: two of the longest backoffs.
const STALE_FOR: Duration = RETRY_WITHIN.saturating_mul(2);

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
        return Err(IpcError::new(
            ErrorCode::InternalRequest,
            format!("{name:?} can be no name in a request's path"),
        ));
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
    pub(crate) fn path(&self, scope: &Scope) -> String {
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

    /// The path of one of its objects, each name escaped; refused where a
    /// name can be no path segment, or a namespaced resource has no
    /// namespace.
    pub fn object_path(&self, namespace: Option<&str>, name: &str) -> Result<String, IpcError> {
        self.check()?;
        segment(name)?;
        let scope = match (self.namespaced, namespace) {
            (true, Some(namespace)) => {
                segment(namespace)?;
                Scope::Namespace(namespace.to_owned())
            }
            (true, None) => {
                return Err(IpcError::new(
                    ErrorCode::InternalRequest,
                    format!("{name} names no namespace"),
                ));
            }
            (false, _) => Scope::Cluster,
        };
        let name = utf8_percent_encode(name, SEGMENT);
        Ok(format!("{}/{name}", self.path(&scope)))
    }

    /// As kubectl names it: `pods`, `deployments.apps`.
    pub fn name(&self) -> String {
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
    /// Empty for every namespace where the person may list the resource.
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
            group: self.resource.group.clone(),
            version: self.resource.version.clone(),
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
    clock: Clock,
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

impl Registry {
    fn take(&mut self, key: &Key) {
        if let Some(entry) = self.entries.remove(key) {
            entry.task.abort();
        }
    }
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

    fn upstream<T: Item>(&self) -> Arc<Upstream<T>> {
        Arc::clone(&self.upstream)
            .into_any()
            .downcast::<Upstream<T>>()
            .expect("a key's form fixes its upstream's items")
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
        Self::with_clock(connect, Arc::new(Timestamp::now))
    }

    /// A hub whose rows are stamped by `clock`, which a test sets.
    pub(crate) fn with_clock(connect: Connect, clock: Clock) -> Self {
        Self {
            inner: Arc::new(Inner {
                connect,
                clock,
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
        let mut subscription = Subscription::new(key.clone(), &namespaces);
        if query.resource.namespaced && namespaces.is_empty() {
            // The clients may take long to come, as they do while a credential
            // plugin signs the person in, and the list says `connecting` until
            // they do, so what it reads is settled apart from this call.
            let mut settling = Box::pin(settle(
                Arc::downgrade(&subscription.inner),
                self.clone(),
                query,
                key,
            ));
            if futures::poll!(&mut settling).is_pending() {
                tokio::spawn(settling);
            }
            return Ok(subscription);
        }
        let cluster_wide =
            namespaces.is_empty() || (namespaces.len() > NAMESPACES && self.may_list(&query).await);
        let namespaces = &namespaces[..];
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

    /// The names of the context's namespaces, sorted, from one list of their
    /// metadata, which takes a request slot and no watch; or the state that
    /// refuses it. A transient failure is tried again with the backoff for
    /// two of its longest waits from the first failure, and says `stale`
    /// after; a try under way is never cut.
    pub async fn namespaces(&self, context: &str) -> Result<Vec<String>, ViewState> {
        let mut backoff = backoff();
        let mut failed_at = None;
        loop {
            match self.read_namespaces(context).await {
                Err(ViewState::Stale { .. }) => {}
                answered => return answered,
            }
            let failed_at = *failed_at.get_or_insert_with(Instant::now);
            let left = STALE_FOR.saturating_sub(failed_at.elapsed());
            if left.is_zero() {
                return Err(ViewState::Stale { cause: None });
            }
            let pause = backoff
                .next()
                .expect("the backoff has no maximum of attempts");
            tokio::time::sleep(pause.min(left)).await;
        }
    }

    /// One try of [`namespaces`](Self::namespaces).
    async fn read_namespaces(&self, context: &str) -> Result<Vec<String>, ViewState> {
        let clients = (self.inner.connect)(context.to_owned())
            .await
            .map_err(unconnected)?;
        let resource = Resource {
            group: String::new(),
            version: "v1".to_owned(),
            resource: "namespaces".to_owned(),
            namespaced: false,
        };
        let path = resource.path(&Scope::Cluster);
        let collection = Collection {
            path: &path,
            format: Format::Metadata,
            field_selector: None,
        };
        let rows = upstream::read(
            &clients,
            &self.inner.clock,
            &collection,
            &resource.name(),
            MetaDecoder,
        )
        .await?;
        let mut names: Vec<String> = rows.iter().map(|row| row.meta.name.to_string()).collect();
        names.sort();
        Ok(names)
    }

    /// What all namespaces of the query's resource come to for a person who
    /// may not list it cluster-wide, as kept with the context's clients or
    /// asked anew: the namespaces where a review allows listing it. No
    /// namespace when they may list it cluster-wide, or may list it nowhere,
    /// or the namespaces are refused, which the cluster part then answers,
    /// with its rows or its own refusal.
    ///
    /// A set kept past its time is read at once, and resolved again in the
    /// background for the lists after it; a resolution that fails or leaves a
    /// review unanswered keeps the set, which the next list resolves again.
    /// What does not answer is no answer:
    /// when the clients, the cluster-wide review or the list of namespaces
    /// fail with anything but a refusal, the state the subscription waits on
    /// comes instead, and a review the server refuses leaves the cluster part
    /// to say what it answers.
    async fn resolve(&self, query: &Query) -> Result<Resolved, ViewState> {
        let access = list_access(&query.resource);
        let clients = (self.inner.connect)(query.context.clone())
            .await
            .map_err(unconnected)?;
        let cluster = self.inner.cluster(&query.context);
        let Some(kept) = cluster.resolved(&clients, &access) else {
            return self.renew(query, &clients, &cluster).await;
        };
        if kept.renew {
            let (hub, query) = (self.clone(), query.clone());
            tokio::spawn(async move { hub.renew(&query, &clients, &cluster).await });
        }
        Ok(kept.resolved)
    }

    /// Asks what all namespaces come to and keeps it: what every question
    /// answers replaces the set it renews, and what does not leaves it be.
    async fn renew(
        &self,
        query: &Query,
        clients: &Arc<Clients>,
        cluster: &Cluster,
    ) -> Result<Resolved, ViewState> {
        let access = list_access(&query.resource);
        match self.ask(query, &access).await {
            Ok((resolved, true)) => {
                cluster.set_resolved(clients, &access, resolved.clone());
                Ok(resolved)
            }
            unsettled => {
                cluster.set_unsettled(clients, &access);
                unsettled.map(|(resolved, _)| resolved)
            }
        }
    }

    /// The namespaces where the person may list the resource, with whether
    /// every question answered. A cluster-wide yes, a review the server
    /// refuses and namespaces it refuses are no namespace, which the cluster
    /// part then answers as the cluster does.
    async fn ask(&self, query: &Query, access: &Access) -> Result<(Resolved, bool), ViewState> {
        let none = (Resolved::default(), true);
        match self.review(&query.context, None, access).await {
            Ok(true) | Err(Failure::Refused(_)) => return Ok(none),
            Ok(false) => {}
            Err(Failure::Unauthorized) => return Err(ViewState::Unauthorized),
            Err(_) => return Err(ViewState::Connecting { cause: None }),
        }
        let names = match self.read_namespaces(&query.context).await {
            Ok(names) => names,
            Err(ViewState::Forbidden { .. }) => return Ok(none),
            Err(ViewState::Unauthorized) => return Err(ViewState::Unauthorized),
            Err(_) => return Err(ViewState::Connecting { cause: None }),
        };
        let reviews: Vec<BoxFuture<'static, Result<bool, Failure>>> = names
            .iter()
            .map(|name| {
                let (hub, context, access, name) = (
                    self.clone(),
                    query.context.clone(),
                    access.clone(),
                    name.clone(),
                );
                async move { hub.review(&context, Some(&name), &access).await }.boxed()
            })
            .collect();
        let mut asked = futures::stream::iter(reviews).buffered(REVIEWS);
        let mut answers: Vec<Option<bool>> = Vec::with_capacity(names.len());
        while let Some(answer) = asked.next().await {
            if matches!(answer, Err(Failure::Unauthorized)) {
                return Err(ViewState::Unauthorized);
            }
            answers.push(answer.ok());
        }
        let allowed: Vec<String> = names
            .iter()
            .zip(&answers)
            .filter(|(_, may)| **may != Some(false))
            .map(|(name, _)| name.clone())
            .collect();
        let resolved = Resolved {
            omitted: u32::try_from(names.len() - allowed.len()).unwrap_or(u32::MAX),
            allowed,
        };
        Ok((resolved, answers.iter().all(Option::is_some)))
    }

    /// An object, followed by an Object upstream for its editor, unless its
    /// namespace can be no path segment.
    pub fn object(
        &self,
        context: &str,
        resource: Resource,
        namespace: Option<String>,
        name: &str,
    ) -> Result<Subscription<Object>, IpcError> {
        self.selected(
            context,
            resource,
            namespace,
            Some(format!("metadata.name={}", field_value(name))),
        )
    }

    /// The objects a field selector picks, or all of them, in a namespace
    /// or, with none, in every namespace, followed whole by an Object
    /// upstream, as an object's events are.
    pub fn selected(
        &self,
        context: &str,
        resource: Resource,
        namespace: Option<String>,
        field_selector: Option<String>,
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
            field_selector,
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

    /// The subscriptions that hold the upstreams of a resource, by its
    /// plural, such as `events`, for tests of the hub's users.
    #[cfg(any(test, feature = "test-util"))]
    pub fn subscribers(&self, resource: &str) -> usize {
        self.inner
            .registry()
            .entries
            .iter()
            .filter(|(key, _)| key.resource.resource == resource)
            .map(|(_, entry)| entry.subscribers)
            .sum()
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
        let upstream = {
            let mut registry = self.inner.registry();
            registry.next_run += 1;
            let run = registry.next_run;
            match registry.entries.get_mut(key) {
                Some(entry) => {
                    entry.subscribers += 1;
                    entry.idle_since = None;
                    entry.expired = false;
                    let upstream = entry.upstream::<T>();
                    if upstream.ended() {
                        upstream.restart();
                        entry.run = run;
                        let task = self.spawn(key, Arc::clone(&upstream), run);
                        std::mem::replace(&mut entry.task, task).abort();
                    }
                    upstream.retry();
                    upstream
                }
                None => {
                    let upstream = Arc::new(Upstream::<T>::new());
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
        Part {
            feed: upstream.store.feed(),
            upstream,
            filter,
            guard: Guard::Hold {
                hub: Arc::downgrade(&self.inner),
                key: key.clone(),
            },
            showing: true,
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
        let upstream = entry.upstream::<T>();
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
            showing: true,
        })
    }

    /// Whether the person may list the query's resource cluster-wide.
    async fn may_list(&self, query: &Query) -> bool {
        self.may(&query.context, None, &list_access(&query.resource))
            .await
            .unwrap_or(false)
    }

    /// Whether RBAC lets the person do `access` in `namespace`, or with
    /// none in every namespace: a SelfSubjectAccessReview, kept with the
    /// context's clients; none when the cluster cannot answer. An access to
    /// one object asks for the whole resource first, which a rule without
    /// `resourceNames` grants, and for the object by name only when that
    /// says no, since a rule that lists names grants only them.
    pub async fn may(
        &self,
        context: &str,
        namespace: Option<&str>,
        access: &Access,
    ) -> Option<bool> {
        if access.name.is_some() {
            let whole = Access {
                name: None,
                ..access.clone()
            };
            if matches!(self.review(context, namespace, &whole).await, Ok(true)) {
                return Some(true);
            }
        }
        self.review(context, namespace, access).await.ok()
    }

    async fn review(
        &self,
        context: &str,
        namespace: Option<&str>,
        access: &Access,
    ) -> Result<bool, Failure> {
        // kube-apiserver authorizes a request on a namespace in that
        // namespace (apiserver v0.37.1, `endpoints/request/requestinfo.go`).
        let namespace = match (
            &access.name,
            access.group.as_str(),
            access.resource.as_str(),
        ) {
            (Some(name), "", "namespaces") => Some(name.as_str()),
            _ => namespace,
        };
        let clients =
            (self.inner.connect)(context.to_owned())
                .await
                .map_err(|error| match error.kind {
                    ErrorKind::Unauthorized => Failure::Unauthorized,
                    _ => Failure::Transient,
                })?;
        let ask = || {
            let review = SelfSubjectAccessReview {
                spec: SelfSubjectAccessReviewSpec {
                    resource_attributes: Some(ResourceAttributes {
                        verb: Some(access.verb.clone()),
                        group: Some(access.group.clone()),
                        resource: Some(access.resource.clone()),
                        subresource: access.subresource.clone(),
                        namespace: namespace.map(str::to_owned),
                        name: access.name.clone(),
                        ..ResourceAttributes::default()
                    }),
                    ..SelfSubjectAccessReviewSpec::default()
                },
                ..SelfSubjectAccessReview::default()
            };
            let reviews = Api::<SelfSubjectAccessReview>::all(clients.api.clone());
            async move {
                let answer = reviews
                    .create(&PostParams::default(), &review)
                    .await
                    .map_err(|error| {
                        upstream::failure(&error, "create", "selfsubjectaccessreviews")
                    })?;
                Ok(answer.status.is_some_and(|status| status.allowed))
            }
            .boxed()
        };
        self.inner
            .cluster(context)
            .review(&clients, namespace, access, ask)
            .await
    }
}

fn list_access(resource: &Resource) -> Access {
    Access {
        verb: "list".to_owned(),
        group: resource.group.clone(),
        resource: resource.resource.clone(),
        subresource: None,
        name: None,
    }
}

/// What a subscription waits on while its context's clients fail: their error,
/// or `unauthorized`, which only a new subscription tries again.
fn unconnected(error: IpcError) -> ViewState {
    match error.kind {
        ErrorKind::Unauthorized => ViewState::Unauthorized,
        _ => ViewState::Error { error },
    }
}

/// Starts the run of an upstream with the decoder of its items.
trait Spawn<T> {
    fn spawn(&self, key: &Key, upstream: Arc<Upstream<T>>, run: u64) -> JoinHandle<()>;
}

impl Spawn<Row> for Hub {
    fn spawn(&self, key: &Key, upstream: Arc<Upstream<Row>>, run: u64) -> JoinHandle<()> {
        match key.format {
            Format::Table => {
                self.start(key, TableDecoder::new(&key.resource.name()), upstream, run)
            }
            Format::Metadata => self.start(key, MetaDecoder, upstream, run),
            Format::Object => unreachable!("an Object upstream keeps objects"),
        }
    }
}

impl Spawn<Object> for Hub {
    fn spawn(&self, key: &Key, upstream: Arc<Upstream<Object>>, run: u64) -> JoinHandle<()> {
        self.start(key, ObjectDecoder::new(), upstream, run)
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
            clock: Arc::clone(&self.inner.clock),
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
            registry.take(key);
        } else {
            evict(&mut registry, &key.context);
        }
    }

    fn release(self: &Arc<Self>, key: &Key) {
        let mut registry = self.registry();
        registry.next_linger += 1;
        let linger = registry.next_linger;
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
            registry.take(key);
            return;
        }
        entry.idle_since = Some(Instant::now());
        entry.linger = linger;
        let hub = Arc::downgrade(self);
        let expiring = key.clone();
        tokio::spawn(async move {
            tokio::time::sleep(LINGER).await;
            if let Some(hub) = hub.upgrade() {
                hub.expire(&expiring, linger);
            }
        });
        make_way(&mut registry, key);
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
            registry.take(key);
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
        if entry.idle() && (entry.expired || entry.queued.is_some()) {
            serve(&mut registry, &key.context, key);
            registry.take(key);
        } else {
            make_way(&mut registry, key);
        }
    }
}

/// For a watch of `context` that waits for the budget, removes the least
/// recently used idle upstream that holds a watch there.
fn evict(registry: &mut Registry, context: &str) {
    let victim = registry
        .entries
        .iter()
        .filter(|(key, entry)| key.context == context && entry.evictable())
        .min_by_key(|(_, entry)| entry.idle_since)
        .map(|(key, _)| key.clone());
    if let Some(victim) = victim {
        serve(registry, context, &victim);
        registry.take(&victim);
    }
}

/// An upstream that just went idle makes way for a watch of its context
/// that waits for the budget.
fn make_way(registry: &mut Registry, key: &Key) {
    let evictable = registry.entries.get(key).is_some_and(Entry::evictable);
    if evictable && serve(registry, &key.context, key) {
        registry.take(key);
    }
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
    /// Its rows are in what the subscription drains, as of its last read.
    showing: bool,
}

impl<T> Part<T> {
    fn borrowed_from(&self, key: &Key) -> bool {
        matches!(&self.guard, Guard::Borrow { key: borrowed, .. } if borrowed == key)
    }

    /// What the part reads, as a list names it.
    fn scope(&self) -> ipc::Part {
        let (Guard::Hold { key, .. } | Guard::Borrow { key, .. }) = &self.guard;
        match &key.scope {
            Scope::Cluster => ipc::Part::Cluster,
            Scope::Namespace(name) => ipc::Part::Namespace { name: name.clone() },
        }
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
    /// columns, new parts, or a part that starts or stops showing.
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

/// What a list reads of its subscription at one moment.
pub struct Shown<T> {
    pub delta: Delta<T>,
    /// As [`ListBatch::status`](ipc::ListBatch::status) says.
    pub status: ViewState,
    pub parts: Parts,
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
    /// For all namespaces settled on parts per namespace, how many of the
    /// cluster's namespaces they leave out; none otherwise, the cluster part
    /// included.
    omitted: Mutex<Option<u32>>,
    /// What the subscription says while it has no part: `connecting`, or the
    /// error of what its settling waits on.
    waiting: Mutex<ViewState>,
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
                omitted: Mutex::new(None),
                waiting: Mutex::new(ViewState::Connecting { cause: None }),
                parts: Mutex::default(),
                swapped,
            }),
        }
    }

    /// It reads parts per namespace, the namespaces that all of them came to
    /// for a person who may not list the resource cluster-wide.
    pub fn resolved(&self) -> bool {
        self.inner.omitted().is_some()
    }

    fn filter(&self) -> Option<Arc<HashSet<String>>> {
        (!self.inner.namespaces.is_empty())
            .then(|| Arc::new(self.inner.namespaces.iter().cloned().collect()))
    }

    fn set_parts(&mut self, parts: Vec<Part<T>>) {
        *self.inner.parts() = parts;
        self.seen.refresh(&self.inner);
    }

    /// The state of the subscription: its least ready part's, or what it
    /// waits on while it has none, as all namespaces have until what they read
    /// is settled.
    pub fn state(&self) -> ViewState {
        let parts = self.inner.parts();
        if parts.is_empty() {
            return self.inner.waiting();
        }
        combine(parts.iter().map(|part| part.upstream.current()))
    }

    /// Every part has held a whole list since it started, so the rows are
    /// all there, if maybe stale.
    pub fn listed(&self) -> bool {
        let parts = self.inner.parts();
        !parts.is_empty() && parts.iter().all(|part| part.upstream.listed())
    }

    /// Its rows once every part has listed them, if maybe stale since; or
    /// the state that refuses them, or `stale` when a first list has
    /// failed for two of the longest backoffs.
    pub async fn whole(&mut self) -> Result<Vec<Arc<T>>, ViewState> {
        loop {
            match self.state() {
                state if failed(&state) => return Err(state),
                _ if self.listed() => return Ok(self.items()),
                ViewState::Stale { .. } => {
                    let tried = tokio::time::timeout(STALE_FOR, async {
                        while matches!(self.state(), ViewState::Stale { .. }) {
                            self.changed().await;
                        }
                    });
                    if tried.await.is_err() {
                        return Err(ViewState::Stale { cause: None });
                    }
                }
                _ => self.changed().await,
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
        drain_parts(&self.inner.parts(), false)
    }

    /// What a list reads: [`drain`](Self::drain) over the parts whose rows
    /// show, and the state and parts that say which these are. It looks at
    /// each part once, so what it returns agrees: a part's rows show once
    /// it has listed and while it is not refused, whatever the others are,
    /// and a part that starts or stops showing resets the drain.
    pub fn drain_shown(&self) -> Shown<T> {
        let mut parts = self.inner.parts();
        let looks: Vec<(ViewState, bool)> = parts
            .iter()
            .map(|part| {
                let (state, listed) = part.upstream.standing();
                let shown = listed && !failed(&state);
                (state, shown)
            })
            .collect();
        let mut flipped = false;
        for (part, (_, shown)) in parts.iter_mut().zip(&looks) {
            flipped |= part.showing != *shown;
            part.showing = *shown;
        }
        let delta = drain_parts(&parts, flipped);
        let (status, count) = if parts.is_empty() {
            (self.inner.waiting(), 1)
        } else {
            (
                status(&looks),
                u32::try_from(parts.len()).unwrap_or(u32::MAX),
            )
        };
        let unready = parts
            .iter()
            .zip(looks)
            .filter(|(_, (state, _))| *state != ViewState::Ready)
            .map(|(part, (state, shown))| PartState {
                part: part.scope(),
                state,
                shown,
            })
            .collect();
        Shown {
            delta,
            status,
            parts: Parts {
                count,
                unready,
                omitted: self.inner.omitted().unwrap_or(0),
            },
        }
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

impl<T: Item> Subscription<T> {
    /// The columns of a Table or Object upstream.
    pub fn columns(&self) -> Option<Arc<[Column]>> {
        let parts = self.inner.parts();
        parts.iter().find_map(|part| part.upstream.store.columns())
    }
}

impl<T> SubscriptionInner<T> {
    fn parts(&self) -> MutexGuard<'_, Vec<Part<T>>> {
        self.parts.lock().expect("subscription lock")
    }

    fn omitted(&self) -> Option<u32> {
        *self.omitted.lock().expect("subscription lock")
    }

    fn waiting(&self) -> ViewState {
        self.waiting.lock().expect("subscription lock").clone()
    }

    fn wait(&self, state: ViewState) {
        let changed = {
            let mut waiting = self.waiting.lock().expect("subscription lock");
            std::mem::replace(&mut *waiting, state.clone()) != state
        };
        if changed {
            self.swapped.send_modify(|swaps| *swaps += 1);
        }
    }
}

/// What changed in the rows of the parts that show, or every one of their
/// rows if one was reset or `reset` says the parts changed.
fn drain_parts<T: Item>(parts: &[Part<T>], reset: bool) -> Delta<T> {
    let drained: Vec<_> = parts
        .iter()
        .map(|part| part.upstream.store.drain(&part.feed))
        .collect();
    if reset || drained.iter().any(|d| matches!(d, Drained::Reset { .. })) {
        let (mut rows, mut columns) = (Vec::new(), None);
        for (part, drained) in parts.iter().zip(drained) {
            if !part.showing {
                columns = columns.or_else(|| part.upstream.store.columns());
                continue;
            }
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
        if !part.showing {
            continue;
        }
        for (key, item) in changes {
            match item {
                Some(item) if part.serves(&item) => upserted.push(item),
                _ => removed.push(key),
            }
        }
    }
    Delta::Changed { upserted, removed }
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

/// Settles what a subscription to all namespaces reads, and nothing if the
/// subscription ends first. What does not answer is tried again with the
/// hub's backoff, the subscription saying what it waits on meanwhile.
async fn settle(subscription: Weak<SubscriptionInner<Row>>, hub: Hub, query: Query, key: Key) {
    let mut backoff = backoff();
    let resolved = loop {
        let waiting = match hub.resolve(&query).await {
            Ok(resolved) => break resolved,
            Err(waiting) => waiting,
        };
        {
            let Some(subscription) = subscription.upgrade() else {
                return;
            };
            subscription.wait(waiting.clone());
        }
        if waiting == ViewState::Unauthorized {
            return;
        }
        let pause = backoff
            .next()
            .expect("the backoff has no maximum of attempts");
        tokio::time::sleep(pause).await;
    };
    let Some(subscription) = subscription.upgrade() else {
        return;
    };
    let (parts, omitted) = if resolved.allowed.is_empty() {
        (vec![hub.hold(&key, None)], None)
    } else {
        (
            hub.per_namespace(&key, &resolved.allowed),
            Some(resolved.omitted),
        )
    };
    *subscription.omitted.lock().expect("subscription lock") = omitted;
    *subscription.parts() = parts;
    subscription.swapped.send_modify(|swaps| *swaps += 1);
}

/// The state of a list from its parts' states and whether each one's rows
/// show, as [`ListBatch::status`](ipc::ListBatch::status) says.
fn status(looks: &[(ViewState, bool)]) -> ViewState {
    let (shown, unshown): (Vec<_>, Vec<_>) = looks.iter().partition(|(_, shown)| *shown);
    if !shown.is_empty() {
        return combine(shown.into_iter().map(|(state, _)| match state {
            ViewState::Queued => ViewState::Stale { cause: None },
            state => state.clone(),
        }));
    }
    let (refused, on_their_way): (Vec<_>, Vec<_>) = unshown
        .into_iter()
        .map(|(state, _)| state.clone())
        .partition(failed);
    if on_their_way.is_empty() {
        return combine(refused.into_iter());
    }
    combine(on_their_way.into_iter().map(|state| match state {
        ViewState::Stale { cause } => ViewState::Connecting { cause },
        state => state,
    }))
}

/// The least ready of `states`, the counts of syncing ones added up: of a
/// subscription's parts when it needs all of them, or of the subscriptions
/// an object reads together. A list says each part's state apart
/// ([`Subscription::drain_shown`]).
pub fn combine(states: impl Iterator<Item = ViewState>) -> ViewState {
    let rank = |state: &ViewState| match state {
        ViewState::Ready => 0,
        ViewState::Stale { .. } => 1,
        ViewState::Relisting => 2,
        ViewState::Syncing { .. } => 3,
        ViewState::Connecting { .. } => 4,
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
mod parts_tests;
#[cfg(test)]
mod tests;
