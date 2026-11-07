//! A kind cluster through a kubeconfig's `proxy-url`, an HTTP CONNECT proxy
//! and a SOCKS5 one written here, each counting its connections. kind's API
//! server listens on loopback, which the environment's proxy never serves,
//! so the environment's rules are the unit tests' (`client::proxy`).

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::future::join_all;
use http::{Request, Version};
use kube::Config;
use kube::config::{KubeConfigOptions, Kubeconfig};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use twigo_kube::client::{Clients, Gate, Options, ProxyEnv, proxy_for};

async fn config() -> Config {
    let path = std::env::var_os("TWIGO_TEST_KUBECONFIG")
        .expect("TWIGO_TEST_KUBECONFIG must name the kubeconfig of a kind or kwok cluster");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.clone().unwrap_or_default();
    assert!(
        context.starts_with("kind-") || context.starts_with("kwok-"),
        "refusing context {context:?}: these tests run only against kind and kwok clusters"
    );
    Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap()
}

struct Listening {
    addr: SocketAddr,
    accepted: Arc<AtomicUsize>,
}

async fn listen(serve: fn(TcpStream) -> futures::future::BoxFuture<'static, ()>) -> Listening {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&accepted);
    tokio::spawn(async move {
        loop {
            let (client, _) = listener.accept().await.unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(serve(client));
        }
    });
    Listening { addr, accepted }
}

/// Reads `CONNECT host:port HTTP/1.1` and its headers, then splices.
fn connect(client: TcpStream) -> futures::future::BoxFuture<'static, ()> {
    Box::pin(async move {
        let mut client = BufReader::new(client);
        let mut line = String::new();
        client.read_line(&mut line).await.unwrap();
        let target = line.split(' ').nth(1).unwrap().to_owned();
        assert!(line.starts_with("CONNECT "), "{line}");
        loop {
            line.clear();
            client.read_line(&mut line).await.unwrap();
            if line == "\r\n" {
                break;
            }
        }
        let mut server = TcpStream::connect(target).await.unwrap();
        let mut client = client.into_inner();
        client
            .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
            .await
            .unwrap();
        let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
    })
}

/// RFC 1928 without authentication, CONNECT only.
fn socks5(mut client: TcpStream) -> futures::future::BoxFuture<'static, ()> {
    Box::pin(async move {
        let mut greeting = [0; 2];
        client.read_exact(&mut greeting).await.unwrap();
        let mut methods = vec![0; greeting[1].into()];
        client.read_exact(&mut methods).await.unwrap();
        assert!(greeting[0] == 5 && methods.contains(&0));
        client.write_all(&[5, 0]).await.unwrap();

        let mut request = [0; 4];
        client.read_exact(&mut request).await.unwrap();
        assert_eq!(request[..3], [5, 1, 0], "a CONNECT");
        let target = match request[3] {
            1 => {
                let mut ip = [0; 4];
                client.read_exact(&mut ip).await.unwrap();
                Ipv4Addr::from(ip).to_string()
            }
            3 => {
                let mut name = vec![0; client.read_u8().await.unwrap().into()];
                client.read_exact(&mut name).await.unwrap();
                String::from_utf8(name).unwrap()
            }
            4 => {
                let mut ip = [0; 16];
                client.read_exact(&mut ip).await.unwrap();
                format!("[{}]", Ipv6Addr::from(ip))
            }
            other => panic!("address type {other}"),
        };
        let port = client.read_u16().await.unwrap();
        let mut server = TcpStream::connect(format!("{target}:{port}"))
            .await
            .unwrap();
        client
            .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();
        let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
    })
}

async fn through(proxy_url: &str) -> Clients {
    let config = config().await;
    let proxy = proxy_for(&config.cluster_url, Some(proxy_url), &ProxyEnv::default()).unwrap();
    assert!(proxy.is_some());
    Clients::new(
        &config,
        Gate::unrestricted(),
        Options {
            proxy,
            ..Options::default()
        },
    )
    .unwrap()
}

async fn versions(clients: &Clients) -> Vec<Version> {
    join_all((0..10).map(|_| async {
        let request = Request::get("/version").body(Vec::new()).unwrap();
        clients
            .api
            .send(request.map(Into::into))
            .await
            .unwrap()
            .version()
    }))
    .await
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_cluster_answers_over_http2_through_an_http_connect_proxy() {
    let proxy = listen(connect).await;
    let clients = through(&format!("http://{}", proxy.addr)).await;
    assert!(
        versions(&clients)
            .await
            .iter()
            .all(|v| *v == Version::HTTP_2)
    );
    assert_eq!(proxy.accepted.load(Ordering::SeqCst), 1);
    assert_eq!(clients.connections().dialled(), 1);
}

#[tokio::test]
#[ignore = "needs TWIGO_TEST_KUBECONFIG"]
async fn a_cluster_answers_over_http2_through_a_socks5_proxy() {
    let proxy = listen(socks5).await;
    let clients = through(&format!("socks5://{}", proxy.addr)).await;
    assert!(
        versions(&clients)
            .await
            .iter()
            .all(|v| *v == Version::HTTP_2)
    );
    assert_eq!(proxy.accepted.load(Ordering::SeqCst), 1);
    assert_eq!(clients.connections().dialled(), 1);
}
