//! The catalog (ARCHITECTURE 5.5): every context its sources list. M1 has
//! one source, the kubeconfig files.

#[cfg(test)]
mod tests;

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{self, AtomicU64};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use twigo_ipc::{CatalogFailure, IpcError};
use twigo_kube::kubeconfig::{self, Fingerprint, Sources, Watch};
use twigo_policy::{Metadata, Policy, TypeLock};

/// The contexts, ordered by their `order`, those without one last, then by
/// name.
#[derive(Debug, PartialEq, Eq)]
pub struct Contexts {
    listed: Vec<kubeconfig::Context>,
    /// The files that could not be read, merged or watched.
    failures: Vec<CatalogFailure>,
    /// By name: the read at which what the catalog says of the context for
    /// its mode last changed, or it was listed again ([`Metadata::revision`]).
    revisions: HashMap<String, u64>,
    /// How many reads came before this one.
    read: u64,
}

/// The contexts as the sources list them, ordered, and what they could not.
fn sorted(catalog: kubeconfig::Catalog) -> (Vec<kubeconfig::Context>, Vec<CatalogFailure>) {
    let mut contexts = catalog.contexts;
    contexts.sort_by(|a, b| by_order(a.order, b.order).then_with(|| a.name.cmp(&b.name)));
    (contexts, catalog.failures)
}

/// Says what changed in the failures since the last read, one line for each
/// file: a failure that holds is not said again.
fn tell_failures(before: &[CatalogFailure], now: &[CatalogFailure]) {
    for failure in now.iter().filter(|failure| !before.contains(failure)) {
        tracing::warn!(
            path = %failure.source,
            code = %failure.error.code,
            "{}",
            failure.error.message
        );
    }
    for failure in before.iter().filter(|failure| !now.contains(failure)) {
        tracing::info!(path = %failure.source, code = %failure.error.code, "the file no longer fails");
    }
}

impl Contexts {
    /// `listed`, read after `before`: a context keeps its revision while
    /// what the catalog says of it stays, else takes this read's.
    fn new(
        listed: Vec<kubeconfig::Context>,
        failures: Vec<CatalogFailure>,
        before: Option<&Self>,
    ) -> Self {
        let read = before.map_or(0, |before| before.read + 1);
        let mut revisions = HashMap::new();
        for context in &listed {
            // A name listed twice counts by its first, as `find` takes it.
            if revisions.contains_key(&context.name) {
                continue;
            }
            let kept = before.and_then(|before| {
                let was = before.find(&context.name)?;
                let revision = before.revisions[&context.name];
                (metadata(was, revision) == metadata(context, revision)).then_some(revision)
            });
            revisions.insert(context.name.clone(), kept.unwrap_or(read));
        }
        Self {
            listed,
            failures,
            revisions,
            read,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &kubeconfig::Context> {
        self.listed.iter()
    }

    pub fn find(&self, name: &str) -> Option<&kubeconfig::Context> {
        self.listed.iter().find(|context| context.name == name)
    }

    fn metadata(&self, name: &str) -> Option<Metadata> {
        let found = self.find(name)?;
        Some(metadata(found, self.revisions[name]))
    }

    /// Tells `policy` of each context whose metadata differs from what
    /// `before` said of it, one listed in only one of them included.
    fn tell(&self, before: &Self, policy: &Policy) {
        let names: BTreeSet<&str> = (before.listed.iter().chain(&self.listed))
            .map(|context| context.name.as_str())
            .collect();
        for name in names {
            let (was, is) = (before.metadata(name), self.metadata(name));
            if was != is {
                policy.catalog_changed(name, was, is);
            }
        }
    }

    pub fn ipc(&self, policy: &Policy) -> twigo_ipc::Catalog {
        let contexts = self
            .listed
            .iter()
            .map(|context| twigo_ipc::Context {
                name: context.name.clone(),
                color: context.color,
                source: context.source.clone(),
                server: context.server.clone(),
                access: policy.access(&context.name),
                namespace: context.namespace.clone(),
                problem: context.problem.as_ref().map(IpcError::from),
            })
            .collect();
        twigo_ipc::Catalog {
            contexts,
            failures: self.failures.clone(),
        }
    }
}

/// What the catalog says of a context for its mode.
fn metadata(context: &kubeconfig::Context, revision: u64) -> Metadata {
    Metadata {
        read_only: context.read_only,
        provider: None,
        environment: context.environment.and_then(TypeLock::of),
        connection: context.fingerprint.value(),
        revision,
    }
}

fn by_order(a: Option<i64>, b: Option<i64>) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// The kubeconfig files to read: in the explicit mode only
/// `explicit`, else kubectl's, from the login shell's `KUBECONFIG` and
/// `HOME`.
pub fn sources(
    explicit: Option<PathBuf>,
    kubeconfig: Option<&OsStr>,
    home: Option<&Path>,
) -> Sources {
    match explicit {
        Some(file) => Sources::explicit(file),
        None => Sources::kubectl(kubeconfig, home),
    }
}

pub struct Catalog {
    /// None until the sources have been read once.
    contexts: watch::Sender<Option<Arc<Contexts>>>,
    /// Counts the changes to the files it follows, those that leave the
    /// contexts as they were included.
    written: watch::Sender<u64>,
    /// What it follows: set before the first read is published.
    sources: Mutex<Option<Sources>>,
    followed: Mutex<Option<Watch>>,
    /// Counts [`Catalog::follow`] calls, so that a watch it replaced cannot
    /// publish after its successor.
    generation: Arc<AtomicU64>,
    /// Told of what each read after the first changes of a context, for its
    /// audit log.
    policy: Option<Arc<Policy>>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            contexts: watch::Sender::new(None),
            written: watch::Sender::new(0),
            sources: Mutex::new(None),
            followed: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
            policy: None,
        }
    }
}

impl Catalog {
    /// The catalog, whose changes after its first read `policy` is told of
    /// as each is published, before anything reads it: a lock an edit takes
    /// away leaves a line in the audit log.
    pub fn audited_by(self, policy: Arc<Policy>) -> Self {
        Self {
            policy: Some(policy),
            ..self
        }
    }

    /// Reads `sources` and follows their changes, in place of what it
    /// followed before.
    pub fn follow(&self, sources: Sources) {
        let mut followed = self.followed.lock().expect("catalog lock");
        followed.take();
        *self.sources.lock().expect("catalog lock") = Some(sources.clone());
        let generation = self.generation.fetch_add(1, atomic::Ordering::AcqRel) + 1;
        let publish = {
            let contexts = self.contexts.clone();
            let current = Arc::clone(&self.generation);
            let policy = self.policy.clone();
            move |catalog: kubeconfig::Catalog| {
                let (listed, failures) = sorted(catalog);
                // Under the channel's write lock, which the successor's
                // publish takes too, so the two cannot interleave.
                contexts.send_if_modified(|now| {
                    if current.load(atomic::Ordering::Acquire) != generation
                        || now
                            .as_ref()
                            .is_some_and(|now| now.listed == listed && now.failures == failures)
                    {
                        return false;
                    }
                    tell_failures(now.as_ref().map_or(&[], |now| &now.failures), &failures);
                    let next = Contexts::new(listed, failures, now.as_deref());
                    if let (Some(policy), Some(before)) = (&policy, now.as_deref()) {
                        next.tell(before, policy);
                    }
                    *now = Some(Arc::new(next));
                    true
                });
            }
        };
        let written = self.written.clone();
        let wrote = move || written.send_modify(|count| *count += 1);
        match Watch::start(sources.clone(), publish.clone(), wrote) {
            Ok(watch) => *followed = Some(watch),
            Err(error) => publish(sources.load().unwatched(&sources, &error)),
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<Option<Arc<Contexts>>> {
        self.contexts.subscribe()
    }

    /// Changes with every change to the files it follows.
    pub fn written(&self) -> watch::Receiver<u64> {
        self.written.subscribe()
    }

    /// The files it reads, once it follows any.
    pub fn sources(&self) -> Option<Sources> {
        self.sources.lock().expect("catalog lock").clone()
    }

    /// A context's fingerprint, followed while the receiver lives: it
    /// changes with what the context's clients are built from, but not
    /// with the oidc tokens that Twigo and kubelogin write back (ARCHITECTURE
    /// 6.2), nor with other contexts. None while no source lists it. It
    /// starts once the sources have been read, so the catalog's first read
    /// is no change.
    pub async fn fingerprint(&self, context: &str) -> watch::Receiver<Option<Fingerprint>> {
        let mut contexts = self.subscribe();
        contexts
            .wait_for(Option::is_some)
            .await
            .expect("the catalog outlives its subscribers");
        let context = context.to_owned();
        let read = move |contexts: &Option<Arc<Contexts>>| {
            contexts
                .as_ref()
                .and_then(|contexts| contexts.find(&context))
                .map(|found| found.fingerprint)
        };
        let (sender, receiver) = watch::channel(read(&contexts.borrow_and_update()));
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = sender.closed() => return,
                    changed = contexts.changed() => if changed.is_err() { return },
                }
                let next = read(&contexts.borrow_and_update());
                sender.send_if_modified(|current| {
                    let modified = *current != next;
                    *current = next;
                    modified
                });
            }
        });
        receiver
    }

    /// What the catalog says of a context for its mode, read anew each time,
    /// so the gate sees a kubeconfig's change with the clients' first request.
    pub fn metadata(&self) -> impl Fn(&str) -> Option<Metadata> + Send + Sync + 'static {
        let contexts = self.subscribe();
        move |context| {
            contexts
                .borrow()
                .as_ref()
                .and_then(|contexts| contexts.metadata(context))
        }
    }

    /// The contexts, once the sources have been read.
    pub async fn contexts(&self) -> Arc<Contexts> {
        let mut contexts = self.subscribe();
        let read = contexts
            .wait_for(Option::is_some)
            .await
            .expect("the catalog outlives its subscribers");
        Arc::clone(read.as_ref().expect("waited for"))
    }
}
