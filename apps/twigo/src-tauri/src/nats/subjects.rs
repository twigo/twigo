use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::task::AbortHandle;
use tokio::time::MissedTickBehavior;

use super::connection::ConnState;
use super::error::{self, Error};
use crate::emit::Emit;

const SNAPSHOT_INTERVAL_MS: u64 = 500;
const MAX_SUBJECTS: usize = 5000;
// A raw 500 ms delta swings too hard to read or to rank by. At this weight and
// tick the average settles over roughly two seconds.
const RATE_SMOOTHING: f64 = 0.25;
// Decay is asymptotic: without a floor a silent subject reports an ever smaller
// non-zero rate forever, rendered as "<0.1/s" and glowing as live.
const RATE_FLOOR: f64 = 0.005;

#[derive(Default)]
pub struct SubjectWatch {
    tasks: Mutex<HashMap<String, AbortHandle>>,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct SubjectStat {
    subject: String,
    count: u64,
    rate: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SubjectsUpdate {
    conn: String,
    subjects: Vec<SubjectStat>,
    truncated: bool,
}

fn build_snapshot(
    counts: &HashMap<String, u64>,
    prev: &HashMap<String, u64>,
    smoothed: &mut HashMap<String, f64>,
    interval_secs: f64,
) -> Vec<SubjectStat> {
    counts
        .iter()
        .map(|(subject, &count)| {
            let previous = prev.get(subject).copied().unwrap_or(0);
            let instant = count.saturating_sub(previous) as f64 / interval_secs;
            // The first sample seeds the average, so a new subject reports its
            // real rate at once instead of ramping up from zero.
            let rate = match smoothed.get_mut(subject) {
                Some(avg) => {
                    *avg += RATE_SMOOTHING * (instant - *avg);
                    if *avg < RATE_FLOOR {
                        *avg = 0.0;
                    }
                    *avg
                }
                None => {
                    smoothed.insert(subject.clone(), instant);
                    instant
                }
            };
            SubjectStat {
                subject: subject.clone(),
                count,
                rate,
            }
        })
        .collect()
}

pub(crate) fn stop(watch: &SubjectWatch, conn_id: &str) {
    if let Some(handle) = watch.tasks.lock().unwrap().remove(conn_id) {
        handle.abort();
    }
}

#[tauri::command]
pub async fn start_subject_watch(
    app: AppHandle,
    conns: State<'_, ConnState>,
    watch: State<'_, SubjectWatch>,
    conn_id: String,
    pattern: Option<String>,
) -> error::Result<()> {
    start_subject_watch_impl(&app, &conns, &watch, conn_id, pattern).await
}

pub(crate) async fn start_subject_watch_impl<E: Emit>(
    emitter: &E,
    conns: &ConnState,
    watch: &SubjectWatch,
    conn_id: String,
    pattern: Option<String>,
) -> error::Result<()> {
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let pattern = pattern
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| ">".to_string());

    stop(watch, &conn_id);

    let mut sub = client.subscribe(pattern).await?;
    let conn = conn_id.clone();
    let emitter = emitter.clone();

    let handle = tokio::spawn(async move {
        let mut counts: HashMap<String, u64> = HashMap::new();
        let mut prev: HashMap<String, u64> = HashMap::new();
        let mut smoothed: HashMap<String, f64> = HashMap::new();
        let mut ticker = tokio::time::interval(Duration::from_millis(SNAPSHOT_INTERVAL_MS));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let interval_secs = SNAPSHOT_INTERVAL_MS as f64 / 1000.0;

        loop {
            tokio::select! {
                message = sub.next() => {
                    let Some(message) = message else { break };
                    let subject = message.subject.to_string();
                    if counts.len() < MAX_SUBJECTS || counts.contains_key(&subject) {
                        *counts.entry(subject).or_insert(0) += 1;
                    }
                }
                _ = ticker.tick() => {
                    let update = SubjectsUpdate {
                        conn: conn.clone(),
                        subjects: build_snapshot(&counts, &prev, &mut smoothed, interval_secs),
                        truncated: counts.len() >= MAX_SUBJECTS,
                    };
                    emitter.emit_event("subjects:update", update);
                    prev.clone_from(&counts);
                }
            }
        }
    });

    watch
        .tasks
        .lock()
        .unwrap()
        .insert(conn_id, handle.abort_handle());
    Ok(())
}

#[tauri::command]
pub fn stop_subject_watch(watch: State<'_, SubjectWatch>, conn_id: String) {
    stop(&watch, &conn_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate_of(snap: &[SubjectStat], subject: &str) -> f64 {
        snap.iter().find(|s| s.subject == subject).unwrap().rate
    }

    #[test]
    fn first_sample_reports_the_raw_delta() {
        let prev = HashMap::from([("a".to_string(), 10)]);
        let counts = HashMap::from([("a".to_string(), 20), ("b".to_string(), 3)]);
        let mut smoothed = HashMap::new();

        let snap = build_snapshot(&counts, &prev, &mut smoothed, 0.5);

        assert_eq!(rate_of(&snap, "a"), 20.0);
        assert_eq!(rate_of(&snap, "b"), 6.0);
    }

    #[test]
    fn a_spike_moves_the_rate_only_part_way() {
        let mut smoothed = HashMap::new();
        let counts = HashMap::from([("a".to_string(), 5)]);
        build_snapshot(&counts, &HashMap::new(), &mut smoothed, 0.5);

        // Seeded at 10/s, then a burst four times that size.
        let counts = HashMap::from([("a".to_string(), 25)]);
        let prev = HashMap::from([("a".to_string(), 5)]);
        let snap = build_snapshot(&counts, &prev, &mut smoothed, 0.5);

        // 10 + 0.25 * (40 - 10), not the raw 40 - the point of smoothing.
        assert_eq!(rate_of(&snap, "a"), 17.5);
    }

    #[test]
    fn a_steady_stream_converges_on_its_true_rate() {
        let mut smoothed = HashMap::new();
        let mut prev = HashMap::new();
        let mut counts = HashMap::new();
        let mut rate = 0.0;

        // Seeds at 0/s, then 10 messages every tick, i.e. a true 20/s.
        for tick in 0..25u64 {
            counts.insert("a".to_string(), tick * 10);
            let snap = build_snapshot(&counts, &prev, &mut smoothed, 0.5);
            rate = rate_of(&snap, "a");
            prev.clone_from(&counts);
        }

        assert!((rate - 20.0).abs() < 0.5, "converged to {rate}");
    }

    #[test]
    fn a_silent_subject_reaches_exactly_zero() {
        let mut smoothed = HashMap::new();
        let counts = HashMap::from([("a".to_string(), 50)]);
        build_snapshot(&counts, &HashMap::new(), &mut smoothed, 0.5);

        // Traffic stops: the count stops moving, so every delta is zero. Decay
        // alone is asymptotic, so this asserts the floor actually lands on 0 -
        // anything else reads as "<0.1/s" and glows as live forever.
        let mut rate = 100.0;
        for _ in 0..40 {
            let snap = build_snapshot(&counts, &counts, &mut smoothed, 0.5);
            rate = rate_of(&snap, "a");
        }

        assert_eq!(rate, 0.0);
    }

    /// Lowest rate reported once the average has settled, for one message every
    /// `every` ticks.
    fn trough(every: u64, ticks: u64) -> f64 {
        let mut smoothed = HashMap::new();
        let mut prev = HashMap::new();
        let mut counts = HashMap::new();
        let mut low = f64::MAX;

        for tick in 0..ticks {
            counts.insert("a".to_string(), tick / every);
            let snap = build_snapshot(&counts, &prev, &mut smoothed, 0.5);
            if tick > ticks / 2 {
                low = low.min(rate_of(&snap, "a"));
            }
            prev.clone_from(&counts);
        }
        low
    }

    #[test]
    fn a_subject_firing_within_the_window_never_reads_as_silent() {
        assert!(trough(4, 80) > RATE_FLOOR);
    }

    #[test]
    fn a_subject_slower_than_the_window_reads_as_silent() {
        // Inherent, not a defect: an exponential average cannot measure
        // something rarer than its own memory. The count column carries it.
        assert_eq!(trough(20, 200), 0.0);
    }
}
