//! Which pod new connections go to (ARCHITECTURE 4.6): the forward's current
//! one while it is a candidate, so a client's connections do not spread over
//! the replicas; another when it leaves or fails. A pod that failed is
//! avoided for a backoff unless it is the only one. A pod whose upgrade
//! answered 404, which a kubelet answers for a pod it does not hold, as
//! around its restart, is avoided for the backoff's longest delay, the only
//! one too, and a failure meanwhile does not shorten that.

use std::collections::HashMap;
use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use tokio::time::Instant;
use twigo_ipc::IpcError;

use super::cause::Cause;
use super::watching::{Candidate, Seen};

/// The backoff's longest delay, before its jitter.
const LONGEST: Duration = Duration::from_secs(30);

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
    missing: Option<Missing>,
}

/// What the upgrade said when it answered 404: such a pod is not chosen
/// before `until`, even as the only one.
struct Missing {
    words: String,
    until: Instant,
}

impl Avoided {
    fn missing(&self, now: Instant) -> Option<&Missing> {
        self.missing.as_ref().filter(|missing| missing.until > now)
    }
}

pub(super) struct Pick {
    known: Known,
    current: Option<Candidate>,
    avoided: HashMap<Box<str>, Avoided>,
}

/// 0.5 s for a first failure, doubling to 30 s for a pod that keeps
/// failing, each with a jitter of up to the delay again, so 0.5–1 s and
/// 30–60 s ([`ExponentialBackoff::next`](https://github.com/Xuanwo/backon/blob/e24dc92742e201f7320868d46a12ff59eb82ef72/backon/src/backoff/exponential.rs#L210-L235), backon 1.6.0).
fn backoff() -> ExponentialBackoff {
    ExponentialBuilder::new()
        .with_min_delay(Duration::from_millis(500))
        .with_max_delay(LONGEST)
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
        }
    }

    /// What the hub tells, which drops what was avoided of a pod that is no
    /// candidate any more.
    pub(super) fn set(&mut self, known: Known) {
        if let Known::Listed { candidates, .. } = &known {
            self.avoided
                .retain(|key, _| candidates.iter().any(|candidate| candidate.key == *key));
        }
        self.known = known;
    }

    fn held(&self, candidate: &Candidate, now: Instant) -> Option<&Avoided> {
        self.avoided
            .get(&candidate.key)
            .filter(|avoided| avoided.until > now)
    }

    /// The pod to go to now: the current one while it is a candidate and not
    /// avoided; else the first by name that is not avoided; else, with every
    /// candidate avoided, the one whose backoff ends first of those that
    /// failed; else none until a pod that answered 404 comes back.
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
        let kept = self
            .current
            .as_ref()
            .and_then(|current| listed.iter().find(|c| c.key == current.key))
            .filter(|candidate| self.held(candidate, now).is_none());
        let chosen = kept
            .or_else(|| {
                listed
                    .iter()
                    .find(|candidate| self.held(candidate, now).is_none())
            })
            .or_else(|| {
                listed
                    .iter()
                    .filter_map(|candidate| Some((candidate, self.held(candidate, now)?)))
                    .filter(|(_, avoided)| avoided.missing(now).is_none())
                    .min_by_key(|(_, avoided)| avoided.until)
                    .map(|(candidate, _)| candidate)
            });
        let Some(chosen) = chosen.cloned() else {
            let missing = listed
                .iter()
                .filter_map(|candidate| self.held(candidate, now)?.missing(now))
                .min_by_key(|missing| missing.until)
                .expect("every candidate answered 404");
            return Chosen::None(missing.words.clone());
        };
        self.current = Some(chosen.clone());
        Chosen::Pod(chosen)
    }

    /// When a pod that answered 404 can be chosen again, while every
    /// candidate is one.
    pub(super) fn back(&self, now: Instant) -> Option<Instant> {
        let Known::Listed { candidates, .. } = &self.known else {
            return None;
        };
        let mut back = None;
        for candidate in candidates {
            let missing = self.held(candidate, now)?.missing(now)?;
            back = Some(back.map_or(missing.until, |back: Instant| back.min(missing.until)));
        }
        back
    }

    fn avoid(&mut self, key: &str, now: Instant) -> &mut Avoided {
        if self
            .current
            .as_ref()
            .is_some_and(|current| &*current.key == key)
        {
            self.current = None;
        }
        self.avoided.entry(key.into()).or_insert_with(|| Avoided {
            until: now,
            backoff: backoff(),
            missing: None,
        })
    }

    /// A connection to the pod failed. The later end of an avoidance stands.
    pub(super) fn failed(&mut self, key: &str, now: Instant) {
        let avoided = self.avoid(key, now);
        let until = now + avoided.backoff.next().expect("without a limit");
        avoided.until = avoided.until.max(until);
    }

    /// The upgrade to the pod answered 404, in these words.
    pub(super) fn left(&mut self, key: &str, words: String, now: Instant) {
        let avoided = self.avoid(key, now);
        let until = now + LONGEST;
        avoided.until = avoided.until.max(until);
        avoided.missing = Some(Missing { words, until });
    }

    /// The pod carried a connection, so it is not avoided.
    pub(super) fn served(&mut self, key: &str) {
        self.avoided.remove(key);
    }

    /// A person asked for the forward again: no pod is avoided.
    pub(super) fn forget(&mut self) {
        self.avoided.clear();
    }
}
