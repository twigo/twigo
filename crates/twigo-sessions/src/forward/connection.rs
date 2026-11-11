//! One accepted connection, and the probe that proves a forward can be
//! reached: each a WebSocket of its own to a pod's port, holding a place
//! among the context's sessions for as long as it lives.

use std::future::pending;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures::FutureExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use tokio::time::{Instant, sleep, sleep_until, timeout};
use twigo_ipc::{ErrorKind, IpcError};
use twigo_kube::client::{Actor, Clients, Waiting};

use super::connect::Connected;
use super::listen::Socket;
use super::pick::Chosen;
use super::watching::Candidate;
use super::{CANDIDATE_WAIT, CONNECT_TIMEOUT, Open, PROBE_WINDOW, QUIET, Report, Shared};
use crate::shell::abandoned;

const CHUNK: usize = 16 * 1024;

/// Why a connection or a try failed.
pub(super) enum Fault {
    /// The cluster refused the credentials, the person's rights or the
    /// policy: the forward fails, and trying again would not help.
    Fatal(IpcError),
    /// The pod or the cluster did not answer.
    Transient(IpcError),
    /// The pod's side refused the port, in its own words, or none was found.
    Port(String),
    /// The clients were replaced, or the network changed under them.
    Lost,
}

/// How a connection or a probe ends when it did not run its course.
pub(super) enum Over {
    /// The forward ended it.
    Ended,
    Lost,
    Fault(Fault),
}

fn clients_fault(error: IpcError) -> Fault {
    match error.kind {
        ErrorKind::Unavailable | ErrorKind::Timeout | ErrorKind::Internal => {
            Fault::Transient(error)
        }
        _ => Fault::Fatal(error),
    }
}

fn upgrade_fault(error: &kube::Error) -> Fault {
    let error = twigo_kube::errors::request(error);
    match error.kind {
        ErrorKind::Unauthorized | ErrorKind::Forbidden | ErrorKind::Permissions => {
            Fault::Fatal(error)
        }
        _ => Fault::Transient(error),
    }
}

/// The clients a connection runs on, and what ends it: the forward, the
/// clients being replaced, or a wake or a moved route, as a shell's ends
/// (`shell::run`).
struct Link {
    clients: Arc<Clients>,
    end: watch::Receiver<u64>,
    abandoned: watch::Receiver<bool>,
    network: watch::Receiver<u64>,
}

impl Link {
    async fn new(shared: &Shared, mut end: watch::Receiver<u64>) -> Result<Self, Over> {
        let clients = tokio::select! {
            biased;
            _ = end.changed() => return Err(Over::Ended),
            clients = shared.hub.clients(&shared.config.context) => {
                clients.map_err(|error| Over::Fault(clients_fault(error)))?
            }
        };
        let mut network = clients.connections().network();
        network.borrow_and_update();
        let abandoned = clients.connections().abandoned();
        Ok(Self {
            clients,
            end,
            abandoned,
            network,
        })
    }

    async fn interrupted(&mut self) -> Over {
        tokio::select! {
            _ = self.end.changed() => Over::Ended,
            () = abandoned(self.abandoned.clone()) => Over::Lost,
            _ = self.network.changed() => Over::Lost,
        }
    }
}

/// Serves an accepted socket until it ends, and tells the supervisor why it
/// failed, if it did.
pub(super) async fn serve(
    shared: Arc<Shared>,
    socket: Socket,
    _open: Open,
    end: watch::Receiver<u64>,
) {
    match run(&shared, socket, end).await {
        Ok(()) | Err(Over::Ended) => {}
        Err(Over::Lost) => shared.report(Report::Failed(Fault::Lost)),
        Err(Over::Fault(fault)) => shared.report(Report::Failed(fault)),
    }
}

async fn run(shared: &Arc<Shared>, socket: Socket, end: watch::Receiver<u64>) -> Result<(), Over> {
    let mut link = Link::new(shared, end).await?;
    let clients = Arc::clone(&link.clients);
    let waiting = Waiting(Arc::new({
        let shared = Arc::clone(shared);
        move |waiting| {
            shared.update(|status| {
                if waiting {
                    status.queued += 1;
                } else {
                    status.queued -= 1;
                }
                true
            });
        }
    }));
    let _permit = tokio::select! {
        biased;
        over = link.interrupted() => return Err(over),
        permit = clients.admit_session(Actor::Ui, Some(&waiting)) => permit,
    };
    let candidate = pod(shared, &mut link).await?;
    let connected = tokio::select! {
        biased;
        over = link.interrupted() => return Err(over),
        connected = connect(shared, &clients, &candidate) => connected?,
    };
    pump(shared, &mut link, socket, connected, &candidate).await
}

async fn pod(shared: &Shared, link: &mut Link) -> Result<Candidate, Over> {
    let mut picked = shared.picked.subscribe();
    let deadline = Instant::now() + CANDIDATE_WAIT;
    loop {
        let why = match shared.choose() {
            Chosen::Pod(candidate) => return Ok(candidate),
            // The forward fails with it, which ends this connection.
            Chosen::Fault(_) => return Err(Over::Ended),
            Chosen::None(why) => why,
            Chosen::Unknown => "no pod to forward to was found".to_owned(),
        };
        tokio::select! {
            biased;
            over = link.interrupted() => return Err(over),
            _ = picked.changed() => {}
            () = sleep_until(deadline) => return Err(Over::Fault(Fault::Port(why))),
        }
    }
}

async fn connect(
    shared: &Shared,
    clients: &Clients,
    candidate: &Candidate,
) -> Result<Connected, Over> {
    let target = &shared.config.target;
    let opened = timeout(
        CONNECT_TIMEOUT,
        shared.connect.connect(
            &clients.sessions,
            &target.namespace,
            &candidate.name,
            candidate.port,
        ),
    )
    .await;
    let fault = match opened {
        Ok(Ok(connected)) => return Ok(connected),
        Ok(Err(error)) => upgrade_fault(&error),
        Err(_) => Fault::Transient(IpcError::new(
            ErrorKind::Timeout,
            format!("timed out opening a stream to pod {}", candidate.name),
        )),
    };
    if !matches!(fault, Fault::Fatal(_)) {
        shared.failed(&candidate.key);
    }
    Err(Over::Fault(fault))
}

enum Side {
    Fin,
    Client,
    Pod,
}

/// Copies both ways, with byte counts. On the client's FIN the stream is not
/// shut down, which kube answers by dropping what the pod still sends and
/// closing the socket: the pod's answer still arrives, and the connection
/// ends once the pod has said nothing for [`QUIET`]. It ends when the pod's
/// side does, with the client's socket shut down.
async fn pump(
    shared: &Shared,
    link: &mut Link,
    socket: Socket,
    connected: Connected,
    candidate: &Candidate,
) -> Result<(), Over> {
    let Connected {
        stream,
        mut error,
        held,
    } = connected;
    let _held = held;
    let (mut from_client, mut to_client) = tokio::io::split(socket);
    let (mut from_pod, mut to_pod) = tokio::io::split(stream);
    let (fin, mut fin_seen) = watch::channel(None::<Instant>);
    let up = async {
        let mut buffer = vec![0; CHUNK];
        loop {
            let Ok(read) = from_client.read(&mut buffer).await else {
                return Side::Client;
            };
            if read == 0 {
                fin.send_replace(Some(Instant::now()));
                return Side::Fin;
            }
            if to_pod.write_all(&buffer[..read]).await.is_err() {
                return Side::Pod;
            }
            shared.sent.fetch_add(read as u64, Ordering::Relaxed);
        }
    };
    let down = async {
        let mut buffer = vec![0; CHUNK];
        let mut last = Instant::now();
        let mut served = false;
        loop {
            let fin_at = *fin_seen.borrow_and_update();
            let quiet = async {
                match fin_at {
                    Some(at) => sleep_until(at.max(last) + QUIET).await,
                    None => pending().await,
                }
            };
            tokio::select! {
                read = from_pod.read(&mut buffer) => {
                    let Ok(read @ 1..) = read else { break };
                    last = Instant::now();
                    if to_client.write_all(&buffer[..read]).await.is_err() {
                        break;
                    }
                    shared.received.fetch_add(read as u64, Ordering::Relaxed);
                    if !served {
                        served = true;
                        shared.pick().served(&candidate.key);
                        shared.report(Report::Served);
                    }
                }
                () = quiet => break,
                _ = fin_seen.changed() => {}
            }
        }
        let _ = to_client.shutdown().await;
    };
    tokio::pin!(up, down);
    let (mut up_over, mut told) = (false, false);
    loop {
        tokio::select! {
            biased;
            over = link.interrupted() => return Err(over),
            text = &mut error, if !told => {
                told = true;
                if let Some(text) = text {
                    shared.failed(&candidate.key);
                    return Err(Over::Fault(Fault::Port(text)));
                }
            }
            () = &mut down => break,
            side = &mut up, if !up_over => {
                up_over = true;
                if matches!(side, Side::Client) {
                    return Ok(());
                }
            }
        }
    }
    if !told && let Some(Some(text)) = (&mut error).now_or_never() {
        shared.failed(&candidate.key);
        return Err(Over::Fault(Fault::Port(text)));
    }
    Ok(())
}

/// Opens a stream to the candidate and drops it, which proves the
/// credentials, the rights, the upgrade, and, by the pod's silence for
/// [`PROBE_WINDOW`], that something listens on its port.
pub(super) async fn probe(
    shared: Arc<Shared>,
    candidate: Candidate,
    end: watch::Receiver<u64>,
) -> Result<(), Over> {
    let mut link = Link::new(&shared, end).await?;
    let clients = Arc::clone(&link.clients);
    let _permit = tokio::select! {
        biased;
        over = link.interrupted() => return Err(over),
        permit = clients.admit_session(Actor::Ui, None) => permit,
    };
    let mut connected = tokio::select! {
        biased;
        over = link.interrupted() => return Err(over),
        connected = connect(&shared, &clients, &candidate) => connected?,
    };
    tokio::select! {
        biased;
        over = link.interrupted() => Err(over),
        text = &mut connected.error => match text {
            Some(text) => {
                shared.failed(&candidate.key);
                Err(Over::Fault(Fault::Port(text)))
            }
            None => Ok(()),
        },
        () = sleep(PROBE_WINDOW) => Ok(()),
    }
}
