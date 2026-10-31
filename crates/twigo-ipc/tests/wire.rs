use serde_json::{Value, json};
use twigo_ipc::{
    Cell, ErrorKind, Gvr, IpcError, ListQuery, RowId, Sort, SubscriptionId, ViewState,
};

fn wire<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serialize")
}

#[test]
fn view_states_are_tagged_by_state() {
    assert_eq!(
        wire(&ViewState::Syncing { loaded: 3 }),
        json!({"state": "syncing", "loaded": 3})
    );
    assert_eq!(
        wire(&ViewState::Error {
            error: IpcError {
                kind: ErrorKind::Unavailable,
                message: "refused".into(),
            },
        }),
        json!({"state": "error", "error": {"kind": "unavailable", "message": "refused"}})
    );
    assert_eq!(wire(&ViewState::Ready), json!({"state": "ready"}));
}

#[test]
fn cells_are_bare_json_values_and_read_back_as_the_same_variant() {
    let cells = vec![
        Cell::Null,
        Cell::Bool(true),
        Cell::Int(1),
        Cell::Number(1.5),
        Cell::Text("1/2".into()),
    ];
    let json = wire(&cells);
    assert_eq!(json, json!([null, true, 1, 1.5, "1/2"]));
    assert_eq!(
        serde_json::from_value::<Vec<Cell>>(json).expect("deserialize"),
        cells
    );
}

#[test]
fn queries_use_camel_case_and_newtypes_are_bare() {
    let query = ListQuery {
        space: "prod".into(),
        gvr: Gvr {
            group: String::new(),
            version: "v1".into(),
            resource: "pods".into(),
        },
        namespaces: vec![],
        label_selector: Some("app=api".into()),
        text: None,
        sort: Some(Sort {
            column: "Age".into(),
            descending: true,
        }),
    };
    assert_eq!(wire(&query)["labelSelector"], json!("app=api"));
    assert_eq!(wire(&SubscriptionId(7)), json!(7));
    assert_eq!(
        wire(&RowId("prod/default/api".into())),
        json!("prod/default/api")
    );
}
