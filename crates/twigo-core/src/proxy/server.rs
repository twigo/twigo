//! The endpoint: HTTP/1.1 over TLS on 127.0.0.1, on a port the OS picks.
//! The upgrades kubectl sends for exec, attach and port-forward exist only
//! in HTTP/1.1, so hyper's `http1` serves alone.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Weak;
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;

use super::handle::handle;
use super::tls::Tls;
use crate::Core;

/// hyper's default, which needs a timer to act
/// ([`header_read_timeout`](https://github.com/hyperium/hyper/blob/v1.12.0/src/server/conn/http1.rs#L361-L373));
/// a TLS handshake gets as long.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HEADER_SIZE: usize = 64 * 1024;
/// How long accepting pauses after a failure, such as running out of file
/// descriptors, which accepting again at once would only repeat.
const ACCEPT_PAUSE: Duration = Duration::from_millis(100);

/// Where processes reach the proxy, and the CA they trust it by.
pub(super) struct Endpoint {
    pub address: SocketAddr,
    pub ca: String,
}

/// Listens and serves for the rest of the app's life.
pub(super) async fn bind(core: Weak<Core>) -> std::io::Result<Endpoint> {
    let tls = Tls::new()?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let address = listener.local_addr()?;
    tokio::spawn(accept(listener, tls.acceptor, address, core));
    Ok(Endpoint {
        address,
        ca: tls.ca,
    })
}

async fn accept(listener: TcpListener, tls: TlsAcceptor, address: SocketAddr, core: Weak<Core>) {
    let mut builder = http1::Builder::new();
    // `half_close` stays off, so a client that goes ends its streams and its
    // ask at once.
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_READ_TIMEOUT)
        .max_header_size(MAX_HEADER_SIZE);
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                eprintln!("the policy proxy could not accept a connection: {error}");
                tokio::time::sleep(ACCEPT_PAUSE).await;
                continue;
            }
        };
        let (core, tls, builder) = (core.clone(), tls.clone(), builder.clone());
        tokio::spawn(async move {
            let Ok(Ok(stream)) =
                tokio::time::timeout(HEADER_READ_TIMEOUT, tls.accept(stream)).await
            else {
                return;
            };
            let (writing, written) = watch::channel(None);
            let writing = Writing(writing);
            let service =
                service_fn(move |request| handle(core.clone(), address, writing.clone(), request));
            let serving = builder
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            // A client that goes away mid-request ends its connection, which
            // is all there is to do about it.
            tokio::select! {
                _ = serving => {}
                () = ended(written) => {}
            }
        });
    }
}

/// The process whose answer a connection is writing, if any, so that the
/// connection ends with it: hyper polls a body only while it can buffer
/// what the body gives
/// ([`poll_write`](https://github.com/hyperium/hyper/blob/v1.12.0/src/proto/h1/dispatch.rs#L384-L401)),
/// so the body of an answer whose client reads nothing would never see its
/// process end, and would keep its stream and its upstream. An HTTP/1.1
/// connection writes one answer at a time.
#[derive(Clone)]
pub(super) struct Writing(watch::Sender<Option<CancellationToken>>);

impl Writing {
    /// The connection ends once `ended` is cancelled, while the answer this
    /// returns lives.
    pub(super) fn answer(&self, ended: &CancellationToken) -> Answer {
        self.0.send_replace(Some(ended.clone()));
        Answer(self.0.clone())
    }
}

/// An answer the connection is writing, dropped with its body.
pub(super) struct Answer(watch::Sender<Option<CancellationToken>>);

impl Drop for Answer {
    fn drop(&mut self) {
        self.0.send_replace(None);
    }
}

/// Returns once the process ends whose answer the connection is writing.
async fn ended(mut written: watch::Receiver<Option<CancellationToken>>) {
    loop {
        let writing = written.borrow_and_update().clone();
        let ended = async {
            match writing {
                Some(ended) => ended.cancelled_owned().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = ended => return,
            changed = written.changed() => {
                // The connection's service holds a sender while it serves.
                if changed.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        }
    }
}
