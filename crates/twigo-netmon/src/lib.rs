//! Wake from sleep and network changes, read from the OS (ARCHITECTURE 3.2):
//! on wake the transport retires every connection, and on a network change
//! the connections whose route moved.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;

use std::time::Duration;

use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Woke,
    NetworkChanged,
}

/// Network changes come in bursts; Firefox coalesces them for a second,
/// Chromium for two.
const QUIET: Duration = Duration::from_secs(1);

pub struct Watch {
    events: UnboundedReceiver<Event>,
    _listeners: platform::Listeners,
}

impl Watch {
    /// Starts listening, within a tokio runtime. A listener the OS refuses
    /// is reported and left out.
    pub fn start() -> Self {
        let (raw, raw_events) = mpsc::unbounded_channel();
        let (events, received) = mpsc::unbounded_channel();
        tokio::spawn(coalesce(raw_events, events));
        Self {
            events: received,
            _listeners: platform::Listeners::start(raw),
        }
    }

    pub async fn next(&mut self) -> Option<Event> {
        self.events.recv().await
    }
}

/// Passes wakes on at once and a burst of network changes once it has been
/// quiet for [`QUIET`].
async fn coalesce(mut raw: UnboundedReceiver<Event>, events: UnboundedSender<Event>) {
    while let Some(event) = raw.recv().await {
        if event == Event::NetworkChanged {
            loop {
                match tokio::time::timeout(QUIET, raw.recv()).await {
                    Ok(Some(Event::NetworkChanged)) => {}
                    Ok(Some(Event::Woke)) => {
                        if events.send(Event::Woke).is_err() {
                            return;
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        }
        if events.send(event).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_burst_of_network_changes_comes_once_and_a_wake_at_once() {
        let (raw, raw_events) = mpsc::unbounded_channel();
        let (events, mut received) = mpsc::unbounded_channel();
        tokio::spawn(coalesce(raw_events, events));

        for _ in 0..5 {
            raw.send(Event::NetworkChanged).unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        raw.send(Event::Woke).unwrap();
        assert_eq!(received.recv().await, Some(Event::Woke));
        assert!(received.try_recv().is_err(), "the burst is still going");

        tokio::time::sleep(QUIET).await;
        assert_eq!(received.recv().await, Some(Event::NetworkChanged));
        assert!(received.try_recv().is_err());

        raw.send(Event::NetworkChanged).unwrap();
        drop(raw);
        assert_eq!(received.recv().await, Some(Event::NetworkChanged));
        assert_eq!(received.recv().await, None);
    }
}
