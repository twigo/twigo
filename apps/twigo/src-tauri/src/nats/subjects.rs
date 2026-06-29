use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::task::AbortHandle;
use tokio::time::MissedTickBehavior;

use super::connection::ConnState;
use super::error::{self, Error};

const SNAPSHOT_INTERVAL_MS: u64 = 500;
const MAX_SUBJECTS: usize = 5000;

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
    interval_secs: f64,
) -> Vec<SubjectStat> {
    counts
        .iter()
        .map(|(subject, &count)| {
            let previous = prev.get(subject).copied().unwrap_or(0);
            SubjectStat {
                subject: subject.clone(),
                count,
                rate: count.saturating_sub(previous) as f64 / interval_secs,
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
    let client = conns
        .client(&conn_id)
        .await
        .ok_or_else(|| Error::NotConnected(conn_id.clone()))?;
    let pattern = pattern
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| ">".to_string());

    stop(&watch, &conn_id);

    let mut sub = client.subscribe(pattern).await?;
    let conn = conn_id.clone();

    let handle = tokio::spawn(async move {
        let mut counts: HashMap<String, u64> = HashMap::new();
        let mut prev: HashMap<String, u64> = HashMap::new();
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
                        subjects: build_snapshot(&counts, &prev, interval_secs),
                        truncated: counts.len() >= MAX_SUBJECTS,
                    };
                    if let Err(e) = app.emit("subjects:update", update) {
                        tracing::warn!("failed to emit subjects:update: {e}");
                    }
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

    #[test]
    fn snapshot_computes_rate_from_delta() {
        let prev = HashMap::from([("a".to_string(), 10)]);
        let counts = HashMap::from([("a".to_string(), 20), ("b".to_string(), 3)]);

        let mut snap = build_snapshot(&counts, &prev, 0.5);
        snap.sort_by(|x, y| x.subject.cmp(&y.subject));

        assert_eq!(
            snap[0],
            SubjectStat {
                subject: "a".into(),
                count: 20,
                rate: 20.0
            }
        );
        assert_eq!(
            snap[1],
            SubjectStat {
                subject: "b".into(),
                count: 3,
                rate: 6.0
            }
        );
    }
}
