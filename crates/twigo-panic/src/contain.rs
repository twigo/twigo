use std::future::Future;
use std::panic::{AssertUnwindSafe, resume_unwind};

use futures::FutureExt as _;
use tokio::task::JoinError;

use crate::inject;

/// An item's task panicked. The hook has recorded where and why.
#[derive(Debug)]
pub struct Panicked;

/// Runs an item's task, which has the end it sends the person when it dies
/// in the caller's hands: `Err` if it panicked.
///
/// The caller keeps the sender and the state the end needs outside `task`,
/// since a panic drops everything `task` owns. `item` names it in the log and
/// for [`inject`].
pub async fn contain<F: Future>(item: &'static str, task: F) -> Result<F::Output, Panicked> {
    let task = async {
        inject::check(item);
        task.await
    };
    AssertUnwindSafe(task).catch_unwind().await.map_err(|_| {
        tracing::error!(item, "an item panicked, so it ends");
        Panicked
    })
}

/// The result of a task nobody expects to panic: its value, or its panic
/// raised again as it was, which the panic hook does not record twice.
pub fn joined<T>(result: Result<T, JoinError>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => match error.try_into_panic() {
            Ok(payload) => resume_unwind(payload),
            Err(error) => panic!("a task that must run to its end did not: {error}"),
        },
    }
}

/// What `work` returns when it runs on the blocking pool, its panic raised
/// again as [`joined`] does.
pub async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    joined(tokio::task::spawn_blocking(work).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_item_that_panics_ends_and_one_that_does_not_gives_its_value() {
        assert_eq!(contain("kept", async { 7 }).await.unwrap(), 7);
        let ended = contain("lost", async { panic!("an item's bug") }).await;
        assert!(matches!(ended, Err(Panicked)));
    }

    #[tokio::test]
    async fn a_blocking_closure_gives_its_value_and_its_panic_goes_on_with_its_own_payload() {
        assert_eq!(blocking(|| 3).await, 3);
        let raised = AssertUnwindSafe(blocking(|| -> u8 { panic!("the original") }))
            .catch_unwind()
            .await
            .unwrap_err();
        assert_eq!(raised.downcast_ref::<&str>(), Some(&"the original"));
    }

    #[tokio::test]
    async fn a_joined_panic_goes_on_with_its_own_payload() {
        let task = tokio::spawn(async { panic!("the original") });
        let raised = std::panic::AssertUnwindSafe(async { joined(task.await) })
            .catch_unwind()
            .await
            .unwrap_err();
        assert_eq!(raised.downcast_ref::<&str>(), Some(&"the original"));
    }
}
