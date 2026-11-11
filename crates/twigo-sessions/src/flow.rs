//! A session's output in bytes: what goes out at once, what gathers, and when
//! the reader stops, as the terminal acknowledges what it parsed.

use std::time::Duration;

use tokio::time::Instant;

pub(crate) const FRAME_MAX: usize = 64 * 1024;
/// The least time between frames, since a webview pays for a frame far more than for its bytes.
pub(crate) const GATHER: Duration = Duration::from_millis(16);
const HIGH_WATER: u64 = 256 * 1024;
const LOW_WATER: u64 = 64 * 1024;

#[derive(Default)]
pub(crate) struct Flow {
    gathered: Vec<u8>,
    /// Sent and not yet acknowledged.
    unacked: u64,
    /// When the last frame went out.
    sent: Option<Instant>,
    /// When what has gathered goes out.
    due: Option<Instant>,
    stopped: bool,
}

impl Flow {
    /// Takes what was read and answers the frames to send now.
    pub(crate) fn read(&mut self, mut bytes: &[u8], now: Instant) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        while !bytes.is_empty() {
            let room = FRAME_MAX - self.gathered.len();
            let (taken, rest) = bytes.split_at(room.min(bytes.len()));
            self.gathered.extend_from_slice(taken);
            bytes = rest;
            if self.gathered.len() == FRAME_MAX {
                frames.extend(self.flush(now));
            }
        }
        if !self.gathered.is_empty() {
            match self.sent.map(|sent| sent + GATHER).filter(|due| *due > now) {
                Some(due) => self.due = Some(due),
                None => frames.extend(self.flush(now)),
            }
        }
        frames
    }

    /// What has gathered, as a frame.
    pub(crate) fn flush(&mut self, now: Instant) -> Option<Vec<u8>> {
        self.due = None;
        if self.gathered.is_empty() {
            return None;
        }
        self.sent = Some(now);
        self.unacked += self.gathered.len() as u64;
        Some(std::mem::take(&mut self.gathered))
    }

    /// Counts bytes the terminal parsed, no more than were sent.
    pub(crate) fn ack(&mut self, bytes: u64) {
        self.unacked -= bytes.min(self.unacked);
    }

    pub(crate) fn due(&self) -> Option<Instant> {
        self.due
    }

    /// Whether the session may read more.
    pub(crate) fn reading(&mut self) -> bool {
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
        assert_eq!(flow.flush(now()), Some(b"bc".to_vec()));
        assert_eq!(flow.due(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn what_has_gathered_leaves_in_frames_of_at_most_64_kib() {
        let mut flow = Flow::default();
        flow.read(&[0; 1], now());
        let frames = flow.read(&vec![0; 3 * FRAME_MAX], now());
        assert_eq!(frames.len(), 3);
        assert!(frames.iter().all(|frame| frame.len() == FRAME_MAX));
        assert_eq!(flow.flush(now()), None);
        assert!(flow.read(&vec![0; KIB], now()).is_empty());
        assert_eq!(flow.flush(now()).map(|frame| frame.len()), Some(KIB));
    }

    #[tokio::test(start_paused = true)]
    async fn an_ack_lets_nothing_out_before_its_time() {
        let mut flow = Flow::default();
        flow.read(b"sent", now());
        flow.ack(4);
        assert!(flow.read(b"more", now()).is_empty());
        assert_eq!(flow.due(), Some(now() + GATHER));
    }

    #[tokio::test(start_paused = true)]
    async fn output_after_the_gap_goes_out_at_once_whatever_is_unacknowledged() {
        let mut flow = Flow::default();
        flow.read(b"sent", now());
        tokio::time::advance(GATHER).await;
        assert_eq!(flow.read(b"echo", now()), vec![b"echo".to_vec()]);
        assert_eq!(flow.due(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn the_timer_counts_from_the_last_frame_not_from_the_first_byte_held() {
        let mut flow = Flow::default();
        flow.read(b"sent", now());
        let due = now() + GATHER;
        tokio::time::advance(Duration::from_millis(4)).await;
        assert!(flow.read(b"more", now()).is_empty());
        assert_eq!(flow.due(), Some(due));
    }

    #[tokio::test(start_paused = true)]
    async fn an_ack_for_more_than_was_sent_is_clamped_and_never_covers_what_only_gathered() {
        let mut flow = Flow::default();
        flow.read(b"sent", now());
        flow.read(b"held", now());
        flow.ack(1 << 40);
        assert_eq!(flow.unacked, 0);
        flow.flush(now());
        assert_eq!(flow.unacked, 4);
        flow.ack(2);
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
