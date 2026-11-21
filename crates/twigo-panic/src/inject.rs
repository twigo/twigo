//! The seam: a panic armed by name. The supervisor starts a duty, and
//! [`contain`](crate::contain) an item, under the name they were given, and
//! each panics when that name is armed. A few more sites say a name of their
//! own, such as the store's lock. Without the `inject` feature nothing is
//! armed and [`check`] is empty, so a release build never has it.

/// Panics if `name` is armed.
#[cfg(not(feature = "inject"))]
#[inline(always)]
pub fn check(_name: &str) {}

#[cfg(feature = "inject")]
pub use armed::{arm, check};

#[cfg(feature = "inject")]
mod armed {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex, PoisonError};

    use tokio::runtime::{Handle, Id};

    struct Arm {
        /// The runtime that armed it, so that tests in one process never
        /// spend each other's: none for a name armed outside any runtime,
        /// as the app's start does.
        runtime: Option<Id>,
        times: u32,
    }

    static ARMED: LazyLock<Mutex<HashMap<String, Arm>>> = LazyLock::new(Mutex::default);

    fn runtime() -> Option<Id> {
        Handle::try_current().ok().map(|handle| handle.id())
    }

    /// Makes the next `times` checks of `name` panic, in the runtime this is
    /// called in, or in any if it is called outside one.
    pub fn arm(name: &str, times: u32) {
        ARMED.lock().unwrap_or_else(PoisonError::into_inner).insert(
            name.to_owned(),
            Arm {
                runtime: runtime(),
                times,
            },
        );
    }

    /// Panics if `name` is armed for this runtime, and counts it spent.
    pub fn check(name: &str) {
        let mut armed = ARMED.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(arm) = armed.get_mut(name) else {
            return;
        };
        if arm.runtime.is_some() && arm.runtime != runtime() {
            return;
        }
        arm.times -= 1;
        if arm.times == 0 {
            armed.remove(name);
        }
        drop(armed);
        panic!("{name} is armed to panic");
    }
}

#[cfg(all(test, feature = "inject"))]
mod tests {
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
}
