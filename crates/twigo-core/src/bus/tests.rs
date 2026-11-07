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
    let kubeconfig = dir.join("config");
    std::fs::write(&kubeconfig, KUBECONFIG).unwrap();
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
        consequences: Vec::new(),
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
    let plan = new_plan(&core, "main", Risk::One, &runs).await;
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
    let plan = new_plan(&core, "main", Risk::One, &runs).await;
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

    let typed = new_plan(&core, "main", Risk::One, &runs).await;
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
    let plan = new_plan(&core, "main", Risk::One, &runs).await;
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
    let waiting = new_plan(&core, "main", Risk::One, &runs).await;
    let started = new_plan(&core, "main", Risk::One, &runs).await;
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
    let plan = new_plan(&core, "main", Risk::One, &runs).await;
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
        .keep(ticket, planned(&core, Risk::One, &runs), &access)
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Unavailable);
}

#[tokio::test]
async fn a_plan_taken_before_its_page_reloaded_does_not_run() {
    let dir = tempfile::tempdir().unwrap();
    let core = running(dir.path());
    let runs = Runs::default();
    let plan = new_plan(&core, "main", Risk::One, &runs).await;
    let (_, ticket) = core.bus.take("main", plan.id).unwrap();
    core.drop_window("main");
    let (_, stop) = Progress::new(|_| true);
    let refused = core.bus.run(ticket, plan.id, stop).unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Unavailable);
}
