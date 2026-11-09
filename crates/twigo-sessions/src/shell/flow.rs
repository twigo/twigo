//! A session's output in bytes: what goes out at once, what gathers, and when
//! the reader stops, as the terminal acknowledges what it parsed.

use std::time::Duration;

use tokio::time::Instant;

pub(super) const FRAME_MAX: usize = 64 * 1024;
const GATHER: Duration = Duration::from_millis(5);
const HIGH_WATER: u64 = 256 * 1024;
const LOW_WATER: u64 = 64 * 1024;

#[derive(Default)]
pub(super) struct Flow {
    gathered: Vec<u8>,
    /// Sent and not yet acknowledged.
    unacked: u64,
    /// When what has gathered goes out.
    due: Option<Instant>,
    stopped: bool,
}

impl Flow {
    /// Takes what was read and answers the frames to send now.
    pub(super) fn read(&mut self, mut bytes: &[u8], now: Instant) -> Vec<Vec<u8>> {
        let idle = self.gathered.is_empty() && self.unacked == 0;
        let mut frames = Vec::new();
        while !bytes.is_empty() {
            let room = FRAME_MAX - self.gathered.len();
            let (taken, rest) = bytes.split_at(room.min(bytes.len()));
            self.gathered.extend_from_slice(taken);
            bytes = rest;
            if self.gathered.len() == FRAME_MAX {
                frames.extend(self.flush());
            }
        }
        if idle {
            frames.extend(self.flush());
        } else if !self.gathered.is_empty() && self.due.is_none() {
            self.due = Some(now + GATHER);
        }
        frames
    }

    /// What has gathered, as a frame.
    pub(super) fn flush(&mut self) -> Option<Vec<u8>> {
        self.due = None;
        if self.gathered.is_empty() {
            return None;
        }
        self.unacked += self.gathered.len() as u64;
        Some(std::mem::take(&mut self.gathered))
    }

    /// Counts bytes the terminal parsed, no more than were sent, and answers
    /// what gathered once nothing is left unacknowledged.
    pub(super) fn ack(&mut self, bytes: u64) -> Option<Vec<u8>> {
        self.unacked -= bytes.min(self.unacked);
        if self.unacked == 0 {
            self.flush()
        } else {
            None
        }
    }

    pub(super) fn due(&self) -> Option<Instant> {
        self.due
    }

    /// Whether the session may read more.
    pub(super) fn reading(&mut self) -> bool {
        let held = self.unacked + self.gathered.len() as u64;
        if self.stopped {
            self.stopped = held >= LOW_WATER;
        } else {
            self.stopped = held >= HIGH_WATER;
        }
        !self.stopped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KIB: usize = 1024;

    fn now() -> Instant {
        Instant::now()
    }

    #[tokio::test(start_paused = true)]
    async fn the_first_output_goes_out_at_once_and_the_next_gathers_for_the_timer() {
        let mut flow = Flow::default();
        assert_eq!(flow.read(b"a", now()), vec![b"a".to_vec()]);
        assert!(flow.read(b"b", now()).is_empty());
        assert!(flow.read(b"c", now()).is_empty());
        assert_eq!(flow.due(), Some(now() + GATHER));
        assert_eq!(flow.flush(), Some(b"bc".to_vec()));
        assert_eq!(flow.due(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn what_has_gathered_leaves_in_frames_of_at_most_64_kib() {
        let mut flow = Flow::default();
        flow.read(&[0; 1], now());
        let frames = flow.read(&vec![0; 3 * FRAME_MAX], now());
        assert_eq!(frames.len(), 3);
        assert!(frames.iter().all(|frame| frame.len() == FRAME_MAX));
        assert_eq!(flow.flush(), None);
        assert!(flow.read(&vec![0; KIB], now()).is_empty());
        assert_eq!(flow.flush().map(|frame| frame.len()), Some(KIB));
    }

    #[tokio::test(start_paused = true)]
    async fn an_ack_that_empties_the_unacknowledged_sends_what_has_gathered() {
        let mut flow = Flow::default();
        flow.read(b"sent", now());
        flow.read(b"more", now());
        assert_eq!(flow.ack(4), Some(b"more".to_vec()));
    }

    #[tokio::test(start_paused = true)]
    async fn an_ack_for_more_than_was_sent_is_clamped_and_never_covers_what_only_gathered() {
        let mut flow = Flow::default();
        flow.read(b"sent", now());
        flow.read(b"held", now());
        assert_eq!(flow.ack(1 << 40), Some(b"held".to_vec()));
        assert_eq!(flow.unacked, 4);
        assert_eq!(flow.ack(2), None);
        assert_eq!(flow.unacked, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn the_reader_stops_at_256_kib_and_starts_again_below_64_kib() {
        let mut flow = Flow::default();
        assert!(flow.reading());
        flow.read(&vec![0; FRAME_MAX], now());
        flow.read(&vec![0; FRAME_MAX], now());
        flow.read(&vec![0; FRAME_MAX], now());
        flow.read(&vec![0; FRAME_MAX], now());
        assert_eq!(flow.unacked, (4 * FRAME_MAX) as u64);
        assert!(!flow.reading());
        flow.ack(((4 * FRAME_MAX) - (64 * KIB)) as u64);
        assert!(!flow.reading());
        flow.ack(1);
        assert!(flow.reading());
    }
}
