//! Offers to move what a tool wrote into a terminal's own kubeconfig, as
//! `aws eks update-kubeconfig` writes a cluster, a user and a context, into
//! the user's (ARCHITECTURE 4.6). An offer belongs to its window: it outlives
//! the terminal's tab, until it is answered or the window goes. A move
//! appends the entries to the file kubectl writes new ones to, leaving out
//! those that would mean something else among the user's files. An offer
//! is made anew whenever what it holds or the user's files change, and is
//! not shown while a move would move nothing. The window is also told which
//! contexts of a proxy terminal's file reach their clusters past the proxy.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use twigo_ipc::{
    ErrorKind, IpcError, KubeconfigNames, KubeconfigOffer, KubeconfigOfferEvent, KubeconfigOfferId,
    SubscriptionId,
};
use twigo_kube::kubeconfig::{Appended, Names, Outcome, Sources, WriteError, Written, append};

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
    /// made, so none outlives a window that went with its terminals, and
    /// nothing more is said of its contexts.
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
    /// The contexts of each proxy terminal's file that reach their clusters
    /// past the proxy, by its session, while there are any.
    direct: HashMap<SubscriptionId, Direct>,
}

struct Direct {
    window: Arc<str>,
    contexts: Vec<String>,
}

struct Held {
    source: Arc<Source>,
    written: Written,
    offer: KubeconfigOffer,
    /// What `offer` says a move leaves out.
    left_out: Names,
    /// Whether its window has it: not while a move would move nothing.
    shown: bool,
    /// Being answered: another answer is refused meanwhile, and what comes
    /// meanwhile joins it.
    answering: bool,
}

/// An offer being answered, as it was when the answer came.
pub(crate) struct Answering {
    source: Arc<Source>,
    id: KubeconfigOfferId,
    written: Written,
    /// What the offer said a move leaves out.
    left_out: Names,
    /// Where a move writes, as a person reads it.
    target: String,
}

impl Offers {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::default(),
        }
    }

    /// The window's offers waiting now; `send` gets the contexts its proxy
    /// terminals reach past the proxy, those of each that has any, then
    /// each new, changed and withdrawn offer and each change of those
    /// contexts, in place of an earlier follower.
    pub(crate) fn follow(
        &self,
        window: &str,
        send: impl FnMut(KubeconfigOfferEvent) -> bool + Send + 'static,
    ) -> Vec<KubeconfigOffer> {
        let mut state = self.state();
        let waiting = state
            .offers
            .values()
            .filter(|held| held.shown && *held.source.window == *window)
            .map(|held| held.offer.clone())
            .collect();
        state.followers.insert(window.into(), Box::new(send));
        let now: Vec<KubeconfigOfferEvent> = state
            .direct
            .iter()
            .filter(|(_, direct)| *direct.window == *window)
            .map(|(session, direct)| KubeconfigOfferEvent::Direct {
                session: *session,
                contexts: direct.contexts.clone(),
            })
            .collect();
        for event in now {
            state.tell(window, event);
        }
        waiting
    }

    /// Tells `source`'s window of `contexts`, those of its proxy terminal's
    /// file that reach their clusters past the proxy, where they changed;
    /// nothing once the terminal has gone.
    pub(crate) fn direct(&self, source: &Source, contexts: BTreeSet<String>) {
        let mut state = self.state();
        if source.stopped.load(Ordering::Acquire) {
            return;
        }
        let session = *source
            .session
            .get()
            .expect("set before the terminal's shell starts");
        let contexts: Vec<String> = contexts.into_iter().collect();
        let held = state.direct.get(&session).map(|direct| &direct.contexts);
        if held.map_or(contexts.is_empty(), |held| *held == contexts) {
            return;
        }
        if contexts.is_empty() {
            state.direct.remove(&session);
        } else {
            let direct = Direct {
                window: Arc::clone(&source.window),
                contexts: contexts.clone(),
            };
            state.direct.insert(session, direct);
        }
        state.tell(
            &source.window,
            KubeconfigOfferEvent::Direct { session, contexts },
        );
    }

    /// `source`'s terminal has gone: no offer of it is made from now on, and
    /// nothing more is said of its contexts.
    pub(crate) fn stop(&self, source: &Source) {
        let mut state = self.state();
        source.stopped.store(true, Ordering::Release);
        if let Some(session) = source.session.get() {
            state.direct.remove(session);
        }
    }

    /// Offers `fresh` names of `text`, a read of the terminal's file whose
    /// names are `holds`: in the terminal's offer, while one waits, else in
    /// a new one, shown once a move would move something. None once the
    /// terminal has gone.
    pub(crate) fn offer(
        &self,
        source: &Arc<Source>,
        text: &str,
        holds: &Names,
        fresh: &Names,
    ) -> Option<KubeconfigOfferId> {
        let mut state = self.state();
        if source.stopped.load(Ordering::Acquire) {
            return None;
        }
        let id = match state.live(source) {
            Some(id) => id,
            None => {
                let base = source.file.parent().expect("a file in a directory");
                state.hold(source, Written::new(base.to_owned(), source.chained))
            }
        };
        let held = state.offers.get_mut(&id.0).expect("found or held above");
        held.written.read(text, holds, fresh);
        state.renew(id);
        Some(id)
    }

    /// Takes `text`, a read of the terminal's file whose names are `holds`,
    /// into the terminal's offer, while one waits: a move takes the offered
    /// entries from it from now on.
    pub(crate) fn read(&self, source: &Arc<Source>, text: &str, holds: &Names) {
        let mut state = self.state();
        if let Some(id) = state.live(source) {
            let held = state.offers.get_mut(&id.0).expect("found above");
            held.written.read(text, holds, &Names::default());
            state.renew(id);
        }
    }

    /// Makes every offer anew, as the user's files have changed.
    pub(crate) fn refresh(&self) {
        let mut state = self.state();
        let ids: Vec<u32> = state.offers.keys().copied().collect();
        for id in ids {
            state.renew(KubeconfigOfferId(id));
        }
    }

    /// The window's offer, which waits on while it is answered; refused for
    /// one that is gone, another window's, or answered already.
    pub(crate) fn take(&self, window: &str, id: KubeconfigOfferId) -> Result<Answering, IpcError> {
        let mut state = self.state();
        let Some(held) = state.offers.get_mut(&id.0).filter(|held| held.shown) else {
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
            left_out: held.left_out.clone(),
            target: held.offer.target.clone(),
        })
    }

    /// An offer answered: withdrawn, and the entries that came while it was
    /// answered offered under a new id, as the window drops the answered id
    /// once its answer is done. Nothing once the window's offers have ended.
    pub(crate) fn withdraw(&self, answering: Answering) {
        let mut state = self.state();
        let id = answering.id;
        let Some(mut held) = state.offers.remove(&id.0) else {
            return;
        };
        if held.shown {
            state.tell(&held.source.window, KubeconfigOfferEvent::Withdrawn { id });
        }
        held.written.forget(&answering.written.names());
        if !held.written.names().is_empty() {
            let rest = state.hold(&held.source, held.written);
            state.renew(rest);
        }
    }

    /// An offer whose move failed, to be answered again, with what came
    /// meanwhile. Nothing once the window's offers have ended.
    pub(crate) fn put_back(&self, answering: Answering) {
        if let Some(held) = self.state().offers.get_mut(&answering.id.0) {
            held.answering = false;
        }
    }

    /// What follows a move: the offer withdrawn once it moved, or, where it
    /// would have left out more than the offer said, made anew as a move
    /// would go now, with the refusal in words; put back where it failed.
    pub(crate) fn moved(
        &self,
        answering: Answering,
        moved: Result<Appended, IpcError>,
    ) -> Result<(), IpcError> {
        match moved {
            Ok(Appended::Moved) => {
                self.withdraw(answering);
                Ok(())
            }
            Ok(Appended::LeavesOutMore(more)) => {
                let (id, target) = (answering.id, &answering.target);
                let mut state = self.state();
                if let Some(held) = state.offers.get_mut(&id.0) {
                    held.answering = false;
                    state.renew(id);
                }
                let shown = state.offers.get(&id.0).is_some_and(|held| held.shown);
                let then = if shown {
                    ". The offer now says what a move does"
                } else {
                    ", so nothing in the offer would move now"
                };
                Err(IpcError::new(
                    ErrorKind::Conflict,
                    format!(
                        "Nothing was moved into {target}: your kubeconfig files changed since the \
                         offer was made, and a move would now also leave out {}{then}.",
                        listed(&more)
                    ),
                ))
            }
            Err(error) => {
                self.put_back(answering);
                Err(error)
            }
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
            let held = state.offers.remove(&id).expect("listed above");
            if held.shown
                && let Some(send) = &mut follower
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
    /// `source`'s offer, while one waits.
    fn live(&self, source: &Arc<Source>) -> Option<KubeconfigOfferId> {
        self.offers
            .iter()
            .find(|(_, held)| Arc::ptr_eq(&held.source, source))
            .map(|(id, _)| KubeconfigOfferId(*id))
    }

    /// A new offer of `source` holding `written`, not shown until renewed.
    fn hold(&mut self, source: &Arc<Source>, written: Written) -> KubeconfigOfferId {
        self.next += 1;
        let id = KubeconfigOfferId(self.next);
        let held = Held {
            source: Arc::clone(source),
            written,
            offer: offer_of(source, id, &Names::default(), &Names::default()),
            left_out: Names::default(),
            shown: false,
            answering: false,
        };
        self.offers.insert(id.0, held);
        id
    }

    /// Makes the offer `id` anew from what it holds and the user's files
    /// as they are, and tells its window of a change: shown while a move
    /// would move something, withdrawn while it would not.
    fn renew(&mut self, id: KubeconfigOfferId) {
        let Some(held) = self.offers.get_mut(&id.0) else {
            return;
        };
        let names = held.written.names();
        let Outcome { moves, left_out } = held
            .written
            .outcome(held.source.sources.files())
            .unwrap_or_else(|error| {
                eprintln!("could not tell what a move of an offer leaves out: {error}");
                Outcome {
                    moves: names.clone(),
                    left_out: Names::default(),
                }
            });
        let offer = offer_of(&held.source, id, &names, &left_out);
        let shows = !moves.is_empty();
        let event = if shows && (!held.shown || offer != held.offer) {
            Some(KubeconfigOfferEvent::Offered {
                offer: Box::new(offer.clone()),
            })
        } else if held.shown && !shows {
            Some(KubeconfigOfferEvent::Withdrawn { id })
        } else {
            None
        };
        held.offer = offer;
        held.left_out = left_out;
        held.shown = shows;
        let window = Arc::clone(&held.source.window);
        if let Some(event) = event {
            self.tell(&window, event);
        }
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
        revision: 0,
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

/// `the context prod, the clusters a and b and the user b`.
fn listed(names: &Names) -> String {
    let parts: Vec<String> = [
        ("context", &names.contexts),
        ("cluster", &names.clusters),
        ("user", &names.users),
    ]
    .into_iter()
    .filter(|(_, names)| !names.is_empty())
    .map(|(noun, names)| {
        let names: Vec<String> = names.iter().cloned().collect();
        let plural = if names.len() == 1 { "" } else { "s" };
        format!("the {noun}{plural} {}", joined(&names))
    })
    .collect();
    joined(&parts)
}

/// `a`, `a and b`, `a, b and c`.
fn joined(parts: &[String]) -> String {
    match parts.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => parts.concat(),
    }
}

impl Answering {
    /// Appends to the target what the offer held as the answer came and a
    /// move takes, each entry as it was last seen while offered; nothing,
    /// should that leave out more than the offer said.
    pub(crate) fn move_entries(&self) -> Result<Appended, IpcError> {
        let source = &self.source;
        let (target, files) = (&source.target, source.sources.files());
        append(target, files, &self.written, &self.left_out).map_err(|error| {
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

    fn offer(offers: &Offers, source: &Arc<Source>, text: &str) -> KubeconfigOfferId {
        let names = Names::of(text).unwrap();
        offers.offer(source, text, &names, &names).unwrap()
    }

    #[test]
    fn what_comes_while_a_move_runs_joins_its_offer_which_a_failed_move_leaves_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let (offers, source) = (Offers::new(), source(dir.path()));
        let first = offer(&offers, &source, FIRST);
        let moving = offers.take("main", first).unwrap();
        let Err(again) = offers.take("main", first) else {
            panic!("taken twice");
        };
        assert_eq!(again.kind, ErrorKind::Conflict);
        assert_eq!(offer(&offers, &source, MORE), first);
        offers.put_back(moving);
        let waiting = offers.follow("main", |_| true);
        assert_eq!(waiting.len(), 1, "{waiting:?}");
        assert_eq!(
            (waiting[0].id, &waiting[0].users),
            (first, &vec!["b".to_owned()])
        );
    }

    #[test]
    fn what_came_while_a_move_ran_is_offered_under_a_new_id_once_the_answered_one_is_withdrawn() {
        let dir = tempfile::tempdir().unwrap();
        let (offers, source) = (Offers::new(), source(dir.path()));
        let (told, events) = std::sync::mpsc::channel();
        offers.follow("main", move |event| told.send(event).is_ok());
        let first = offer(&offers, &source, FIRST);
        let moving = offers.take("main", first).unwrap();
        assert_eq!(offer(&offers, &source, MORE), first);
        let moved = moving.move_entries();
        offers.moved(moving, moved).unwrap();
        let told: Vec<KubeconfigOfferEvent> = events.try_iter().collect();
        let [
            ..,
            KubeconfigOfferEvent::Withdrawn { id },
            KubeconfigOfferEvent::Offered { offer: rest },
        ] = &told[..]
        else {
            panic!("{told:#?}");
        };
        assert_eq!(*id, first);
        assert_ne!(rest.id, first);
        assert_eq!(
            (&rest.clusters, &rest.users),
            (&Vec::<String>::new(), &vec!["b".to_owned()])
        );
        let context = "contexts:\n- name: c\n  context:\n    cluster: a\n    user: b\n";
        let still = format!("{MORE}{context}");
        let holds = Names::of(&still).unwrap();
        let joined = offers.offer(&source, &still, &holds, &Names::of(context).unwrap());
        assert_eq!(joined, Some(rest.id));
        let joined = offered(&events);
        assert_eq!(
            (joined.id, &joined.users, &joined.contexts),
            (rest.id, &vec!["b".to_owned()], &vec!["c".to_owned()])
        );
    }

    #[test]
    fn nothing_is_put_back_once_the_window_s_offers_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let (offers, source) = (Offers::new(), source(dir.path()));
        let first = offer(&offers, &source, FIRST);
        let moving = offers.take("main", first).unwrap();
        offers.drop_window("main");
        offers.put_back(moving);
        assert!(offers.follow("main", |_| true).is_empty());
    }

    const PROD: &str = "clusters:\n- name: b\n  cluster:\n    server: https://b\nusers:\n- name: b\n  user:\n    token: b\ncontexts:\n- name: prod\n  context:\n    cluster: b\n    user: b\n";
    const BOTH: &str = "clusters:\n- name: b\n  cluster:\n    server: https://b\n- name: c\n  cluster:\n    server: https://c\nusers:\n- name: b\n  user:\n    token: b\n- name: c\n  user:\n    token: c\ncontexts:\n- name: prod\n  context:\n    cluster: b\n    user: b\n- name: other\n  context:\n    cluster: c\n    user: c\n";
    const THEIR_PROD: &str = "clusters:\n- name: a\n  cluster:\n    server: https://a\nusers:\n- name: a\n  user:\n    token: a\ncontexts:\n- name: prod\n  context:\n    cluster: a\n    user: a\n";

    fn offered(events: &std::sync::mpsc::Receiver<KubeconfigOfferEvent>) -> KubeconfigOffer {
        match events.try_recv() {
            Ok(KubeconfigOfferEvent::Offered { offer }) => *offer,
            event => panic!("{event:?}"),
        }
    }

    fn listed<T: FromIterator<String>>(names: &[&str]) -> T {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    fn moved(offers: &Offers, id: KubeconfigOfferId) -> Result<(), IpcError> {
        let answering = offers.take("main", id).unwrap();
        let moved = answering.move_entries();
        offers.moved(answering, moved)
    }

    #[test]
    fn a_move_that_would_leave_out_more_than_its_offer_said_moves_nothing_and_comes_back_anew() {
        let dir = tempfile::tempdir().unwrap();
        let (offers, source) = (Offers::new(), source(dir.path()));
        let (told, events) = std::sync::mpsc::channel();
        offers.follow("main", move |event| told.send(event).is_ok());
        let id = offer(&offers, &source, BOTH);
        assert!(offered(&events).left_out == KubeconfigNames::default());
        std::fs::write(dir.path().join("config"), THEIR_PROD).unwrap();
        let refused = moved(&offers, id).unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Conflict);
        assert_eq!(
            refused.message,
            format!(
                "Nothing was moved into {}: your kubeconfig files changed since the offer was \
                 made, and a move would now also leave out the context prod, the cluster b and \
                 the user b. The offer now says what a move does.",
                dir.path().join("config").display()
            )
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("config")).unwrap(),
            THEIR_PROD
        );
        let anew = offered(&events);
        assert_eq!(anew.id, id);
        assert_eq!(
            anew.left_out,
            KubeconfigNames {
                contexts: listed(&["prod"]),
                clusters: listed(&["b"]),
                users: listed(&["b"]),
            }
        );
        moved(&offers, id).unwrap();
        assert_eq!(
            events.try_recv().unwrap(),
            KubeconfigOfferEvent::Withdrawn { id }
        );
        let mine = std::fs::read_to_string(dir.path().join("config")).unwrap();
        assert_eq!(
            Names::of(&mine).unwrap(),
            Names {
                clusters: listed(&["a", "c"]),
                users: listed(&["a", "c"]),
                contexts: listed(&["other", "prod"]),
            }
        );
    }

    #[test]
    fn a_move_that_would_now_move_nothing_withdraws_its_offer_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let (offers, source) = (Offers::new(), source(dir.path()));
        let (told, events) = std::sync::mpsc::channel();
        offers.follow("main", move |event| told.send(event).is_ok());
        let id = offer(&offers, &source, PROD);
        offered(&events);
        std::fs::write(dir.path().join("config"), THEIR_PROD).unwrap();
        let refused = moved(&offers, id).unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Conflict);
        assert!(
            refused
                .message
                .ends_with("the cluster b and the user b, so nothing in the offer would move now."),
            "{}",
            refused.message
        );
        assert_eq!(
            events.try_recv().unwrap(),
            KubeconfigOfferEvent::Withdrawn { id }
        );
        assert!(offers.follow("main", |_| true).is_empty());
        let Err(gone) = offers.take("main", id) else {
            panic!("a withdrawn offer taken");
        };
        assert_eq!(gone.kind, ErrorKind::NotFound);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("config")).unwrap(),
            THEIR_PROD
        );
    }

    #[test]
    fn an_offered_entry_rewritten_so_that_nothing_would_move_withdraws_the_offer() {
        let dir = tempfile::tempdir().unwrap();
        let (offers, source) = (Offers::new(), source(dir.path()));
        std::fs::write(
            dir.path().join("config"),
            "users:\n- name: me\n  user:\n    token: t\n",
        )
        .unwrap();
        let (told, events) = std::sync::mpsc::channel();
        offers.follow("main", move |event| told.send(event).is_ok());
        let first = "clusters:\n- name: own\n  cluster:\n    server: https://own\nusers:\n- name: me\n  user:\n    token: t\ncontexts:\n- name: c\n  context:\n    cluster: own\n    user: me\n";
        let id = offer(&offers, &source, first);
        assert_eq!(offered(&events).contexts, ["c"]);
        let second = first.replace("token: t", "token: t2");
        offers.read(&source, &second, &Names::of(&second).unwrap());
        assert_eq!(
            events.try_recv().unwrap(),
            KubeconfigOfferEvent::Withdrawn { id }
        );
        offers.read(&source, first, &Names::of(first).unwrap());
        assert_eq!(offered(&events).id, id);
    }
}
