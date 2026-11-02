use twigo_cache::decode::{Decode, Event};
use twigo_cache::object::ObjectDecoder;

#[test]
fn an_object_list_keeps_the_whole_object() {
    let page = ObjectDecoder
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
}

#[test]
fn an_object_watch_follows_its_edits_and_its_deletion() {
    let mut decoder = ObjectDecoder;
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
