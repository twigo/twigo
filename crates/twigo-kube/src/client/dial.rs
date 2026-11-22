//! The connection TLS to the API server runs over: straight to it, through
//! an HTTP CONNECT tunnel, or through SOCKS5 (ARCHITECTURE 6.3).

use std::convert::Infallible;
use std::future::{Future, Ready, ready};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use http::{HeaderValue, Uri};
use hyper::rt::{Read, ReadBufCursor, Write};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder, MaybeHttpsStream};
use hyper_util::client::legacy::connect::dns::GaiResolver;
use hyper_util::client::legacy::connect::proxy::{SocksV5, Tunnel};
use hyper_util::client::legacy::connect::{Connected, Connection, HttpConnector};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tower::util::MapErr;
use tower::{BoxError, Service, ServiceExt};

use super::proxy::Proxy;

/// A name that does not resolve. hyper-util keeps its `ConnectError` private,
/// so the resolver says it in a type of Twigo's own.
#[derive(Debug, thiserror::Error)]
#[error("the name does not resolve")]
pub struct Unresolved(#[source] io::Error);

/// A proxy that Twigo could not reach: its connection was refused or timed
/// out, its name does not resolve, or its certificate is not trusted.
#[derive(Debug, thiserror::Error)]
#[error("to the proxy")]
pub struct ProxyUnreachable(#[source] BoxError);

/// A proxy that answered the tunnel or the SOCKS handshake with a refusal or
/// an error, or left it half done, which says nothing of the cluster.
/// hyper-util's tunnel and SOCKS errors are not nameable.
#[derive(Debug, thiserror::Error)]
#[error("refused by the proxy")]
pub struct ProxyRefused(#[source] BoxError);

/// A proxy that tried the connection to the cluster and could not make it: a
/// SOCKS reply that says the network or the host was unreachable, the
/// connection refused or the TTL expired.
#[derive(Debug, thiserror::Error)]
#[error("through the proxy")]
pub struct ProxyFailed(#[source] BoxError);

/// The system's resolver, which hyper-util uses by default, with its failure
/// told by [`Unresolved`].
type Resolver = MapErr<GaiResolver, fn(io::Error) -> Unresolved>;

pub type Http = HttpConnector<Resolver>;

pub fn http() -> Http {
    HttpConnector::new_with_resolver(GaiResolver::new().map_err(Unresolved as fn(_) -> _))
}

#[derive(Clone)]
pub enum Dialer {
    Direct(Http),
    Tunnel {
        proxy: Uri,
        to_proxy: HttpsConnector<Http>,
        auth: Option<HeaderValue>,
    },
    Socks {
        proxy: Uri,
        to_proxy: Http,
        auth: Option<(String, String)>,
    },
}

impl Dialer {
    pub fn new(http: Http, proxy: Option<&Proxy>) -> Result<Self, rustls::Error> {
        let Some(proxy) = proxy else {
            return Ok(Dialer::Direct(http));
        };
        let uri = with_port(proxy.uri());
        if proxy.is_socks() {
            return Ok(Dialer::Socks {
                proxy: uri,
                to_proxy: http,
                auth: proxy
                    .intercept()
                    .raw_auth()
                    .map(|(user, password)| (user.to_owned(), password.to_owned())),
            });
        }
        // client-go checks an https proxy's certificate against the
        // cluster's CA, and would give it the cluster's client certificate
        // if asked, since Go's transport reuses its TLS config for the proxy
        // (`addTLS` in net/http). Twigo checks it against the OS's trust
        // store and gives it no certificate.
        let to_proxy = HttpsConnectorBuilder::new()
            .try_with_platform_verifier()?
            .https_or_http()
            .enable_http1()
            .wrap_connector(http);
        Ok(Dialer::Tunnel {
            proxy: uri,
            to_proxy,
            auth: proxy.intercept().basic_auth().cloned(),
        })
    }
}

/// The URL with Go's default port for its scheme: hyper-util knows none for
/// socks5, and its tunnels take 443 for any server without a port.
fn with_port(uri: &Uri) -> Uri {
    if uri.port().is_some() {
        return uri.clone();
    }
    let scheme = uri.scheme_str().unwrap_or("http");
    let port = match scheme {
        "https" => 443,
        "http" => 80,
        _ => 1080,
    };
    let host = uri.host().unwrap_or_default();
    format!("{scheme}://{host}:{port}")
        .parse()
        .unwrap_or_else(|_| uri.clone())
}

type Dialling = Pin<Box<dyn Future<Output = Result<Stream, BoxError>> + Send>>;

impl Service<Uri> for Dialer {
    type Response = Stream;
    type Error = BoxError;
    type Future = Dialling;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        match self {
            Dialer::Direct(http) => http.poll_ready(cx).map_err(Into::into),
            Dialer::Tunnel { .. } | Dialer::Socks { .. } => Poll::Ready(Ok(())),
        }
    }

    fn call(&mut self, server: Uri) -> Dialling {
        match self {
            Dialer::Direct(http) => {
                let dialling = http.call(server);
                Box::pin(async move { Ok(Stream::Tcp(dialling.await?)) })
            }
            Dialer::Tunnel {
                proxy,
                to_proxy,
                auth,
            } => {
                let (proxy, to_proxy, auth) = (proxy.clone(), to_proxy.clone(), auth.clone());
                Box::pin(async move {
                    let reached = reach(to_proxy, &proxy).await?;
                    let mut tunnel = Tunnel::new(proxy, Reached(Some(reached)));
                    if let Some(auth) = auth {
                        tunnel = tunnel.with_auth(auth);
                    }
                    let tunnel = tunnel
                        .oneshot(with_port(&server))
                        .await
                        .map_err(|error| ProxyRefused(error.into()))?;
                    Ok(Stream::Tunnel(Box::new(tunnel)))
                })
            }
            Dialer::Socks {
                proxy,
                to_proxy,
                auth,
            } => {
                let (proxy, to_proxy, auth) = (proxy.clone(), to_proxy.clone(), auth.clone());
                Box::pin(async move {
                    let reached = reach(to_proxy, &proxy).await?;
                    let mut socks = SocksV5::new(proxy, Reached(Some(reached)));
                    if let Some((user, password)) = auth {
                        socks = socks.with_auth(user, password);
                    }
                    let tcp = socks.oneshot(with_port(&server)).await.map_err(declined)?;
                    Ok(Stream::Tcp(tcp))
                })
            }
        }
    }
}

/// [`ProxyFailed`] for a reply that says the proxy tried the cluster and could
/// not get there, else [`ProxyRefused`].
///
/// @todo: read the reply from `SocksV5Error`'s variants, not its words, once
/// hyper-util exports it (a private module in 0.1.21).
fn declined<E: std::error::Error + Send + Sync + 'static>(error: E) -> BoxError {
    const TRIED: [&str; 4] = [
        "SOCKS error: network unreachable",
        "SOCKS error: host unreachable",
        "SOCKS error: connection refused",
        "SOCKS error: ttl expired",
    ];
    if TRIED.contains(&error.to_string().as_str()) {
        ProxyFailed(error.into()).into()
    } else {
        ProxyRefused(error.into()).into()
    }
}

/// The connection to the proxy, made apart from the tunnel or the handshake
/// that goes over it, so a failure of either says which it was.
async fn reach<C>(to_proxy: C, proxy: &Uri) -> Result<C::Response, ProxyUnreachable>
where
    C: Service<Uri>,
    C::Error: Into<BoxError>,
{
    to_proxy
        .oneshot(proxy.clone())
        .await
        .map_err(|error| ProxyUnreachable(error.into()))
}

/// A connector that hands over the connection already made.
struct Reached<T>(Option<T>);

impl<T> Service<Uri> for Reached<T> {
    type Response = T;
    type Error = Infallible;
    type Future = Ready<Result<T, Infallible>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _: Uri) -> Self::Future {
        ready(Ok(self
            .0
            .take()
            .expect("a tunnel or a handshake dials once")))
    }
}

pub enum Stream {
    Tcp(TokioIo<TcpStream>),
    /// TLS to an https proxy, or TCP to an http one.
    Tunnel(Box<MaybeHttpsStream<TokioIo<TcpStream>>>),
}

impl Connection for Stream {
    fn connected(&self) -> Connected {
        match self {
            Stream::Tcp(tcp) => tcp.connected(),
            Stream::Tunnel(tunnel) => tunnel.connected(),
        }
    }
}

impl Read for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Tcp(tcp) => Pin::new(tcp).poll_read(cx, buf),
            Stream::Tunnel(tunnel) => Pin::new(&mut **tunnel).poll_read(cx, buf),
        }
    }
}

impl Write for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Tcp(tcp) => Pin::new(tcp).poll_write(cx, buf),
            Stream::Tunnel(tunnel) => Pin::new(&mut **tunnel).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Tcp(tcp) => Pin::new(tcp).poll_flush(cx),
            Stream::Tunnel(tunnel) => Pin::new(&mut **tunnel).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Tcp(tcp) => Pin::new(tcp).poll_shutdown(cx),
            Stream::Tunnel(tunnel) => Pin::new(&mut **tunnel).poll_shutdown(cx),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Stream::Tcp(tcp) => tcp.is_write_vectored(),
            Stream::Tunnel(tunnel) => tunnel.is_write_vectored(),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Tcp(tcp) => Pin::new(tcp).poll_write_vectored(cx, bufs),
            Stream::Tunnel(tunnel) => Pin::new(&mut **tunnel).poll_write_vectored(cx, bufs),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_default_by_scheme() {
        let port = |url: &str| with_port(&url.parse().unwrap()).port_u16();
        assert_eq!(port("http://api.example.com"), Some(80));
        assert_eq!(port("https://api.example.com"), Some(443));
        assert_eq!(port("socks5://proxy"), Some(1080));
        assert_eq!(port("http://api.example.com:6443"), Some(6443));
        let v6 = with_port(&"https://[fd00::5]".parse().unwrap());
        assert_eq!(v6.to_string(), "https://[fd00::5]:443/");
    }
}
