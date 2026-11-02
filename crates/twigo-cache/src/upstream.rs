//! One upstream's list and watch (ARCHITECTURE 3.2, 3.7): the initial list,
//! streamed where the cluster can, then a watch resumed from its last
//! `resourceVersion`, a relist on `410 Gone`, a probe when it goes quiet,
//! and a backoff after failures.
//!
//! Each line of a watch is decoded and stored as it arrives, so a slow
//! reader never holds the connection back.

use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use futures::{AsyncBufRead, AsyncBufReadExt};
use http::Request;
use tokio::sync::watch;
use twigo_ipc::{ErrorKind, IpcError, ViewState};
use twigo_kube::client::{Clients, Waiting};

use crate::cluster::Cluster;
use crate::decode::{Decode, DecodeError, Event};
use crate::request::{self, Collection, Format, WatchFrom};
use crate::store::{self, Item, Items, RowKey, Store};

/// Items per list page.
const LIMIT: u32 = 500;
/// kube's default for watches (`kube-core` 4.2, `params.rs`).
const TIMEOUT_SECONDS: u32 = 290;
/// The API server's watch cache sends a bookmark roughly every minute
/// (`cacheWatcher.nextBookmarkTime`, Kubernetes v1.37.0), so two missing
/// mean the watch has stalled.
pub(crate) const IDLE: Duration = Duration::from_secs(120);

/// Gets a context's clients, or says why the upstream cannot have them.
pub type Connect = Arc<
    dyn Fn(String) -> futures::future::BoxFuture<'static, Result<Arc<Clients>, IpcError>>
        + Send
        + Sync,
>;

/// What an upstream watches.
#[derive(Debug, Clone)]
pub(crate) struct Spec {
    pub context: String,
    pub path: String,
    pub format: Format,
    pub field_selector: Option<String>,
    /// How a 403 names it: `pods`, or `deployments.apps`.
    pub resource: String,
}

/// An upstream's store and state, which its subscriptions read.
pub(crate) struct Upstream<T> {
    pub store: Store<T>,
    status: Mutex<Status>,
    state: watch::Sender<ViewState>,
}

#[derive(Debug, Clone, PartialEq)]
enum Phase {
    Connecting,
    Syncing(u32),
    Ready,
    Relisting,
    Stale,
    /// Retried only when someone subscribes again.
    Failed(ViewState),
}

#[derive(Debug)]
struct Status {
    phase: Phase,
    queued: bool,
    /// The store has held a whole list since the upstream started.
    listed: bool,
}

impl<T: Item> Upstream<T> {
    pub fn new() -> Self {
        Self {
            store: Store::default(),
            status: Mutex::new(Status {
                phase: Phase::Connecting,
                queued: false,
                listed: false,
            }),
            state: watch::Sender::new(ViewState::Connecting),
        }
    }

    pub fn state(&self) -> watch::Receiver<ViewState> {
        self.state.subscribe()
    }

    /// While a request waits for its class's budget, the upstream is
    /// `queued`.
    pub fn set_queued(&self, queued: bool) {
        self.update(|status| status.queued = queued);
    }

    fn update(&self, change: impl FnOnce(&mut Status)) {
        let mut status = self.status();
        change(&mut status);
        let view = match (&status.phase, status.queued) {
            (Phase::Failed(view), _) => view.clone(),
            (_, true) => ViewState::Queued,
            (Phase::Connecting, _) => ViewState::Connecting,
            (Phase::Syncing(loaded), _) => ViewState::Syncing { loaded: *loaded },
            (Phase::Ready, _) => ViewState::Ready,
            (Phase::Relisting, _) => ViewState::Relisting,
            (Phase::Stale, _) => ViewState::Stale,
        };
        // Under the lock, so states go out in the order they were set.
        self.state.send_if_modified(|state| {
            let changed = *state != view;
            *state = view;
            changed
        });
    }

    fn status(&self) -> MutexGuard<'_, Status> {
        self.status.lock().expect("upstream lock")
    }
}

/// What a run of the upstream needs from the hub.
pub(crate) struct Env {
    pub connect: Connect,
    pub cluster: Arc<Cluster>,
    /// Told when a watch waits for the budget, and when it stops waiting,
    /// so the hub can evict an idle upstream.
    pub waiting: Arc<dyn Fn(bool) + Send + Sync>,
}

/// Runs the upstream until it fails for good; the hub aborts it to stop
/// it. A run after a failure starts from the items the store kept.
pub(crate) async fn run<D: Decode>(
    env: Env,
    spec: Spec,
    decoder: D,
    upstream: Arc<Upstream<D::Item>>,
) where
    D::Item: Item,
{
    start(env, spec, decoder, upstream, Next::List).await;
}

/// Runs the upstream as if its watch had stopped at `from`.
#[cfg(test)]
pub(crate) async fn resume<D: Decode>(
    env: Env,
    spec: Spec,
    decoder: D,
    upstream: Arc<Upstream<D::Item>>,
    from: &str,
) where
    D::Item: Item,
{
    start(env, spec, decoder, upstream, Next::Watch(from.into())).await;
}

async fn start<D: Decode>(
    env: Env,
    spec: Spec,
    decoder: D,
    upstream: Arc<Upstream<D::Item>>,
    next: Next,
) where
    D::Item: Item,
{
    upstream.update(|status| {
        status.queued = false;
        status.phase = if status.listed {
            Phase::Relisting
        } else {
            Phase::Connecting
        };
    });
    let mut run = Run {
        watch_waiting: waiting(&upstream, Some(Arc::clone(&env.waiting))),
        list_waiting: waiting(&upstream, None),
        env,
        spec,
        decoder,
        upstream,
        clients: None,
        backoff: backoff(),
    };
    if let Err(view) = run.run(next).await {
        run.upstream.update(|status| {
            status.queued = false;
            status.phase = Phase::Failed(view);
        });
    }
}

fn backoff() -> ExponentialBackoff {
    // Jitter adds up to the delay again: 0.5–5 s in all (ARCHITECTURE 3.2).
    ExponentialBuilder::new()
        .with_min_delay(Duration::from_millis(500))
        .with_max_delay(Duration::from_millis(2500))
        .with_jitter()
        .without_max_times()
        .build()
}

fn waiting<T: Item>(
    upstream: &Arc<Upstream<T>>,
    hub: Option<Arc<dyn Fn(bool) + Send + Sync>>,
) -> Waiting {
    let upstream = Arc::downgrade(upstream);
    Waiting(Arc::new(move |queued| {
        if let Some(upstream) = upstream.upgrade() {
            upstream.set_queued(queued);
        }
        if let Some(hub) = &hub {
            hub(queued);
        }
    }))
}

/// Where the next attempt starts.
#[derive(Clone)]
enum Next {
    List,
    Watch(Box<str>),
}

/// How a list or a watch ended.
enum Outcome {
    /// The server closed the response; `quiet` if it sent nothing.
    Ended { next: Next, quiet: bool },
    /// The connection was retired under the watch.
    Retired(Next),
    /// No line within [`IDLE`].
    Idle { next: Next, seen: u64 },
    /// `410 Gone`: the server no longer has what the watch resumes from.
    Gone,
    Failed {
        error: kube::Error,
        verb: &'static str,
        next: Next,
    },
    /// Rows came before any column definitions, which a new connection
    /// sends again.
    NoColumns(Next),
    /// The server's answer makes no sense to the decoder.
    Undecodable(DecodeError),
}

struct Run<D: Decode> {
    env: Env,
    spec: Spec,
    decoder: D,
    upstream: Arc<Upstream<D::Item>>,
    /// The clients the store's items came over.
    clients: Option<Arc<Clients>>,
    backoff: ExponentialBackoff,
    watch_waiting: Waiting,
    list_waiting: Waiting,
}

type Lines = Pin<Box<dyn AsyncBufRead + Send>>;

/// A list under way: a relist collects its items apart and puts them in
/// the store at its end, while a first list stores each as it comes.
struct Listing<T> {
    collected: Option<Items<T>>,
    loaded: u32,
}

impl<D: Decode> Run<D>
where
    D::Item: Item,
{
    async fn run(&mut self, mut next: Next) -> Result<(), ViewState> {
        loop {
            let clients = (self.env.connect)(self.spec.context.clone())
                .await
                .map_err(|error| match error.kind {
                    ErrorKind::Unauthorized => ViewState::Unauthorized,
                    _ => ViewState::Error { error },
                })?;
            if self
                .clients
                .as_ref()
                .is_some_and(|held| !Arc::ptr_eq(held, &clients))
            {
                // Rebuilt clients may reach another server.
                next = Next::List;
            }
            self.clients = Some(Arc::clone(&clients));
            let outcome = match next {
                Next::List => self.list(&clients).await,
                Next::Watch(from) => {
                    let start = WatchFrom::ResourceVersion(&from);
                    self.stream(&clients, start, None, from.clone()).await
                }
            };
            next = match outcome {
                Outcome::Ended { next, quiet } => {
                    if quiet {
                        // A server or proxy that ends watches at once must
                        // not have them reopened at once.
                        self.interrupted();
                        self.pause().await;
                    }
                    next
                }
                Outcome::Retired(next) => {
                    self.interrupted();
                    next
                }
                Outcome::Idle { next, seen } => {
                    self.interrupted();
                    if !probe(&clients).await {
                        clients.connections().retire_after(seen);
                    }
                    next
                }
                Outcome::Gone => Next::List,
                Outcome::NoColumns(next) => {
                    self.interrupted();
                    self.pause().await;
                    next
                }
                Outcome::Undecodable(error) => {
                    return Err(ViewState::Error {
                        error: IpcError {
                            kind: ErrorKind::Internal,
                            message: format!("could not decode the server's answer: {error}"),
                        },
                    });
                }
                Outcome::Failed { error, verb, next } => {
                    match failure(&error, verb, &self.spec.resource) {
                        Failure::Gone => Next::List,
                        Failure::Transient => {
                            self.interrupted();
                            self.pause().await;
                            next
                        }
                        Failure::Terminal(view) => return Err(view),
                    }
                }
            };
        }
    }

    /// Lists the collection, by a streaming list where the cluster has
    /// them, and goes on watching.
    async fn list(&mut self, clients: &Arc<Clients>) -> Outcome {
        let listed = self.upstream.status().listed;
        if !listed && !self.upstream.store.is_empty() {
            // What an interrupted first list stored.
            self.upstream.store.replace(Items::new());
        }
        if listed {
            self.set_phase(Phase::Relisting);
        }
        let listing = || Listing {
            collected: listed.then(Items::new),
            loaded: 0,
        };
        if self.env.cluster.streaming(clients) != Some(false) {
            let outcome = self
                .stream(
                    clients,
                    WatchFrom::InitialEvents,
                    Some(listing()),
                    "".into(),
                )
                .await;
            match outcome {
                Outcome::Failed {
                    error: kube::Error::Api(status),
                    ..
                } if refuses_streaming(&status) => {
                    self.env.cluster.set_streaming(clients, false);
                }
                outcome => return outcome,
            }
        }
        self.paginate(clients, listing()).await
    }

    /// A list in pages, then a watch from its `resourceVersion`.
    async fn paginate(&mut self, clients: &Arc<Clients>, mut listing: Listing<D::Item>) -> Outcome {
        let mut token: Option<Box<str>> = None;
        let from = loop {
            let mut request = request::list(&self.collection(), LIMIT, token.as_deref());
            request.extensions_mut().insert(self.list_waiting.clone());
            let body = match clients.api.request_text(request).await {
                Ok(body) => body,
                Err(error) => {
                    return Outcome::Failed {
                        error,
                        verb: "list",
                        next: Next::List,
                    };
                }
            };
            let page = match self.decoder.decode_list(body.as_bytes()) {
                Ok(page) => page,
                Err(DecodeError::NoColumns) => return Outcome::NoColumns(Next::List),
                Err(error) => return Outcome::Undecodable(error),
            };
            self.backoff = backoff();
            self.upstream.store.set_columns(self.decoder.columns());
            for item in page.items {
                self.add(&mut listing, item);
            }
            match page.continue_token {
                Some(next) => token = Some(next),
                None => break page.resource_version,
            }
        };
        self.listed(listing);
        let start = WatchFrom::ResourceVersion(&from);
        self.stream(clients, start, None, from.clone()).await
    }

    /// Reads a watch until it ends: the initial events of a streaming list
    /// first, given `listing`, then the changes after `from`.
    async fn stream(
        &mut self,
        clients: &Arc<Clients>,
        start: WatchFrom<'_>,
        mut listing: Option<Listing<D::Item>>,
        mut from: Box<str>,
    ) -> Outcome {
        let again = |from: &str, listing: &Option<Listing<D::Item>>| match listing {
            Some(_) => Next::List,
            None => Next::Watch(from.into()),
        };
        let mut retired = clients.connections().retired();
        let seen = *retired.borrow_and_update();
        let mut request = request::watch(&self.collection(), start, TIMEOUT_SECONDS);
        request.extensions_mut().insert(self.watch_waiting.clone());
        let mut lines: Lines = tokio::select! {
            opened = clients.api.request_stream(request) => match opened {
                Ok(lines) => Box::pin(lines),
                Err(error) => {
                    let next = again(&from, &listing);
                    return Outcome::Failed { error, verb: "watch", next };
                }
            },
            _ = retired.changed() => return Outcome::Retired(again(&from, &listing)),
        };
        match &listing {
            Some(_) => self.env.cluster.set_streaming(clients, true),
            // The server watches from `from`, so nothing was missed.
            None => self.set_phase(Phase::Ready),
        }
        let mut quiet = true;
        let mut line = Vec::new();
        loop {
            line.clear();
            let read = tokio::select! {
                read = tokio::time::timeout(IDLE, lines.read_until(b'\n', &mut line)) => read,
                _ = retired.changed() => return Outcome::Retired(again(&from, &listing)),
            };
            match read {
                Err(_) => {
                    let next = again(&from, &listing);
                    return Outcome::Idle { next, seen };
                }
                Ok(Ok(0)) => {
                    let next = again(&from, &listing);
                    return Outcome::Ended { next, quiet };
                }
                Ok(Err(error)) => {
                    let next = again(&from, &listing);
                    let error = kube::Error::ReadEvents(error);
                    return Outcome::Failed {
                        error,
                        verb: "watch",
                        next,
                    };
                }
                Ok(Ok(_)) => {}
            }
            quiet = false;
            self.backoff = backoff();
            let event = match self.decoder.decode_event(&line) {
                Ok(event) => event,
                Err(DecodeError::NoColumns) => return Outcome::NoColumns(again(&from, &listing)),
                Err(error) => return Outcome::Undecodable(error),
            };
            self.upstream.store.set_columns(self.decoder.columns());
            match event {
                Event::Upsert(item) => {
                    advance(&mut from, item.meta());
                    match &mut listing {
                        Some(listing) => self.add(listing, item),
                        None => self.upstream.store.upsert(item),
                    }
                }
                Event::Delete(item) => {
                    advance(&mut from, item.meta());
                    match &mut listing {
                        Some(Listing {
                            collected: Some(items),
                            ..
                        }) => {
                            items.remove(&RowKey::of(item.meta()));
                        }
                        _ => self.upstream.store.delete(&item),
                    }
                }
                Event::Bookmark {
                    resource_version,
                    initial_events_end,
                } => {
                    from = resource_version;
                    if initial_events_end && let Some(done) = listing.take() {
                        self.listed(done);
                    }
                }
                Event::Error(status) if status.code == 410 => return Outcome::Gone,
                Event::Error(status) => {
                    let next = again(&from, &listing);
                    let error = kube::Error::Api(Box::new(
                        kube::core::Status::failure(&status.message, &status.reason)
                            .with_code(status.code),
                    ));
                    return Outcome::Failed {
                        error,
                        verb: "watch",
                        next,
                    };
                }
            }
        }
    }

    fn add(&self, listing: &mut Listing<D::Item>, item: D::Item) {
        listing.loaded = listing.loaded.saturating_add(1);
        match &mut listing.collected {
            Some(items) => store::collect(items, item),
            None => {
                self.upstream.store.upsert(item);
                self.set_phase(Phase::Syncing(listing.loaded));
            }
        }
    }

    /// A list ended: a relist's items replace the store's.
    fn listed(&self, listing: Listing<D::Item>) {
        if let Some(items) = listing.collected {
            self.upstream.store.replace(items);
        }
        self.upstream.update(|status| {
            status.listed = true;
            status.phase = Phase::Ready;
        });
    }

    /// A list or watch broke off: the upstream is stale while it
    /// reconnects, or still relisting.
    fn interrupted(&self) {
        self.upstream.update(|status| {
            if status.phase != Phase::Relisting {
                status.phase = Phase::Stale;
            }
        });
    }

    fn set_phase(&self, phase: Phase) {
        self.upstream.update(|status| status.phase = phase);
    }

    async fn pause(&mut self) {
        let delay = self
            .backoff
            .next()
            .expect("the backoff has no maximum of attempts");
        tokio::time::sleep(delay).await;
    }

    fn collection(&self) -> Collection<'_> {
        Collection {
            path: &self.spec.path,
            format: self.spec.format,
            field_selector: self.spec.field_selector.as_deref(),
        }
    }
}

/// A watch resumes after the last change it saw; objects built without a
/// `resourceVersion`, such as metrics, leave it be.
fn advance(from: &mut Box<str>, meta: &crate::meta::Meta) {
    if !meta.resource_version.is_empty() {
        from.clone_from(&meta.resource_version);
    }
}

/// Whether the connection still answers, any status included: a quiet
/// watch on a live one opens again alone, and one on a dead one retires it
/// for every upstream.
async fn probe(clients: &Clients) -> bool {
    let mut version = Request::new(Vec::new());
    *version.uri_mut() = http::Uri::from_static("/version");
    match clients.api.request_text(version).await {
        Ok(_) | Err(kube::Error::Api(_)) => true,
        Err(_) => false,
    }
}

/// 1.33 rejects `sendInitialEvents` with 422 on the field (apimachinery's
/// `validateWatchOptions`, v1.33.12).
fn refuses_streaming(status: &kube::core::Status) -> bool {
    status.code == 422
        && status.details.as_ref().is_some_and(|details| {
            details
                .causes
                .iter()
                .any(|cause| cause.field == "sendInitialEvents")
        })
}

enum Failure {
    Gone,
    Transient,
    Terminal(ViewState),
}

fn failure(error: &kube::Error, verb: &str, resource: &str) -> Failure {
    if twigo_kube::errors::no_credential(error) {
        return Failure::Terminal(ViewState::Unauthorized);
    }
    match error {
        kube::Error::Api(status) if status.code == 410 => return Failure::Gone,
        // The connection broke under the watch.
        kube::Error::ReadEvents(_) => return Failure::Transient,
        _ => {}
    }
    let error = twigo_kube::errors::request(error);
    match error.kind {
        ErrorKind::Unavailable | ErrorKind::Timeout => Failure::Transient,
        ErrorKind::Unauthorized => Failure::Terminal(ViewState::Unauthorized),
        ErrorKind::Forbidden => Failure::Terminal(ViewState::Forbidden {
            verb: verb.to_owned(),
            resource: resource.to_owned(),
        }),
        _ => Failure::Terminal(ViewState::Error { error }),
    }
}
