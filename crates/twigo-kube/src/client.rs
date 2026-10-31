use hyper_rustls::{FixedServerNameResolver, HttpsConnectorBuilder};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use kube::client::{Body, ConfigExt};
use kube::{Client, Config};
use rustls::pki_types::InvalidDnsNameError;
use rustls::pki_types::ServerName;
use tower::{BoxError, ServiceBuilder};

pub struct Clients {
    /// Requests, watches and followed logs, on one HTTP/2 connection when the
    /// server negotiates it.
    pub api: Client,
    /// Exec, attach and port-forward: their WebSocket upgrade needs HTTP/1.1.
    pub sessions: Client,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Kube(#[from] kube::Error),
    #[error("invalid tls-server-name: {0}")]
    ServerName(#[from] InvalidDnsNameError),
    #[error("a proxy (kubeconfig proxy-url or HTTPS_PROXY) is not supported yet")]
    Proxy,
}

impl Clients {
    pub fn new(config: Config) -> Result<Self, Error> {
        let api = multiplexed(&config)?;
        let sessions = Client::try_from(config)?;
        Ok(Clients {
            // Only kube's builder can read an exec plugin certificate's expiry.
            api: api.with_valid_until(*sessions.valid_until()),
            sessions,
        })
    }
}

fn multiplexed(config: &Config) -> Result<Client, Error> {
    if config.proxy_url.is_some() {
        return Err(Error::Proxy);
    }
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    http.set_connect_timeout(config.connect_timeout);
    let mut https = HttpsConnectorBuilder::new()
        .with_tls_config(config.rustls_client_config()?)
        .https_or_http();
    if let Some(name) = &config.tls_server_name {
        https = https.with_server_name_resolver(FixedServerNameResolver::new(
            ServerName::try_from(name.clone())?,
        ));
    }
    let connector = https.enable_all_versions().wrap_connector(http);
    let client = hyper_util::client::legacy::Client::builder(TokioExecutor::new())
        .build::<_, Body>(connector);
    let service = ServiceBuilder::new()
        .layer(config.base_uri_layer())
        .option_layer(config.auth_layer()?)
        .layer(config.extra_headers_layer()?)
        .map_err(BoxError::from)
        .service(client);
    Ok(Client::new(service, config.default_namespace.clone()))
}
