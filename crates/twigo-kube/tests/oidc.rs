//! The `auth-provider: oidc` refresh against an in-test issuer over HTTPS,
//! which rotates the refresh token on every use, as Dex does by default.

use std::collections::HashMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use futures::future::join_all;
use jiff::{SignedDuration, Timestamp};
use kube::config::Kubeconfig;
use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use secrecy::ExposeSecret;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;
use twigo_env::ShellEnv;
use twigo_kube::credentials::{Oidc, OidcEntry, OidcError, Registry, Timeouts};

/// A JWT whose `exp` is `from_now` away; its signature goes unchecked.
fn jwt(from_now: SignedDuration, n: u32) -> String {
    let part = |json: serde_json::Value| URL_SAFE_NO_PAD.encode(json.to_string());
    let exp = (Timestamp::now() + from_now).as_second();
    format!(
        "{}.{}.sig",
        part(serde_json::json!({"alg": "none"})),
        part(serde_json::json!({"exp": exp, "n": n}))
    )
}

#[derive(Default)]
struct Issued {
    /// The refresh token the issuer takes next.
    refresh: String,
    /// The form and `Authorization` header of each token request.
    grants: Vec<(HashMap<String, String>, Option<String>)>,
    /// The issuer answers only a form that carries the client's secret.
    form_only: bool,
    /// How long the id-tokens it issues last; an hour when unset.
    lifetime: Option<SignedDuration>,
    /// The bearer tokens of the requests to `/version`, which it answers
    /// with a 401, as an API server that rejects the token.
    rejected: Vec<Option<String>>,
    token_delay: Option<std::time::Duration>,
}

struct Issuer {
    addr: SocketAddr,
    ca_pem: String,
    issued: Arc<Mutex<Issued>>,
}

impl Issuer {
    async fn start(refresh: &str) -> Self {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut params = CertificateParams::new(Vec::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca = CertifiedIssuer::self_signed(params, KeyPair::generate().unwrap()).unwrap();
        let key = KeyPair::generate().unwrap();
        let leaf = CertificateParams::new(vec!["localhost".to_owned()])
            .unwrap()
            .signed_by(&key, &ca)
            .unwrap();
        let mut tls = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf.der().clone()],
                PrivateKeyDer::Pkcs8(key.serialize_der().into()),
            )
            .unwrap();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let acceptor = TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let issued = Arc::new(Mutex::new(Issued {
            refresh: refresh.to_owned(),
            ..Issued::default()
        }));
        let state = Arc::clone(&issued);
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let Ok(stream) = acceptor.accept(tcp).await else {
                    continue;
                };
                tokio::spawn(answer(stream, addr, Arc::clone(&state)));
            }
        });
        Self {
            addr,
            ca_pem: ca.pem(),
            issued,
        }
    }

    fn url(&self) -> String {
        format!("https://localhost:{}", self.addr.port())
    }

    fn grants(&self) -> Vec<(HashMap<String, String>, Option<String>)> {
        self.issued.lock().unwrap().grants.clone()
    }
}

async fn answer(
    mut stream: tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
    addr: SocketAddr,
    issued: Arc<Mutex<Issued>>,
) {
    let mut buffer = Vec::new();
    loop {
        let (head, body) = loop {
            if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().ok())?
                    })
                    .unwrap_or(0);
                if buffer.len() >= end + 4 + length {
                    let body =
                        String::from_utf8_lossy(&buffer[end + 4..end + 4 + length]).into_owned();
                    buffer.drain(..end + 4 + length);
                    break (head, body);
                }
            }
            let mut chunk = [0; 4096];
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            }
        };
        let (status, json) = if head.starts_with("GET /version ") {
            let bearer = head.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("authorization")
                    .then(|| value.trim().strip_prefix("Bearer ").map(str::to_owned))?
            });
            issued.lock().unwrap().rejected.push(bearer);
            (
                401,
                serde_json::json!({"kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 401}),
            )
        } else if head.starts_with("GET /.well-known/openid-configuration ") {
            let url = format!("https://localhost:{}", addr.port());
            (
                200,
                serde_json::json!({"issuer": url, "token_endpoint": format!("{url}/token")}),
            )
        } else if head.starts_with("POST /token ") {
            let form: HashMap<String, String> = form_urlencoded::parse(body.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            let basic = head.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("authorization")
                    .then(|| value.trim().to_owned())
            });
            let delay = issued.lock().unwrap().token_delay;
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            let mut issued = issued.lock().unwrap();
            issued.grants.push((form.clone(), basic.clone()));
            let client_ok = if issued.form_only {
                form.get("client_secret").map(String::as_str) == Some("s3cret")
            } else {
                basic.as_deref() == Some(&format!("Basic {}", STANDARD.encode("twigo:s3cret")))
            };
            if !client_ok {
                (401, serde_json::json!({"error": "invalid_client"}))
            } else if form.get("refresh_token") != Some(&issued.refresh) {
                (400, serde_json::json!({"error": "invalid_grant"}))
            } else {
                let n = u32::try_from(issued.grants.len()).unwrap();
                issued.refresh = format!("r{}", n + 1);
                (
                    200,
                    serde_json::json!({
                        "id_token": jwt(issued.lifetime.unwrap_or(SignedDuration::from_hours(1)), n),
                        "refresh_token": issued.refresh,
                        "token_type": "bearer",
                    }),
                )
            }
        } else {
            (404, serde_json::json!({}))
        };
        let body = json.to_string();
        let response = format!(
            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        if stream.write_all(response.as_bytes()).await.is_err() {
            return;
        }
    }
}

/// A kubeconfig as people keep them: comments, a context in flow style,
/// the provider's settings in block style.
fn kubeconfig(issuer: &Issuer, id_token: &str, refresh_token: Option<&str>) -> String {
    let refresh = refresh_token
        .map(|token| format!("        refresh-token: {token}\n"))
        .unwrap_or_default();
    format!(
        "# Clusters of the payments team.
apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {{ server: 'https://127.0.0.1:1' }}
contexts:
- name: kind-oidc
  context: {{ cluster: c, user: dev }} # the dev login
users:
- name: dev
  user:
    auth-provider:
      name: oidc
      config:
        idp-issuer-url: {}
        client-id: twigo
        client-secret: s3cret
        idp-certificate-authority-data: {}
        id-token: {id_token} # rotated by kubectl
{refresh}",
        issuer.url(),
        STANDARD.encode(&issuer.ca_pem),
    )
}

struct Setup {
    dir: TempDir,
    file: PathBuf,
    registry: Registry,
    oidc: Arc<Oidc>,
}

fn setup(text: &str) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("config");
    std::fs::write(&file, text).unwrap();
    let env: ShellEnv = Vec::<(OsString, OsString)>::new().into_iter().collect();
    let registry = Registry::new(
        watch::channel(Some(Arc::new(env))).1,
        watch::channel(true).1,
        Timeouts::default(),
    );
    let oidc = registry.oidc(Some(file.clone()), "dev", entry(&file));
    Setup {
        dir,
        file,
        registry,
        oidc,
    }
}

fn entry(file: &Path) -> OidcEntry {
    let config = Kubeconfig::read_from(file).unwrap();
    let provider = config.auth_infos[0]
        .auth_info
        .as_ref()
        .unwrap()
        .auth_provider
        .as_ref()
        .unwrap();
    OidcEntry::of(&provider.config).unwrap()
}

fn token(credential: &twigo_kube::credentials::Credential) -> String {
    credential.token().unwrap().expose_secret().to_owned()
}

#[tokio::test]
async fn an_expired_token_is_refreshed_and_only_the_two_values_change_in_the_file() {
    let issuer = Issuer::start("r1").await;
    let expired = jwt(SignedDuration::from_secs(-60), 0);
    let before = kubeconfig(&issuer, &expired, Some("r1"));
    let setup = setup(&before);

    let refreshed = token(&setup.oidc.credential().await.unwrap());
    assert_ne!(refreshed, expired);
    let grants = issuer.grants();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].0["grant_type"], "refresh_token");
    assert_eq!(grants[0].0["refresh_token"], "r1");

    let after = std::fs::read_to_string(&setup.file).unwrap();
    let changed: Vec<(&str, &str)> = before
        .lines()
        .zip(after.lines())
        .filter(|(a, b)| a != b)
        .collect();
    assert_eq!(
        changed,
        [
            (
                format!("        id-token: {expired} # rotated by kubectl").as_str(),
                format!("        id-token: {refreshed} # rotated by kubectl").as_str()
            ),
            ("        refresh-token: r1", "        refresh-token: r2"),
        ]
    );
    assert_eq!(before.lines().count(), after.lines().count());
    assert!(!lock(&setup.file).exists());
}

#[tokio::test]
async fn concurrent_requests_spend_the_refresh_token_once() {
    let issuer = Issuer::start("r1").await;
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        Some("r1"),
    ));
    let tokens = join_all((0..10).map(|_| setup.oidc.credential())).await;
    let first = token(tokens[0].as_ref().unwrap());
    assert!(tokens.iter().all(|t| token(t.as_ref().unwrap()) == first));
    assert_eq!(issuer.grants().len(), 1);
}

#[tokio::test]
async fn a_token_kubectl_got_meanwhile_is_taken_rather_than_refreshed() {
    let issuer = Issuer::start("r1").await;
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        Some("r1"),
    ));
    let from_kubectl = jwt(SignedDuration::from_hours(1), 99);
    std::fs::write(
        &setup.file,
        kubeconfig(&issuer, &from_kubectl, Some("r-kubectl")),
    )
    .unwrap();
    assert_eq!(token(&setup.oidc.credential().await.unwrap()), from_kubectl);
    assert!(issuer.grants().is_empty());
}

#[tokio::test]
async fn a_held_lock_keeps_the_new_tokens_in_memory_and_the_file_as_it_was() {
    let issuer = Issuer::start("r1").await;
    let before = kubeconfig(&issuer, &jwt(SignedDuration::from_secs(-60), 0), Some("r1"));
    let setup = setup(&before);
    std::fs::write(lock(&setup.file), "").unwrap();
    let refreshed = token(&setup.oidc.credential().await.unwrap());
    assert_eq!(std::fs::read_to_string(&setup.file).unwrap(), before);
    assert!(lock(&setup.file).exists(), "another writer's lock stays");
    assert_eq!(token(&setup.oidc.credential().await.unwrap()), refreshed);
    assert_eq!(issuer.grants().len(), 1);
}

#[tokio::test]
async fn the_client_s_secret_goes_in_the_form_when_the_issuer_refuses_the_header() {
    let issuer = Issuer::start("r1").await;
    issuer.issued.lock().unwrap().form_only = true;
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        Some("r1"),
    ));
    setup.oidc.credential().await.unwrap();
    let grants = issuer.grants();
    assert_eq!(grants.len(), 2);
    assert!(grants[0].1.is_some(), "the header first");
    assert_eq!(grants[1].0["client_id"], "twigo");
    assert_eq!(grants[1].1, None);
}

#[tokio::test]
async fn without_a_refresh_token_an_expired_token_is_an_error() {
    let issuer = Issuer::start("r1").await;
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        None,
    ));
    assert_eq!(
        setup.oidc.credential().await.unwrap_err(),
        OidcError::NoRefreshToken
    );
}

fn lock(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".lock");
    name.into()
}

#[tokio::test]
async fn a_rejected_token_is_refreshed_rather_than_read_back_from_the_file() {
    let issuer = Issuer::start("r1").await;
    let valid = jwt(SignedDuration::from_hours(1), 0);
    let setup = setup(&kubeconfig(&issuer, &valid, Some("r1")));
    let rejected = setup.oidc.credential().await.unwrap();
    assert_eq!(token(&rejected), valid);
    setup.oidc.reject(&rejected);
    let refreshed = token(&setup.oidc.credential().await.unwrap());
    assert_ne!(refreshed, valid);
    assert_eq!(issuer.grants().len(), 1);
}

#[tokio::test]
async fn after_a_failed_write_the_next_refresh_spends_the_rotated_token() {
    let issuer = Issuer::start("r1").await;
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        Some("r1"),
    ));
    issuer.issued.lock().unwrap().lifetime = Some(SignedDuration::from_millis(11_500));
    std::fs::write(lock(&setup.file), "").unwrap();
    setup.oidc.credential().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    setup.oidc.credential().await.unwrap();
    let spent: Vec<String> = issuer
        .grants()
        .into_iter()
        .map(|(form, _)| form["refresh_token"].clone())
        .collect();
    assert_eq!(spent, ["r1", "r2"]);
}

#[tokio::test]
async fn the_tokens_go_to_the_file_a_symlink_names() {
    let issuer = Issuer::start("r1").await;
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        Some("r1"),
    ));
    let link = setup.dir.path().join("link");
    std::os::unix::fs::symlink(&setup.file, &link).unwrap();
    let through_link = setup.registry.oidc(Some(link.clone()), "dev", entry(&link));
    through_link.credential().await.unwrap();
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        std::fs::read_to_string(&setup.file)
            .unwrap()
            .contains("refresh-token: r2")
    );
}

#[tokio::test]
async fn a_corrected_client_secret_reaches_a_new_source() {
    let issuer = Issuer::start("r1").await;
    let expired = jwt(SignedDuration::from_secs(-60), 0);
    let setup = setup(
        &kubeconfig(&issuer, &expired, Some("r1"))
            .replace("client-secret: s3cret", "client-secret: wrong"),
    );
    assert!(matches!(
        setup.oidc.credential().await,
        Err(OidcError::Refresh { .. })
    ));
    std::fs::write(&setup.file, kubeconfig(&issuer, &expired, Some("r1"))).unwrap();
    let corrected = setup
        .registry
        .oidc(Some(setup.file.clone()), "dev", entry(&setup.file));
    assert!(!Arc::ptr_eq(&corrected, &setup.oidc));
    corrected.credential().await.unwrap();
}

#[tokio::test]
async fn a_refreshed_token_the_server_rejects_too_is_kept_until_it_expires() {
    let issuer = Issuer::start("r1").await;
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        Some("r1"),
    ));
    let refreshed = setup.oidc.credential().await.unwrap();
    for _ in 0..5 {
        let used = setup.oidc.credential().await.unwrap();
        assert!(
            Arc::ptr_eq(&used, &refreshed),
            "the same credential, so no retry"
        );
        setup.oidc.reject(&used);
    }
    assert_eq!(issuer.grants().len(), 1);
}

#[tokio::test]
async fn a_rejected_refreshed_token_gives_way_to_one_signed_in_elsewhere() {
    let issuer = Issuer::start("r1").await;
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        Some("r1"),
    ));
    let refreshed = setup.oidc.credential().await.unwrap();
    setup.oidc.reject(&refreshed);
    let from_kubectl = jwt(SignedDuration::from_hours(1), 77);
    std::fs::write(
        &setup.file,
        kubeconfig(&issuer, &from_kubectl, Some("r-kubectl")),
    )
    .unwrap();
    assert_eq!(token(&setup.oidc.credential().await.unwrap()), from_kubectl);
    assert_eq!(issuer.grants().len(), 1);
}

#[tokio::test]
async fn without_a_refresh_token_a_rejection_keeps_the_token_it_cannot_replace() {
    let issuer = Issuer::start("r1").await;
    let valid = jwt(SignedDuration::from_hours(1), 0);
    let setup = setup(&kubeconfig(&issuer, &valid, None));
    let used = setup.oidc.credential().await.unwrap();
    setup.oidc.reject(&used);
    let kept = setup.oidc.credential().await.unwrap();
    assert!(
        Arc::ptr_eq(&kept, &used),
        "the same credential, so no retry"
    );
    setup.oidc.reject(&kept);
    let from_kubectl = jwt(SignedDuration::from_hours(1), 78);
    std::fs::write(&setup.file, kubeconfig(&issuer, &from_kubectl, None)).unwrap();
    assert_eq!(token(&setup.oidc.credential().await.unwrap()), from_kubectl);
}

#[tokio::test]
async fn a_rejected_token_stays_while_the_issuer_refuses_its_refresh() {
    let issuer = Issuer::start("not-r1").await;
    let valid = jwt(SignedDuration::from_hours(1), 0);
    let setup = setup(&kubeconfig(&issuer, &valid, Some("r1")));
    let used = setup.oidc.credential().await.unwrap();
    setup.oidc.reject(&used);
    let kept = setup.oidc.credential().await.unwrap();
    assert!(Arc::ptr_eq(&kept, &used));
    let tried = issuer.grants().len();
    assert!(tried > 0, "it tried to refresh");
    setup.oidc.credential().await.unwrap();
    setup.oidc.reject(&kept);
    let again = setup.oidc.credential().await.unwrap();
    assert!(Arc::ptr_eq(&again, &used));
    assert_eq!(
        issuer.grants().len(),
        tried,
        "one refresh per rejected token"
    );
}

#[tokio::test]
async fn rejections_of_a_token_whose_refresh_is_under_way_refresh_it_once() {
    let issuer = Issuer::start("r1").await;
    issuer.issued.lock().unwrap().token_delay = Some(std::time::Duration::from_millis(300));
    let valid = jwt(SignedDuration::from_hours(1), 0);
    let setup = setup(&kubeconfig(&issuer, &valid, Some("r1")));
    let used = setup.oidc.credential().await.unwrap();
    setup.oidc.reject(&used);
    let oidc = Arc::clone(&setup.oidc);
    let first = tokio::spawn(async move { oidc.credential().await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    setup.oidc.reject(&used);
    let second = setup.oidc.credential().await.unwrap();
    let first = first.await.unwrap().unwrap();
    assert!(!Arc::ptr_eq(&first, &used));
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(issuer.grants().len(), 1);
}

#[tokio::test]
async fn a_request_whose_refreshed_token_is_rejected_goes_unretried() {
    let issuer = Issuer::start("r1").await;
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        Some("r1"),
    ));
    let mut config = kube::Config::new(issuer.url().parse().unwrap());
    config.root_cert = Some(vec![
        CertificateDer::from_pem_slice(issuer.ca_pem.as_bytes())
            .unwrap()
            .to_vec(),
    ]);
    let clients = twigo_kube::client::Clients::new(
        &config,
        twigo_kube::client::Options {
            provider: Some(twigo_kube::credentials::Provider::Oidc(Arc::clone(
                &setup.oidc,
            ))),
            ..Default::default()
        },
    )
    .unwrap();
    let request = http::Request::get("/version").body(Vec::new()).unwrap();
    assert!(clients.api.request_text(request).await.is_err());
    let rejected = issuer.issued.lock().unwrap().rejected.clone();
    assert_eq!(
        rejected.len(),
        1,
        "the same token again would only be rejected again"
    );
}

#[tokio::test]
async fn a_refresh_whose_request_is_dropped_still_keeps_the_rotated_tokens() {
    let issuer = Issuer::start("r1").await;
    issuer.issued.lock().unwrap().token_delay = Some(std::time::Duration::from_millis(300));
    let setup = setup(&kubeconfig(
        &issuer,
        &jwt(SignedDuration::from_secs(-60), 0),
        Some("r1"),
    ));
    let dropped = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        setup.oidc.credential(),
    )
    .await;
    assert!(dropped.is_err());
    setup.oidc.credential().await.unwrap();
    assert_eq!(issuer.grants().len(), 1);
    assert!(
        std::fs::read_to_string(&setup.file)
            .unwrap()
            .contains("refresh-token: r2")
    );
}

#[tokio::test]
async fn rejections_of_a_token_whose_refresh_fails_refresh_it_once() {
    let issuer = Issuer::start("not-r1").await;
    issuer.issued.lock().unwrap().token_delay = Some(std::time::Duration::from_millis(300));
    let valid = jwt(SignedDuration::from_hours(1), 0);
    let setup = setup(&kubeconfig(&issuer, &valid, Some("r1")));
    let used = setup.oidc.credential().await.unwrap();
    setup.oidc.reject(&used);
    let oidc = Arc::clone(&setup.oidc);
    let first = tokio::spawn(async move { oidc.credential().await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    setup.oidc.reject(&used);
    let second = setup.oidc.credential().await.unwrap();
    let first = first.await.unwrap().unwrap();
    assert!(Arc::ptr_eq(&first, &used));
    assert!(Arc::ptr_eq(&second, &used));
    assert_eq!(issuer.grants().len(), 2, "the header, then the form, once");
}
