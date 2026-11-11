//! A forward's local port (ARCHITECTURE 4.6): `127.0.0.1`, which must bind,
//! and `::1` on the same port where it can, as kubectl's `localhost` does
//! ([client-go `parsePorts` and `forward`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/portforward/portforward.go#L135-L166)).

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};

use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::sleep;
use twigo_ipc::BusyWhy;

use super::ACCEPT_PAUSE;
use super::connect::Duplex;

const FIRST_FREE: u16 = 1024;

pub struct Listeners {
    pub(super) v4: TcpListener,
    pub(super) v6: Option<TcpListener>,
    port: u16,
}

pub(super) type Socket = Box<dyn Duplex>;

pub(super) type Sockets = mpsc::UnboundedReceiver<Socket>;

/// The tasks that accept on the listeners, which end when it is dropped.
pub(super) struct Accepting(Vec<JoinHandle<()>>);

impl Drop for Accepting {
    fn drop(&mut self) {
        self.0.iter().for_each(JoinHandle::abort);
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

    /// Accepts on every listener, from a task of its own each.
    pub(super) fn accept(self) -> (Sockets, Accepting) {
        let (sender, sockets) = mpsc::unbounded_channel();
        let mut tasks = vec![tokio::spawn(accept(self.v4, sender.clone()))];
        if let Some(v6) = self.v6 {
            tasks.push(tokio::spawn(accept(v6, sender)));
        }
        (sockets, Accepting(tasks))
    }

    pub fn addresses(&self) -> Vec<String> {
        let mut addresses = vec![Ipv4Addr::LOCALHOST.to_string()];
        if self.v6.is_some() {
            addresses.push(Ipv6Addr::LOCALHOST.to_string());
        }
        addresses
    }
}

async fn accept(listener: TcpListener, sockets: mpsc::UnboundedSender<Socket>) {
    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                if let Err(error) = socket.set_nodelay(true) {
                    eprintln!("could not set TCP_NODELAY on a forward's connection: {error}");
                }
                if sockets.send(Box::new(socket)).is_err() {
                    return;
                }
            }
            Err(error) => {
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
    let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|error| busy(&error).map_or(BindError::Failed(error), BindError::Busy))?;
    let v6 = match TcpListener::bind((Ipv6Addr::LOCALHOST, port)).await {
        Ok(v6) => Some(v6),
        Err(error) => match busy(&error) {
            Some(why) => return Err(BindError::Busy(why)),
            None => None,
        },
    };
    Ok(Listeners { v4, v6, port })
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
