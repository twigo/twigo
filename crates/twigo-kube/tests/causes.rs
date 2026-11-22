//! What a request that gets no answer says: the code of the cause that
//! stopped it, and the innermost cause in its message, against local sockets.

use std::sync::Arc;
use std::time::Duration;

use http::Request;
use kube::Config;
use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair};
use rustls::pki_types::PrivateKeyDer;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use twigo_ipc::{ErrorCode, ErrorKind, IpcError};
use twigo_kube::client::{Clients, Gate, Options, ProxyEnv, proxy_for};
use twigo_kube::errors;

async fn failure(config: &Config, options: Options) -> IpcError {
    let clients = Clients::new(config, Gate::unrestricted(), options).unwrap();
    let request = Request::get("/version").body(Vec::new()).unwrap();
    let error = clients
        .api
        .request_text(request)
        .await
        .expect_err("nothing answers");
    errors::request(&error)
}

fn config(url: &str) -> Config {
    Config::new(url.parse().unwrap())
}

async fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

async fn replying(reply: &'static [u8]) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut tcp, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buffer = [0; 1024];
                let _ = tcp.read(&mut buffer).await;
                let _ = tcp.write_all(reply).await;
            });
        }
    });
    port
}

fn ca() -> CertifiedIssuer<'static, KeyPair> {
    let mut params = CertificateParams::new(Vec::new()).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    CertifiedIssuer::self_signed(params, KeyPair::generate().unwrap()).unwrap()
}

#[tokio::test]
async fn a_port_that_refuses() {
    let port = closed_port().await;
    let error = failure(
        &config(&format!("https://127.0.0.1:{port}")),
        Options::default(),
    )
    .await;
    assert_eq!(error.code, ErrorCode::ConnectRefused);
    assert_eq!(error.kind, ErrorKind::Unavailable);
    assert!(error.message.contains("onnection refused"), "{error:?}");
}

#[tokio::test]
async fn a_name_that_does_not_resolve() {
    let error = failure(
        &config("https://twigo-probe.invalid:6443"),
        Options::default(),
    )
    .await;
    assert_eq!(error.code, ErrorCode::ConnectUnresolved);
    assert!(error.message.contains("lookup address"), "{error:?}");
}

#[tokio::test]
async fn a_certificate_that_no_trusted_authority_signed() {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
    params
        .distinguished_name
        .push(DnType::CommonName, "a server nobody trusts");
    let leaf = params.self_signed(&key).unwrap();
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![leaf.der().clone()],
        PrivateKeyDer::Pkcs8(key.serialize_der().into()),
    )
    .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(tls));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (tcp, _) = listener.accept().await.unwrap();
            let _ = acceptor.accept(tcp).await;
        }
    });
    let mut config = config(&format!("https://localhost:{port}"));
    config.root_cert = Some(vec![ca().der().to_vec()]);
    let error = failure(&config, Options::default()).await;
    assert_eq!(error.code, ErrorCode::ConnectCertificate);
    assert!(error.message.contains("UnknownIssuer"), "{error:?}");
}

#[tokio::test]
async fn a_server_that_does_not_speak_tls() {
    let port = replying(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
    let error = failure(
        &config(&format!("https://localhost:{port}")),
        Options::default(),
    )
    .await;
    assert_eq!(error.code, ErrorCode::ConnectTls);
}

#[tokio::test]
async fn a_server_that_accepts_and_never_answers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        loop {
            held.push(listener.accept().await.unwrap());
        }
    });
    let mut config = config(&format!("https://localhost:{port}"));
    config.connect_timeout = Some(Duration::from_millis(300));
    let error = failure(&config, Options::default()).await;
    assert_eq!(error.code, ErrorCode::ConnectTimeout);
    assert_eq!(error.kind, ErrorKind::Timeout);
}

async fn through(proxy_url: &str) -> IpcError {
    let config = config("https://localhost:6443");
    let proxy = proxy_for(&config.cluster_url, Some(proxy_url), &ProxyEnv::default()).unwrap();
    let options = Options {
        proxy,
        ..Options::default()
    };
    failure(&config, options).await
}

async fn accepting<Serving>(serve: impl Fn(TcpStream) -> Serving + Send + 'static) -> u16
where
    Serving: std::future::Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (tcp, _) = listener.accept().await.unwrap();
            tokio::spawn(serve(tcp));
        }
    });
    port
}

async fn socks_replying(reply: u8) -> u16 {
    accepting(move |mut tcp| async move {
        let mut buffer = [0; 512];
        let _ = tcp.read(&mut buffer).await;
        let _ = tcp.write_all(&[5, 0]).await;
        let _ = tcp.read(&mut buffer).await;
        let _ = tcp.write_all(&[5, reply, 0, 1, 0, 0, 0, 0, 0, 0]).await;
    })
    .await
}

async fn socks_refusing_credentials() -> u16 {
    accepting(|mut tcp| async move {
        let mut buffer = [0; 512];
        let _ = tcp.read(&mut buffer).await;
        let _ = tcp.write_all(&[5, 2]).await;
        let _ = tcp.read(&mut buffer).await;
        let _ = tcp.write_all(&[1, 1]).await;
    })
    .await
}

const UNREACHED: &str = "Twigo could not reach the proxy: ";
const DECLINED: &str = "The proxy did not open the connection to the cluster: ";
const FAILED: &str = "The proxy could not reach the cluster: ";

#[tokio::test]
async fn a_proxy_that_is_not_there() {
    let port = closed_port().await;
    let error = through(&format!("http://127.0.0.1:{port}")).await;
    assert_eq!(error.code, ErrorCode::ConnectProxy);
    assert!(error.message.starts_with(UNREACHED), "{error:?}");
    assert!(error.message.contains("onnection refused"), "{error:?}");
}

#[tokio::test]
async fn a_proxy_that_answers_the_tunnel_with_a_refusal_did_not_open_it() {
    for (reply, inner) in [
        (
            b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n".as_slice(),
            "proxy authorization required",
        ),
        (b"HTTP/1.1 403 Forbidden\r\n\r\n".as_slice(), "unsuccessful"),
    ] {
        let port = replying(reply).await;
        let error = through(&format!("http://127.0.0.1:{port}")).await;
        assert_eq!(error.code, ErrorCode::ConnectProxy);
        assert!(error.message.starts_with(DECLINED), "{error:?}");
        assert!(error.message.contains(inner), "{error:?}");
    }
}

#[tokio::test]
async fn a_socks_proxy_that_is_not_there() {
    let port = closed_port().await;
    let error = through(&format!("socks5://127.0.0.1:{port}")).await;
    assert_eq!(error.code, ErrorCode::ConnectProxy);
    assert!(error.message.starts_with(UNREACHED), "{error:?}");
    assert!(error.message.contains("onnection refused"), "{error:?}");
}

#[tokio::test]
async fn a_socks_reply_says_whether_the_proxy_tried_the_cluster() {
    for (reply, tried, inner) in [
        (3, true, "network unreachable"),
        (4, true, "host unreachable"),
        (5, true, "connection refused"),
        (6, true, "ttl expired"),
        (1, false, "general server failure"),
        (2, false, "connection not allowed"),
        (7, false, "command not supported"),
    ] {
        let port = socks_replying(reply).await;
        let error = through(&format!("socks5://127.0.0.1:{port}")).await;
        assert_eq!(error.code, ErrorCode::ConnectProxy);
        let start = if tried { FAILED } else { DECLINED };
        assert!(error.message.starts_with(start), "{error:?}");
        assert!(error.message.ends_with(inner), "{error:?}");
    }
}

#[tokio::test]
async fn a_socks_proxy_that_refuses_the_credentials_did_not_open_the_connection() {
    let port = socks_refusing_credentials().await;
    let error = through(&format!("socks5://twigo:wrong@127.0.0.1:{port}")).await;
    assert_eq!(error.code, ErrorCode::ConnectProxy);
    assert!(error.message.starts_with(DECLINED), "{error:?}");
    assert!(
        error.message.contains("credentials not accepted"),
        "{error:?}"
    );
}

#[tokio::test]
async fn an_answer_that_is_no_status_has_no_server_status() {
    let port = replying(
        b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 18\r\n\r\n404 page not found",
    )
    .await;
    let error = failure(
        &config(&format!("http://127.0.0.1:{port}")),
        Options::default(),
    )
    .await;
    assert_eq!(error.code, ErrorCode::ServerNotFound);
    assert_eq!(error.message, "404 page not found");
    assert_eq!(error.server, None);
}
