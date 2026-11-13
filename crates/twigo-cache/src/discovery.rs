//! What a context serves (ARCHITECTURE 3.6), followed: discovery comes from
//! the disk cache revalidated with its ETags, and again after the CRDs or
//! APIServices the hub lists change, every minute while the person may not
//! list them, after the hub's longest backoff while it fails, which keeps
//! the resources the server last answered, and once the context's entry in
//! the kubeconfig changes, even after a failed credential stopped it.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};
use twigo_ipc::{Discovered, ErrorKind, IpcError, ViewState};
use twigo_kube::discovery::{Cache, Discovery, Error};
use twigo_kube::kubeconfig::Fingerprint;

use crate::hub::{Hub, Query, RETRY_WITHIN, Resource, RowFormat, Subscription};
use crate::table::Row;

/// The API server updates its discovery from a change of a CRD or an
/// APIService in a controller of its own, which may not be done when the
/// change reaches Twigo: discovery is fetched once the changes settle, or
/// the first recheck after the first of them, whichever comes first, and
/// at the rechecks after the last of them.
const SETTLE: Duration = Duration::from_millis(500);
const RECHECKS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(10)];
/// kube-aggregator's `discoveryRefreshInterval`, how often the API server
/// asks an aggregated server for its discovery.
pub const POLL: Duration = Duration::from_secs(60);

pub struct Follower {
    hub: Hub,
    cache: Arc<Cache>,
    context: String,
    /// The context's fingerprint, whose change restarts the follower.
    entry: watch::Receiver<Option<Fingerprint>>,
    indexes: [Index; 2],
    /// The discovery last answered, or cached, by the cluster, as
    /// `Clients::cluster` names it.
    known: Option<(String, Discovery)>,
    /// Whether the server answered `known` to this follower: a cached copy
    /// may be another cluster's at the same address and with the same
    /// trust, as behind a load balancer, which only the server's ETags tell
    /// apart.
    confirmed: bool,
    /// Whether the clients of the last fetch were replaced.
    abandoned: Option<watch::Receiver<bool>>,
    /// The fetches due after a change, soonest first.
    due: Vec<Instant>,
    /// When the first change since the last fetch came.
    burst: Option<Instant>,
    poll: Instant,
    /// What the last fetch's failure asks for.
    failed: Option<Failed>,
    /// The cluster the last `Pending` named.
    named: Option<String>,
    last: Option<Discovered>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failed {
    Retry,
    /// The context's credential failed: retrying would run its plugin by
    /// itself, so it asks again once the person changes the context's
    /// entry, or the next follower does (ARCHITECTURE 3.2).
    Stop,
}

/// CRDs or APIServices, as the hub lists their metadata.
struct Index {
    rows: Subscription<Row>,
    /// A digest of the rows' names and versions, once listed.
    seen: Option<u64>,
}

impl Follower {
    pub async fn new(
        hub: Hub,
        cache: Arc<Cache>,
        context: String,
        mut entry: watch::Receiver<Option<Fingerprint>>,
    ) -> Self {
        entry.borrow_and_update();
        let indexes = indexes(&hub, &context).await;
        let listed = indexes.iter().any(|index| index.seen.is_some());
        let mut follower = Self {
            hub,
            cache,
            context,
            entry,
            indexes,
            known: None,
            confirmed: false,
            abandoned: None,
            due: Vec::new(),
            burst: None,
            poll: Instant::now() + POLL,
            failed: None,
            named: None,
            last: None,
        };
        // Indexes that another follower left listed have told it changes
        // whose discovery may still lag.
        if listed {
            follower.schedule();
        }
        follower
    }

    /// The cluster the context reaches at first, as soon as its clients
    /// are built, then its resources, then each time they change, with the
    /// cluster named first again whenever an edit moves the context to
    /// another.
    pub async fn next(&mut self) -> Discovered {
        let mut wait = !matches!(self.last, None | Some(Discovered::Pending { .. }));
        loop {
            if wait {
                self.wait().await;
            }
            wait = true;
            self.burst = None;
            let Some(discovered) = self.fetch().await else {
                wait = false;
                continue;
            };
            self.poll = Instant::now() + POLL;
            if self.last.as_ref() != Some(&discovered) {
                self.last = Some(discovered.clone());
                return discovered;
            }
        }
    }

    /// The discovery the cluster last answered to this follower, or
    /// confirmed against its ETags, as the last [`Self::next`] sent it.
    pub fn confirmed(&self) -> Option<&Discovery> {
        self.known
            .as_ref()
            .filter(|_| self.confirmed)
            .map(|(_, discovery)| discovery)
    }

    async fn wait(&mut self) {
        if self.failed == Some(Failed::Stop) {
            edited(&mut self.entry).await;
            return self.restart().await;
        }
        let retry = (self.failed == Some(Failed::Retry)).then(|| Instant::now() + RETRY_WITHIN);
        loop {
            let refused = self.indexes.iter().any(Index::refused);
            let due = self.due.first().copied();
            let [crds, apiservices] = &mut self.indexes;
            // In order, so an edit restarts before a change its new
            // subscriptions tell again.
            let changed = tokio::select! {
                biased;
                () = edited(&mut self.entry) => return self.restart().await,
                () = replaced(&mut self.abandoned) => return,
                () = sleep_until(due.unwrap_or(self.poll)), if due.is_some() => {
                    self.due.remove(0);
                    return;
                }
                () = sleep_until(retry.unwrap_or(self.poll)), if retry.is_some() => return,
                () = sleep_until(self.poll), if refused => return,
                changed = crds.changed() => changed,
                changed = apiservices.changed() => changed,
            };
            if changed {
                self.schedule();
            }
        }
    }

    /// The fetches after a change, from now.
    fn schedule(&mut self) {
        let now = Instant::now();
        let burst = *self.burst.get_or_insert(now);
        let settled = (now + SETTLE).min(burst + RECHECKS[0]);
        self.due = std::iter::once(settled)
            .chain(RECHECKS.map(|after| now + after))
            .collect();
    }

    /// Holds the indexes anew, which restarts those a failed credential
    /// ended, as the hub restarts an ended upstream for a new subscription,
    /// and forgets the failure. The fetches due after a change stay, since
    /// the server's discovery may still lag it, and a change the old
    /// subscriptions had not told yet is one too.
    async fn restart(&mut self) {
        let indexes = indexes(&self.hub, &self.context).await;
        let untold = indexes
            .iter()
            .zip(&self.indexes)
            .any(|(new, old)| new.seen.is_some() && new.seen != old.seen);
        self.indexes = indexes;
        self.failed = None;
        if untold {
            self.schedule();
        }
    }

    /// The cluster when the clients reach another than the one named last,
    /// else discovery; none when an edit came while it was asked.
    async fn fetch(&mut self) -> Option<Discovered> {
        let clients = match self.hub.clients(&self.context).await {
            Ok(clients) => clients,
            Err(error) => {
                // Whatever server the context now reaches, it is not known.
                self.abandoned = None;
                self.known = None;
                let stop = error.kind == ErrorKind::Unauthorized;
                return Some(self.failure(error, stop));
            }
        };
        self.abandoned = Some(clients.connections().abandoned());
        let cluster = clients.cluster().to_owned();
        if self.named.as_ref() != Some(&cluster) {
            self.named = Some(cluster.clone());
            return Some(Discovered::Pending { cluster });
        }
        if self
            .known
            .as_ref()
            .is_none_or(|(known, _)| *known != cluster)
        {
            self.known = self
                .load(&cluster)
                .await
                .map(|found| (cluster.clone(), found));
            self.confirmed = false;
        }
        let cached = self.known.as_ref().map(|(_, discovery)| discovery);
        let refreshed = tokio::select! {
            biased;
            () = edited(&mut self.entry) => None,
            refreshed = Discovery::refresh(&clients.api, cached) => Some(refreshed),
        };
        let Some(refreshed) = refreshed else {
            // The request may wait on the old cluster's timeout or sign-in,
            // while the edit may have moved the context to another one.
            self.restart().await;
            return None;
        };
        match refreshed {
            Ok(None) => self.confirmed = true,
            Ok(Some(discovery)) => {
                self.store(&cluster, &discovery).await;
                self.known = Some((cluster, discovery));
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
                return Some(self.failure(IpcError::from(&error), stop));
            }
        }
        self.failed = None;
        let (cluster, discovery) = self.known.as_ref().expect("refreshed or revalidated");
        Some(Discovered::Ready {
            cluster: cluster.clone(),
            resources: discovery.resources(),
        })
    }

    /// The resources the server last answered, a failed refresh
    /// notwithstanding, or the failure when it answered none.
    fn failure(&mut self, error: IpcError, stop: bool) -> Discovered {
        self.failed = Some(if stop { Failed::Stop } else { Failed::Retry });
        match &self.known {
            Some((cluster, discovery)) if self.confirmed => Discovered::Ready {
                cluster: cluster.clone(),
                resources: discovery.resources(),
            },
            _ => Discovered::Failed { error },
        }
    }

    async fn load(&self, cluster: &str) -> Option<Discovery> {
        let cache = Arc::clone(&self.cache);
        let key = cluster.to_owned();
        let loaded = tokio::task::spawn_blocking(move || cache.load(&key))
            .await
            .expect("loading does not panic");
        loaded.unwrap_or_else(|error| {
            eprintln!("could not read the cached discovery of {cluster}: {error}");
            None
        })
    }

    async fn store(&self, cluster: &str, discovery: &Discovery) {
        let cache = Arc::clone(&self.cache);
        let key = cluster.to_owned();
        let discovery = discovery.clone();
        let stored = tokio::task::spawn_blocking(move || cache.store(&key, &discovery))
            .await
            .expect("storing does not panic");
        if let Err(error) = stored {
            eprintln!("could not cache the discovery of {cluster}: {error}");
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

/// The CRDs and the APIServices of the context, as the hub lists their
/// metadata.
async fn indexes(hub: &Hub, context: &str) -> [Index; 2] {
    let index = async |group: &str, resource: &str| {
        let rows = hub
            .rows(Query {
                context: context.to_owned(),
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
    [
        index("apiextensions.k8s.io", "customresourcedefinitions").await,
        index("apiregistration.k8s.io", "apiservices").await,
    ]
}

/// Waits for the context's entry to change; never once nothing follows it.
async fn edited(entry: &mut watch::Receiver<Option<Fingerprint>>) {
    if entry.changed().await.is_err() {
        std::future::pending::<()>().await;
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
