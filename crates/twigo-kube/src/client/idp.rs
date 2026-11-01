//! HTTPS to an OIDC issuer, for the `auth-provider: oidc` refresh: its CA
//! when the kubeconfig names one, else the OS's trust store, and the login
//! shell's proxy, as client-go's oidc plugin builds its transport
//! (`plugin/pkg/client/auth/oidc/oidc.go`, `newOIDCAuthProvider`).

use std::time::Duration;

use bytes::Bytes;
use http::header::{AUTHORIZATION, CONTENT_TYPE};
use http::{Method, Request, StatusCode, Uri};
use http_body_util::{BodyExt, Full, Limited};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use rustls::{ClientConfig, RootCertStore};

use super::dial::Dialer;
use super::proxy::{ProxyEnv, proxy_for};

/// client-go sets none; a refresh that hangs would hold every request.
const TIMEOUT: Duration = Duration::from_secs(30);

/// A discovery document or a token response is a few KiB.
const MAX_BODY: usize = 1 << 20;

pub struct Idp {
    client: Client<HttpsConnector<Dialer>, Full<Bytes>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdpError {
    #[error("the IdP's certificate authority: {0}")]
    Authority(String),
    #[error("the proxy to the IdP: {0}")]
    Proxy(String),
    #[error("{uri}: {message}")]
    Request { uri: String, message: String },
    #[error("{0}: no answer in 30 s")]
    Timeout(String),
}

impl Idp {
    /// `ca` is PEM, from `idp-certificate-authority(-data)`.
    pub fn new(issuer: &Uri, ca: Option<&[u8]>, env: &ProxyEnv) -> Result<Self, IdpError> {
        let builder = match ca {
            Some(pem) => {
                let mut roots = RootCertStore::empty();
                for cert in CertificateDer::pem_slice_iter(pem) {
                    let cert = cert.map_err(|error| IdpError::Authority(error.to_string()))?;
                    roots
                        .add(cert)
                        .map_err(|error| IdpError::Authority(error.to_string()))?;
                }
                HttpsConnectorBuilder::new().with_tls_config(
                    ClientConfig::builder()
                        .with_root_certificates(roots)
                        .with_no_client_auth(),
                )
            }
            None => HttpsConnectorBuilder::new()
                .try_with_platform_verifier()
                .map_err(|error| IdpError::Authority(error.to_string()))?,
        };
        let proxy =
            proxy_for(issuer, None, env).map_err(|error| IdpError::Proxy(error.to_string()))?;
        let mut http = HttpConnector::new();
        http.enforce_http(false);
        let dialer = Dialer::new(http, proxy.as_ref())
            .map_err(|error| IdpError::Proxy(error.to_string()))?;
        let connector = builder
            .https_or_http()
            .enable_http1()
            .wrap_connector(dialer);
        Ok(Self {
            client: Client::builder(TokioExecutor::new()).build(connector),
        })
    }

    pub async fn get(&self, uri: &Uri) -> Result<(StatusCode, Bytes), IdpError> {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Full::default())
            .expect("a GET request builds");
        self.send(uri, request).await
    }

    /// Posts a form, with `basic` as the `Authorization` header when given.
    pub async fn post_form(
        &self,
        uri: &Uri,
        form: String,
        basic: Option<String>,
    ) -> Result<(StatusCode, Bytes), IdpError> {
        let mut request = Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded");
        if let Some(basic) = basic {
            request = request.header(AUTHORIZATION, basic);
        }
        let request = request
            .body(Full::new(Bytes::from(form)))
            .expect("a form request builds");
        self.send(uri, request).await
    }

    async fn send(
        &self,
        uri: &Uri,
        request: Request<Full<Bytes>>,
    ) -> Result<(StatusCode, Bytes), IdpError> {
        let failed = |message: String| IdpError::Request {
            uri: uri.to_string(),
            message,
        };
        let exchange = async {
            let response = self
                .client
                .request(request)
                .await
                .map_err(|error| failed(error.to_string()))?;
            let status = response.status();
            let body = Limited::new(response.into_body(), MAX_BODY)
                .collect()
                .await
                .map_err(|error| failed(error.to_string()))?
                .to_bytes();
            Ok((status, body))
        };
        tokio::time::timeout(TIMEOUT, exchange)
            .await
            .map_err(|_| IdpError::Timeout(uri.to_string()))?
    }
}
