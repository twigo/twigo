//! The catalog (ARCHITECTURE 5.5): every context its sources list. M1 has
//! one source, the kubeconfig files.

#[cfg(test)]
mod tests;

use std::cmp::Ordering;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{self, AtomicU64};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use twigo_kube::kubeconfig::{self, Sources, Watch};

/// The contexts, ordered by their `order`, those without one last, then by
/// name.
#[derive(Debug, PartialEq, Eq)]
pub struct Contexts(Vec<kubeconfig::Context>);

impl Contexts {
    fn new(catalog: kubeconfig::Catalog) -> Self {
        for failure in &catalog.failures {
            eprintln!("skipped {}: {}", failure.file.display(), failure.message);
        }
        let mut contexts = catalog.contexts;
        contexts.sort_by(|a, b| by_order(a.order, b.order).then_with(|| a.name.cmp(&b.name)));
        Self(contexts)
    }

    pub fn iter(&self) -> impl Iterator<Item = &kubeconfig::Context> {
        self.0.iter()
    }

    pub fn find(&self, name: &str) -> Option<&kubeconfig::Context> {
        self.0.iter().find(|context| context.name == name)
    }

    pub fn ipc(&self) -> Vec<twigo_ipc::Context> {
        self.0
            .iter()
            .map(|context| twigo_ipc::Context {
                name: context.name.clone(),
                color: context.color,
            })
            .collect()
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
    followed: Mutex<Option<Watch>>,
    /// Counts [`Catalog::follow`] calls, so that a watch it replaced cannot
    /// publish after its successor.
    generation: Arc<AtomicU64>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            contexts: watch::Sender::new(None),
            followed: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl Catalog {
    /// Reads `sources` and follows their changes, in place of what it
    /// followed before.
    pub fn follow(&self, sources: Sources) {
        let mut followed = self.followed.lock().expect("catalog lock");
        followed.take();
        let generation = self.generation.fetch_add(1, atomic::Ordering::AcqRel) + 1;
        let publish = {
            let contexts = self.contexts.clone();
            let current = Arc::clone(&self.generation);
            move |catalog: kubeconfig::Catalog| {
                let next = Arc::new(Contexts::new(catalog));
                // Under the channel's write lock, which the successor's
                // publish takes too, so the two cannot interleave.
                contexts.send_if_modified(|now| {
                    if current.load(atomic::Ordering::Acquire) != generation
                        || now.as_deref() == Some(&next)
                    {
                        return false;
                    }
                    *now = Some(Arc::clone(&next));
                    true
                });
            }
        };
        match Watch::start(sources.clone(), publish.clone()) {
            Ok(watch) => *followed = Some(watch),
            Err(error) => {
                eprintln!(
                    "could not watch the kubeconfig files, so their changes go unseen: {error}"
                );
                publish(sources.load());
            }
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<Option<Arc<Contexts>>> {
        self.contexts.subscribe()
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
