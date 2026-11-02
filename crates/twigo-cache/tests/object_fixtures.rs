use twigo_cache::decode::{Decode, Event};
use twigo_cache::object::ObjectDecoder;
use twigo_cache::table::{Cell, ColumnKind};

#[test]
fn a_table_list_keeps_the_whole_object_and_its_cells() {
    let mut decoder = ObjectDecoder::new();
    let page = decoder
        .decode_list(include_bytes!("fixtures/pod-object-table-list.json"))
        .unwrap();
    let [pod] = &page.items[..] else {
        panic!("one pod, not {}", page.items.len());
    };
    assert_eq!(&*pod.meta.name, "p1");
    assert_eq!(pod.meta.namespace.as_deref(), Some("probe"));
    let json: serde_json::Value = serde_json::from_str(pod.json.get()).unwrap();
    assert_eq!(json["spec"]["nodeName"], "kwok-node-0");
    assert_eq!(
        (&json["kind"], &json["apiVersion"]),
        (&"Pod".into(), &"v1".into())
    );
    assert!(
        json["metadata"]["managedFields"].is_array(),
        "managedFields stay in Rust"
    );
    let columns = decoder.columns().expect("the server's columns");
    let names: Vec<&str> = columns.iter().map(|column| &*column.name).collect();
    assert_eq!(
        names,
        [
            "Name",
            "Ready",
            "Status",
            "Restarts",
            "Age",
            "IP",
            "Node",
            "Nominated Node",
            "Readiness Gates"
        ]
    );
    assert_eq!(pod.cells.len(), columns.len());
    assert_eq!(pod.cells[0], Cell::Text("p1".into()));
    assert_eq!(columns[4].kind, ColumnKind::Age);
    assert_eq!(pod.cells[4], Cell::Age);
    assert_eq!(pod.cells[6], Cell::Text("kwok-node-0".into()));
}

#[test]
fn a_table_watch_follows_edits_with_the_columns_of_its_first_event() {
    let mut decoder = ObjectDecoder::new();
    let events: Vec<Event<_>> = include_str!("fixtures/pod-object-table-watch.jsonl")
        .lines()
        .map(|line| decoder.decode_event(line.as_bytes()).unwrap())
        .collect();
    let summary: Vec<(&str, String)> = events
        .iter()
        .map(|event| match event {
            Event::Upsert(pod) => ("upsert", pod.meta.resource_version.to_string()),
            Event::Delete(pod) => ("delete", pod.meta.resource_version.to_string()),
            Event::Bookmark {
                resource_version,
                initial_events_end,
            } => (
                if *initial_events_end {
                    "initial events end"
                } else {
                    "bookmark"
                },
                resource_version.to_string(),
            ),
            Event::Error(status) => ("error", status.code.to_string()),
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("upsert", "1208".to_owned()),
            ("initial events end", "1211".to_owned()),
            ("upsert", "1214".to_owned()),
            ("upsert", "1217".to_owned()),
            ("upsert", "1218".to_owned()),
            ("delete", "1219".to_owned()),
            ("bookmark", "1219".to_owned()),
            ("bookmark", "1219".to_owned()),
        ]
    );
    let Event::Upsert(labelled) = &events[2] else {
        unreachable!()
    };
    let json: serde_json::Value = serde_json::from_str(labelled.json.get()).unwrap();
    assert_eq!(json["metadata"]["labels"]["touched"], "yes");
    assert_eq!(
        labelled.cells.len(),
        9,
        "typed by the columns of the first event"
    );
}

#[test]
fn a_raw_list_keeps_the_whole_object_under_the_metadata_columns() {
    let mut decoder = ObjectDecoder::new();
    let page = decoder
        .decode_list(include_bytes!("fixtures/pod-object-list.json"))
        .unwrap();
    assert_eq!(page.resource_version.as_ref(), "1008");
    let [pod] = &page.items[..] else {
        panic!("one pod, not {}", page.items.len());
    };
    assert_eq!(&*pod.meta.name, "p1");
    assert_eq!(pod.meta.namespace.as_deref(), Some("probe"));
    let json: serde_json::Value = serde_json::from_str(pod.json.get()).unwrap();
    assert_eq!(json["spec"]["nodeName"], "kwok-node-0");
    assert_eq!(
        (&json["kind"], &json["apiVersion"]),
        (&"Pod".into(), &"v1".into()),
        "the list's, as a watch's objects carry their own"
    );
    #[derive(serde::Deserialize)]
    struct Items<'a> {
        #[serde(borrow)]
        items: Vec<&'a serde_json::value::RawValue>,
    }
    let fixture = include_str!("fixtures/pod-object-list.json");
    let items: Items<'_> = serde_json::from_str(fixture).unwrap();
    let item = items.items[0].get();
    assert_eq!(
        pod.json.get(),
        format!(r#"{{"kind":"Pod","apiVersion":"v1",{}"#, &item[1..]),
        "first, as in a watch, and the item's own bytes after"
    );
    assert!(
        json["metadata"]["managedFields"].is_array(),
        "managedFields stay in Rust"
    );
    let names: Vec<&str> = decoder
        .columns()
        .expect("metadata columns")
        .iter()
        .map(|column| &*column.name)
        .collect();
    assert_eq!(names, ["Name", "Age"]);
    assert_eq!(&*pod.cells, [Cell::Text("p1".into()), Cell::Age]);
}

#[test]
fn a_raw_watch_follows_its_edits_and_its_deletion() {
    let mut decoder = ObjectDecoder::new();
    let events: Vec<Event<_>> = include_str!("fixtures/pod-object-watch.jsonl")
        .lines()
        .map(|line| decoder.decode_event(line.as_bytes()).unwrap())
        .collect();
    let summary: Vec<(&str, String)> = events
        .iter()
        .map(|event| match event {
            Event::Upsert(pod) => ("upsert", pod.meta.resource_version.to_string()),
            Event::Delete(pod) => ("delete", pod.meta.resource_version.to_string()),
            Event::Bookmark {
                resource_version, ..
            } => ("bookmark", resource_version.to_string()),
            Event::Error(status) => ("error", status.code.to_string()),
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("upsert", "1010".to_owned()),
            ("upsert", "1011".to_owned()),
            ("delete", "1012".to_owned()),
            ("bookmark", "1012".to_owned()),
        ]
    );
    let Event::Upsert(labelled) = &events[0] else {
        unreachable!()
    };
    let json: serde_json::Value = serde_json::from_str(labelled.json.get()).unwrap();
    assert_eq!(json["metadata"]["labels"]["touched"], "yes");
}
