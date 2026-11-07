//! An HTTP/2 server written frame by frame over TLS, for the client's
//! tests: h2's own server names in its GOAWAY every stream it has read, so it
//! cannot leave one unprocessed.

use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use http::Request;
use kube::Config;
use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use twigo_kube::client::{Clients, Gate, Options};

const HEADERS: u8 = 0x1;
const RST_STREAM: u8 = 0x3;
const SETTINGS: u8 = 0x4;
const PING: u8 = 0x6;
const GOAWAY: u8 = 0x7;
const DATA: u8 = 0x0;
const END_STREAM: u8 = 0x1;
const END_HEADERS: u8 = 0x4;
const ACK: u8 = 0x1;
pub const NO_ERROR: u32 = 0x0;
pub const REFUSED_STREAM: u32 = 0x7;
pub const ENHANCE_YOUR_CALM: u32 = 0xb;

/// What the first connection does with the streams after its first.
#[derive(Clone, Copy)]
pub enum Refusal {
    /// Once it has read this many, a GOAWAY whose last stream is the first;
    /// when `watch`, the first stream stays open, as a watch's would.
    GoAway {
        code: u32,
        after: usize,
        watch: bool,
    },
    /// A REFUSED_STREAM for the second.
    Reset,
    /// A GOAWAY whose last stream is the first, then the connection closes
    /// without answering it.
    Drop { code: u32 },
    /// The first answered this late.
    Delay(std::time::Duration),
}

pub struct Server {
    addr: SocketAddr,
    ca: CertificateDer<'static>,
    /// The (connection, stream) of every request answered.
    pub answered: Arc<Mutex<Vec<(usize, u32)>>>,
    /// The pings answered, of every connection.
    pub pings: Arc<AtomicUsize>,
}

pub async fn serve(refusal: Option<Refusal>) -> Server {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca = CertifiedIssuer::self_signed(ca_params, ca_key).unwrap();
    let key = KeyPair::generate().unwrap();
    let leaf = CertificateParams::new(vec!["localhost".to_owned()])
        .unwrap()
        .signed_by(&key, &ca)
        .unwrap();
    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(
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
    tls.alpn_protocols = vec![b"h2".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(tls));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let answered = Arc::new(Mutex::new(Vec::new()));
    let pings = Arc::new(AtomicUsize::new(0));
    let (log, pinged) = (Arc::clone(&answered), Arc::clone(&pings));
    tokio::spawn(async move {
        let mut connection = 0;
        loop {
            let (tcp, _) = listener.accept().await.unwrap();
            let stream = acceptor.accept(tcp).await.unwrap();
            let refusal = refusal.filter(|_| connection == 0);
            // Its error goes unread: the client may close a connection
            // mid-frame.
            let (log, pinged) = (Arc::clone(&log), Arc::clone(&pinged));
            tokio::spawn(answer(stream, connection, refusal, log, pinged));
            connection += 1;
        }
    });
    Server {
        addr,
        ca: ca.der().clone(),
        answered,
        pings,
    }
}

async fn answer(
    mut io: impl AsyncRead + AsyncWrite + Unpin,
    connection: usize,
    refusal: Option<Refusal>,
    answered: Arc<Mutex<Vec<(usize, u32)>>>,
    pings: Arc<AtomicUsize>,
) -> io::Result<()> {
    let mut preface = [0; 24];
    io.read_exact(&mut preface).await?;
    write(&mut io, SETTINGS, 0, 0, &[]).await?;
    let mut requests = 0;
    let mut first = 0;
    while let Some((kind, flags, stream, payload)) = read(&mut io).await? {
        match kind {
            SETTINGS if flags & ACK == 0 => write(&mut io, SETTINGS, ACK, 0, &[]).await?,
            PING if flags & ACK == 0 => {
                write(&mut io, PING, ACK, 0, &payload).await?;
                pings.fetch_add(1, Ordering::SeqCst);
            }
            HEADERS => {
                requests += 1;
                match (requests, refusal) {
                    (1, Some(Refusal::GoAway { watch: true, .. })) => {
                        first = stream;
                        write(&mut io, HEADERS, END_HEADERS, stream, &[0x88]).await?;
                        write(&mut io, DATA, 0, stream, b"ok").await?;
                        answered.lock().unwrap().push((connection, stream));
                        continue;
                    }
                    (1, Some(Refusal::Drop { code })) => {
                        let mut payload = stream.to_be_bytes().to_vec();
                        payload.extend(code.to_be_bytes());
                        write(&mut io, GOAWAY, 0, 0, &payload).await?;
                        return Ok(());
                    }
                    (1, Some(Refusal::Delay(delay))) => {
                        first = stream;
                        tokio::time::sleep(delay).await;
                    }
                    (1, _) => first = stream,
                    (_, Some(Refusal::GoAway { code, after, .. })) if requests <= after + 1 => {
                        if requests == after + 1 {
                            let mut payload = first.to_be_bytes().to_vec();
                            payload.extend(code.to_be_bytes());
                            write(&mut io, GOAWAY, 0, 0, &payload).await?;
                        }
                        continue;
                    }
                    (2, Some(Refusal::Reset)) => {
                        write(
                            &mut io,
                            RST_STREAM,
                            0,
                            stream,
                            &REFUSED_STREAM.to_be_bytes(),
                        )
                        .await?;
                        continue;
                    }
                    _ => {}
                }
                // `:status: 200`, entry 8 of HPACK's static table.
                write(&mut io, HEADERS, END_HEADERS, stream, &[0x88]).await?;
                write(&mut io, DATA, END_STREAM, stream, b"ok").await?;
                answered.lock().unwrap().push((connection, stream));
            }
            _ => {}
        }
    }
    Ok(())
}

/// None at the end of the connection.
async fn read(io: &mut (impl AsyncRead + Unpin)) -> io::Result<Option<(u8, u8, u32, Vec<u8>)>> {
    let mut header = [0; 9];
    match io.read_exact(&mut header).await {
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        read => read?,
    };
    let length = u32::from_be_bytes([0, header[0], header[1], header[2]]) as usize;
    let stream = u32::from_be_bytes([header[5], header[6], header[7], header[8]]) & 0x7fff_ffff;
    let mut payload = vec![0; length];
    io.read_exact(&mut payload).await?;
    Ok(Some((header[3], header[4], stream, payload)))
}

async fn write(
    io: &mut (impl AsyncWrite + Unpin),
    kind: u8,
    flags: u8,
    stream: u32,
    payload: &[u8],
) -> io::Result<()> {
    let mut frame = (payload.len() as u32).to_be_bytes()[1..].to_vec();
    frame.extend([kind, flags]);
    frame.extend(stream.to_be_bytes());
    frame.extend(payload);
    io.write_all(&frame).await?;
    io.flush().await
}

pub fn clients(server: &Server) -> Clients {
    let url = format!("https://localhost:{}", server.addr.port());
    let mut config = Config::new(url.parse().unwrap());
    config.root_cert = Some(vec![server.ca.to_vec()]);
    Clients::new(&config, Gate::unrestricted(), Options::default()).unwrap()
}

pub async fn watch(clients: &Clients) -> impl futures::AsyncBufRead + use<> {
    let request = Request::get("/watch").body(Vec::new()).unwrap();
    clients.api.request_stream(request).await.unwrap()
}

pub async fn get(clients: &Clients, path: &str) -> Result<String, kube::Error> {
    let request = Request::get(path).body(Vec::new()).unwrap();
    clients.api.request_text(request).await
}
