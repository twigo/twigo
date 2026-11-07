//! The gate in the clients' stack, over a server that counts what reaches it.

use std::convert::Infallible;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http::{Request, Response};
use http_body_util::Full;
use jiff::SignedDuration;
use tokio::sync::Notify;
use twigo_ipc::{BlockReason, ErrorKind, Mode, ModeSource, RequestClass};
use twigo_policy::Policy;

use super::*;
use crate::errors;

#[derive(Clone, Default)]
struct Server {
    requests: Arc<Mutex<Vec<String>>>,
    /// Requests to `/hold` wait for it.
    release: Arc<Notify>,
}

impl Server {
    fn clients(&self, budgets: Budgets, gate: Gate) -> Clients {
        let server = self.clone();
        let service = tower::service_fn(move |request: Request<Body>| {
            let server = server.clone();
            async move {
                let line = format!("{} {}", request.method(), request.uri());
                server.requests.lock().unwrap().push(line);
                if request.uri().path() == "/hold" {
                    server.release.notified().await;
                }
                Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"{}"))))
            }
        });
        Clients::over_gated(service, budgets, gate)
    }

    fn seen(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    fn reached(&self, line: &str) -> impl Future<Output = ()> + use<> {
        let requests = Arc::clone(&self.requests);
        let line = line.to_owned();
        async move {
            while !requests.lock().unwrap().contains(&line) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }
}

fn in_mode(mode: Mode) -> Arc<Policy> {
    let policy = Policy::open();
    policy.set_mode("c", Some(mode)).unwrap();
    policy
}

async fn send(client: &Client, method: &str, uri: &str) -> Result<String, kube::Error> {
    let request = Request::builder().method(method).uri(uri);
    client.request_text(request.body(Vec::new()).unwrap()).await
}

const CONFIGMAPS: &str = "/api/v1/namespaces/a/configmaps";

#[tokio::test]
async fn a_write_in_a_read_only_context_never_reaches_the_server() {
    let server = Server::default();
    let policy = in_mode(Mode::ReadOnly);
    let clients = server.clients(Budgets::default(), policy.gate("c", Actor::Ui));
    let usage = clients.usage();

    let refused = send(&clients.api, "POST", CONFIGMAPS).await.unwrap_err();
    assert_eq!(server.seen(), Vec::<String>::new());
    assert_eq!(*usage.borrow(), Usage::default(), "it took no stream");

    let error = errors::request(&refused);
    assert_eq!(error.kind, ErrorKind::Permissions);
    let blocked = error.blocked.unwrap();
    assert_eq!(blocked.mode, Mode::ReadOnly);
    assert_eq!(blocked.source, ModeSource::User);
    assert_eq!(blocked.class, RequestClass::Write);
    assert_eq!(blocked.reason, BlockReason::Mode);
    assert_eq!(blocked.verb, "create");
    assert_eq!(blocked.target, "configmaps in a");
    assert!(error.message.contains("read-only"), "{}", error.message);

    let exec = "/api/v1/namespaces/a/pods/p/exec";
    let refused = send(&clients.sessions, "POST", exec).await.unwrap_err();
    assert_eq!(errors::request(&refused).kind, ErrorKind::Permissions);
    assert_eq!(server.seen(), Vec::<String>::new());
}

#[tokio::test]
async fn reads_and_dry_runs_pass_in_every_mode() {
    for mode in [Mode::ReadWrite, Mode::Guarded, Mode::ReadOnly] {
        let server = Server::default();
        let clients = server.clients(Budgets::default(), in_mode(mode).gate("c", Actor::Ui));
        let dry_run = format!("{CONFIGMAPS}?dryRun=All");
        let review = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";
        send(&clients.api, "GET", "/api/v1/pods").await.unwrap();
        send(&clients.api, "POST", &dry_run).await.unwrap();
        send(&clients.api, "POST", review).await.unwrap();
        send(&clients.sessions, "GET", "/api/v1/pods")
            .await
            .unwrap();
        assert_eq!(server.seen().len(), 4, "{mode:?}");
    }
}

/// The write waits for the only request stream while the first holds it,
/// and what happens to the mode meanwhile decides its fate.
async fn wait_for_a_stream(change: impl FnOnce(&Policy)) -> (Server, Result<String, kube::Error>) {
    let server = Server::default();
    let policy = in_mode(Mode::ReadOnly);
    policy.unlock("c").unwrap();
    let budgets = Budgets {
        requests: 1,
        ..Budgets::default()
    };
    let clients = server.clients(budgets, policy.gate("c", Actor::Ui));
    let holder = {
        let api = clients.api.clone();
        tokio::spawn(async move { send(&api, "GET", "/hold").await })
    };
    server.reached("GET /hold").await;
    let write = {
        let api = clients.api.clone();
        tokio::spawn(async move { send(&api, "POST", CONFIGMAPS).await })
    };
    let mut usage = clients.usage();
    let queued = usage.wait_for(|usage| usage.requests.queued == 1);
    tokio::time::timeout(Duration::from_secs(5), queued)
        .await
        .expect("the write waits for the stream")
        .unwrap();

    change(&policy);
    server.release.notify_one();
    holder.await.unwrap().unwrap();
    let answer = tokio::time::timeout(Duration::from_secs(5), write)
        .await
        .expect("the write gets its answer")
        .unwrap();
    (server, answer)
}

#[tokio::test]
async fn a_relock_reaches_a_request_already_waiting() {
    let (server, answer) = wait_for_a_stream(|policy| policy.relock("c")).await;
    let error = errors::request(&answer.unwrap_err());
    assert_eq!(error.kind, ErrorKind::Permissions);
    assert_eq!(error.blocked.unwrap().mode, Mode::ReadOnly);
    assert_eq!(server.seen(), ["GET /hold"]);
}

#[tokio::test]
async fn an_unlock_that_lasts_lets_the_waiting_request_through() {
    let (server, answer) = wait_for_a_stream(|_| {}).await;
    answer.unwrap();
    assert_eq!(
        server.seen(),
        ["GET /hold".to_owned(), format!("POST {CONFIGMAPS}")]
    );
}

#[tokio::test]
async fn an_unlock_that_ends_by_itself_reaches_a_request_already_waiting() {
    let wait_it_out = |policy: &Policy| {
        policy
            .unlock_for("c", SignedDuration::from_millis(1))
            .unwrap();
        std::thread::sleep(Duration::from_millis(5));
    };
    let (server, answer) = wait_for_a_stream(wait_it_out).await;
    assert_eq!(
        errors::request(&answer.unwrap_err()).kind,
        ErrorKind::Permissions
    );
    assert_eq!(server.seen(), ["GET /hold"]);
}

#[tokio::test]
async fn a_mode_set_after_the_clients_were_built_holds_for_them() {
    let server = Server::default();
    let policy = Policy::open();
    let clients = server.clients(Budgets::default(), policy.gate("c", Actor::Ui));
    send(&clients.api, "POST", CONFIGMAPS).await.unwrap();
    policy.set_mode("c", Some(Mode::ReadOnly)).unwrap();
    assert!(send(&clients.api, "POST", CONFIGMAPS).await.is_err());
    assert_eq!(server.seen().len(), 1);
}

#[tokio::test]
async fn a_context_s_mode_stays_with_that_context() {
    let server = Server::default();
    let policy = Policy::open();
    policy.set_mode("other", Some(Mode::ReadOnly)).unwrap();
    let clients = server.clients(Budgets::default(), policy.gate("c", Actor::Ui));
    send(&clients.api, "POST", CONFIGMAPS).await.unwrap();
}

#[tokio::test]
async fn each_actor_has_its_own_clients_with_its_own_answers_over_the_same_budgets() {
    let server = Server::default();
    let policy = in_mode(Mode::Guarded);
    let budgets = Budgets {
        requests: 2,
        others: 1,
        ..Budgets::default()
    };
    let clients = server.clients(budgets, policy.gate("c", Actor::Ui));
    let terminal = clients.actor(Actor::Terminal).unwrap();

    let refused = send(&terminal.api, "POST", CONFIGMAPS).await.unwrap_err();
    let blocked = errors::request(&refused).blocked.unwrap();
    assert_eq!(blocked.reason, BlockReason::NoApproval);
    let exec = "/api/v1/namespaces/a/pods/p/exec";
    assert!(send(&terminal.sessions, "POST", exec).await.is_err());
    assert_eq!(server.seen(), Vec::<String>::new());
    send(&clients.api, "POST", CONFIGMAPS).await.unwrap();

    let holder = {
        let api = terminal.api.clone();
        tokio::spawn(async move { send(&api, "GET", "/hold").await })
    };
    server.reached("GET /hold").await;
    let mut usage = clients.usage();
    assert_eq!(
        usage.borrow().requests.held,
        1,
        "the shared counter sees it"
    );
    let second = {
        let api = terminal.api.clone();
        tokio::spawn(async move { send(&api, "GET", "/api/v1/nodes").await })
    };
    let queued = usage.wait_for(|usage| usage.requests.queued == 1);
    tokio::time::timeout(Duration::from_secs(5), queued)
        .await
        .expect("the actor's share is full")
        .unwrap();
    let ui = send(&clients.api, "GET", "/api/v1/pods");
    tokio::time::timeout(Duration::from_secs(5), ui)
        .await
        .expect("the UI still gets a stream")
        .unwrap();

    server.release.notify_one();
    holder.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
}

#[tokio::test]
async fn the_sessions_budget_is_shared_by_every_actor() {
    let server = Server::default();
    let budgets = Budgets {
        sessions: 1,
        ..Budgets::default()
    };
    let clients = server.clients(budgets, Policy::open().gate("c", Actor::Ui));
    let held = clients.admit_session(Actor::Ui, None).await;
    assert!(clients.try_admit(Class::Session, Actor::Terminal).is_none());
    assert_eq!(clients.usage().borrow().sessions.held, 1);
    drop(held);
    assert!(clients.try_admit(Class::Session, Actor::Terminal).is_some());
}
