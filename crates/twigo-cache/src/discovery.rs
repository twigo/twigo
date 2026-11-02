//! What a context serves (ARCHITECTURE 3.6), followed: discovery comes from
//! the disk cache revalidated with its ETags, and again after the CRDs or
//! APIServices the hub lists change, every minute while the person may not
//! list them, and after the hub's longest backoff while it fails, which
//! keeps the resources the server last answered.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};
use twigo_ipc::{Discovered, ErrorKind, IpcError, ViewState};
use twigo_kube::discovery::{Cache, Discovery, Error};

use crate::hub::{Hub, Query, RETRY_WITHIN, Resource, RowFormat, Subscription};
use crate::table::Row;

/// The API server updates its discovery from a change of a CRD or an
/// APIService in a controller of its own, which may not be done when the
/// change reaches Twigo: discovery is fetched once the changes settle, and
/// twice more after the last of them.
const SETTLE: Duration = Duration::from_millis(500);
const RECHECKS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(10)];
/// kube-aggregator's `discoveryRefreshInterval`, how often the API server
/// asks an aggregated server for its discovery.
pub const POLL: Duration = Duration::from_secs(60);

pub struct Follower {
    hub: Hub,
    cache: Arc<Cache>,
    context: String,
    indexes: [Index; 2],
    /// The discovery last answered, or cached, by the server's URL.
    known: Option<(String, Discovery)>,
    /// Whether the server answered `known` to this follower: a cached copy
    /// may be another cluster's that took over the URL, which only the
    /// server's ETags tell apart.
    confirmed: bool,
    /// Whether the clients of the last fetch were replaced.
    abandoned: Option<watch::Receiver<bool>>,
    /// The fetches due after a change, soonest first.
    due: Vec<Instant>,
    poll: Instant,
    /// What the last fetch's failure asks for.
    failed: Option<Failed>,
    last: Option<Discovered>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failed {
    Retry,
    /// The context's credential failed: retrying would run its plugin by
    /// itself, so the next follower asks again, as a subscription restarts
    /// the hub's upstreams (ARCHITECTURE 3.2), or rebuilt clients.
    Stop,
}

/// CRDs or APIServices, as the hub lists their metadata.
struct Index {
    rows: Subscription<Row>,
    /// A digest of the rows' names and versions, once listed.
    seen: Option<u64>,
}

impl Follower {
    pub async fn new(hub: Hub, cache: Arc<Cache>, context: String) -> Self {
        let index = async |group: &str, resource: &str| {
            let rows = hub
                .rows(Query {
                    context: context.clone(),
                    resource: Resource {
                        group: group.to_owned(),
                        version: "v1".to_owned(),
                        resource: resource.to_owned(),
                        namespaced: false,
                    },
                    format: RowFormat::Metadata,
                    namespaces: Vec::new(),
                    field_selector: None,
                })
                .await
                .expect("its names are path segments");
            Index::new(rows)
        };
        let indexes = [
            index("apiextensions.k8s.io", "customresourcedefinitions").await,
            index("apiregistration.k8s.io", "apiservices").await,
        ];
        Self {
            hub,
            cache,
            context,
            indexes,
            known: None,
            confirmed: false,
            abandoned: None,
            due: Vec::new(),
            poll: Instant::now() + POLL,
            failed: None,
            last: None,
        }
    }

    /// The context's resources at first, then each time they change.
    pub async fn next(&mut self) -> Discovered {
        loop {
            if self.last.is_some() {
                self.wait().await;
            }
            let discovered = self.fetch().await;
            self.poll = Instant::now() + POLL;
            if self.last.as_ref() != Some(&discovered) {
                self.last = Some(discovered.clone());
                return discovered;
            }
        }
    }

    async fn wait(&mut self) {
        if self.failed == Some(Failed::Stop) {
            return replaced(&mut self.abandoned).await;
        }
        let retry = (self.failed == Some(Failed::Retry)).then(|| Instant::now() + RETRY_WITHIN);
        loop {
            let refused = self.indexes.iter().any(Index::refused);
            let due = self.due.first().copied();
            let [crds, apiservices] = &mut self.indexes;
            let changed = tokio::select! {
                () = sleep_until(due.unwrap_or(self.poll)), if due.is_some() => {
                    self.due.remove(0);
                    return;
                }
                () = sleep_until(retry.unwrap_or(self.poll)), if retry.is_some() => return,
                () = sleep_until(self.poll), if refused => return,
                () = replaced(&mut self.abandoned) => return,
                changed = crds.changed() => changed,
                changed = apiservices.changed() => changed,
            };
            if changed {
                let now = Instant::now();
                self.due = std::iter::once(SETTLE)
                    .chain(RECHECKS)
                    .map(|after| now + after)
                    .collect();
            }
        }
    }

    async fn fetch(&mut self) -> Discovered {
        let clients = match self.hub.clients(&self.context).await {
            Ok(clients) => clients,
            Err(error) => {
                // Whatever server the context now reaches, it is not known.
                self.abandoned = None;
                self.known = None;
                let stop = error.kind == ErrorKind::Unauthorized;
                return self.failure(error, stop);
            }
        };
        self.abandoned = Some(clients.connections().abandoned());
        let server = clients.server().to_string();
        if self
            .known
            .as_ref()
            .is_none_or(|(known, _)| *known != server)
        {
            self.known = self
                .load(&server)
                .await
                .map(|found| (server.clone(), found));
            self.confirmed = false;
        }
        let cached = self.known.as_ref().map(|(_, discovery)| discovery);
        match Discovery::refresh(&clients.api, cached).await {
            Ok(None) => self.confirmed = true,
            Ok(Some(discovery)) => {
                self.store(&server, &discovery).await;
                self.known = Some((server, discovery));
                self.confirmed = true;
            }
            Err(error) => {
                let stop = match &error {
                    Error::Request(request) => {
                        twigo_kube::errors::no_credential(request)
                            || twigo_kube::errors::request(request).kind == ErrorKind::Unauthorized
                    }
                    Error::NotAggregated { .. } | Error::Decode { .. } => false,
                };
                return self.failure(IpcError::from(&error), stop);
            }
        }
        self.failed = None;
        let (_, discovery) = self.known.as_ref().expect("refreshed or revalidated");
        Discovered::Ready {
            resources: discovery.resources(),
        }
    }

    /// The resources the server last answered, a failed refresh
    /// notwithstanding, or the failure when it answered none.
    fn failure(&mut self, error: IpcError, stop: bool) -> Discovered {
        self.failed = Some(if stop { Failed::Stop } else { Failed::Retry });
        match &self.known {
            Some((_, discovery)) if self.confirmed => Discovered::Ready {
                resources: discovery.resources(),
            },
            _ => Discovered::Failed { error },
        }
    }

    async fn load(&self, server: &str) -> Option<Discovery> {
        let cache = Arc::clone(&self.cache);
        let key = server.to_owned();
        let loaded = tokio::task::spawn_blocking(move || cache.load(&key))
            .await
            .expect("loading does not panic");
        loaded.unwrap_or_else(|error| {
            eprintln!("could not read the cached discovery of {server}: {error}");
            None
        })
    }

    async fn store(&self, server: &str, discovery: &Discovery) {
        let cache = Arc::clone(&self.cache);
        let key = server.to_owned();
        let discovery = discovery.clone();
        let stored = tokio::task::spawn_blocking(move || cache.store(&key, &discovery))
            .await
            .expect("storing does not panic");
        if let Err(error) = stored {
            eprintln!("could not cache the discovery of {server}: {error}");
        }
    }
}

impl Index {
    fn new(rows: Subscription<Row>) -> Self {
        let mut index = Self { rows, seen: None };
        index.seen = index.digest();
        index
    }

    fn refused(&self) -> bool {
        matches!(
            self.rows.state(),
            ViewState::Forbidden { .. } | ViewState::Error { .. }
        )
    }

    fn digest(&self) -> Option<u64> {
        if !self.rows.listed() {
            return None;
        }
        let mut rows: Vec<(Box<str>, Box<str>)> = self
            .rows
            .items()
            .iter()
            .map(|row| (row.meta.name.clone(), row.meta.resource_version.clone()))
            .collect();
        rows.sort();
        let mut hasher = DefaultHasher::new();
        rows.hash(&mut hasher);
        Some(hasher.finish())
    }

    /// Waits for a change of its rows or its state; whether its rows
    /// changed, their first whole list included.
    async fn changed(&mut self) -> bool {
        self.rows.changed().await;
        let seen = self.digest();
        if seen.is_none() || seen == self.seen {
            return false;
        }
        self.seen = seen;
        true
    }
}

async fn replaced(abandoned: &mut Option<watch::Receiver<bool>>) {
    let Some(abandoned) = abandoned else {
        return std::future::pending().await;
    };
    if abandoned.wait_for(|abandoned| *abandoned).await.is_err() {
        std::future::pending::<()>().await;
    }
}

#[cfg(test)]
mod live;
#[cfg(test)]
mod tests;
