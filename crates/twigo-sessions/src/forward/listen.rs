//! A forward's local port (ARCHITECTURE 4.6): `127.0.0.1`, which must bind,
//! and `::1` on the same port where it can, as kubectl's `localhost` does
//! ([client-go `parsePorts` and `forward`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/portforward/portforward.go#L135-L166)).

use std::future::poll_fn;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::task::Poll;

use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};
use twigo_ipc::BusyWhy;

use super::connect::Duplex;
use super::{ACCEPT_PAUSE, LISTENING_PROBE};

const FIRST_FREE: u16 = 1024;

pub struct Listeners {
    pub(super) v4: TcpListener,
    pub(super) v6: Option<TcpListener>,
    port: u16,
}

pub(super) type Socket = Box<dyn Duplex>;

pub(super) type Sockets = mpsc::UnboundedReceiver<Socket>;

/// A listener that its owner closes at once, whatever the task that accepts
/// on it is doing: aborting the task would close it only when the runtime
/// got to it.
struct Held(Mutex<Option<TcpListener>>);

/// The tasks that accept on the listeners. Dropping it closes the listeners
/// before it returns.
pub(super) struct Accepting {
    held: Vec<Arc<Held>>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Accepting {
    fn drop(&mut self) {
        self.tasks.iter().for_each(JoinHandle::abort);
        for held in &self.held {
            held.0.lock().expect("listener lock").take();
        }
    }
}

#[derive(Debug)]
pub enum BindError {
    Busy(BusyWhy),
    Failed(io::Error),
}

impl Listeners {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Accepts on every listener, from a task of its own each, into
    /// `sockets`.
    pub(super) fn accept(self, sockets: &mpsc::UnboundedSender<Socket>) -> Accepting {
        let held: Vec<Arc<Held>> = std::iter::once(self.v4)
            .chain(self.v6)
            .map(|listener| Arc::new(Held(Mutex::new(Some(listener)))))
            .collect();
        let tasks = held
            .iter()
            .map(|held| tokio::spawn(accept(Arc::clone(held), sockets.clone())))
            .collect();
        Accepting { held, tasks }
    }

    pub fn addresses(&self) -> Vec<String> {
        let mut addresses = vec![Ipv4Addr::LOCALHOST.to_string()];
        if self.v6.is_some() {
            addresses.push(Ipv6Addr::LOCALHOST.to_string());
        }
        addresses
    }
}

async fn accept(held: Arc<Held>, sockets: mpsc::UnboundedSender<Socket>) {
    loop {
        let accepted = poll_fn(|cx| match held.0.lock().expect("listener lock").as_ref() {
            Some(listener) => listener.poll_accept(cx).map(Some),
            None => Poll::Ready(None),
        })
        .await;
        match accepted {
            None => return,
            Some(Ok((socket, _))) => {
                if let Err(error) = socket.set_nodelay(true) {
                    eprintln!("could not set TCP_NODELAY on a forward's connection: {error}");
                }
                if sockets.send(Box::new(socket)).is_err() {
                    return;
                }
            }
            Some(Err(error)) => {
                eprintln!("could not accept a connection to a forward: {error}");
                sleep(ACCEPT_PAUSE).await;
            }
        }
    }
}

fn busy(error: &io::Error) -> Option<BusyWhy> {
    match error.kind() {
        io::ErrorKind::AddrInUse => Some(BusyWhy::InUse),
        io::ErrorKind::PermissionDenied => Some(BusyWhy::NotPermitted),
        _ => None,
    }
}

/// Binds `port` on `127.0.0.1` and on `::1`. A `::1` that this machine has
/// not is left out; one that another process holds, or that Twigo may not
/// bind, counts as the port being busy, since a client that tries `localhost`
/// first would reach that process.
pub async fn listen(port: u16) -> Result<Listeners, BindError> {
    let v4 = bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .await
        .map_err(|error| busy(&error).map_or(BindError::Failed(error), BindError::Busy))?;
    let v6 = match bind(SocketAddr::from((Ipv6Addr::LOCALHOST, port))).await {
        Ok(v6) => Some(v6),
        Err(error) => match busy(&error) {
            Some(why) => return Err(BindError::Busy(why)),
            None => None,
        },
    };
    Ok(Listeners { v4, v6, port })
}

/// Binds `address`. `SO_REUSEADDR` lets a port bind again while the
/// connections it served wait out `TIME_WAIT`, which mio sets everywhere but
/// on Windows, where it would let a socket in use be bound over
/// ([`listener.rs`](https://github.com/tokio-rs/mio/blob/v1.2.4/src/net/tcp/listener.rs#L74-L82)).
/// On macOS it also lets `127.0.0.1:P` bind beside another process's
/// listener on `0.0.0.0:P` or `[::]:P` and take its loopback clients, which
/// Linux refuses whatever the options. So Linux binds with it, Windows
/// without, and macOS without it first: when that finds the port in use, the
/// port is busy unless nothing accepts a connection on it, which leaves only
/// leftovers.
async fn bind(address: SocketAddr) -> io::Result<TcpListener> {
    if !cfg!(target_os = "macos") {
        return bound(address, cfg!(not(windows)));
    }
    match bound(address, false) {
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {}
        bound => return bound,
    }
    // A listener on this address fails here and is not probed: the probe
    // would connect to one of Twigo's own forwards.
    claim(address)?;
    if listening(address).await {
        return Err(io::ErrorKind::AddrInUse.into());
    }
    bound(address, true)
}

fn socket(address: SocketAddr, reuse: bool) -> io::Result<TcpSocket> {
    let socket = if address.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    socket.set_reuseaddr(reuse)?;
    Ok(socket)
}

fn bound(address: SocketAddr, reuse: bool) -> io::Result<TcpListener> {
    let socket = socket(address, reuse)?;
    socket.bind(address)?;
    socket.listen(1024)
}

fn claim(address: SocketAddr) -> io::Result<()> {
    socket(address, true)?.bind(address)
}

/// Whether something accepts, or would accept, a connection on `address`: a
/// full backlog drops it silently, so only a refusal says no.
async fn listening(address: SocketAddr) -> bool {
    match timeout(LISTENING_PROBE, TcpStream::connect(address)).await {
        Ok(Err(error)) => error.kind() != io::ErrorKind::ConnectionRefused,
        Ok(Ok(_)) | Err(_) => true,
    }
}

/// The next port above `port`, from 1024 up, that binds on the addresses a
/// forward binds, found by binding them. It is free as it was asked; a start
/// on it binds again and learns whether it still is.
pub async fn free_port(port: u16) -> io::Result<u16> {
    for candidate in port.saturating_add(1).max(FIRST_FREE)..=u16::MAX {
        match listen(candidate).await {
            Ok(_) => return Ok(candidate),
            Err(BindError::Busy(_)) => {}
            Err(BindError::Failed(error)) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AddrNotAvailable,
        format!("no port above {port} is free"),
    ))
}
