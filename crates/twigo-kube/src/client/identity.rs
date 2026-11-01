//! The client certificate a plugin returned, offered at each TLS handshake,
//! as client-go offers it through `GetClientCertificate`.

use std::sync::{Arc, Mutex, OnceLock};

use rustls::SignatureScheme;
use rustls::client::ResolvesClientCert;
use rustls::crypto::CryptoProvider;
use rustls::sign::CertifiedKey;

use crate::credentials::Credential;

#[derive(Debug, Default)]
pub struct Identity {
    /// The TLS config's, for loading the key.
    provider: OnceLock<Arc<CryptoProvider>>,
    current: Mutex<Option<Current>>,
}

#[derive(Debug)]
struct Current {
    from: Arc<Credential>,
    key: Option<Arc<CertifiedKey>>,
}

impl Identity {
    pub fn provider(&self, provider: &Arc<CryptoProvider>) {
        self.provider.get_or_init(|| Arc::clone(provider));
    }

    /// Offers the certificate of `credential` from now on, and says whether
    /// it differs from the one offered before, as client-go compares them
    /// before it closes the connections the old one opened.
    pub fn offer(&self, credential: &Arc<Credential>) -> Result<bool, rustls::Error> {
        let mut current = self.current.lock().expect("identity lock");
        if current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.from, credential))
        {
            return Ok(false);
        }
        let key = match &credential.identity {
            Some(identity) => {
                let provider = self
                    .provider
                    .get()
                    .expect("the TLS config is built before any request");
                Some(Arc::new(CertifiedKey::from_der(
                    identity.chain.clone(),
                    identity.key.clone_key(),
                    provider,
                )?))
            }
            None => None,
        };
        let changed = current.as_ref().is_some_and(|current| {
            current.key.as_ref().map(|key| &key.cert) != key.as_ref().map(|key| &key.cert)
        });
        *current = Some(Current {
            from: Arc::clone(credential),
            key,
        });
        Ok(changed)
    }
}

impl ResolvesClientCert for Identity {
    fn resolve(&self, _: &[&[u8]], _: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        let current = self.current.lock().expect("identity lock");
        current.as_ref()?.key.clone()
    }

    fn has_certs(&self) -> bool {
        true
    }
}
