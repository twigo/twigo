use std::collections::BTreeMap;

use serde_json::{Value, json};
use twigo_ipc::{
    BlockReason, Blocked, Cell, ColumnValues, ContextAccess, Environment, ErrorCode, ErrorKind,
    Grouping, Gvr, IpcError, ListQuery, Lock, LockSource, Mode, ModeSource, Part, PartState, Parts,
    RequestClass, RowId, ServerCause, ServerStatus, Sort, SubscriptionId, ViewState,
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
            error: IpcError::new(ErrorCode::ConnectRefused, "refused"),
        }),
        json!({
            "state": "error",
            "error": {"code": "connect.refused", "kind": "unavailable", "message": "refused"},
        })
    );
    assert_eq!(wire(&ViewState::Ready), json!({"state": "ready"}));
}

#[test]
fn a_waiting_state_names_its_cause_only_when_it_has_one() {
    assert_eq!(
        wire(&ViewState::Connecting { cause: None }),
        json!({"state": "connecting"})
    );
    let cause = IpcError::new(ErrorCode::ConnectRefused, "refused");
    let stale = ViewState::Stale {
        cause: Some(cause.clone()),
    };
    assert_eq!(
        wire(&stale),
        json!({"state": "stale", "cause": wire(&cause)})
    );
    assert_eq!(
        serde_json::from_value::<ViewState>(json!({"state": "stale"})).unwrap(),
        ViewState::Stale { cause: None }
    );
}

#[test]
fn parts_are_tagged_by_kind() {
    let parts = Parts {
        count: 22,
        omitted: 0,
        unready: vec![PartState {
            part: Part::Namespace {
                name: "team-b".into(),
            },
            state: ViewState::Forbidden {
                verb: "watch".into(),
                resource: "pods".into(),
            },
            shown: false,
        }],
    };
    assert_eq!(
        wire(&parts),
        json!({"count": 22, "omitted": 0, "unready": [{
            "part": {"kind": "namespace", "name": "team-b"},
            "state": {"state": "forbidden", "verb": "watch", "resource": "pods"},
            "shown": false,
        }]})
    );
    assert_eq!(wire(&Part::Cluster), json!({"kind": "cluster"}));
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
        namespaced: true,
        namespaces: vec![],
        label_selector: Some("app=api".into()),
        field_selector: Some("spec.nodeName=node-1".into()),
        owners: Some(vec!["5c2f".into()]),
        text: None,
        columns: Some(BTreeMap::from([
            ("IP".into(), true),
            ("Namespace".into(), false),
        ])),
        sort: Some(Sort {
            column: "Age".into(),
            descending: true,
        }),
        count_by: Some("Status".into()),
        group_by: Some(Grouping {
            column: "Namespace".into(),
            collapsed: vec!["kube-system".into()],
        }),
        values: Some(ColumnValues {
            column: "Status".into(),
            values: vec!["Error".into()],
        }),
    };
    assert_eq!(wire(&query)["namespaced"], json!(true));
    assert_eq!(wire(&query)["labelSelector"], json!("app=api"));
    assert_eq!(wire(&query)["fieldSelector"], json!("spec.nodeName=node-1"));
    assert_eq!(wire(&query)["owners"], json!(["5c2f"]));
    assert_eq!(wire(&query)["countBy"], json!("Status"));
    assert_eq!(
        wire(&query)["groupBy"],
        json!({ "column": "Namespace", "collapsed": ["kube-system"] })
    );
    assert_eq!(
        wire(&query)["columns"],
        json!({ "IP": true, "Namespace": false })
    );
    assert_eq!(
        wire(&query)["values"],
        json!({ "column": "Status", "values": ["Error"] })
    );
    assert_eq!(wire(&SubscriptionId(7)), json!(7));
    assert_eq!(
        wire(&RowId("prod/default/api".into())),
        json!("prod/default/api")
    );
}

#[test]
fn modes_read_as_people_name_them() {
    assert_eq!(wire(&Mode::ReadWrite), json!("read-write"));
    assert_eq!(wire(&Mode::Guarded), json!("guarded"));
    assert_eq!(wire(&Mode::ReadOnly), json!("read-only"));
    assert!(Mode::ReadWrite < Mode::Guarded && Mode::Guarded < Mode::ReadOnly);
}

#[test]
fn a_context_s_access_says_where_its_mode_comes_from() {
    assert_eq!(
        wire(&ContextAccess {
            mode: Mode::Guarded,
            source: ModeSource::PolicyFile {
                file: "/etc/twigo/policy.json".to_owned(),
                pattern: Some("prod-*".to_owned()),
            },
            environment: Some(Environment::Production),
            unlocked_until: Some(1000),
        }),
        json!({
            "mode": "guarded",
            "source": {
                "kind": "policyFile",
                "file": "/etc/twigo/policy.json",
                "pattern": "prod-*",
            },
            "environment": "production",
            "unlockedUntil": 1000,
        })
    );
    assert_eq!(
        wire(&ModeSource::Environment {
            environment: Environment::Staging
        }),
        json!({"kind": "environment", "environment": "staging"})
    );
    assert_eq!(wire(&ModeSource::Unmarked), json!({"kind": "unmarked"}));
    assert_eq!(
        wire(&ModeSource::User {
            overrides: Some(Lock {
                mode: Mode::ReadOnly,
                source: LockSource::Kubeconfig,
            }),
        }),
        json!({
            "kind": "user",
            "overrides": {"mode": "read-only", "source": {"kind": "kubeconfig"}},
        })
    );
}

#[test]
fn only_a_blocked_request_s_error_carries_its_rule() {
    assert_eq!(
        wire(&IpcError::new(ErrorCode::ServerForbidden, "no")),
        json!({"code": "server.forbidden", "kind": "forbidden", "message": "no"})
    );
    let blocked = Blocked {
        context: "prod-eu".to_owned(),
        mode: Mode::ReadOnly,
        source: ModeSource::User { overrides: None },
        class: RequestClass::DryRun,
        reason: BlockReason::Mode,
        verb: "create".to_owned(),
        target: "configmaps in a".to_owned(),
    };
    let error = IpcError::from(blocked);
    assert_eq!(
        wire(&error),
        json!({
            "code": "policy.blocked",
            "kind": "permissions",
            "message": "prod-eu is read-only by your choice, so Twigo did not send create configmaps in a",
            "blocked": {
                "context": "prod-eu",
                "mode": "read-only",
                "source": {"kind": "user", "overrides": null},
                "class": "dryRun",
                "reason": "mode",
                "verb": "create",
                "target": "configmaps in a",
            },
        })
    );
    let read: IpcError = serde_json::from_value(wire(&error)).unwrap();
    assert_eq!(read, error);
    let plain: IpcError = serde_json::from_value(
        json!({"code": "server.timeout", "kind": "timeout", "message": "late"}),
    )
    .unwrap();
    assert_eq!(plain.blocked, None);
    assert_eq!(plain.server, None);
}

#[test]
fn the_servers_status_travels_as_data_beside_the_code() {
    let status = ServerStatus {
        reason: "Invalid".to_owned(),
        causes: vec![ServerCause {
            reason: "FieldValueInvalid".to_owned(),
            field: "spec.replicas".to_owned(),
            message: "must be non-negative".to_owned(),
        }],
    };
    let error = IpcError::new(ErrorCode::ServerInvalid, "invalid").with_server(status);
    assert_eq!(
        wire(&error),
        json!({
            "code": "server.invalid",
            "kind": "invalidInput",
            "message": "invalid",
            "server": {
                "reason": "Invalid",
                "causes": [{
                    "reason": "FieldValueInvalid",
                    "field": "spec.replicas",
                    "message": "must be non-negative",
                }],
            },
        })
    );
    let read: IpcError = serde_json::from_value(wire(&error)).unwrap();
    assert_eq!(read, error);
}

#[test]
fn a_refused_state_says_its_words_as_an_error_and_the_others_say_none() {
    let forbidden = ViewState::Forbidden {
        verb: "watch".into(),
        resource: "pods".into(),
    };
    let refused = forbidden.refusal().unwrap();
    assert_eq!(refused.code, ErrorCode::ServerForbidden);
    assert_eq!(refused.kind, ErrorKind::Forbidden);
    assert_eq!(refused.message, "You may not watch pods.");
    assert_eq!(
        ViewState::Unauthorized.refusal().unwrap().code,
        ErrorCode::ServerUnauthorized
    );
    let failed = IpcError::new(ErrorCode::InternalPanic, "broken");
    let error = ViewState::Error {
        error: failed.clone(),
    };
    assert_eq!(error.refusal(), Some(failed));
    assert_eq!(ViewState::Stale { cause: None }.refusal(), None);
}
