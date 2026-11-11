//! Offers to move what a tool wrote into a terminal's own kubeconfig, as
//! `aws eks update-kubeconfig` writes a cluster, a user and a context, into
//! the user's (ARCHITECTURE 4.6). An offer belongs to its window: it outlives
//! the terminal's tab, until it is answered or the window goes. A move
//! appends the entries to the file kubectl writes new ones to, leaving out
//! those that would mean something else among the user's files.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use twigo_ipc::{
    ErrorKind, IpcError, KubeconfigOffer, KubeconfigOfferEvent, KubeconfigOfferId, SubscriptionId,
};
use twigo_kube::kubeconfig::{Names, Sources, WriteError, Written, append};

type Follower = Box<dyn FnMut(KubeconfigOfferEvent) -> bool + Send>;

/// A terminal whose file is followed for offers.
pub(crate) struct Source {
    pub window: Arc<str>,
    pub label: Arc<str>,
    /// The context the terminal was pinned to.
    pub context: String,
    /// Its id in the shells' table, set before its shell can start.
    pub session: OnceLock<SubscriptionId>,
    /// The first file of its `KUBECONFIG`, where tools write new entries.
    pub file: PathBuf,
    /// The user's files.
    pub sources: Sources,
    /// The one of them kubectl writes new entries to.
    pub target: PathBuf,
    /// Whether the user's files follow `file` in its `KUBECONFIG`, as in a
    /// kubeconfig terminal.
    pub chained: bool,
    /// Set once the terminal is gone: an offer that comes after it is not
    /// made, so none outlives a window that went with its terminals.
    pub stopped: AtomicBool,
}

pub(crate) struct Offers {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// One per window: a later follower replaces the earlier.
    followers: HashMap<Arc<str>, Follower>,
    offers: BTreeMap<u32, Held>,
    next: u32,
}

pub(crate) struct Held {
    source: Arc<Source>,
    written: Written,
    offer: KubeconfigOffer,
}

impl Offers {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::default(),
        }
    }

    /// The window's offers waiting now; `send` gets each new, changed and
    /// withdrawn one from then on, in place of an earlier follower.
    pub(crate) fn follow(
        &self,
        window: &str,
        send: impl FnMut(KubeconfigOfferEvent) -> bool + Send + 'static,
    ) -> Vec<KubeconfigOffer> {
        let mut state = self.state();
        let waiting = state
            .offers
            .values()
            .filter(|held| *held.source.window == *window)
            .map(|held| held.offer.clone())
            .collect();
        state.followers.insert(window.into(), Box::new(send));
        waiting
    }

    /// Offers `fresh` names of `text`, a read of the terminal's file whose
    /// names are `holds`: in `live`, the terminal's offer, while it waits,
    /// else in a new one. None once the terminal has gone.
    pub(crate) fn offer(
        &self,
        source: &Arc<Source>,
        live: Option<KubeconfigOfferId>,
        text: &str,
        holds: &Names,
        fresh: &Names,
    ) -> Option<KubeconfigOfferId> {
        let mut state = self.state();
        if source.stopped.load(Ordering::Acquire) {
            return None;
        }
        let waiting = live.filter(|id| state.live(source, *id).is_some());
        let id = match waiting {
            Some(id) => id,
            None => {
                state.next += 1;
                KubeconfigOfferId(state.next)
            }
        };
        let mut written = state.offers.remove(&id.0).map_or_else(
            || {
                let base = source.file.parent().expect("a file in a directory");
                Written::new(base.to_owned(), source.chained)
            },
            |held| held.written,
        );
        written.read(text, holds, fresh);
        let names = written.names();
        let taken = written
            .left_out(source.sources.files())
            .unwrap_or_else(|error| {
                eprintln!("could not tell what a move of an offer leaves out: {error}");
                Vec::new()
            });
        let offer = KubeconfigOffer {
            id,
            terminal: source.label.to_string(),
            session: *source
                .session
                .get()
                .expect("set before the terminal's shell starts"),
            context: source.context.clone(),
            contexts: names.contexts.iter().cloned().collect(),
            clusters: names.clusters.iter().cloned().collect(),
            users: names.users.iter().cloned().collect(),
            target: source.sources.named(&source.target),
            taken,
        };
        state.tell(
            &source.window,
            KubeconfigOfferEvent::Offered {
                offer: offer.clone(),
            },
        );
        let held = Held {
            source: Arc::clone(source),
            written,
            offer,
        };
        state.offers.insert(id.0, held);
        Some(id)
    }

    /// Takes `text`, a read of the terminal's file whose names are `holds`,
    /// into `live`, the terminal's offer, while it waits: a move takes the
    /// offered entries from it from now on.
    pub(crate) fn read(
        &self,
        source: &Arc<Source>,
        live: Option<KubeconfigOfferId>,
        text: &str,
        holds: &Names,
    ) {
        let mut state = self.state();
        if let Some(held) = live.and_then(|id| state.live(source, id)) {
            held.written.read(text, holds, &Names::default());
        }
    }

    /// Takes the window's offer out, to be answered.
    pub(crate) fn take(&self, window: &str, id: KubeconfigOfferId) -> Result<Held, IpcError> {
        let mut state = self.state();
        let Some(held) = state.offers.get(&id.0) else {
            return Err(IpcError::new(ErrorKind::NotFound, "this offer is gone"));
        };
        if *held.source.window != *window {
            return Err(IpcError::new(
                ErrorKind::Forbidden,
                "another window has this offer",
            ));
        }
        Ok(state.offers.remove(&id.0).expect("found above"))
    }

    /// An offer taken out and answered.
    pub(crate) fn withdraw(&self, held: &Held) {
        let id = held.offer.id;
        self.state()
            .tell(&held.source.window, KubeconfigOfferEvent::Withdrawn { id });
    }

    /// An offer taken out whose move failed, to be answered again.
    pub(crate) fn put_back(&self, held: Held) {
        self.state().offers.insert(held.offer.id.0, held);
    }

    pub(crate) fn drop_window(&self, window: &str) {
        let mut state = self.state();
        let mut follower = state.followers.remove(window);
        let gone: Vec<u32> = state
            .offers
            .iter()
            .filter(|(_, held)| *held.source.window == *window)
            .map(|(id, _)| *id)
            .collect();
        for id in gone {
            state.offers.remove(&id);
            if let Some(send) = &mut follower
                && !send(KubeconfigOfferEvent::Withdrawn {
                    id: KubeconfigOfferId(id),
                })
            {
                follower = None;
            }
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("offers lock")
    }
}

impl State {
    /// The offer `id`, while it waits, if it is `source`'s.
    fn live(&mut self, source: &Arc<Source>, id: KubeconfigOfferId) -> Option<&mut Held> {
        self.offers
            .get_mut(&id.0)
            .filter(|held| Arc::ptr_eq(&held.source, source))
    }

    fn tell(&mut self, window: &str, event: KubeconfigOfferEvent) {
        if let Some(send) = self.followers.get_mut(window)
            && !send(event)
        {
            self.followers.remove(window);
        }
    }
}

impl Held {
    /// Appends to the target what the offer holds and a move takes, each
    /// entry as it was last seen while offered.
    pub(crate) fn move_entries(&self) -> Result<(), IpcError> {
        let source = &self.source;
        append(&source.target, source.sources.files(), &self.written).map_err(|error| {
            let kind = match error {
                WriteError::Locked(_) => ErrorKind::Conflict,
                WriteError::Io(_) | WriteError::Parse(_) => ErrorKind::Internal,
            };
            IpcError::new(
                kind,
                format!(
                    "could not move the entries into {}: {error}",
                    self.offer.target
                ),
            )
        })
    }
}
