//! Which pod new connections go to (ARCHITECTURE 4.6): the forward's current
//! one while it is a candidate, so a client's connections do not spread over
//! the replicas; another when it leaves or fails, and a pod that failed is
//! avoided for a backoff unless it is the only one. A pod whose upgrade
//! answered 404 is no candidate any more: a uid never comes back.

use std::collections::HashMap;
use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use tokio::time::Instant;
use twigo_ipc::IpcError;

use super::cause::Cause;
use super::watching::{Candidate, Seen};

pub(super) enum Known {
    /// Nothing is listed yet, or nothing is watched; why, when the cluster
    /// does not answer.
    Unknown(Option<String>),
    Fault(Cause),
    Refused(IpcError),
    Listed {
        candidates: Vec<Candidate>,
        why: String,
    },
}

impl From<Seen> for Known {
    fn from(seen: Seen) -> Self {
        match seen {
            Seen::Unlisted(why) => Known::Unknown(why),
            Seen::Fault(error) => Known::Fault(error),
            Seen::Refused(error) => Known::Refused(error),
            Seen::Listed { candidates, why } => Known::Listed { candidates, why },
        }
    }
}

pub(super) enum Chosen {
    Pod(Candidate),
    /// There is none, and why.
    None(String),
    Fault(Cause),
    Refused(IpcError),
    Unknown(Option<String>),
}

struct Avoided {
    until: Instant,
    backoff: ExponentialBackoff,
}

pub(super) struct Pick {
    known: Known,
    current: Option<Candidate>,
    avoided: HashMap<Box<str>, Avoided>,
    /// The pods that answered 404, and what the server said.
    gone: HashMap<Box<str>, String>,
}

/// Jitter adds up to the delay again: 0.5–5 s for a first failure of the
/// hub's, growing to 30 s for a pod that keeps failing.
fn backoff() -> ExponentialBackoff {
    ExponentialBuilder::new()
        .with_min_delay(Duration::from_millis(500))
        .with_max_delay(Duration::from_secs(30))
        .with_jitter()
        .without_max_times()
        .build()
}

impl Pick {
    pub(super) fn new() -> Self {
        Self {
            known: Known::Unknown(None),
            current: None,
            avoided: HashMap::new(),
            gone: HashMap::new(),
        }
    }

    pub(super) fn set(&mut self, known: Known) {
        self.known = known;
    }

    /// The pod to go to now: the current one while it is a candidate and not
    /// avoided; else the first by name that is not avoided; else, with every
    /// candidate avoided, the one whose backoff ends first.
    pub(super) fn choose(&mut self, now: Instant) -> Chosen {
        let listed = match &self.known {
            Known::Unknown(why) => return Chosen::Unknown(why.clone()),
            Known::Fault(error) => return Chosen::Fault(error.clone()),
            Known::Refused(error) => return Chosen::Refused(error.clone()),
            Known::Listed { candidates, why } if candidates.is_empty() => {
                return Chosen::None(why.clone());
            }
            Known::Listed { candidates, .. } => candidates,
        };
        let mut candidates = listed
            .iter()
            .filter(|candidate| !self.gone.contains_key(&candidate.key))
            .peekable();
        if candidates.peek().is_none() {
            return Chosen::None(self.gone[&listed[0].key].clone());
        }
        let avoided = |candidate: &Candidate| {
            self.avoided
                .get(&candidate.key)
                .is_some_and(|avoided| avoided.until > now)
        };
        let kept = self
            .current
            .as_ref()
            .and_then(|current| candidates.clone().find(|c| c.key == current.key))
            .filter(|candidate| !avoided(candidate));
        let chosen = kept
            .or_else(|| candidates.clone().find(|candidate| !avoided(candidate)))
            .or_else(|| candidates.min_by_key(|candidate| self.avoided[&candidate.key].until))
            .expect("there is a candidate")
            .clone();
        self.current = Some(chosen.clone());
        Chosen::Pod(chosen)
    }

    /// A connection to the pod failed.
    pub(super) fn failed(&mut self, key: &str, now: Instant) {
        let avoided = self.avoided.entry(key.into()).or_insert_with(|| Avoided {
            until: now,
            backoff: backoff(),
        });
        let wait = avoided.backoff.next().expect("without a limit");
        avoided.until = now + wait;
        if self
            .current
            .as_ref()
            .is_some_and(|current| &*current.key == key)
        {
            self.current = None;
        }
    }

    /// The upgrade to the pod answered 404, in these words.
    pub(super) fn left(&mut self, key: &str, words: String) {
        self.gone.insert(key.into(), words);
        if self
            .current
            .as_ref()
            .is_some_and(|current| &*current.key == key)
        {
            self.current = None;
        }
    }

    /// The pod carried a connection, so it is not avoided.
    pub(super) fn served(&mut self, key: &str) {
        self.avoided.remove(key);
    }
}
