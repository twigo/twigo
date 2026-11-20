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
mod served;
mod user_agent;

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
use secrecy::ExposeSecret;
use tokio::sync::watch;
use tower::ServiceBuilder;
use tower::timeout::TimeoutLayer;

pub use connections::Connections;
pub use counter::{Budgets, Class, OverBudget, Party, Permit, Proxied, Slots, Usage, Waiting};
pub use proxy::{Proxy, ProxyEnv, ProxyError, proxy_for};
pub use twigo_policy::{Actor, Gate, Server};

use auth::AuthLayer;
use connections::{ConnectionsLayer, Tracked};
use counter::{Counter, CounterLayer};
use dial::Dialer;
use identity::Identity;
use retry::RetryLayer;
use user_agent::UserAgentLayer;

use crate::credentials::{Provider, token_or_basic};

/// client-go's: its dialer's keepalive (`transport/cache.go`) and its
/// HTTP/2 health check (`ReadIdleTimeout` and `PingTimeout` in
/// apimachinery's `util/net/http.go`), which hyper's keep-alive matches:
/// a ping once the connection has read nothing for the interval.
const TCP_KEEPALIVE: Duration = Duration::from_secs(30);
const PING_INTERVAL: Duration = Duration::from_secs(30);
const PING_TIMEOUT: Duration = Duration::from_secs(15);

const REQUEST_TIMEOUT: Duration = Duration::from_secs(70);

/// hyper 1.12's default, set so that [`connection_window`] depends on no
/// default.
const STREAM_WINDOW: u32 = 2 * 1024 * 1024;

/// The most a window can be (RFC 9113 6.9.1); h2 asserts it.
const MAX_WINDOW: u32 = i32::MAX as u32;

/// A stream whose body nobody reads keeps its whole window of the
/// connection's, so a connection window of every stream the counter admits at
/// the stream window leaves one stalled body nothing to take from the rest.
fn connection_window(budgets: &Budgets) -> u32 {
    let window = budgets.api_streams().saturating_mul(STREAM_WINDOW as usize);
    window.min(MAX_WINDOW as usize) as u32
}

pub struct Clients {
    /// The UI's requests, watches and followed logs, on one HTTP/2 connection
    /// when the server negotiates it.
    pub api: Client,
    /// The UI's exec, attach and port-forward: their WebSocket upgrade needs
    /// HTTP/1.1.
    pub sessions: Client,
    cluster: String,
    counter: Counter,
    connections: Connections,
    gate: Gate,
    actors: BuildActor,
}

type BuildActor = Arc<dyn Fn(&Gate) -> Result<ActorClients, Error> + Send + Sync>;

/// An actor's two clients (ARCHITECTURE 6.4), which carry its gate over the
/// context's shared connections and stream counter.
pub struct ActorClients {
    pub api: Client,
    pub sessions: Client,
    gate: Gate,
}

impl ActorClients {
    /// What the gate reads of `request`, once who serves the group-version
    /// it dry-runs is read as this actor where nothing kept knows it.
    pub async fn attributes<B>(&self, request: &http::Request<B>) -> twigo_policy::Attributes {
        served::attributes(&self.api, &self.gate, request).await
    }

    /// Who serves `group/version`, read as this actor where nothing kept
    /// knows it; none when it cannot be read.
    pub async fn server(&self, group: &str, version: &str) -> Option<Server> {
        served::server(&self.api, &self.gate, group, version).await
    }
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

/// What every actor's clients of a context share.
struct Shared<A, S> {
    config: Config,
    provider: Option<Provider>,
    identity: Arc<Identity>,
    api: hyper_util::client::legacy::Client<A, Body>,
    sessions: hyper_util::client::legacy::Client<S, Body>,
    counter: Counter,
    connections: Connections,
}

impl<A, S> Shared<A, S>
where
    A: Connect + Clone + Send + Sync + 'static,
    S: Connect + Clone + Send + Sync + 'static,
{
    fn actor(&self, gate: &Gate) -> Result<ActorClients, Error> {
        let config = &self.config;
        let auth = config.auth_layer()?;
        let outer = ServiceBuilder::new()
            .layer(gate.layer())
            .layer(config.base_uri_layer())
            .option_layer(auth.as_ref())
            .option_layer(
                self.provider
                    .as_ref()
                    .map(|provider| AuthLayer::new(provider.clone(), Arc::clone(&self.identity))),
            )
            .layer(config.extra_headers_layer()?)
            .layer(UserAgentLayer::of(gate.actor()));
        let api = outer
            .clone()
            .layer(CounterLayer(self.counter.clone(), party(gate.actor())))
            .layer(TimeoutLayer::new(REQUEST_TIMEOUT))
            .layer(RetryLayer)
            .layer(ConnectionsLayer(self.connections.clone()))
            .layer(gate.recheck())
            .service(self.api.clone());
        let sessions = outer.layer(gate.recheck()).service(self.sessions.clone());
        Ok(ActorClients {
            api: Client::new(api, config.default_namespace.clone()),
            sessions: Client::new(sessions, config.default_namespace.clone()),
            gate: gate.clone(),
        })
    }
}

fn party(actor: Actor) -> Party {
    match actor {
        Actor::Ui => Party::Ui,
        _ => Party::Other,
    }
}

impl Clients {
    /// The clients of the context `gate` is for, the UI's first. `gate` is
    /// the UI's: no client of the context goes around it.
    pub fn new(config: &Config, gate: Gate, options: Options) -> Result<Self, Error> {
        let config = &without_plugins(config, options.provider.is_some())?;
        let proxy = options.proxy.as_ref();
        let counter = Counter::new(options.budgets);
        let window = connection_window(&options.budgets);
        let connections = Connections::default();
        let identity = Arc::new(Identity::new(connections.clone()));
        let offered = matches!(options.provider, Some(Provider::Exec(_))).then_some(&identity);

        let mut builder = hyper_util::client::legacy::Client::builder(TokioExecutor::new());
        builder
            // hyper-util expires a shared HTTP/2 entry that saw no new
            // request for the idle timeout, even while its streams run, and
            // opens another.
            .pool_idle_timeout(None)
            .http2_initial_stream_window_size(STREAM_WINDOW)
            .http2_initial_connection_window_size(window)
            .timer(TokioTimer::new())
            .http2_keep_alive_interval(PING_INTERVAL)
            .http2_keep_alive_timeout(PING_TIMEOUT)
            .http2_keep_alive_while_idle(true);
        let api = builder.build::<_, Body>(Tracked::new(
            connector(config, Alpn::Both, proxy, offered)?,
            connections.clone(),
        ));

        // Each session upgrades its connection, which leaves the pool, so an
        // idle one would only carry a certificate the plugin has replaced.
        let sessions = hyper_util::client::legacy::Client::builder(TokioExecutor::new())
            .pool_max_idle_per_host(0)
            .build::<_, Body>(connector(config, Alpn::Http1, proxy, offered)?);

        let shared = Shared {
            config: config.clone(),
            provider: options.provider,
            identity: Arc::clone(&identity),
            api,
            sessions,
            counter: counter.clone(),
            connections: connections.clone(),
        };
        let ui = shared.actor(&gate)?;
        Ok(Clients {
            api: ui.api,
            sessions: ui.sessions,
            cluster: cluster(config),
            counter,
            connections,
            gate,
            actors: Arc::new(move |gate| shared.actor(gate)),
        })
    }

    /// Clients over `service` in place of a server, the cluster
    /// `https://fake.invalid`, with the stream counter of `budgets` and
    /// connections that nothing dials: for the tests of what runs over
    /// them. Their gate lets everything through.
    #[cfg(any(test, feature = "test-util"))]
    pub fn over<S, B>(service: S, budgets: Budgets) -> Self
    where
        S: tower::Service<http::Request<Body>, Response = http::Response<B>>
            + Clone
            + Send
            + Sync
            + 'static,
        S::Future: Send + 'static,
        S::Error: Into<tower::BoxError>,
        S::Response: Send + 'static,
        B: http_body::Body<Data = bytes::Bytes> + Send + Unpin + 'static,
        B::Error: Into<tower::BoxError>,
    {
        Self::over_gated(service, budgets, Gate::unrestricted())
    }

    /// [`Clients::over`], through `gate`.
    #[cfg(any(test, feature = "test-util"))]
    pub fn over_gated<S, B>(service: S, budgets: Budgets, gate: Gate) -> Self
    where
        S: tower::Service<http::Request<Body>, Response = http::Response<B>>
            + Clone
            + Send
            + Sync
            + 'static,
        S::Future: Send + 'static,
        S::Error: Into<tower::BoxError>,
        S::Response: Send + 'static,
        B: http_body::Body<Data = bytes::Bytes> + Send + Unpin + 'static,
        B::Error: Into<tower::BoxError>,
    {
        let counter = Counter::new(budgets);
        let actors = {
            let counter = counter.clone();
            move |gate: &Gate| {
                let api = ServiceBuilder::new()
                    .layer(gate.layer())
                    .layer(CounterLayer(counter.clone(), party(gate.actor())))
                    .layer(gate.recheck())
                    .service(service.clone());
                let sessions = ServiceBuilder::new()
                    .layer(gate.layer())
                    .layer(gate.recheck())
                    .service(service.clone());
                Ok(ActorClients {
                    api: Client::new(api, "default"),
                    sessions: Client::new(sessions, "default"),
                    gate: gate.clone(),
                })
            }
        };
        let ui = actors(&gate).expect("building over a service cannot fail");
        Clients {
            api: ui.api,
            sessions: ui.sessions,
            cluster: "https://fake.invalid".to_owned(),
            counter,
            connections: Connections::default(),
            gate,
            actors: Arc::new(actors),
        }
    }

    /// What the UI's gate reads of `request`, once who serves the
    /// group-version it dry-runs is read where nothing kept knows it.
    pub async fn attributes<B>(&self, request: &http::Request<B>) -> twigo_policy::Attributes {
        served::attributes(&self.api, &self.gate, request).await
    }

    /// Who serves `group/version`, read as the UI where nothing kept knows
    /// it; none when it cannot be read.
    pub async fn server(&self, group: &str, version: &str) -> Option<Server> {
        served::server(&self.api, &self.gate, group, version).await
    }

    /// Another actor's clients of this context, over its shared connections
    /// and stream counter.
    pub fn actor(&self, actor: Actor) -> Result<ActorClients, Error> {
        (self.actors)(&self.gate.of(actor))
    }

    /// A session's permit, which it holds for its life, since the upgraded
    /// stream outlives the response that would hold it: waits as queued over
    /// the budget, and tells `waiting`.
    pub async fn admit_session(&self, actor: Actor, waiting: Option<&Waiting>) -> Permit {
        self.counter
            .admit(Class::Session, party(actor), waiting)
            .await
    }

    /// A permit of the class for what refuses over its budget: the proxy's
    /// streams and its upgrades.
    pub fn try_admit(&self, class: Class, actor: Actor) -> Option<Permit> {
        self.counter.try_admit(class, party(actor))
    }

    /// The cluster they reach: its URL, the name they check its certificate
    /// against, and the certificates they trust it with, since a cluster
    /// recreated at the same address may get a CA of its own.
    pub fn cluster(&self) -> &str {
        &self.cluster
    }

    /// The context's connection they were built for (`Gate::connection`).
    pub fn connection(&self) -> Option<u64> {
        self.gate.connection()
    }

    /// The same clients, said to reach `cluster`: for the tests of what
    /// tells clusters apart.
    #[cfg(feature = "test-util")]
    pub fn reaching(mut self, cluster: &str) -> Self {
        self.cluster = cluster.to_owned();
        self
    }

    pub fn usage(&self) -> watch::Receiver<Usage> {
        self.counter.usage()
    }

    pub fn connections(&self) -> &Connections {
        &self.connections
    }
}

/// The cluster's URL, its `tls-server-name`, and a digest of the CAs it is
/// trusted with, or a word for the system's roots or any certificate.
fn cluster(config: &Config) -> String {
    let trust = match &config.root_cert {
        _ if config.accept_invalid_certs => "any certificate".to_owned(),
        None => "the system's roots".to_owned(),
        Some(certificates) => {
            let mut context = ring::digest::Context::new(&ring::digest::SHA256);
            for certificate in certificates {
                context.update(&(certificate.len() as u64).to_be_bytes());
                context.update(certificate);
            }
            context.finish().as_ref()[..16]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        }
    };
    match &config.tls_server_name {
        Some(name) => format!("{} as {name} trusting {trust}", config.cluster_url),
        None => format!("{} trusting {trust}", config.cluster_url),
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
    // client-go reads an empty token or username as none; kube would send
    // `Bearer ` and leave a token file unread.
    let user = &mut config.auth_info;
    if user
        .token
        .as_ref()
        .is_some_and(|token| token.expose_secret().is_empty())
    {
        user.token = None;
    }
    if user.username.as_deref() == Some("") {
        user.username = None;
    }
    // client-go's bearer and basic round trippers wrap the provider's, which
    // passes on a request that carries a header already; kube reads the
    // provider first.
    if provided || token_or_basic(&config.auth_info) {
        config.auth_info.auth_provider = None;
    }
    Ok(config)
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

#[cfg(test)]
mod gate_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_connection_window_holds_the_stream_window_of_every_stream_of_the_api_client() {
        const MIB: u32 = 1024 * 1024;
        assert_eq!(connection_window(&Budgets::default()), 200 * MIB);
        let raised = Budgets {
            watches: 100,
            sessions: 1,
            ..Budgets::default()
        };
        assert_eq!(connection_window(&raised), 352 * MIB);
        let enormous = Budgets {
            watches: 2000,
            logs: 2000,
            ..Budgets::default()
        };
        assert_eq!(connection_window(&enormous), i32::MAX as u32);
    }

    #[test]
    fn a_cluster_is_its_url_and_what_it_is_trusted_with() {
        let with = |certificates: Option<Vec<Vec<u8>>>, any: bool| {
            let mut config = Config::new(http::Uri::from_static("https://192.168.49.2:8443"));
            config.root_cert = certificates;
            config.accept_invalid_certs = any;
            cluster(&config)
        };
        let first = with(Some(vec![b"ca-1".to_vec()]), false);
        assert!(
            first.starts_with("https://192.168.49.2:8443/ trusting "),
            "{first}"
        );
        assert_eq!(first, with(Some(vec![b"ca-1".to_vec()]), false));
        assert_ne!(first, with(Some(vec![b"ca-2".to_vec()]), false));
        assert_ne!(
            with(Some(vec![b"ab".to_vec(), b"c".to_vec()]), false),
            with(Some(vec![b"a".to_vec(), b"bc".to_vec()]), false)
        );
        assert!(with(None, false).ends_with("trusting the system's roots"));
        let mut named = Config::new(http::Uri::from_static("https://192.168.49.2:8443"));
        named.tls_server_name = Some("b.example".to_owned());
        assert_eq!(
            cluster(&named),
            "https://192.168.49.2:8443/ as b.example trusting the system's roots"
        );
        assert!(with(Some(vec![b"ca-1".to_vec()]), true).ends_with("trusting any certificate"));
    }
}
