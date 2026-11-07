//! The gate in the stack of real clients, over a local HTTP server that says
//! what reached it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use http::Request;
use kube::Config;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use twigo_ipc::{ErrorKind, Mode};
use twigo_kube::client::{Actor, Budgets, Clients, Options};
use twigo_kube::errors;
use twigo_policy::Policy;

#[derive(Clone)]
struct Server {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
    /// Requests whose path ends in `/hold` wait for it.
    release: Arc<Notify>,
}

impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = Self {
            port: listener.local_addr().unwrap().port(),
            seen: Arc::default(),
            release: Arc::new(Notify::new()),
        };
        let serving = server.clone();
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                tokio::spawn(serving.clone().serve(socket));
            }
        });
        server
    }

    async fn serve(self, mut socket: tokio::net::TcpStream) {
        let mut request = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            match socket.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(read) => request.extend_from_slice(&buffer[..read]),
            }
            while let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&request[..end]).into_owned();
                request.drain(..end + 4);
                let line = head.lines().next().unwrap_or_default();
                let line = line.trim_end_matches(" HTTP/1.1").to_owned();
                let hold = line.ends_with("/hold");
                self.seen.lock().unwrap().push(line);
                if hold {
                    self.release.notified().await;
                }
                let answer = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}";
                if socket.write_all(answer.as_bytes()).await.is_err() {
                    return;
                }
            }
        }
    }

    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }

    fn clients(&self, path: &str, policy: &Arc<Policy>, budgets: Budgets) -> Clients {
        let url = format!("http://127.0.0.1:{}{path}", self.port);
        Clients::new(
            &Config::new(url.parse().unwrap()),
            policy.gate("c", Actor::Ui),
            Options {
                budgets,
                ..Options::default()
            },
        )
        .unwrap()
    }
}

fn in_mode(mode: Mode) -> Arc<Policy> {
    let policy = Policy::open();
    policy.set_mode("c", Some(mode)).unwrap();
    policy
}

async fn send(client: &kube::Client, method: &str, uri: &str) -> Result<String, kube::Error> {
    let request = Request::builder().method(method).uri(uri);
    client.request_text(request.body(Vec::new()).unwrap()).await
}

const EXEC: &str = "/api/v1/namespaces/a/pods/p/exec";
const CONFIGMAPS: &str = "/api/v1/namespaces/a/configmaps";

#[tokio::test]
async fn both_clients_are_gated_and_read_the_path_from_the_api_server_s_root() {
    let server = Server::start().await;
    let policy = in_mode(Mode::ReadOnly);
    let clients = server.clients("/k8s/clusters/c1", &policy, Budgets::default());

    for (client, method, uri) in [
        (&clients.api, "POST", CONFIGMAPS),
        (&clients.api, "POST", EXEC),
        (&clients.sessions, "POST", EXEC),
        (&clients.sessions, "POST", CONFIGMAPS),
    ] {
        let refused = send(client, method, uri).await.unwrap_err();
        assert_eq!(
            errors::request(&refused).kind,
            ErrorKind::Permissions,
            "{uri}"
        );
    }
    assert_eq!(server.seen(), Vec::<String>::new());

    send(&clients.api, "GET", "/api/v1/pods").await.unwrap();
    send(&clients.sessions, "GET", "/api/v1/pods")
        .await
        .unwrap();
    assert_eq!(
        server.seen(),
        [
            "GET /k8s/clusters/c1/api/v1/pods",
            "GET /k8s/clusters/c1/api/v1/pods"
        ]
    );
}

#[tokio::test]
async fn a_relock_reaches_a_request_waiting_in_the_counter_of_real_clients() {
    let server = Server::start().await;
    let policy = in_mode(Mode::ReadOnly);
    policy.unlock("c").unwrap();
    let budgets = Budgets {
        requests: 1,
        ..Budgets::default()
    };
    let clients = server.clients("", &policy, budgets);

    let holder = {
        let api = clients.api.clone();
        tokio::spawn(async move { send(&api, "GET", "/hold").await })
    };
    let mut usage = clients.usage();
    usage
        .wait_for(|usage| usage.requests.held == 1)
        .await
        .unwrap();
    let write = {
        let api = clients.api.clone();
        tokio::spawn(async move { send(&api, "POST", CONFIGMAPS).await })
    };
    let queued = usage.wait_for(|usage| usage.requests.queued == 1);
    tokio::time::timeout(Duration::from_secs(5), queued)
        .await
        .expect("the write waits for the stream")
        .unwrap();

    policy.relock("c");
    while server.seen().is_empty() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    server.release.notify_one();
    holder.await.unwrap().unwrap();
    let refused = write.await.unwrap().unwrap_err();
    assert_eq!(errors::request(&refused).kind, ErrorKind::Permissions);
    assert_eq!(server.seen(), ["GET /hold"]);
}

#[tokio::test]
async fn another_actor_s_clients_share_the_counter_and_keep_their_own_rules() {
    let server = Server::start().await;
    let policy = in_mode(Mode::Guarded);
    let clients = server.clients("", &policy, Budgets::default());
    let terminal = clients.actor(Actor::Terminal).unwrap();

    assert!(send(&terminal.api, "POST", CONFIGMAPS).await.is_err());
    assert!(send(&terminal.sessions, "POST", EXEC).await.is_err());
    assert_eq!(server.seen(), Vec::<String>::new());
    send(&terminal.api, "GET", "/api/v1/pods").await.unwrap();
    send(&clients.api, "POST", CONFIGMAPS).await.unwrap();
    assert_eq!(server.seen().len(), 2);
    assert_eq!(clients.usage().borrow().requests.held, 0);
}
