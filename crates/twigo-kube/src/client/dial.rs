//! The connection TLS to the API server runs over: straight to it, through
//! an HTTP CONNECT tunnel, or through SOCKS5 (ARCHITECTURE 6.3).

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use http::Uri;
use hyper::rt::{Read, ReadBufCursor, Write};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder, MaybeHttpsStream};
use hyper_util::client::legacy::connect::proxy::{SocksV5, Tunnel};
use hyper_util::client::legacy::connect::{Connected, Connection, HttpConnector};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tower::{BoxError, Service};

use super::proxy::Proxy;

#[derive(Clone)]
pub enum Dialer {
    Direct(HttpConnector),
    Tunnel(Tunnel<HttpsConnector<HttpConnector>>),
    Socks(SocksV5<HttpConnector>),
}

impl Dialer {
    pub fn new(http: HttpConnector, proxy: Option<&Proxy>) -> Result<Self, rustls::Error> {
        let Some(proxy) = proxy else {
            return Ok(Dialer::Direct(http));
        };
        let uri = with_port(proxy.uri());
        if proxy.is_socks() {
            let mut socks = SocksV5::new(uri, http);
            if let Some((user, password)) = proxy.intercept().raw_auth() {
                socks = socks.with_auth(user.to_owned(), password.to_owned());
            }
            return Ok(Dialer::Socks(socks));
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
        let mut tunnel = Tunnel::new(uri, to_proxy);
        if let Some(auth) = proxy.intercept().basic_auth() {
            tunnel = tunnel.with_auth(auth.clone());
        }
        Ok(Dialer::Tunnel(tunnel))
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
            Dialer::Tunnel(tunnel) => tunnel.poll_ready(cx).map_err(Into::into),
            Dialer::Socks(socks) => socks.poll_ready(cx).map_err(Into::into),
        }
    }

    fn call(&mut self, server: Uri) -> Dialling {
        match self {
            Dialer::Direct(http) => {
                let dialling = http.call(server);
                Box::pin(async move { Ok(Stream::Tcp(dialling.await?)) })
            }
            Dialer::Tunnel(tunnel) => {
                let dialling = tunnel.call(with_port(&server));
                Box::pin(async move { Ok(Stream::Tunnel(Box::new(dialling.await?))) })
            }
            Dialer::Socks(socks) => {
                let dialling = socks.call(with_port(&server));
                Box::pin(async move { Ok(Stream::Tcp(dialling.await?)) })
            }
        }
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
