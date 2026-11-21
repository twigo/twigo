//! One upstream's list and watch (ARCHITECTURE 3.2, 3.7): the initial list,
//! streamed where the server compresses streaming lists and in pages
//! elsewhere, then a watch resumed from its last `resourceVersion`, a relist
//! on `410 Gone`, a probe when it goes quiet, and a backoff after failures,
//! refusals included; only rejected credentials stop it.
//!
//! Each line of a watch is decoded and stored as it arrives, so a slow
//! reader never holds the connection back.

use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use bytes::Bytes;
use futures::{AsyncBufRead, AsyncBufReadExt};
use http::header::ACCEPT_ENCODING;
use http::response::Parts;
use http::{HeaderMap, Request};
use http_body_util::BodyExt;
use jiff::Timestamp;
use kube::client::Body;
use tokio::sync::watch;
use twigo_ipc::{ErrorKind, IpcError, ViewState};
use twigo_kube::client::{Clients, Waiting};

use crate::cluster::{Cluster, REFUSED_FOR};
use crate::decode::{Decode, DecodeError, Event};
use crate::encoding;
use crate::request::{self, Collection, Format, WatchFrom};
use crate::store::{Item, Items, Store};

/// Items per list page.
const LIMIT: u32 = 500;
/// kube's default for watches (`kube-core` 5.1, `params.rs`).
const TIMEOUT_SECONDS: u32 = 290;
/// The API server's watch cache sends a bookmark roughly every minute
/// (`cacheWatcher.nextBookmarkTime`, Kubernetes v1.37.0), so two missing
/// mean the watch has stalled.
pub(crate) const IDLE: Duration = Duration::from_secs(120);
/// The longest a streaming list goes without a line before its server is
/// asked whether it answers at all. The server sends its initial events back
/// to back, flushing whenever its queue is empty.
pub(crate) const INITIAL_IDLE: Duration = Duration::from_secs(30);
/// How long the probe's body has, from its headers on, to count as an
/// answer; client-go's ping timeout. A connection whose window unread streams
/// fill still gives headers and never a body. The headers are timed by the
/// client stack, which starts once a request slot admits the probe.
const PROBE: Duration = Duration::from_secs(15);
/// The longest an upstream waits after a failure before it tries again.
pub const RETRY_WITHIN: Duration = Duration::from_secs(5);
/// How often a resource the server cannot watch is listed again.
const POLL: Duration = Duration::from_secs(15);

/// Gets a context's clients, or says why the upstream cannot have them.
pub type Connect = Arc<
    dyn Fn(String) -> futures::future::BoxFuture<'static, Result<Arc<Clients>, IpcError>>
        + Send
        + Sync,
>;

/// The time now, which stamps what the server answers.
pub(crate) type Clock = Arc<dyn Fn() -> Timestamp + Send + Sync>;

/// What an upstream watches.
#[derive(Debug, Clone)]
pub(crate) struct Spec {
    pub context: String,
    /// The group-version, which the cluster keeps what it learnt of lists by.
    pub group: String,
    pub version: String,
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
    /// It holds a watch open, so evicting it frees one.
    watching: AtomicBool,
}

#[derive(Debug, Clone, PartialEq)]
enum Phase {
    Connecting,
    Syncing(u32),
    Ready,
    Relisting,
    Stale,
    /// Refused, `forbidden` or an error, while it retries.
    Refused(ViewState),
    /// `unauthorized`, retried only when someone subscribes again: a retry
    /// by itself would run a credential plugin again.
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
            watching: AtomicBool::new(false),
        }
    }

    pub fn state(&self) -> watch::Receiver<ViewState> {
        self.state.subscribe()
    }

    pub fn current(&self) -> ViewState {
        self.state.borrow().clone()
    }

    /// Its state and whether it has listed, read together: `update` sets
    /// both under the lock.
    pub fn standing(&self) -> (ViewState, bool) {
        let status = self.status();
        (self.current(), status.listed)
    }

    /// The store has held a whole list since the upstream started.
    pub fn listed(&self) -> bool {
        self.status().listed
    }

    /// Rejected credentials ended its run.
    pub fn ended(&self) -> bool {
        matches!(self.status().phase, Phase::Failed(_))
    }

    pub fn watching(&self) -> bool {
        self.watching.load(Ordering::Relaxed)
    }

    /// The state of a run about to start, set before it does, so nobody
    /// reads a failure it is about to retry.
    pub fn restart(&self) {
        self.update(|status| {
            status.queued = false;
            status.phase = if status.listed {
                Phase::Relisting
            } else {
                Phase::Connecting
            };
        });
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
            (Phase::Failed(view) | Phase::Refused(view), _) => view.clone(),
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
    pub clock: Clock,
    pub cluster: Arc<Cluster>,
    /// Told when a watch waits for the budget, and when it stops waiting,
    /// so the hub can evict an idle upstream.
    pub waiting: Arc<dyn Fn(bool) + Send + Sync>,
}

/// Runs the upstream until the server rejects its credentials; the hub
/// aborts it to stop it. A run after a failure starts from the items the store kept.
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
    upstream.restart();
    let mut run = Run {
        watch_waiting: waiting(&upstream, Some(Arc::clone(&env.waiting))),
        list_waiting: waiting(&upstream, None),
        env,
        spec,
        decoder,
        upstream,
        clients: None,
        backoff: backoff(),
        unwatchable: false,
    };
    if let Err(view) = run.run(next).await {
        run.upstream.update(|status| {
            status.queued = false;
            status.phase = Phase::Failed(view);
        });
    }
}

/// The pause between a failure and the next try: 0.5–5 s in all, as the
/// upstreams, log streams and forwards wait.
pub fn backoff() -> ExponentialBackoff {
    paced(Duration::from_millis(500), RETRY_WITHIN / 2)
}

/// The pause before a part whose first list RBAC refused tries again: the
/// hub's own lifetime of RBAC's no, `REFUSED_FOR`.
fn refusal_pause() -> Duration {
    paced(REFUSED_FOR, REFUSED_FOR)
        .next()
        .expect("the backoff has no maximum of attempts")
}

fn paced(min: Duration, max: Duration) -> ExponentialBackoff {
    // Jitter adds up to the delay again (ARCHITECTURE 3.2).
    ExponentialBuilder::new()
        .with_min_delay(min)
        .with_max_delay(max)
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
    /// A list of a resource the server cannot watch ended.
    Polled,
    /// The server does not stream a list: it refused, or answered
    /// without compression, or without the end the stream must have, or
    /// not at all.
    NotStreamed,
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
    /// The server answered a watch with 405, as for ComponentStatus: the
    /// upstream lists again every [`POLL`].
    unwatchable: bool,
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
            let clients = match (self.env.connect)(self.spec.context.clone()).await {
                Ok(clients) => clients,
                Err(error) if error.kind == ErrorKind::Unauthorized => {
                    return Err(ViewState::Unauthorized);
                }
                Err(error) => {
                    self.refused(ViewState::Error { error }).await;
                    continue;
                }
            };
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
                Next::Watch(from) => self.stream(&clients, None, from).await,
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
                    answers(&clients, seen).await;
                    next
                }
                Outcome::NotStreamed => unreachable!("a streaming list is only asked for by list"),
                Outcome::Gone => Next::List,
                Outcome::NoColumns(next) => {
                    self.interrupted();
                    self.pause().await;
                    next
                }
                Outcome::Polled => {
                    let mut abandoned = clients.connections().abandoned();
                    tokio::select! {
                        () = tokio::time::sleep(POLL) => {}
                        _ = abandoned.wait_for(|abandoned| *abandoned) => {}
                    }
                    Next::List
                }
                Outcome::Failed {
                    error: kube::Error::Api(status),
                    verb: "watch",
                    ..
                } if status.code == 405 => {
                    self.unwatchable = true;
                    Next::List
                }
                Outcome::Undecodable(error) => {
                    self.refused(undecodable(&error)).await;
                    Next::List
                }
                Outcome::Failed { error, verb, next } => {
                    match failure(&error, verb, &self.spec.resource) {
                        Failure::Gone => Next::List,
                        Failure::Transient => {
                            self.interrupted();
                            self.pause().await;
                            next
                        }
                        Failure::Refused(view) => {
                            self.refused(view).await;
                            next
                        }
                        Failure::Unauthorized => return Err(ViewState::Unauthorized),
                    }
                }
            };
        }
    }

    /// Lists the collection, by a streaming list where the server
    /// compresses them, and goes on watching.
    async fn list(&mut self, clients: &Arc<Clients>) -> Outcome {
        let listed = self.upstream.status().listed;
        if !listed {
            self.forget_partial();
        }
        if listed && !self.unwatchable {
            self.set_phase(Phase::Relisting);
        }
        let listing = || Listing {
            collected: listed.then(Items::new),
            loaded: 0,
        };
        let streams = self
            .env
            .cluster
            .streams(clients, &self.spec.group, &self.spec.version);
        if streams && !self.unwatchable {
            match self.stream(clients, Some(listing()), "".into()).await {
                Outcome::NotStreamed => {
                    self.env
                        .cluster
                        .page(clients, &self.spec.group, &self.spec.version);
                    if !listed {
                        self.forget_partial();
                        self.set_phase(Phase::Connecting);
                    }
                }
                outcome => return outcome,
            }
        }
        self.paginate(clients, listing()).await
    }

    /// What an interrupted or refused first list stored.
    fn forget_partial(&self) {
        if !self.upstream.store.is_empty() {
            self.upstream.store.replace(Items::new());
        }
    }

    /// A list in pages, then a watch from its `resourceVersion`.
    async fn paginate(&mut self, clients: &Arc<Clients>, mut listing: Listing<D::Item>) -> Outcome {
        let mut token: Option<Box<str>> = None;
        let from = loop {
            let mut request = request::list(&self.collection(), LIMIT, token.as_deref());
            request.extensions_mut().insert(self.list_waiting.clone());
            let (body, received) = match fetch(clients, request, &self.env.clock).await {
                Ok(page) => page,
                Err(error) => {
                    return Outcome::Failed {
                        error,
                        verb: "list",
                        next: Next::List,
                    };
                }
            };
            let page = match self.decoder.decode_list(&body, received) {
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
        if self.unwatchable {
            return Outcome::Polled;
        }
        self.stream(clients, None, from).await
    }

    /// Reads a watch until it ends: the initial events of a streaming list
    /// first, given `listing`, then the changes after `from`. A streaming
    /// list the server does not stream ends as [`Outcome::NotStreamed`].
    async fn stream(
        &mut self,
        clients: &Arc<Clients>,
        mut listing: Option<Listing<D::Item>>,
        mut from: Box<str>,
    ) -> Outcome {
        let again = |from: &str, listing: &Option<Listing<D::Item>>| match listing {
            Some(_) => Next::List,
            None => Next::Watch(from.into()),
        };
        let mut retired = clients.connections().retired();
        let seen = *retired.borrow_and_update();
        // Abandoned clients say so to whoever looks, however late.
        let mut abandoned = clients.connections().abandoned();
        let mut abandoned = std::pin::pin!(async move {
            if abandoned.wait_for(|abandoned| *abandoned).await.is_err() {
                std::future::pending::<()>().await;
            }
        });
        let start = match listing {
            Some(_) => WatchFrom::InitialEvents,
            None => WatchFrom::ResourceVersion(&from),
        };
        let mut request = request::watch(&self.collection(), start, TIMEOUT_SECONDS);
        request.extensions_mut().insert(self.watch_waiting.clone());
        let (parts, body) = tokio::select! {
            opened = open(clients, request) => match opened {
                Ok(opened) => opened,
                Err(kube::Error::Api(status))
                    if listing.is_some() && matches!(status.code, 400 | 422) =>
                {
                    return Outcome::NotStreamed;
                }
                Err(error) => {
                    let next = again(&from, &listing);
                    return Outcome::Failed { error, verb: "watch", next };
                }
            },
            _ = retired.changed() => return Outcome::Retired(again(&from, &listing)),
            () = &mut abandoned => return Outcome::Retired(again(&from, &listing)),
        };
        // A server that streams without compression, as 1.34 to 1.36 do, is
        // paged instead, since its pages come gzipped.
        if listing.is_some() && !encoding::gzipped(&parts.headers) {
            return Outcome::NotStreamed;
        }
        let mut lines: Lines = Box::pin(encoding::lines(&parts.headers, body));
        let _watching = Watching::new(&self.upstream.watching);
        if listing.is_none() {
            // The server watches from `from`, so nothing was missed.
            self.set_phase(Phase::Ready);
        }
        let mut quiet = true;
        let mut line = Vec::new();
        loop {
            line.clear();
            let idle = if listing.is_some() {
                INITIAL_IDLE
            } else {
                IDLE
            };
            let read = tokio::select! {
                read = tokio::time::timeout(idle, lines.read_until(b'\n', &mut line)) => read,
                _ = retired.changed() => return Outcome::Retired(again(&from, &listing)),
                () = &mut abandoned => return Outcome::Retired(again(&from, &listing)),
            };
            match read {
                Err(_) if listing.is_some() => {
                    // A server that answers and sends nothing does not stream.
                    return if answers(clients, seen).await {
                        Outcome::NotStreamed
                    } else {
                        Outcome::Retired(Next::List)
                    };
                }
                Err(_) => {
                    let next = again(&from, &listing);
                    return Outcome::Idle { next, seen };
                }
                Ok(Ok(0)) if listing.is_some() => return Outcome::NotStreamed,
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
            let received = (self.env.clock)();
            let event = match self.decoder.decode_event(&line, received) {
                Ok(event) => event,
                Err(DecodeError::NoColumns) => return Outcome::NoColumns(again(&from, &listing)),
                Err(_) if listing.is_some() => return Outcome::NotStreamed,
                Err(error) => return Outcome::Undecodable(error),
            };
            self.upstream.store.set_columns(self.decoder.columns());
            if !matches!(event, Event::Error(_)) {
                self.backoff = backoff();
            }
            match event {
                Event::Upsert(item) => {
                    advance(&mut from, item.meta());
                    match &mut listing {
                        Some(listing) => self.add(listing, item),
                        None => self.upstream.store.upsert(item),
                    }
                }
                Event::Delete(_) if listing.is_some() => return Outcome::NotStreamed,
                Event::Delete(item) => {
                    advance(&mut from, item.meta());
                    self.upstream.store.delete(&item);
                }
                Event::Bookmark {
                    resource_version,
                    initial_events_end,
                } => {
                    if listing.is_some() && !initial_events_end {
                        return Outcome::NotStreamed;
                    }
                    from = resource_version;
                    if let Some(done) = listing.take() {
                        self.listed(done);
                    }
                }
                Event::Error(_) if listing.is_some() => return Outcome::NotStreamed,
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
            Some(items) => self.upstream.store.collect(items, item),
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

    /// Shows why the server refused, then waits to try again: an API server
    /// that just restarted refuses for a while what it allows, so a part
    /// that has listed tries soon, while one that never did, whose RBAC said
    /// no, waits for the no to pass.
    async fn refused(&mut self, view: ViewState) {
        let unlisted_no =
            matches!(view, ViewState::Forbidden { .. }) && !self.upstream.status().listed;
        self.set_phase(Phase::Refused(view));
        if unlisted_no {
            tokio::time::sleep(refusal_pause()).await;
        } else {
            self.pause().await;
        }
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

/// Marks an upstream as holding a watch while the guard lives.
struct Watching<'a>(&'a AtomicBool);

impl<'a> Watching<'a> {
    fn new(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::Relaxed);
        Self(flag)
    }
}

impl Drop for Watching<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// A watch resumes after the last change it saw; objects built without a
/// `resourceVersion`, such as ComponentStatus, leave it be.
fn advance(from: &mut Box<str>, meta: &crate::meta::Meta) {
    if !meta.resource_version.is_empty() {
        from.clone_from(&meta.resource_version);
    }
}

/// Every item of a collection, listed once in pages as an upstream lists it,
/// for a reader that needs the names and no watch: the list takes a request
/// slot, where a watch waits for one of the budget's watches.
pub(crate) async fn read<D: Decode>(
    clients: &Clients,
    clock: &Clock,
    collection: &Collection<'_>,
    resource: &str,
    mut decoder: D,
) -> Result<Vec<D::Item>, ViewState> {
    let mut items = Vec::new();
    let mut token: Option<Box<str>> = None;
    loop {
        let request = request::list(collection, LIMIT, token.as_deref());
        let (body, received) =
            fetch(clients, request, clock).await.map_err(|error| {
                match failure(&error, "list", resource) {
                    Failure::Refused(view) => view,
                    Failure::Unauthorized => ViewState::Unauthorized,
                    Failure::Gone | Failure::Transient => ViewState::Stale,
                }
            })?;
        let page = decoder
            .decode_list(&body, received)
            .map_err(|error| undecodable(&error))?;
        items.extend(page.items);
        match page.continue_token {
            Some(next) => token = Some(next),
            None => return Ok(items),
        }
    }
}

fn undecodable(error: &DecodeError) -> ViewState {
    let error = IpcError::new(
        ErrorKind::Internal,
        format!("could not decode the server's answer: {error}"),
    );
    ViewState::Error { error }
}

/// A list page, and when its response started: its status and headers have
/// arrived, which `Client::send` yields before the body. The server prints a
/// row's ages as it builds the answer, so a page stamped once its body is
/// whole, seconds later on a slow link, would count each age from a later
/// moment than it was printed at. What is left is the server's time from
/// printing to writing the first bytes, and the network's for them.
async fn fetch(
    clients: &Clients,
    request: Request<Vec<u8>>,
    clock: &Clock,
) -> Result<(Bytes, Timestamp), kube::Error> {
    let (parts, body) = open(clients, request).await?;
    let started = clock();
    Ok((whole(&parts.headers, body).await?, started))
}

/// A response's status and headers with its body, or the refusal in place
/// of them, to a request that asks for gzip.
async fn open(
    clients: &Clients,
    mut request: Request<Vec<u8>>,
) -> Result<(Parts, Body), kube::Error> {
    request
        .headers_mut()
        .insert(ACCEPT_ENCODING, encoding::GZIP);
    let response = clients.api.send(request.map(Body::from)).await?;
    let (parts, body) = response.into_parts();
    if !parts.status.is_success() {
        return Err(match whole(&parts.headers, body).await {
            Ok(body) => twigo_kube::errors::refused(parts.status, &body),
            Err(error) => error,
        });
    }
    Ok((parts, body))
}

async fn whole(headers: &HeaderMap, body: Body) -> Result<Bytes, kube::Error> {
    let body = body.collect().await?.to_bytes();
    encoding::page(headers, body).map_err(|error| kube::Error::Service(Box::new(error)))
}

/// Whether the connection still answers, any status included: a quiet
/// watch on a live one opens again alone, and one on a dead one is retired
/// for every upstream.
async fn answers(clients: &Clients, seen: u64) -> bool {
    let mut version = Request::new(Vec::new());
    *version.uri_mut() = http::Uri::from_static("/version");
    let answered = match clients.api.send(version.map(Body::from)).await {
        Ok(response) => {
            let mut body = response.into_body();
            let drained = async {
                while body.frame().await.transpose()?.is_some() {}
                Ok::<_, kube::Error>(())
            };
            matches!(tokio::time::timeout(PROBE, drained).await, Ok(Ok(())))
        }
        Err(_) => false,
    };
    if !answered {
        clients.connections().retire_after(seen);
    }
    answered
}

enum Failure {
    Gone,
    Transient,
    Refused(ViewState),
    Unauthorized,
}

fn failure(error: &kube::Error, verb: &str, resource: &str) -> Failure {
    if twigo_kube::errors::no_credential(error) {
        return Failure::Unauthorized;
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
        ErrorKind::Unauthorized => Failure::Unauthorized,
        ErrorKind::Forbidden => Failure::Refused(ViewState::Forbidden {
            verb: verb.to_owned(),
            resource: resource.to_owned(),
        }),
        _ => Failure::Refused(ViewState::Error { error }),
    }
}
