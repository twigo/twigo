//! The connections of a client (ARCHITECTURE 3.2): counted, retired on wake,
//! on a network change or after a failed probe, and warmed by one request
//! whenever none is usable.
//!
//! Retiring poisons a connection, so the pool hands it out no more, while
//! the streams on it run until their owners drop them. hyper-util keeps the
//! poison flag in the `Connected` of each connection and lets it out only
//! through `capture_connection`, so every request captures its connection,
//! which the connector tagged with an id.
//!
//! A network change retires the connections whose route moved: the kernel
//! would now send to their server from another address, or not at all. So
//! containers and VPNs that leave the route alone leave the connections
//! alone, as kind's own bridge does.
//!
//! A client with no usable connection opens one TCP and TLS connection per
//! concurrent first request and keeps only the first that negotiates `h2`
//! ([HTTP/2 spike](../../../../docs/spikes/http2.md)), so while none is
//! usable, one request dials and the others wait until it is connected or
//! has failed.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use http::{Extensions, Request, Response, Uri};
use hyper::rt::{Read, ReadBufCursor, Write};
use hyper_util::client::legacy::connect::{
    CaptureConnection, Connected, Connection, HttpInfo, capture_connection,
};
use tokio::sync::{OwnedMutexGuard, watch};
use tower::{BoxError, Layer, Service, ServiceExt};

#[derive(Clone)]
pub struct Connections(Arc<Inner>);

struct Inner {
    state: Mutex<State>,
    warming: Arc<tokio::sync::Mutex<()>>,
    retired: watch::Sender<u64>,
}

#[derive(Default)]
struct State {
    /// The id of the next connection to be dialled, which is also how many
    /// have been.
    next: u64,
    /// Connections dialled before this id are retired.
    floor: u64,
    open: HashMap<u64, Open>,
}

struct Open {
    capture: Option<CaptureConnection>,
    retired: bool,
    /// The server is going away, or the pool dialled past it: poisoned at
    /// its next use, so the pool hands it out no more before it learns why,
    /// but not retired, so a route that moves still retires the streams
    /// left on it.
    passed: bool,
    route: Option<Route>,
    /// Negotiated HTTP/2, so the pool shares it rather than dial anew.
    h2: bool,
    /// Has carried a request, which only a pooled connection does: before
    /// that, a request that skipped the gate would find the pool empty and
    /// dial.
    served: bool,
}

/// The ends of a connection's TCP leg: to the server, or to its proxy.
#[derive(Debug, Clone, Copy)]
struct Route {
    local: IpAddr,
    remote: SocketAddr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Id(u64);

impl Default for Connections {
    fn default() -> Self {
        Self(Arc::new(Inner {
            state: Mutex::default(),
            warming: Arc::default(),
            retired: watch::Sender::new(0),
        }))
    }
}

impl Connections {
    /// How many connections have been dialled.
    pub fn dialled(&self) -> u64 {
        self.state().next
    }

    /// How many are open, retired ones included.
    pub fn open(&self) -> usize {
        self.state().open.len()
    }

    /// Retires every connection open or being dialled. The streams on them
    /// keep running: their owners re-open them after the returned
    /// generation, which [`Connections::retired`] also tells.
    pub fn retire(&self) {
        let mut state = self.state();
        state.floor = state.next;
        for open in state.open.values_mut() {
            open.retired = true;
            if let Some(capture) = &open.capture {
                poison(capture);
            }
        }
        drop(state);
        self.0.retired.send_modify(|generation| *generation += 1);
    }

    /// Retires every connection if one's route moved, as after a network
    /// change, and says whether it did.
    pub fn retire_moved(&self) -> bool {
        self.retire_if_moved(source_for)
    }

    fn retire_if_moved(&self, source: impl Fn(SocketAddr) -> Option<IpAddr>) -> bool {
        let moved = self
            .state()
            .open
            .values()
            .filter(|open| !open.retired)
            .filter_map(|open| open.route)
            .any(|route| source(route.remote) != Some(route.local));
        if moved {
            self.retire();
        }
        moved
    }

    /// Counts the retirements.
    pub fn retired(&self) -> watch::Receiver<u64> {
        self.0.retired.subscribe()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().expect("connections lock")
    }

    /// hyper-util dials only when its pool holds no HTTP/2 connection that
    /// can take a stream, and a connection that has carried a request is in
    /// it: such connections are going away, as after a GOAWAY that came
    /// between requests, which no request's error tells. One pooled in the
    /// moment between a request's checkout and its dial is passed wrongly,
    /// which costs a dial or two.
    fn dial(&self) -> u64 {
        let mut state = self.state();
        for open in state
            .open
            .values_mut()
            .filter(|open| open.h2 && open.served)
        {
            open.passed = true;
        }
        state.next += 1;
        state.next - 1
    }

    fn opened(&self, id: u64, route: Option<Route>, h2: bool) {
        let mut state = self.state();
        let retired = id < state.floor;
        state.open.insert(
            id,
            Open {
                capture: None,
                retired,
                passed: false,
                route,
                h2,
                served: false,
            },
        );
    }

    fn closed(&self, id: u64) {
        self.state().open.remove(&id);
    }

    fn usable(&self) -> bool {
        self.state()
            .open
            .values()
            .any(|open| open.served && !open.retired && !open.passed)
    }

    /// While no connection is usable, one request dials and the others wait
    /// until it is connected or has failed, then go together: after a
    /// failure, one at a time would make each wait out the last one's
    /// timeout.
    async fn gate(&self) -> Option<OwnedMutexGuard<()>> {
        if self.usable() {
            return None;
        }
        if let Ok(dialling) = Arc::clone(&self.0.warming).try_lock_owned() {
            return Some(dialling);
        }
        drop(self.0.warming.lock().await);
        None
    }

    /// Notes the connection a request went over, and poisons it if it is
    /// retired or passed.
    fn used(&self, capture: CaptureConnection, going_away: bool) {
        let Some(id) = id(&capture) else {
            return;
        };
        let mut state = self.state();
        let Some(open) = state.open.get_mut(&id) else {
            return;
        };
        open.served = true;
        open.passed |= going_away;
        if open.retired || open.passed {
            poison(&capture);
        }
        open.capture.get_or_insert(capture);
    }
}

fn id(capture: &CaptureConnection) -> Option<u64> {
    let connected = capture.connection_metadata();
    let mut extensions = Extensions::new();
    connected.as_ref()?.get_extras(&mut extensions);
    extensions.get::<Id>().map(|id| id.0)
}

/// The address the kernel would send from to `remote` now. Connecting a UDP
/// socket picks a route and binds its source without sending anything; no
/// man page promises the source, but macOS and Linux both bind it.
fn source_for(remote: SocketAddr) -> Option<IpAddr> {
    let any: IpAddr = if remote.is_ipv4() {
        Ipv4Addr::UNSPECIFIED.into()
    } else {
        Ipv6Addr::UNSPECIFIED.into()
    };
    let socket = UdpSocket::bind((any, 0)).ok()?;
    socket.connect(remote).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

fn route(connected: &Connected) -> Option<Route> {
    let mut extensions = Extensions::new();
    connected.get_extras(&mut extensions);
    let info = extensions.get::<HttpInfo>()?;
    Some(Route {
        local: info.local_addr().ip(),
        remote: info.remote_addr(),
    })
}

fn poison(capture: &CaptureConnection) {
    if let Some(connected) = capture.connection_metadata().as_ref() {
        connected.poison();
    }
}

/// Whether the server said it is going away, so the connection takes no new
/// streams.
fn going_away(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(h2) = error.downcast_ref::<h2::Error>() {
            return h2.is_go_away() && h2.is_remote();
        }
        source = error.source();
    }
    false
}

/// The connector, tagging each connection with its id.
#[derive(Clone)]
pub struct Tracked<C> {
    inner: C,
    connections: Connections,
}

impl<C> Tracked<C> {
    pub fn new(inner: C, connections: Connections) -> Self {
        Self { inner, connections }
    }
}

impl<C> Service<Uri> for Tracked<C>
where
    C: Service<Uri>,
    C::Response: Connection,
    C::Future: Send + 'static,
    C::Error: Into<BoxError>,
{
    type Response = TrackedIo<C::Response>;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, BoxError>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        self.inner.poll_ready(cx).map_err(Into::into)
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let id = self.connections.dial();
        let dialling = self.inner.call(uri);
        let connections = self.connections.clone();
        Box::pin(async move {
            let io = dialling.await.map_err(Into::into)?;
            let connected = io.connected();
            connections.opened(id, route(&connected), connected.is_negotiated_h2());
            Ok(TrackedIo {
                io,
                id,
                connections,
            })
        })
    }
}

pub struct TrackedIo<T> {
    io: T,
    id: u64,
    connections: Connections,
}

impl<T> Drop for TrackedIo<T> {
    fn drop(&mut self) {
        self.connections.closed(self.id);
    }
}

impl<T: Connection> Connection for TrackedIo<T> {
    fn connected(&self) -> Connected {
        self.io.connected().extra(Id(self.id))
    }
}

impl<T: Read + Unpin> Read for TrackedIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl<T: Write + Unpin> Write for TrackedIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write_vectored(cx, bufs)
    }
}

/// The per-request side: captures each request's connection and holds the
/// gate while no connection is usable.
#[derive(Clone)]
pub struct ConnectionsLayer(pub Connections);

impl<S> Layer<S> for ConnectionsLayer {
    type Service = Pooled<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Pooled {
            connections: self.0.clone(),
            inner,
        }
    }
}

#[derive(Clone)]
pub struct Pooled<S> {
    connections: Connections,
    inner: S,
}

impl<S, B, R> Service<Request<B>> for Pooled<S>
where
    S: Service<Request<B>, Response = Response<R>> + Clone + Send + 'static,
    S::Future: Send,
    S::Error: Into<BoxError> + Send,
    B: Send + 'static,
    R: Send + 'static,
{
    type Response = Response<R>;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, BoxError>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        // Readiness is the inner service's, awaited past the gate.
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, mut request: Request<B>) -> Self::Future {
        let connections = self.connections.clone();
        let inner = self.inner.clone();
        Box::pin(async move {
            let capture = capture_connection(&mut request);
            let mut gate = connections.gate().await;
            let response = inner.oneshot(request);
            tokio::pin!(response);
            // The connection is noted as soon as the request has one, so
            // that retiring reaches it while its first response is due.
            let mut connected = capture.clone();
            let mut noted = false;
            let result = loop {
                tokio::select! {
                    result = &mut response => break result,
                    () = async { connected.wait_for_connection_metadata().await; }, if !noted => {
                        noted = true;
                        connections.used(capture.clone(), false);
                        gate.take();
                    }
                }
            }
            .map_err(Into::into);
            let going = result.as_ref().is_err_and(|error| going_away(&**error));
            connections.used(capture, going);
            result
        })
    }
}

#[cfg(test)]
mod tests {
    use hyper_util::client::legacy::connect::HttpConnector;

    use super::*;

    fn served(connections: &Connections, id: u64) {
        connections.state().open.get_mut(&id).unwrap().served = true;
    }

    #[tokio::test]
    async fn a_dialled_connection_keeps_its_route() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let connections = Connections::default();
        let mut tracked = Tracked::new(HttpConnector::new(), connections.clone());
        let _io = tracked
            .call(format!("http://{addr}").parse().unwrap())
            .await
            .unwrap();
        let route = connections.state().open[&0].route.unwrap();
        assert_eq!(
            (route.local, route.remote),
            (Ipv4Addr::LOCALHOST.into(), addr)
        );
        assert!(!connections.retire_moved());
    }

    #[test]
    fn a_new_dial_takes_the_open_http2_connections_out_of_use() {
        let connections = Connections::default();
        let h2 = connections.dial();
        connections.opened(h2, None, true);
        assert!(!connections.usable(), "not yet in the pool");
        served(&connections, h2);
        assert!(connections.usable());
        connections.dial();
        assert!(!connections.usable(), "the pool dials only past them");

        let connections = Connections::default();
        let handshaking = connections.dial();
        connections.opened(handshaking, None, true);
        connections.dial();
        served(&connections, handshaking);
        assert!(
            connections.usable(),
            "a dial during its handshake passed nothing"
        );

        let connections = Connections::default();
        let remote = SocketAddr::from((Ipv4Addr::new(10, 0, 0, 5), 6443));
        let route = Route {
            local: Ipv4Addr::new(192, 168, 1, 2).into(),
            remote,
        };
        let watched = connections.dial();
        connections.opened(watched, Some(route), true);
        served(&connections, watched);
        connections.dial();
        let elsewhere = Ipv4Addr::new(10, 8, 0, 2).into();
        assert!(
            connections.retire_if_moved(|_| Some(elsewhere)),
            "the streams left on a passed connection still move"
        );

        let connections = Connections::default();
        let http1 = connections.dial();
        connections.opened(http1, None, false);
        served(&connections, http1);
        connections.dial();
        assert!(
            connections.usable(),
            "an HTTP/1.1 connection may just be busy"
        );
    }

    #[test]
    fn loopback_routes_from_loopback() {
        let server = SocketAddr::from((Ipv4Addr::LOCALHOST, 6443));
        assert_eq!(source_for(server), Some(Ipv4Addr::LOCALHOST.into()));
    }

    #[test]
    fn a_moved_route_retires_every_connection() {
        let connections = Connections::default();
        let remote = SocketAddr::from((Ipv4Addr::new(10, 0, 0, 5), 6443));
        let local = Ipv4Addr::new(192, 168, 1, 2).into();
        let open = |connections: &Connections| {
            let id = connections.dial();
            connections.opened(id, Some(Route { local, remote }), false);
            served(connections, id);
        };
        open(&connections);
        open(&connections);
        let retired = connections.retired();

        assert!(!connections.retire_if_moved(|_| Some(local)));
        assert!(connections.usable());
        assert!(!retired.has_changed().unwrap());

        let elsewhere = Ipv4Addr::new(10, 8, 0, 2).into();
        assert!(connections.retire_if_moved(|_| Some(elsewhere)));
        assert!(!connections.usable());
        assert!(retired.has_changed().unwrap());

        open(&connections);
        assert!(connections.retire_if_moved(|_| None), "no route at all");
        assert!(!connections.usable());
    }
}
