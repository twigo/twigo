use twigo_cache::table::{Cell, Column, ColumnKind, DecodeError, Event, Row, TableDecoder};

fn lines(fixture: &str) -> impl Iterator<Item = &[u8]> {
    fixture.lines().map(str::as_bytes)
}

fn names(columns: &[Column]) -> Vec<&str> {
    columns.iter().map(|column| &*column.name).collect()
}

fn upsert(event: Event) -> Row {
    match event {
        Event::Upsert(row) => row,
        other => panic!("expected an upsert, got {other:?}"),
    }
}

#[test]
fn pod_list_keeps_typed_columns_and_metadata() {
    let mut decoder = TableDecoder::new();
    let page = decoder
        .decode_list(include_bytes!("fixtures/pods-list.json"))
        .unwrap();

    let columns = decoder.columns().unwrap();
    assert_eq!(
        names(columns),
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
    assert_eq!(columns[0].format.as_ref(), "name");
    assert_eq!(columns[4].kind, ColumnKind::Age);
    let priorities: Vec<i32> = columns.iter().map(|column| column.priority).collect();
    assert_eq!(priorities, [0, 0, 0, 0, 0, 1, 1, 1, 1]);

    assert_eq!(page.resource_version.as_ref(), "946");
    assert_eq!(page.continue_token, None);
    assert_eq!(page.rows.len(), 2);
    let row = &page.rows[0];
    assert_eq!(row.meta.name.as_ref(), "p1");
    assert_eq!(row.meta.namespace.as_deref(), Some("probe"));
    assert_eq!(row.meta.uid.len(), 36);
    assert_eq!(
        row.meta.labels.as_ref(),
        [("app".into(), "probe".into())] as [(Box<str>, Box<str>); 1]
    );
    assert!(row.meta.created.is_some());
    assert_eq!(row.cells[0], Cell::Text("p1".into()));
    assert_eq!(row.cells[3], Cell::Text("0".into()));
    assert_eq!(row.cells[4], Cell::Age);
}

#[test]
fn watch_columns_come_once_per_connection() {
    let fixture = include_str!("fixtures/pods-watch.jsonl");
    assert!(
        fixture
            .lines()
            .next()
            .unwrap()
            .contains("\"columnDefinitions\":[{")
    );
    assert!(
        fixture
            .lines()
            .skip(1)
            .all(|line| line.contains("\"columnDefinitions\":null"))
    );

    let mut decoder = TableDecoder::new();
    let events: Vec<Event> = lines(fixture)
        .map(|line| decoder.decode_event(line).unwrap())
        .collect();
    assert_eq!(decoder.columns().unwrap().len(), 9);

    let summary: Vec<(&str, &str)> = events
        .iter()
        .map(|event| match event {
            Event::Upsert(row) => ("upsert", &*row.meta.name),
            Event::Delete(row) => ("delete", &*row.meta.name),
            Event::Bookmark {
                resource_version, ..
            } => ("bookmark", &**resource_version),
            Event::Error(_) => ("error", ""),
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("upsert", "p1"),
            ("upsert", "p3"),
            ("upsert", "p3"),
            ("upsert", "p2"),
            ("upsert", "p2"),
            ("delete", "p2"),
            ("bookmark", "976"),
        ]
    );
}

#[test]
fn a_reconnect_reuses_the_columns_it_already_has() {
    let fixture = include_str!("fixtures/pods-watch.jsonl");
    let mut decoder = TableDecoder::new();
    decoder
        .decode_event(lines(fixture).next().unwrap())
        .unwrap();
    let columns = decoder.columns().unwrap().clone();

    let headless = lines(fixture).nth(1).unwrap();
    let row = upsert(decoder.decode_event(headless).unwrap());
    assert_eq!(row.cells.len(), columns.len());

    assert!(matches!(
        TableDecoder::new().decode_event(headless),
        Err(DecodeError::NoColumns)
    ));
}

#[test]
fn identical_columns_keep_the_same_allocation() {
    let mut decoder = TableDecoder::new();
    decoder
        .decode_list(include_bytes!("fixtures/pods-list.json"))
        .unwrap();
    let before = decoder.columns().unwrap().clone();
    let first_event = include_str!("fixtures/pods-watch.jsonl")
        .lines()
        .next()
        .unwrap();
    decoder.decode_event(first_event.as_bytes()).unwrap();
    assert!(std::sync::Arc::ptr_eq(&before, decoder.columns().unwrap()));
}

#[test]
fn a_bookmark_can_be_the_event_that_carries_the_columns() {
    let mut decoder = TableDecoder::new();
    let event = decoder
        .decode_event(include_bytes!("fixtures/pods-watch-bookmark-first.jsonl").trim_ascii())
        .unwrap();
    assert_eq!(
        event,
        Event::Bookmark {
            resource_version: "1117".into(),
            initial_events_end: false
        }
    );
    assert_eq!(decoder.columns().unwrap().len(), 9);
}

#[test]
fn a_streaming_list_ends_with_an_annotated_bookmark() {
    let mut decoder = TableDecoder::new();
    let events: Vec<Event> = lines(include_str!("fixtures/pods-watch-initial-events.jsonl"))
        .map(|line| decoder.decode_event(line).unwrap())
        .collect();
    assert_eq!(events.len(), 3);
    assert!(matches!(&events[0], Event::Upsert(row) if &*row.meta.name == "p1"));
    assert!(matches!(&events[1], Event::Upsert(row) if &*row.meta.name == "p3"));
    assert_eq!(
        events[2],
        Event::Bookmark {
            resource_version: "1019".into(),
            initial_events_end: true
        }
    );
}

#[test]
fn crd_printer_columns_decode_by_json_type() {
    let mut decoder = TableDecoder::new();
    let page = decoder
        .decode_list(include_bytes!("fixtures/widgets-list.json"))
        .unwrap();
    let columns = decoder.columns().unwrap();
    let kinds: Vec<ColumnKind> = columns.iter().map(|column| column.kind).collect();
    assert_eq!(
        kinds,
        [
            ColumnKind::String,
            ColumnKind::String,
            ColumnKind::Integer,
            ColumnKind::Number,
            ColumnKind::Boolean,
            ColumnKind::Date,
            ColumnKind::Age,
        ]
    );
    assert_eq!(columns[3].priority, 1);

    let full = page
        .rows
        .iter()
        .find(|row| &*row.meta.name == "full")
        .unwrap();
    assert_eq!(
        full.cells.as_ref(),
        [
            Cell::Text("full".into()),
            Cell::Text("large".into()),
            Cell::Int(3),
            Cell::Number(0.5),
            Cell::Bool(true),
            Cell::Text("303d".into()),
            Cell::Age,
        ]
    );
    let empty = page
        .rows
        .iter()
        .find(|row| &*row.meta.name == "empty")
        .unwrap();
    assert!(empty.cells[1..6].iter().all(|cell| *cell == Cell::Null));
}

#[test]
fn a_raw_object_falls_back_to_name_and_age() {
    let mut decoder = TableDecoder::new();
    decoder
        .decode_list(include_bytes!("fixtures/pods-list.json"))
        .unwrap();
    let row = upsert(
        decoder
            .decode_event(include_bytes!("fixtures/pods-watch-raw-object.jsonl").trim_ascii())
            .unwrap(),
    );
    assert_eq!(row.meta.name.as_ref(), "p1");
    assert_eq!(row.cells.len(), 9);
    assert_eq!(row.cells[0], Cell::Text("p1".into()));
    assert_eq!(row.cells[4], Cell::Age);
    assert!(row.cells[1..4].iter().all(|cell| *cell == Cell::Null));
}

#[test]
fn an_api_without_table_gets_metadata_columns() {
    let mut decoder = TableDecoder::new();
    let page = decoder
        .decode_list(include_bytes!("fixtures/metrics-list.json"))
        .unwrap();
    assert_eq!(names(decoder.columns().unwrap()), ["Name", "Age"]);
    assert_eq!(page.resource_version.as_ref(), "7");
    assert_eq!(page.rows.len(), 2);
    assert_eq!(
        page.rows[0].cells.as_ref(),
        [Cell::Text("p1".into()), Cell::Age]
    );

    let events: Vec<Event> = lines(include_str!("fixtures/metrics-watch.jsonl"))
        .map(|line| decoder.decode_event(line).unwrap())
        .collect();
    assert!(matches!(&events[0], Event::Upsert(row) if &*row.meta.resource_version == "8"));
    assert_eq!(
        events[1],
        Event::Bookmark {
            resource_version: "9".into(),
            initial_events_end: false
        }
    );
}

#[test]
fn server_columns_replace_the_metadata_fallback() {
    let mut decoder = TableDecoder::new();
    decoder
        .decode_event(
            include_bytes!("fixtures/metrics-watch.jsonl")
                .split(|b| *b == b'\n')
                .next()
                .unwrap(),
        )
        .unwrap();
    assert_eq!(decoder.columns().unwrap().len(), 2);
    decoder
        .decode_list(include_bytes!("fixtures/pods-list.json"))
        .unwrap();
    assert_eq!(decoder.columns().unwrap().len(), 9);
}

#[test]
fn an_error_event_carries_the_status() {
    let event = TableDecoder::new()
        .decode_event(include_bytes!("fixtures/watch-gone.jsonl").trim_ascii())
        .unwrap();
    let Event::Error(status) = event else {
        panic!("expected an error event, got {event:?}");
    };
    assert_eq!(status.code, 410);
    assert_eq!(status.reason.as_ref(), "Expired");
}
