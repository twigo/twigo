use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{ErrorKind, Execute, Friction, Mode, OperationEvent, PlanId, SetContextMode};
use twigo_policy::Attributes;
use twigo_policy::friction::Risk;

use super::{Finished, Planned, Progress};
use crate::Core;

const KUBECONFIG: &str = "
clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]
users: [{ name: u, user: {} }]
contexts:
- name: kind-a
  context: { cluster: c, user: u }
";

fn running(dir: &Path) -> Arc<Core> {
    running_with(dir, KUBECONFIG)
}

fn running_with(dir: &Path, text: &str) -> Arc<Core> {
    let kubeconfig = dir.join("config");
    std::fs::write(&kubeconfig, text).unwrap();
    let core = Core::new(dir, &dir.join("cache"), &dir.join("policy.json"));
    let (_status, followed) = watch::channel(Status::Resolved(Arc::new(ShellEnv::from_iter([]))));
    tokio::spawn({
        let core = Arc::clone(&core);
        async move { core.run(followed, Some(kubeconfig)).await }
    });
    core
}

/// How many times the plan's run ran.
type Runs = Arc<Mutex<u32>>;

fn planned(core: &Core, risk: Risk, runs: &Runs) -> Planned {
    let runs = Arc::clone(runs);
    Planned {
        context: "kind-a".to_owned(),
        connection: core.policy.connection("kind-a"),
        space: Some("kind-a".to_owned()),
        risk,
        writes: vec![Attributes::action(
            "delete",
            "configmaps",
            None,
            Some("a"),
            Some("m"),
        )],
        command: "delete",
        target: "configmaps/m in a".to_owned(),
        question: "Delete config map m in a from kind-a?".to_owned(),
        confirm: "Delete config map".to_owned(),
        destructive: true,
        consequences: Vec::new(),
        affected: Vec::new(),
        kubectl: "kubectl --context kind-a delete configmaps m -n a".to_owned(),
        doing: "Deleting config map m".to_owned(),
        run: Box::new(move |progress: Progress| {
            Box::pin(async move {
                *runs.lock().unwrap() += 1;
                progress.running("Waiting for config map m to go");
                progress.stopped().await;
                Ok(Finished::Stopped("stopped".to_owned()))
            })
        }),
    }
}

async fn new_plan(core: &Core, window: &str, risk: Risk, runs: &Runs) -> twigo_ipc::Plan {
    core.catalog.contexts().await;
    let ticket = core.bus.ticket(window);
    let access = core.policy.access("kind-a");
    core.bus
        .keep(ticket, planned(core, risk, runs), &access)
        .unwrap()
}

/// The events a run sends.
fn events() -> (
    Arc<Mutex<Vec<OperationEvent>>>,
    impl FnMut(OperationEvent) -> bool + Send + 'static,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sent = Arc::clone(&events);
    (events, move |event| {
        sent.lock().unwrap().push(event);
        true
    })
}

async fn execute(
    core: &Core,
    window: &str,
    plan: PlanId,
    typed: Option<&str>,
) -> Result<(), ErrorKind> {
    let (_, send) = events();
    let request = Execute {
        plan,
        typed: typed.map(str::to_owned),
    };
    core.command_execute(window, request, send)
        .await
        .map_err(|error| error.kind)
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    let waited = tokio::time::timeout(Duration::from_secs(5), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    assert!(waited.await.is_ok(), "{what}");
}

#[tokio::test]
async fn a_plan_runs_once_and_only_from_its_own_window() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    let plan = new_plan(&core, "main", Risk::Lasting, &runs).await;
    assert_eq!(plan.friction, Friction::Confirm);

    assert_eq!(
        execute(&core, "other", plan.id, None).await,
        Err(ErrorKind::NotFound)
    );
    execute(&core, "main", plan.id, None).await.unwrap();
    assert_eq!(
        execute(&core, "main", plan.id, None).await,
        Err(ErrorKind::NotFound)
    );
    until("the run starts", || *runs.lock().unwrap() == 1).await;
    core.command_cancel("main", plan.id);
}

#[tokio::test]
async fn a_typed_friction_runs_only_with_its_name_typed() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    let wide = || Risk::Wide {
        name: "payments".to_owned(),
    };
    let plan = new_plan(&core, "main", wide(), &runs).await;
    assert_eq!(
        plan.friction,
        Friction::Typed {
            text: "payments".to_owned()
        }
    );
    assert_eq!(
        execute(&core, "main", plan.id, None).await,
        Err(ErrorKind::InvalidInput)
    );
    assert_eq!(
        execute(&core, "main", plan.id, Some("payments")).await,
        Err(ErrorKind::NotFound),
        "a refused plan is spent"
    );
    let plan = new_plan(&core, "main", wide(), &runs).await;
    assert_eq!(
        execute(&core, "main", plan.id, Some("Payments")).await,
        Err(ErrorKind::InvalidInput)
    );
    let plan = new_plan(&core, "main", wide(), &runs).await;
    execute(&core, "main", plan.id, Some("payments"))
        .await
        .unwrap();
    until("the run starts", || *runs.lock().unwrap() == 1).await;
    core.command_cancel("main", plan.id);
}

#[tokio::test]
async fn a_countdown_runs_only_once_it_has_ended_and_a_cancel_drops_it() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    core.catalog.contexts().await;
    tokio::time::pause();
    let plan = new_plan(&core, "main", Risk::Replaced, &runs).await;
    assert_eq!(plan.friction, Friction::Countdown { seconds: 5 });
    tokio::time::advance(Duration::from_millis(4_900)).await;
    assert_eq!(
        execute(&core, "main", plan.id, None).await,
        Err(ErrorKind::InvalidInput)
    );

    let cancelled = new_plan(&core, "main", Risk::Replaced, &runs).await;
    tokio::time::advance(Duration::from_secs(5)).await;
    core.command_cancel("main", cancelled.id);
    assert_eq!(
        execute(&core, "main", cancelled.id, None).await,
        Err(ErrorKind::NotFound)
    );

    let ended = new_plan(&core, "main", Risk::Replaced, &runs).await;
    tokio::time::advance(Duration::from_secs(5)).await;
    execute(&core, "main", ended.id, None).await.unwrap();
    tokio::time::resume();
    until("the run starts", || *runs.lock().unwrap() == 1).await;
    core.command_cancel("main", ended.id);
}

#[tokio::test]
async fn a_mode_that_asks_for_more_than_the_plan_did_refuses_it() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    let plan = new_plan(&core, "main", Risk::Lasting, &runs).await;
    core.set_context_mode(SetContextMode {
        context: "kind-a".to_owned(),
        mode: Some(Mode::Guarded),
    })
    .await
    .unwrap();
    assert_eq!(
        execute(&core, "main", plan.id, None).await,
        Err(ErrorKind::Conflict)
    );

    let typed = new_plan(&core, "main", Risk::Lasting, &runs).await;
    assert_eq!(
        typed.friction,
        Friction::Typed {
            text: "kind-a".to_owned()
        }
    );
    core.set_context_mode(SetContextMode {
        context: "kind-a".to_owned(),
        mode: Some(Mode::ReadOnly),
    })
    .await
    .unwrap();
    let blocked = core
        .command_execute(
            "main",
            Execute {
                plan: typed.id,
                typed: Some("kind-a".to_owned()),
            },
            events().1,
        )
        .await
        .unwrap_err();
    assert_eq!(blocked.kind, ErrorKind::Permissions);
    assert_eq!(blocked.blocked.unwrap().mode, Mode::ReadOnly);
    assert_eq!(*runs.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_plan_never_runs_on_another_cluster_its_context_names_now() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    let plan = new_plan(&core, "main", Risk::Lasting, &runs).await;
    let mut contexts = core.catalog.subscribe();
    contexts.borrow_and_update();
    std::fs::write(
        dir.path().join("config"),
        KUBECONFIG.replace("127.0.0.1:1", "127.0.0.1:2"),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), contexts.changed())
        .await
        .expect("the catalog reads the new server")
        .unwrap();
    assert_eq!(
        execute(&core, "main", plan.id, None).await,
        Err(ErrorKind::Conflict)
    );
    assert_eq!(*runs.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_reload_drops_the_window_s_plans_and_stops_its_runs() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    let waiting = new_plan(&core, "main", Risk::Lasting, &runs).await;
    let started = new_plan(&core, "main", Risk::Lasting, &runs).await;
    let (events, send) = events();
    core.command_execute(
        "main",
        Execute {
            plan: started.id,
            typed: None,
        },
        send,
    )
    .await
    .unwrap();
    until("the run starts", || *runs.lock().unwrap() == 1).await;

    core.drop_window("main");
    until("the run stops", || {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, OperationEvent::Stopped { .. }))
    })
    .await;
    assert_eq!(
        *events.lock().unwrap(),
        [
            OperationEvent::Running {
                text: "Waiting for config map m to go".to_owned()
            },
            OperationEvent::Stopped {
                text: "stopped".to_owned()
            },
        ]
    );
    assert_eq!(
        execute(&core, "main", waiting.id, None).await,
        Err(ErrorKind::NotFound)
    );
}

#[tokio::test]
async fn the_audit_log_has_what_a_person_confirmed_and_how_it_ended() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    let plan = new_plan(&core, "main", Risk::Lasting, &runs).await;
    execute(&core, "main", plan.id, None).await.unwrap();
    until("the run starts", || *runs.lock().unwrap() == 1).await;
    core.command_cancel("main", plan.id);

    let path = dir.path().join("audit.jsonl");
    until("the run's end is logged", || {
        std::fs::read_to_string(&path).is_ok_and(|text| text.lines().count() == 2)
    })
    .await;
    let text = std::fs::read_to_string(&path).unwrap();
    let lines: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines[0]["event"], "confirmed");
    assert_eq!(lines[0]["command"], "delete");
    assert_eq!(lines[0]["target"], "configmaps/m in a");
    assert_eq!(
        lines[0]["friction"],
        serde_json::json!({ "kind": "confirm" })
    );
    assert_eq!(lines[1]["event"], "ended");
    assert_eq!(lines[1]["outcome"], "stopped");
}

#[tokio::test]
async fn a_plan_asked_for_by_a_page_that_reloaded_is_not_kept() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    core.catalog.contexts().await;
    let ticket = core.bus.ticket("main");
    core.drop_window("main");
    let access = core.policy.access("kind-a");
    let refused = core
        .bus
        .keep(ticket, planned(&core, Risk::Lasting, &runs), &access)
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Unavailable);
}

#[tokio::test]
async fn a_plan_taken_before_its_page_reloaded_does_not_run() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    let plan = new_plan(&core, "main", Risk::Lasting, &runs).await;
    let (_, ticket) = core.bus.take("main", plan.id).unwrap();
    core.drop_window("main");
    let (_, stop) = Progress::new(|_| true);
    let refused = core.bus.run(ticket, plan.id, stop).unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Unavailable);
}

/// An API server on loopback that holds each GET until released and notes
/// every request line it gets.
struct Held {
    port: u16,
    release: Arc<tokio::sync::Notify>,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Held {
    async fn start() -> Self {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let release = Arc::new(tokio::sync::Notify::new());
        let seen = Arc::new(Mutex::new(Vec::new()));
        tokio::spawn({
            let (release, seen) = (Arc::clone(&release), Arc::clone(&seen));
            async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let (release, seen) = (Arc::clone(&release), Arc::clone(&seen));
                    tokio::spawn(async move {
                        let mut read = Vec::new();
                        let mut buffer = [0; 4096];
                        while !read.windows(4).any(|window| window == b"\r\n\r\n") {
                            let n = socket.read(&mut buffer).await.unwrap();
                            if n == 0 {
                                return;
                            }
                            read.extend_from_slice(&buffer[..n]);
                        }
                        let line = String::from_utf8_lossy(&read)
                            .lines()
                            .next()
                            .unwrap_or_default()
                            .to_owned();
                        let get = line.starts_with("GET ");
                        seen.lock().unwrap().push(line);
                        if get {
                            release.notified().await;
                        }
                        let body = r#"{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"m","namespace":"a","uid":"u-1"}}"#;
                        let answer = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        socket.write_all(answer.as_bytes()).await.unwrap();
                    });
                }
            }
        });
        Held {
            port,
            release,
            seen,
        }
    }
}

#[tokio::test]
async fn a_plan_whose_read_waited_across_an_edit_of_its_context_never_runs() {
    let dir = tempfile::tempdir().unwrap();
    let server = Held::start().await;
    let kubeconfig = KUBECONFIG.replace("127.0.0.1:1", &format!("127.0.0.1:{}", server.port));
    let core = running(dir.path());
    std::fs::write(dir.path().join("config"), &kubeconfig).unwrap();
    let mut contexts = core.catalog.subscribe();
    tokio::time::timeout(
        Duration::from_secs(5),
        contexts.wait_for(|listed| {
            listed
                .as_ref()
                .is_some_and(|listed| listed.iter().any(|c| c.name == "kind-a"))
        }),
    )
    .await
    .unwrap()
    .unwrap();
    let space = core.state.open_space("kind-a").id;
    let planning = tokio::spawn({
        let core = Arc::clone(&core);
        async move {
            let target = twigo_ipc::ResourceRef {
                gvr: twigo_ipc::Gvr {
                    group: String::new(),
                    version: "v1".to_owned(),
                    resource: "configmaps".to_owned(),
                },
                namespaced: true,
                namespace: Some("a".to_owned()),
                name: "m".to_owned(),
            };
            let request = twigo_ipc::PlanRequest::Delete {
                space,
                targets: vec![target],
            };
            core.command_plan("main", request).await
        }
    });
    until("the plan's read reaches the server", || {
        !server.seen.lock().unwrap().is_empty()
    })
    .await;

    // The same server, but what the kubeconfig says of the context changed,
    // as when it is pointed elsewhere: its clients are rebuilt.
    contexts.borrow_and_update();
    std::fs::write(
        dir.path().join("config"),
        kubeconfig.replace(
            "context: { cluster: c, user: u }",
            "context: { cluster: c, user: u, extensions: [{ name: twigo, extension: { readOnly: false } }] }",
        ),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), contexts.changed())
        .await
        .expect("the catalog reads the edit")
        .unwrap();
    server.release.notify_one();
    let plan = planning.await.unwrap().unwrap();

    assert_eq!(
        execute(&core, "main", plan.id, None).await,
        Err(ErrorKind::Conflict)
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    let seen = server.seen.lock().unwrap().clone();
    assert_eq!(seen, ["GET /api/v1/namespaces/a/configmaps/m HTTP/1.1"]);
}

/// A server that answers each request line by `answer`, given how many
/// times that line came before.
struct Scripted {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Scripted {
    async fn start(answer: fn(&str, usize) -> (u16, &'static str)) -> Self {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        tokio::spawn({
            let seen = Arc::clone(&seen);
            async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let seen = Arc::clone(&seen);
                    tokio::spawn(async move {
                        let mut read = Vec::new();
                        let mut buffer = [0; 4096];
                        let end = loop {
                            if let Some(at) = read.windows(4).position(|w| w == b"\r\n\r\n") {
                                break at + 4;
                            }
                            let n = socket.read(&mut buffer).await.unwrap();
                            if n == 0 {
                                return;
                            }
                            read.extend_from_slice(&buffer[..n]);
                        };
                        let head = String::from_utf8_lossy(&read[..end]).into_owned();
                        let length: usize = head
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().ok())?
                            })
                            .unwrap_or(0);
                        while read.len() < end + length {
                            let n = socket.read(&mut buffer).await.unwrap();
                            read.extend_from_slice(&buffer[..n]);
                        }
                        let line = head.lines().next().unwrap_or_default().to_owned();
                        let before = {
                            let mut seen = seen.lock().unwrap();
                            let before = seen.iter().filter(|other| **other == line).count();
                            seen.push(line.clone());
                            before
                        };
                        let (status, body) = answer(&line, before);
                        let answer = format!(
                            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        socket.write_all(answer.as_bytes()).await.unwrap();
                    });
                }
            }
        });
        Scripted { port, seen }
    }
}

#[tokio::test]
async fn a_scale_that_happened_is_done_when_the_read_after_it_fails() {
    const OBJECT: &str = "GET /apis/apps/v1/namespaces/a/deployments/d HTTP/1.1";
    const SCALE: &str = "GET /apis/apps/v1/namespaces/a/deployments/d/scale HTTP/1.1";
    const PATCH: &str = "PATCH /apis/apps/v1/namespaces/a/deployments/d/scale HTTP/1.1";
    let server = Scripted::start(|line, before| match line {
        OBJECT if before == 0 => (
            200,
            r#"{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"d","namespace":"a","uid":"u-1","generation":1}}"#,
        ),
        OBJECT => (
            500,
            r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"etcd is away","code":500}"#,
        ),
        SCALE | PATCH => (
            200,
            r#"{"apiVersion":"autoscaling/v1","kind":"Scale","metadata":{"name":"d","namespace":"a"},"spec":{"replicas":1}}"#,
        ),
        _ => (404, r#"{"kind":"Status","apiVersion":"v1","code":404}"#),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let core = running_with(
        dir.path(),
        &KUBECONFIG.replace("127.0.0.1:1", &format!("127.0.0.1:{}", server.port)),
    );
    core.catalog.contexts().await;
    let space = core.state.open_space("kind-a").id;
    let target = twigo_ipc::ResourceRef {
        gvr: twigo_ipc::Gvr {
            group: "apps".to_owned(),
            version: "v1".to_owned(),
            resource: "deployments".to_owned(),
        },
        namespaced: true,
        namespace: Some("a".to_owned()),
        name: "d".to_owned(),
    };
    let request = twigo_ipc::PlanRequest::Scale {
        space,
        target,
        replicas: 3,
    };
    let plan = core.command_plan("main", request).await.unwrap();
    assert_eq!(plan.friction, Friction::AtOnce);
    let (told, send) = events();
    core.command_execute(
        "main",
        Execute {
            plan: plan.id,
            typed: None,
        },
        send,
    )
    .await
    .unwrap();
    until("the scale ends", || !told.lock().unwrap().is_empty()).await;
    assert_eq!(
        told.lock().unwrap().as_slice(),
        [OperationEvent::Done {
            text: "Scaled deployment d to 3".to_owned(),
            undo_until: None,
        }]
    );
    let seen = server.seen.lock().unwrap().clone();
    assert!(seen.iter().any(|line| line == PATCH), "{seen:?}");
}
