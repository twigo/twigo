//! The seam: a panic armed by name. The supervisor starts a duty, and
//! [`contain`](crate::contain()) an item, under the name they were given, and
//! each panics when that name is armed. A few more sites say a name of their
//! own, such as the store's lock. Without the `inject` feature nothing is
//! armed and [`check`] is empty, so a release build never has it.
//!
//! An arm counts in the runtime it was made in, and a thread checks in the
//! runtime that started it ([`Scope`]): a test owns its runtime, so the tests
//! of one process never spend each other's arms. An arm made outside any
//! runtime, as the check build makes it, counts everywhere.

/// Where a check counts: the runtime it runs in, or, for a thread, the one
/// that started it.
#[derive(Clone, Copy, Debug)]
pub struct Scope(#[cfg(feature = "inject")] Option<tokio::runtime::Id>);

#[cfg(not(feature = "inject"))]
impl Scope {
    /// The runtime this is called in.
    #[inline(always)]
    pub fn current() -> Self {
        Self()
    }

    /// Panics if `name` is armed in this scope.
    #[inline(always)]
    pub fn check(self, _name: &str) {}
}

/// Panics if `name` is armed in the runtime this runs in.
#[inline(always)]
pub fn check(name: &str) {
    Scope::current().check(name);
}

#[cfg(feature = "inject")]
pub(crate) use armed::raised;
#[cfg(feature = "inject")]
pub use armed::{arm, armed};

#[cfg(feature = "inject")]
mod armed {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

    use tokio::runtime::{Handle, Id};

    use super::Scope;

    type Key = (Option<Id>, String);

    #[derive(Default)]
    struct Seam {
        /// How many panics each arm has left.
        arms: HashMap<Key, u32>,
        /// The panics raised in each scope that [`raised`] has not taken.
        raised: HashMap<Key, u32>,
    }

    static SEAM: LazyLock<Mutex<Seam>> = LazyLock::new(Mutex::default);

    fn seam() -> MutexGuard<'static, Seam> {
        SEAM.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn runtime() -> Option<Id> {
        Handle::try_current().ok().map(|handle| handle.id())
    }

    /// The arm of `name` that counts in `scope`: its own, or one made
    /// outside any runtime.
    fn key(arms: &HashMap<Key, u32>, scope: Option<Id>, name: &str) -> Option<Key> {
        [scope, None]
            .into_iter()
            .map(|scope| (scope, name.to_owned()))
            .find(|key| arms.contains_key(key))
    }

    impl Scope {
        pub fn current() -> Self {
            Self(runtime())
        }

        pub fn check(self, name: &str) {
            let mut seam = seam();
            let Some(key) = key(&seam.arms, self.0, name) else {
                return;
            };
            let left = seam.arms.get_mut(&key).expect("found above");
            *left -= 1;
            if *left == 0 {
                seam.arms.remove(&key);
            }
            *seam.raised.entry((self.0, name.to_owned())).or_default() += 1;
            drop(seam);
            panic!("{name} is armed to panic");
        }
    }

    /// Makes the next `times` checks of `name` panic, in the runtime this is
    /// called in, or in every one if it is called outside one.
    pub fn arm(name: &str, times: u32) {
        seam().arms.insert((runtime(), name.to_owned()), times);
    }

    /// How many panics `name` has left in this runtime.
    pub fn armed(name: &str) -> u32 {
        let seam = seam();
        key(&seam.arms, runtime(), name).map_or(0, |key| seam.arms[&key])
    }

    /// Whether the seam raised a panic of `name` in this runtime, or on a
    /// thread started outside any, that this has not taken yet; takes it.
    pub(crate) fn raised(name: &str) -> bool {
        let mut seam = seam();
        let Some(key) = key(&seam.raised, runtime(), name) else {
            return false;
        };
        let left = seam.raised.get_mut(&key).expect("found above");
        *left -= 1;
        if *left == 0 {
            seam.raised.remove(&key);
        }
        true
    }
}

#[cfg(all(test, feature = "inject"))]
mod tests {
    use super::Scope;
    use crate::contain;

    #[tokio::test]
    async fn an_armed_name_panics_the_times_asked_in_the_runtime_that_armed_it() {
        super::arm("armed item", 2);
        let other = std::thread::spawn(|| {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(contain("armed item", async {}))
        });
        assert!(
            other.join().unwrap().is_ok(),
            "another runtime is not armed"
        );
        assert!(contain("armed item", async {}).await.is_err());
        assert!(contain("armed item", async {}).await.is_err());
        assert!(contain("armed item", async {}).await.is_ok(), "spent");
    }

    #[tokio::test]
    async fn a_thread_checks_in_the_runtime_that_started_it() {
        super::arm("armed thread", 1);
        let started_here = Scope::current();
        let started_elsewhere = std::thread::spawn(|| {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(async { Scope::current() })
        })
        .join()
        .unwrap();
        let checked = |scope: Scope| {
            std::thread::spawn(move || scope.check("armed thread"))
                .join()
                .is_err()
        };
        assert!(!checked(started_elsewhere), "another runtime's thread");
        assert!(checked(started_here));
        assert_eq!(super::armed("armed thread"), 0, "spent");
    }
}
