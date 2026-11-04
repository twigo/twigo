//! Where a stream's reads start, and which lines a reopened read had
//! already.

use std::hash::{DefaultHasher, Hash, Hasher};

use twigo_ipc::Since;

use super::Read;
use crate::logs::now;

/// Where a read starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFrom {
    /// The instance's last lines.
    Lines(u32),
    /// The instance's start.
    Start,
    /// A whole second, in nanoseconds since the Unix epoch, which
    /// kube-core's rounding of `sinceTime` to the second keeps.
    Time(i64),
}

impl ReadFrom {
    /// Where the source starts the first instance a stream reads: a
    /// number of seconds from the time it is first asked, so a read
    /// repeated before any line came reads the same lines.
    pub fn source(since: Since) -> Self {
        match since {
            Since::Lines { lines } => ReadFrom::Lines(lines),
            Since::Seconds { seconds } => {
                ReadFrom::Time(second(now() - i64::from(seconds) * SECOND))
            }
            Since::Start => ReadFrom::Start,
        }
    }
}

pub fn second(at: i64) -> i64 {
    at.div_euclid(SECOND) * SECOND
}

/// A line as the kubelet sent it, its time included, by a hash.
fn digest(line: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    line.hash(&mut hasher);
    hasher.finish()
}

/// The lines a reopened read has delivered already. It starts at the
/// second of the latest line, since the server reads `sinceTime` to the
/// second (the API server passes it on as `time.RFC3339`, kubernetes
/// v1.37.0 `pkg/registry/core/pod/strategy.go`), and the kubelet sends each
/// line of the log at or after it, in the log's order (cri-client
/// `logWriter.write`), so the lines the stream admitted at or after that
/// second come first. Times may go back a little, as containerd stamps
/// stdout and stderr in goroutines of their own, so they are counted, none
/// later than the latest: a later line first says the log holds none of
/// them, as the next instance's does.
///
/// A read of the log's last lines starts where they start (cri-client
/// v0.37.0, `ReadLogs`), which may be inside a second after lines of it
/// the read does not get, and a reread from that second gets those first.
/// So while the latest line is in that second, a reread passes over the
/// lines before the first one that read got, which it knows by its time
/// and bytes, and counts from there.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Resume {
    /// The latest time admitted, and how many admitted lines came at or
    /// after its second.
    latest: Option<(i64, u32)>,
    /// The read under way started at the log's last lines.
    tail: bool,
    /// The first line such a read admitted, by its time and the hash of
    /// its bytes, while the latest line is in its second.
    first: Option<(i64, u64)>,
    /// What a reopened read has still to skip.
    skip: Option<Skip>,
    /// The latest time admitted when a rest started, until the rest gives
    /// a line at or after it: a log holding the lines read gives the latest
    /// again before any later one, as the kubelet sends those at or after
    /// its second first, in the log's order, so the lines before it are
    /// none the stream had, but another instance's, or of that second
    /// before where a tail of lines started.
    hold: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Skip {
    left: u32,
    latest: i64,
    /// It reads the instance it read before, so a later line first says
    /// the log holds none of what came: the kubelet reads another, or the
    /// log was rotated.
    same: bool,
    /// The first line a read of the last lines admitted, which it has yet
    /// to pass the lines before.
    first: Option<(i64, u64)>,
}

/// What a line read is to the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admit {
    New,
    /// One it had, or one before the first of the last lines it read, in
    /// their second, which it never had nor will.
    Again,
    /// A reread of the same instance found a log without what it had.
    Moved,
    /// A rest's line the hold keeps back, which neither comes nor counts.
    Held,
}

pub const SECOND: i64 = 1_000_000_000;

impl Resume {
    /// Starts a read that skips what came already, and for a rest holds
    /// back what came before the latest line; where it starts: the second
    /// of the latest line, or `from` while there is none.
    pub fn start(&mut self, read: Read, from: ReadFrom) -> ReadFrom {
        let same = matches!(read, Read::Follow { same: true } | Read::Previous);
        let first = self.first;
        self.skip = self.latest.map(|(latest, left)| Skip {
            left,
            latest,
            same,
            first,
        });
        self.hold = self.last_at().filter(|_| read == Read::Rest);
        self.tail = self.latest.is_none() && matches!(from, ReadFrom::Lines(_));
        self.latest
            .map_or(from, |(at, _)| ReadFrom::Time(second(at)))
    }

    /// What a line read at `at` is, counting it if new; a line held back
    /// does not come, so it must not count, or a later read would skip one
    /// that it never sent for it.
    pub fn admit(&mut self, at: i64, line: &[u8]) -> Admit {
        if self.hold.is_some_and(|hold| at >= hold) {
            self.hold = None;
        }
        if let Some(skip) = &mut self.skip {
            if at <= skip.latest {
                if let Some((first, hash)) = skip.first {
                    if first != at || hash != digest(line) {
                        return Admit::Again;
                    }
                    skip.first = None;
                }
                skip.left -= 1;
                if skip.left == 0 {
                    self.skip = None;
                }
                return Admit::Again;
            }
            let same = skip.same;
            self.skip = None;
            if same {
                return Admit::Moved;
            }
        }
        if self.hold.is_some() {
            return Admit::Held;
        }
        let tail = self.tail && self.latest.is_none();
        let (latest, count) = match self.latest {
            Some((latest, count)) if second(at) == second(latest) => (latest.max(at), count + 1),
            Some((latest, count)) if at < latest => (latest, count),
            _ => (at, 1),
        };
        self.latest = Some((latest, count));
        self.first = if tail {
            Some((at, digest(line)))
        } else {
            self.first
                .filter(|(first, _)| second(*first) == second(latest))
        };
        Admit::New
    }

    pub fn last_at(&self) -> Option<i64> {
        self.latest.map(|(at, _)| at)
    }

    /// Whether a reread of the instance read before has yet to get lines
    /// it had, or a rest the latest of them: a log that ends first holds
    /// none of them.
    pub fn lacks(&self) -> bool {
        self.hold.is_some() || self.skip.is_some_and(|skip| skip.same)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use Admit::{Again, Moved, New};

    fn admit(resume: &mut Resume, at: i64) -> Admit {
        resume.admit(at, format!("{at} line").as_bytes())
    }

    fn reread(resume: &mut Resume, times: &[i64]) -> Vec<Admit> {
        resume.start(Read::Follow { same: true }, ReadFrom::Start);
        times.iter().map(|at| admit(resume, *at)).collect()
    }

    #[test]
    fn a_reopened_read_skips_what_came_already() {
        let mut resume = Resume::default();
        for at in [1_500, 2_000, 2_000] {
            assert_eq!(admit(&mut resume, at), New);
        }
        assert_eq!(
            resume.start(Read::Follow { same: true }, ReadFrom::Start),
            ReadFrom::Time(0)
        );
        let again = reread(&mut resume, &[1_500, 2_000, 2_000, 2_000, 2_500]);
        assert_eq!(again, [Again, Again, Again, New, New]);
    }

    #[test]
    fn a_reopened_read_skips_exactly_what_came_at_or_after_its_second_when_times_go_back() {
        let ms = |ms: i64| ms * 1_000_000;
        let mut resume = Resume::default();
        for at in [ms(1_900), ms(2_200), ms(2_300), ms(2_100)] {
            assert_eq!(admit(&mut resume, at), New);
        }
        assert_eq!(
            resume.start(Read::Follow { same: true }, ReadFrom::Start),
            ReadFrom::Time(2 * SECOND)
        );
        let again = reread(
            &mut resume,
            &[ms(2_200), ms(2_300), ms(2_100), ms(2_250), ms(2_400)],
        );
        assert_eq!(again, [Again, Again, Again, New, New]);
        let again = reread(
            &mut resume,
            &[
                ms(2_200),
                ms(2_300),
                ms(2_100),
                ms(2_250),
                ms(2_400),
                ms(2_050),
            ],
        );
        assert_eq!(again, [Again, Again, Again, Again, Again, New]);
    }

    #[test]
    fn a_later_line_first_says_the_log_holds_none_of_what_came() {
        let mut resume = Resume::default();
        for at in [1_000, 2_000] {
            assert_eq!(admit(&mut resume, at), New);
        }
        assert_eq!(reread(&mut resume, &[5_000, 6_000]), [Moved, New]);
        resume.start(Read::Follow { same: false }, ReadFrom::Start);
        assert_eq!(admit(&mut resume, 9_000), New);
        assert_eq!(admit(&mut resume, 9_500), New);
    }

    #[test]
    fn a_reopened_read_resumes_from_the_latest_lines_second() {
        let mut resume = Resume::default();
        assert_eq!(admit(&mut resume, 5 * SECOND + 700), New);
        assert_eq!(
            resume.start(Read::Follow { same: true }, ReadFrom::Lines(10)),
            ReadFrom::Time(5 * SECOND)
        );
        assert_eq!(
            Resume::default().start(Read::Follow { same: true }, ReadFrom::Lines(10)),
            ReadFrom::Lines(10)
        );
    }

    #[test]
    fn a_reread_from_the_second_last_lines_started_in_passes_the_lines_before_them() {
        let mut resume = Resume::default();
        resume.start(Read::Follow { same: true }, ReadFrom::Lines(2));
        for at in [1_200, 1_300] {
            assert_eq!(admit(&mut resume, at), New);
        }
        let again = reread(&mut resume, &[1_100, 1_200, 1_300, 1_400]);
        assert_eq!(again, [Again, Again, Again, New]);
        let again = reread(&mut resume, &[1_100, 1_250, 1_500]);
        assert_eq!(again, [Again, Again, Moved]);
        assert_eq!(admit(&mut resume, SECOND + 100), New);
        let again = reread(&mut resume, &[SECOND + 100, SECOND + 200]);
        assert_eq!(again, [Again, New]);
    }
}
