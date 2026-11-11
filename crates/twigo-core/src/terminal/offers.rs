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
    ErrorKind, IpcError, KubeconfigNames, KubeconfigOffer, KubeconfigOfferEvent, KubeconfigOfferId,
    SubscriptionId,
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

struct Held {
    source: Arc<Source>,
    written: Written,
    offer: KubeconfigOffer,
    /// Being answered: another answer is refused meanwhile, and what comes
    /// meanwhile joins it.
    answering: bool,
}

/// An offer being answered, as it was when the answer came.
pub(crate) struct Answering {
    source: Arc<Source>,
    id: KubeconfigOfferId,
    written: Written,
    /// Where a move writes, as a person reads it.
    target: String,
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
        let mut held = match state.offers.remove(&id.0) {
            Some(held) => held,
            None => {
                let base = source.file.parent().expect("a file in a directory");
                Held {
                    source: Arc::clone(source),
                    written: Written::new(base.to_owned(), source.chained),
                    offer: offer_of(source, id, &Names::default(), &Names::default()),
                    answering: false,
                }
            }
        };
        held.written.read(text, holds, fresh);
        state.renew(held);
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

    /// The window's offer, which waits on while it is answered; refused for
    /// one that is gone, another window's, or answered already.
    pub(crate) fn take(&self, window: &str, id: KubeconfigOfferId) -> Result<Answering, IpcError> {
        let mut state = self.state();
        let Some(held) = state.offers.get_mut(&id.0) else {
            return Err(IpcError::new(ErrorKind::NotFound, "this offer is gone"));
        };
        if *held.source.window != *window {
            return Err(IpcError::new(
                ErrorKind::Forbidden,
                "another window has this offer",
            ));
        }
        if held.answering {
            return Err(IpcError::new(
                ErrorKind::Conflict,
                "this offer is being answered",
            ));
        }
        held.answering = true;
        Ok(Answering {
            source: Arc::clone(&held.source),
            id,
            written: held.written.clone(),
            target: held.offer.target.clone(),
        })
    }

    /// An offer answered: withdrawn, unless entries came while it was
    /// answered, which it goes on offering. Nothing once the window's offers
    /// have ended.
    pub(crate) fn withdraw(&self, answering: Answering) {
        let mut state = self.state();
        let Some(mut held) = state.offers.remove(&answering.id.0) else {
            return;
        };
        held.written.forget(&answering.written.names());
        if held.written.names().is_empty() {
            let id = answering.id;
            state.tell(&held.source.window, KubeconfigOfferEvent::Withdrawn { id });
            return;
        }
        held.answering = false;
        state.renew(held);
    }

    /// An offer whose move failed, to be answered again, with what came
    /// meanwhile. Nothing once the window's offers have ended.
    pub(crate) fn put_back(&self, answering: Answering) {
        if let Some(held) = self.state().offers.get_mut(&answering.id.0) {
            held.answering = false;
        }
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

    /// Keeps `held` with its offer made anew from what it holds, and tells
    /// its window.
    fn renew(&mut self, mut held: Held) {
        let names = held.written.names();
        let left_out = held
            .written
            .left_out(held.source.sources.files())
            .unwrap_or_else(|error| {
                eprintln!("could not tell what a move of an offer leaves out: {error}");
                Names::default()
            });
        held.offer = offer_of(&held.source, held.offer.id, &names, &left_out);
        let offer = held.offer.clone();
        let offer = Box::new(offer);
        self.tell(&held.source.window, KubeconfigOfferEvent::Offered { offer });
        self.offers.insert(held.offer.id.0, held);
    }

    fn tell(&mut self, window: &str, event: KubeconfigOfferEvent) {
        if let Some(send) = self.followers.get_mut(window)
            && !send(event)
        {
            self.followers.remove(window);
        }
    }
}

fn offer_of(
    source: &Source,
    id: KubeconfigOfferId,
    names: &Names,
    left_out: &Names,
) -> KubeconfigOffer {
    KubeconfigOffer {
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
        left_out: KubeconfigNames {
            contexts: left_out.contexts.iter().cloned().collect(),
            clusters: left_out.clusters.iter().cloned().collect(),
            users: left_out.users.iter().cloned().collect(),
        },
    }
}

impl Answering {
    /// Appends to the target what the offer held as the answer came and a
    /// move takes, each entry as it was last seen while offered.
    pub(crate) fn move_entries(&self) -> Result<(), IpcError> {
        let source = &self.source;
        append(&source.target, source.sources.files(), &self.written).map_err(|error| {
            let kind = match error {
                WriteError::Locked(_) => ErrorKind::Conflict,
                WriteError::Io(_) | WriteError::Parse(_) => ErrorKind::Internal,
            };
            IpcError::new(
                kind,
                format!("could not move the entries into {}: {error}", self.target),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: &str = "clusters:\n- name: a\n  cluster:\n    server: https://a\n";
    const MORE: &str = "clusters:\n- name: a\n  cluster:\n    server: https://a\nusers:\n- name: b\n  user:\n    token: t\n";

    fn source(dir: &std::path::Path) -> Arc<Source> {
        let mine = dir.join("config");
        Arc::new(Source {
            window: "main".into(),
            label: "Terminal 1".into(),
            context: "kind-a".to_owned(),
            session: OnceLock::from(SubscriptionId(4)),
            file: dir.join("terminal").join("kubeconfig"),
            sources: Sources::explicit(mine.clone()),
            target: mine,
            chained: true,
            stopped: AtomicBool::new(false),
        })
    }

    fn offer(
        offers: &Offers,
        source: &Arc<Source>,
        live: Option<KubeconfigOfferId>,
        text: &str,
    ) -> KubeconfigOfferId {
        let names = Names::of(text).unwrap();
        offers.offer(source, live, text, &names, &names).unwrap()
    }

    #[test]
    fn what_comes_while_a_move_runs_joins_its_offer_which_a_failed_move_leaves_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let (offers, source) = (Offers::new(), source(dir.path()));
        let first = offer(&offers, &source, None, FIRST);
        let moving = offers.take("main", first).unwrap();
        let Err(again) = offers.take("main", first) else {
            panic!("taken twice");
        };
        assert_eq!(again.kind, ErrorKind::Conflict);
        assert_eq!(offer(&offers, &source, Some(first), MORE), first);
        offers.put_back(moving);
        let waiting = offers.follow("main", |_| true);
        assert_eq!(waiting.len(), 1, "{waiting:?}");
        assert_eq!(
            (waiting[0].id, &waiting[0].users),
            (first, &vec!["b".to_owned()])
        );
    }

    #[test]
    fn nothing_is_put_back_once_the_window_s_offers_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let (offers, source) = (Offers::new(), source(dir.path()));
        let first = offer(&offers, &source, None, FIRST);
        let moving = offers.take("main", first).unwrap();
        offers.drop_window("main");
        offers.put_back(moving);
        assert!(offers.follow("main", |_| true).is_empty());
    }
}
