use twigo_cache::decode::{Decode, Event};
use twigo_cache::meta::MetaDecoder;

fn events(fixture: &str) -> Vec<Event> {
    let mut decoder = MetaDecoder;
    fixture
        .lines()
        .map(|line| decoder.decode_event(line.as_bytes()).unwrap())
        .collect()
}

fn summary(events: &[Event]) -> Vec<(&'static str, String)> {
    events
        .iter()
        .map(|event| match event {
            Event::Upsert(row) => ("upsert", row.meta.name.to_string()),
            Event::Delete(row) => ("delete", row.meta.name.to_string()),
            Event::Bookmark {
                resource_version,
                initial_events_end,
            } => (
                if *initial_events_end {
                    "end"
                } else {
                    "bookmark"
                },
                resource_version.to_string(),
            ),
            Event::Error(status) => ("error", status.code.to_string()),
        })
        .collect()
}

#[test]
fn a_metadata_list_keeps_meta_lite_and_no_cells() {
    let page = MetaDecoder
        .decode_list(include_bytes!("fixtures/namespaces-metadata-list.json"))
        .unwrap();
    assert_eq!(page.resource_version.as_ref(), "922");
    assert_eq!(page.continue_token, None);
    let names: Vec<&str> = page.items.iter().map(|row| &*row.meta.name).collect();
    assert_eq!(
        names,
        [
            "default",
            "kube-node-lease",
            "kube-public",
            "kube-system",
            "local-path-storage",
            "probe"
        ]
    );
    let probe = &page.items[5];
    assert!(probe.cells.is_empty());
    assert_eq!(probe.meta.namespace, None);
    assert_eq!(probe.meta.uid.as_deref().map(str::len), Some(36));
    assert_eq!(
        probe.meta.labels.as_ref(),
        [("kubernetes.io/metadata.name".into(), "probe".into())] as [(Box<str>, Box<str>); 1]
    );
    assert!(probe.meta.created.is_some());
}

#[test]
fn a_streaming_list_of_metadata_ends_with_its_bookmark() {
    let events = events(include_str!(
        "fixtures/namespaces-metadata-initial-events.jsonl"
    ));
    assert_eq!(
        summary(&events),
        [
            ("upsert", "default".to_owned()),
            ("upsert", "kube-node-lease".to_owned()),
            ("upsert", "kube-public".to_owned()),
            ("upsert", "kube-system".to_owned()),
            ("upsert", "local-path-storage".to_owned()),
            ("upsert", "probe".to_owned()),
            ("end", "922".to_owned()),
            ("upsert", "probe-gone".to_owned()),
            ("upsert", "probe".to_owned()),
            ("upsert", "probe-gone".to_owned()),
            ("bookmark", "929".to_owned()),
            ("bookmark", "929".to_owned()),
        ]
    );
}

#[test]
fn a_metadata_watch_carries_each_change() {
    let events = events(include_str!("fixtures/namespaces-metadata-watch.jsonl"));
    assert_eq!(
        summary(&events),
        [
            ("upsert", "probe-gone".to_owned()),
            ("upsert", "probe".to_owned()),
            ("upsert", "probe-gone".to_owned()),
            ("bookmark", "929".to_owned()),
            ("bookmark", "929".to_owned()),
        ]
    );
    let Event::Upsert(labelled) = &events[1] else {
        unreachable!()
    };
    assert_eq!(&*labelled.meta.resource_version, "927");
    assert!(
        labelled
            .meta
            .labels
            .iter()
            .any(|(key, value)| &**key == "touched" && &**value == "yes")
    );
}
