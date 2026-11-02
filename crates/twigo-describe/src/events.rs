//! An object's events, read from `events.k8s.io/v1` (ARCHITECTURE 3.6).

use std::cmp::Reverse;

use jiff::Timestamp;
use serde_json::Value;
use twigo_ipc::ObjectEvent;

use crate::text;

/// An `events.k8s.io/v1` Event. A repeat counts its series, or the count of
/// a core/v1 event read through events.k8s.io, and is last seen when its
/// series last observed it, as `kubectl events` reads them.
pub fn event(object: &Value) -> ObjectEvent {
    let first = text(&object["eventTime"])
        .or_else(|| text(&object["deprecatedFirstTimestamp"]))
        .or_else(|| text(&object["metadata"]["creationTimestamp"]));
    let last = text(&object["series"]["lastObservedTime"])
        .or_else(|| text(&object["deprecatedLastTimestamp"]))
        .or_else(|| first.clone());
    let count = object["series"]["count"]
        .as_u64()
        .or_else(|| object["deprecatedCount"].as_u64())
        .unwrap_or(1)
        .max(1);
    ObjectEvent {
        kind: text(&object["type"]).unwrap_or_else(|| "Normal".to_owned()),
        reason: text(&object["reason"]).unwrap_or_default(),
        message: text(&object["note"]).unwrap_or_default(),
        source: text(&object["reportingController"])
            .or_else(|| text(&object["deprecatedSource"]["component"]))
            .unwrap_or_default(),
        count: u32::try_from(count).unwrap_or(u32::MAX),
        first,
        last,
        field_path: text(&object["regarding"]["fieldPath"]),
    }
}

/// Sorts by when each was last seen, newest first; one without a time last.
pub fn newest_first(events: &mut [ObjectEvent]) {
    events.sort_by_cached_key(|event| {
        Reverse(
            event
                .last
                .as_deref()
                .and_then(|at| at.parse::<Timestamp>().ok()),
        )
    });
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_series_counts_and_dates_a_repeat() {
        let read = event(&json!({
            "type": "Warning",
            "reason": "BackOff",
            "note": "Back-off restarting failed container",
            "reportingController": "kubelet",
            "eventTime": "2026-11-02T10:00:00.000001Z",
            "series": { "count": 7, "lastObservedTime": "2026-11-02T10:05:00.000002Z" },
            "regarding": { "fieldPath": "spec.containers{app}" },
        }));
        assert_eq!(read.count, 7);
        assert_eq!(read.first.as_deref(), Some("2026-11-02T10:00:00.000001Z"));
        assert_eq!(read.last.as_deref(), Some("2026-11-02T10:05:00.000002Z"));
        assert_eq!(read.field_path.as_deref(), Some("spec.containers{app}"));
    }

    #[test]
    fn a_core_event_keeps_its_count_and_timestamps() {
        let read = event(&json!({
            "reason": "Scheduled",
            "deprecatedSource": { "component": "default-scheduler" },
            "deprecatedCount": 3,
            "deprecatedFirstTimestamp": "2026-11-02T10:00:00Z",
            "deprecatedLastTimestamp": "2026-11-02T10:01:00Z",
        }));
        assert_eq!(
            (read.kind.as_str(), read.source.as_str(), read.count),
            ("Normal", "default-scheduler", 3)
        );
        assert_eq!(read.last.as_deref(), Some("2026-11-02T10:01:00Z"));
    }

    #[test]
    fn newest_first_compares_times_not_text() {
        let at = |last: &str| ObjectEvent {
            last: Some(last.to_owned()),
            ..event(&json!({}))
        };
        let mut events = vec![at("2026-11-02T10:00:00Z"), at("2026-11-02T10:00:00.5Z")];
        newest_first(&mut events);
        assert_eq!(events[0].last.as_deref(), Some("2026-11-02T10:00:00.5Z"));
    }
}
