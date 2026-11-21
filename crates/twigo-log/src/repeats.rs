/// A failure that repeats, such as a listener's `accept` under too many open
/// files: the first of a run is logged, the rest are counted, and the count is
/// logged once the run ends, so a log holds a change of state and not each
/// repeat.
#[derive(Debug, Default)]
pub struct Repeats {
    failures: u64,
}

impl Repeats {
    /// Counts a failure, and says whether it is the first since the run
    /// began: the one to log.
    pub fn failed(&mut self) -> bool {
        self.failures += 1;
        self.failures == 1
    }

    /// Ends the run, as a success or the end of the session does: how many
    /// failures followed the first, if any did.
    pub fn ended(&mut self) -> Option<u64> {
        let failures = std::mem::take(&mut self.failures);
        failures.checked_sub(1).filter(|&followed| followed > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_failure_of_a_run_is_logged_and_the_rest_counted() {
        let mut repeats = Repeats::default();
        assert_eq!(repeats.ended(), None);
        assert!(repeats.failed());
        assert_eq!(repeats.ended(), None, "a single failure has no repeats");
        assert!(repeats.failed());
        assert!(!repeats.failed());
        assert!(!repeats.failed());
        assert_eq!(repeats.ended(), Some(2));
        assert!(repeats.failed(), "the next run starts afresh");
    }
}
