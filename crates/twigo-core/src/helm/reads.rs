//! The reads of a revision's Secret that the core asks again: the list's
//! newest revisions, an editor's page, History's lines and a pinned
//! editor's newest revision each keep, by key, what the last answer for a
//! version of a Secret kept, the version asked, and a request that failed.
//!
//! A request that fails says nothing of the revision and shows only on the
//! version of the Secret it was for. It is asked again once the hub's
//! backoff has passed, or RBAC's no has had the time the hub gives it to
//! pass, or at once after a relist; its pause grows while that Secret's
//! requests fail.

use std::collections::HashMap;
use std::hash::Hash;

use backon::ExponentialBackoff;
use tokio::time::Instant;
use twigo_cache::hub::{backoff, refusal_pause};
use twigo_cache::meta::Meta;
use twigo_ipc::{ErrorCode, IpcError};

use super::fetch::Failed;

/// One version of a revision's Secret: Helm writes a revision again, whole,
/// when its status changes, which may change its description too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Stamp {
    uid: Option<Box<str>>,
    resource_version: Box<str>,
}

impl Stamp {
    pub(super) fn of(meta: &Meta) -> Self {
        Self {
            uid: meta.uid.clone(),
            resource_version: meta.resource_version.clone(),
        }
    }

    /// Whether `other` is a version of the same Secret.
    pub(super) fn same_secret(&self, other: &Stamp) -> bool {
        self.uid.is_some() && self.uid == other.uid
    }

    pub(super) fn uid(&self) -> Option<&str> {
        self.uid.as_deref()
    }
}

/// What was read of a version of a Secret, by key, as `T`.
pub(super) struct Reads<K, T> {
    done: HashMap<K, (Stamp, T)>,
    asked: HashMap<K, Stamp>,
    failed: HashMap<K, Failing>,
}

impl<K, T> Default for Reads<K, T> {
    fn default() -> Self {
        Self {
            done: HashMap::new(),
            asked: HashMap::new(),
            failed: HashMap::new(),
        }
    }
}

impl<K: Eq + Hash, T> Reads<K, T> {
    /// What the last answer for `key` kept, and the version it read.
    pub(super) fn get(&self, key: &K) -> Option<(&Stamp, &T)> {
        self.done.get(key).map(|(stamp, kept)| (stamp, kept))
    }

    /// Why the request for `stamp` of `key` fails, while it does.
    pub(super) fn failure(&self, key: &K, stamp: &Stamp) -> Option<&IpcError> {
        self.failed
            .get(key)
            .filter(|failing| failing.stamp == *stamp)
            .map(|failing| &failing.error)
    }

    pub(super) fn asking(&self, key: &K, stamp: &Stamp) -> bool {
        self.asked.get(key) == Some(stamp)
    }

    /// Whether `stamp` of `key` wants a fetch: no answer for it is kept, none
    /// is under way, and no failed request for it waits out its pause.
    pub(super) fn wants(&self, key: &K, stamp: &Stamp) -> bool {
        self.done.get(key).is_none_or(|(at, _)| at != stamp)
            && !self.asking(key, stamp)
            && self
                .failed
                .get(key)
                .is_none_or(|failing| failing.stamp != *stamp || Instant::now() >= failing.due)
    }

    /// Marks `stamp` of `key` asked where it wants a fetch, and says whether
    /// it does; where it does not, a request for another version of `key`
    /// is no longer the one asked, so its answer is not taken.
    pub(super) fn ask(&mut self, key: K, stamp: &Stamp) -> bool {
        let wants = self.wants(&key, stamp);
        if wants {
            self.asked.insert(key, stamp.clone());
        } else if !self.asking(&key, stamp) {
            self.asked.remove(&key);
        }
        wants
    }

    /// Takes what the request for `stamp` of `key` answered, unless it is no
    /// longer the one asked, and says whether it did: a failed request grows
    /// the pause of the last one for that Secret, anything else is kept as
    /// `keep` makes it.
    pub(super) fn answered<U>(
        &mut self,
        key: K,
        stamp: Stamp,
        read: Result<U, Failed>,
        keep: impl FnOnce(Result<U, IpcError>) -> T,
    ) -> bool {
        if !self.asking(&key, &stamp) {
            return false;
        }
        self.asked.remove(&key);
        let last = self.failed.remove(&key);
        match read {
            Err(Failed::Request(error)) => {
                let last = last.filter(|last| last.stamp.same_secret(&stamp));
                self.failed.insert(key, Failing::after(last, stamp, error));
            }
            read => {
                self.done
                    .insert(key, (stamp, keep(read.map_err(Failed::error))));
            }
        }
        true
    }

    /// Keeps `kept` for `stamp` of `key`, read with no fetch of its own.
    pub(super) fn keep(&mut self, key: K, stamp: Stamp, kept: T) {
        self.failed.remove(&key);
        self.done.insert(key, (stamp, kept));
    }

    /// The keys whose failed request is due to be asked again.
    pub(super) fn due(&self) -> impl Iterator<Item = &K> {
        let now = Instant::now();
        self.failed
            .iter()
            .filter(move |(_, failing)| now >= failing.due)
            .map(|(key, _)| key)
    }

    /// The server listed again: every failed request is due at once.
    pub(super) fn relisted(&mut self) {
        let now = Instant::now();
        for failing in self.failed.values_mut() {
            failing.due = now;
        }
    }

    /// Forgets each key that `held` says no Secret holds now; what an
    /// earlier version or another Secret answered stays until the key is
    /// read again.
    pub(super) fn retain(&mut self, mut held: impl FnMut(&K) -> bool) {
        self.done.retain(|key, _| held(key));
        self.asked.retain(|key, _| held(key));
        self.failed.retain(|key, _| held(key));
    }

    pub(super) fn clear(&mut self) {
        self.done.clear();
        self.asked.clear();
        self.failed.clear();
    }
}

struct Failing {
    stamp: Stamp,
    error: IpcError,
    backoff: ExponentialBackoff,
    due: Instant,
}

impl Failing {
    /// `error` of the request for `stamp`; after `last`, the pause grows.
    fn after(last: Option<Failing>, stamp: Stamp, error: IpcError) -> Self {
        let mut backoff = last.map_or_else(backoff, |last| last.backoff);
        let pause = match error.code {
            ErrorCode::ServerForbidden | ErrorCode::ServerUnauthorized => refusal_pause(),
            _ => backoff
                .next()
                .expect("the backoff has no maximum of attempts"),
        };
        Self {
            stamp,
            error,
            backoff,
            due: Instant::now() + pause,
        }
    }
}
