//! The clients of a context (ARCHITECTURE 3.2, 6.2, 6.3): two shared
//! hyper-util clients, and the kube clients built over them.

mod auth;
mod connections;
mod counter;
mod dial;
mod identity;
pub(crate) mod idp;
mod proxy;
mod retry;

use std::sync::Arc;
use std::time::Duration;

use hyper_rustls::{FixedServerNameResolver, HttpsConnectorBuilder};
use hyper_timeout::TimeoutConnector;
use hyper_util::client::legacy::connect::{Connect, HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioTimer};
use kube::client::{Body, ConfigExt};
use kube::{Client, Config};
use rustls::client::Resumption;
use rustls::pki_types::InvalidDnsNameError;
use rustls::pki_types::ServerName;
use tokio::sync::watch;
use tower::timeout::TimeoutLayer;
use tower::{BoxError, ServiceBuilder};

pub use connections::Connections;
pub use counter::{Budgets, Class, Slots, Usage};
pub use proxy::{Proxy, ProxyEnv, ProxyError, proxy_for};

use auth::AuthLayer;
use connections::{ConnectionsLayer, Tracked};
use counter::{Counter, CounterLayer};
use dial::Dialer;
use identity::Identity;
use retry::RetryLayer;

use crate::credentials::Provider;

/// client-go's: its dialer's keepalive (`transport/cache.go`) and its
/// HTTP/2 health check (`ReadIdleTimeout` and `PingTimeout` in
/// apimachinery's `util/net/http.go`), which hyper's keep-alive matches:
/// a ping once the connection has read nothing for the interval.
const TCP_KEEPALIVE: Duration = Duration::from_secs(30);
const PING_INTERVAL: Duration = Duration::from_secs(30);
const PING_TIMEOUT: Duration = Duration::from_secs(15);

const REQUEST_TIMEOUT: Duration = Duration::from_secs(70);

pub struct Clients {
    /// Requests, watches and followed logs, on one HTTP/2 connection when the
    /// server negotiates it.
    pub api: Client,
    /// Exec, attach and port-forward: their WebSocket upgrade needs HTTP/1.1.
    pub sessions: Client,
    counter: Counter,
    connections: Connections,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Kube(#[from] kube::Error),
    #[error("invalid tls-server-name: {0}")]
    ServerName(#[from] InvalidDnsNameError),
    #[error("the OS's trust store, for an https proxy: {0}")]
    TrustStore(#[from] rustls::Error),
    #[error(
        "The gcp auth plugin has been removed.\nPlease use the \"gke-gcloud-auth-plugin\" kubectl/client-go credential plugin instead.\nSee https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke for further details"
    )]
    Gcp,
    #[error(
        "The azure auth plugin has been removed.\nPlease use the https://github.com/Azure/kubelogin kubectl/client-go credential plugin instead.\nSee https://kubernetes.io/docs/reference/access-authn-authz/authentication/#client-go-credential-plugins for further details"
    )]
    Azure,
}

#[derive(Debug, Clone, Default)]
pub struct Options {
    pub budgets: Budgets,
    /// From [`proxy_for`]: `config.proxy_url` is not read, since kube fills
    /// it from Twigo's own environment.
    pub proxy: Option<Proxy>,
    /// The user entry's exec plugin or oidc provider, whose credential
    /// Twigo gets instead of kube (ARCHITECTURE 6.2): `config.auth_info`'s
    /// `exec` is never read, nor its `auth-provider` with one.
    pub provider: Option<Provider>,
}

impl Clients {
    pub fn new(config: &Config, options: Options) -> Result<Self, Error> {
        let config = &without_plugins(config, options.provider.is_some())?;
        let proxy = options.proxy.as_ref();
        let counter = Counter::new(options.budgets);
        let connections = Connections::default();
        let identity = Arc::new(Identity::default());
        let offered = matches!(options.provider, Some(Provider::Exec(_))).then_some(&identity);
        let auth = |connections: Option<&Connections>| {
            options.provider.as_ref().map(|provider| {
                AuthLayer::new(
                    provider.clone(),
                    Arc::clone(&identity),
                    connections.cloned(),
                )
            })
        };

        let mut builder = hyper_util::client::legacy::Client::builder(TokioExecutor::new());
        builder
            // hyper-util expires a shared HTTP/2 entry that saw no new
            // request for the idle timeout, even while its streams run, and
            // opens another.
            .pool_idle_timeout(None)
            .timer(TokioTimer::new())
            .http2_keep_alive_interval(PING_INTERVAL)
            .http2_keep_alive_timeout(PING_TIMEOUT)
            .http2_keep_alive_while_idle(true);
        let api = builder.build::<_, Body>(Tracked::new(
            connector(config, Alpn::Both, proxy, offered)?,
            connections.clone(),
        ));
        let api = ServiceBuilder::new()
            .layer(config.base_uri_layer())
            .option_layer(config.auth_layer()?)
            .option_layer(auth(Some(&connections)))
            .layer(config.extra_headers_layer()?)
            .layer(CounterLayer(counter.clone()))
            .layer(TimeoutLayer::new(REQUEST_TIMEOUT))
            .layer(RetryLayer)
            .layer(ConnectionsLayer(connections.clone()))
            .service(api);

        let sessions = hyper_util::client::legacy::Client::builder(TokioExecutor::new())
            .build::<_, Body>(connector(config, Alpn::Http1, proxy, offered)?);

        Ok(Clients {
            api: Client::new(api, config.default_namespace.clone()),
            sessions: kube_client(config, sessions, auth(None))?,
            counter,
            connections,
        })
    }

    pub fn usage(&self) -> watch::Receiver<Usage> {
        self.counter.usage()
    }

    pub fn connections(&self) -> &Connections {
        &self.connections
    }
}

/// The config without what kube would get credentials from itself: the
/// exec plugin, which Twigo runs, the auth provider when Twigo gets its
/// credential, and the gcp one's `cmd-path`, refused with the azure one as
/// client-go refuses both since they were removed
/// (`plugin/pkg/client/auth/gcp/gcp_stub.go`, `azure/azure_stub.go`).
fn without_plugins(config: &Config, provided: bool) -> Result<Config, Error> {
    match config
        .auth_info
        .auth_provider
        .as_ref()
        .map(|p| p.name.as_str())
    {
        Some("gcp") => return Err(Error::Gcp),
        Some("azure") => return Err(Error::Azure),
        _ => {}
    }
    let mut config = config.clone();
    config.auth_info.exec = None;
    if provided {
        config.auth_info.auth_provider = None;
    }
    Ok(config)
}

fn kube_client<C>(
    config: &Config,
    client: hyper_util::client::legacy::Client<C, Body>,
    auth: Option<AuthLayer>,
) -> Result<Client, Error>
where
    C: Connect + Clone + Send + Sync + 'static,
{
    let service = ServiceBuilder::new()
        .layer(config.base_uri_layer())
        .option_layer(config.auth_layer()?)
        .option_layer(auth)
        .layer(config.extra_headers_layer()?)
        .map_err(BoxError::from)
        .service(client);
    Ok(Client::new(service, config.default_namespace.clone()))
}

#[derive(Clone, Copy)]
enum Alpn {
    Both,
    Http1,
}

fn connector(
    config: &Config,
    alpn: Alpn,
    proxy: Option<&Proxy>,
    identity: Option<&Arc<Identity>>,
) -> Result<TimeoutConnector<hyper_rustls::HttpsConnector<Dialer>>, Error> {
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    http.set_connect_timeout(config.connect_timeout);
    http.set_keepalive(Some(TCP_KEEPALIVE));
    http.set_keepalive_interval(Some(TCP_KEEPALIVE));
    let mut tls = config.rustls_client_config()?;
    if let Some(identity) = identity {
        identity.provider(tls.crypto_provider());
        tls.client_auth_cert_resolver = Arc::clone(identity) as _;
        // A resumed session keeps the certificate of the handshake it
        // resumes, so a new one from the plugin needs a full handshake.
        tls.resumption = Resumption::disabled();
    }
    let mut https = HttpsConnectorBuilder::new()
        .with_tls_config(tls)
        .https_or_http();
    if let Some(name) = &config.tls_server_name {
        https = https.with_server_name_resolver(FixedServerNameResolver::new(
            ServerName::try_from(name.clone())?,
        ));
    }
    let dialer = Dialer::new(http, proxy)?;
    let https = match alpn {
        Alpn::Both => https.enable_all_versions().wrap_connector(dialer),
        Alpn::Http1 => https.enable_http1().wrap_connector(dialer),
    };
    let mut connector = TimeoutConnector::new(https);
    connector.set_connect_timeout(config.connect_timeout);
    connector.set_write_timeout(config.write_timeout);
    // No read timeout: it would time the whole multiplexed connection, so a
    // quiet cluster would cut every watch.
    Ok(connector)
}
