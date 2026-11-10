//! TLS on the loopback endpoint, which carries no secret the token does not
//! guard already: clientcmd reads a user's credentials only for an https
//! server ([`ClientConfig`]), so a plain endpoint would get requests without
//! their token. A CA made in memory for the app's run signs the endpoint's
//! certificate for 127.0.0.1 and is dropped; each kubeconfig trusts that CA
//! alone.
//!
//! [`ClientConfig`]: https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/clientcmd/client_config.go#L230-L249

use std::sync::Arc;

use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair};
use rustls::ServerConfig;
use rustls::pki_types::PrivateKeyDer;
use tokio_rustls::TlsAcceptor;

pub(super) struct Tls {
    pub acceptor: TlsAcceptor,
    /// The CA, in PEM, as a kubeconfig's `certificate-authority-data` holds
    /// it, base64 aside.
    pub ca: String,
}

impl Tls {
    pub(super) fn new() -> std::io::Result<Self> {
        let mut params = CertificateParams::new(Vec::new()).map_err(std::io::Error::other)?;
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params
            .distinguished_name
            .push(DnType::CommonName, "Twigo's policy proxy");
        let key = KeyPair::generate().map_err(std::io::Error::other)?;
        let ca = CertifiedIssuer::self_signed(params, key).map_err(std::io::Error::other)?;
        let key = KeyPair::generate().map_err(std::io::Error::other)?;
        let leaf = CertificateParams::new(vec!["127.0.0.1".to_owned()])
            .and_then(|params| params.signed_by(&key, &ca))
            .map_err(std::io::Error::other)?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut config = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .and_then(|config| {
                config.with_no_client_auth().with_single_cert(
                    vec![leaf.der().clone()],
                    PrivateKeyDer::Pkcs8(key.serialize_der().into()),
                )
            })
            .map_err(std::io::Error::other)?;
        // The upgrades of exec, attach and port-forward are HTTP/1.1's.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Self {
            acceptor: TlsAcceptor::from(Arc::new(config)),
            ca: ca.pem(),
        })
    }
}
