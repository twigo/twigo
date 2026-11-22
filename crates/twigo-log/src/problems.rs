//! What Twigo's own files could not do, which leaves the person with less than
//! they set up and which they would otherwise not learn: the state set aside
//! with its locks, an audit log that records nothing, tokens kept in memory.
//!
//! One list for the run, with each problem once: a report of a code replaces
//! the last of it, so a failure that repeats stays one entry. The window reads
//! it through `problems_watch`.

use std::sync::LazyLock;

use tokio::sync::watch;
use twigo_ipc::{ErrorCode, IpcError};

static PROBLEMS: LazyLock<watch::Sender<Vec<IpcError>>> =
    LazyLock::new(|| watch::Sender::new(Vec::new()));

/// Adds `problem` to the run's list, in place of the last of its code.
pub fn report(problem: IpcError) {
    PROBLEMS.send_if_modified(|list| {
        match list.iter_mut().find(|listed| listed.code == problem.code) {
            Some(listed) if *listed == problem => return false,
            Some(listed) => *listed = problem,
            None => list.push(problem),
        }
        true
    });
}

/// Takes the problem of `code` off the list, as what it said no longer holds.
pub fn clear(code: ErrorCode) {
    PROBLEMS.send_if_modified(|list| {
        let before = list.len();
        list.retain(|listed| listed.code != code);
        list.len() != before
    });
}

/// The run's list, now and as it changes.
pub fn watch() -> watch::Receiver<Vec<IpcError>> {
    PROBLEMS.subscribe()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_problem_is_listed_once_and_goes_when_it_is_cleared() {
        let mut list = watch();
        list.borrow_and_update();
        report(IpcError::new(ErrorCode::AuditOff, "first"));
        report(IpcError::new(ErrorCode::AuditOff, "second"));
        assert!(list.has_changed().unwrap());
        let held: Vec<_> = list
            .borrow_and_update()
            .iter()
            .filter(|problem| problem.code == ErrorCode::AuditOff)
            .cloned()
            .collect();
        assert_eq!(held, [IpcError::new(ErrorCode::AuditOff, "second")]);

        report(IpcError::new(ErrorCode::AuditOff, "second"));
        assert!(
            !list.has_changed().unwrap(),
            "the same words change nothing"
        );

        clear(ErrorCode::AuditOff);
        assert!(
            list.borrow()
                .iter()
                .all(|problem| problem.code != ErrorCode::AuditOff)
        );
    }
}
