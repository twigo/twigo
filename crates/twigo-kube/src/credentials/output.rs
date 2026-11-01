//! What a plugin prints: an `ExecCredential`, read by client-go's rules
//! (`plugin/pkg/client/auth/exec/exec.go`, `refreshCredsLocked`).

use jiff::{SignedDuration, Timestamp};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use secrecy::SecretString;
use serde::Deserialize;

use super::exec::ApiVersion;

/// A credential counts as expired this long before it does, so that a
/// request never carries one that expires on its way (ARCHITECTURE 6.2).
const MARGIN: SignedDuration = SignedDuration::from_secs(60);

#[derive(Debug)]
pub struct Credential {
    pub(crate) token: Option<SecretString>,
    pub(crate) identity: Option<Identity>,
    pub(super) expires: Option<Timestamp>,
}

/// A client certificate chain and its key, in DER.
pub struct Identity {
    pub(crate) chain: Vec<CertificateDer<'static>>,
    pub(crate) key: PrivateKeyDer<'static>,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("chain", &self.chain.len())
            .finish_non_exhaustive()
    }
}

impl Credential {
    pub fn token(&self) -> Option<&SecretString> {
        self.token.as_ref()
    }

    pub fn expires(&self) -> Option<Timestamp> {
        self.expires
    }

    /// Without an expiry, a credential lasts until the server rejects it.
    pub(super) fn valid_at(&self, now: Timestamp) -> bool {
        self.expires.is_none_or(|expires| now + MARGIN < expires)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OutputError {
    #[error("decoding stdout: {0}")]
    Decode(String),
    #[error(
        "exec plugin is configured to use API version {configured}, plugin returned version {returned}"
    )]
    ApiVersion {
        configured: &'static str,
        returned: String,
    },
    #[error("exec plugin didn't return a status field")]
    NoStatus,
    #[error("exec plugin didn't return a token or cert/key pair")]
    Empty,
    #[error("exec plugin returned only certificate or key, not both")]
    HalfPair,
    #[error("exec plugin returned an invalid expirationTimestamp {0:?}")]
    Expiry(String),
    #[error("exec plugin returned an invalid certificate or key: {0}")]
    Pem(String),
}

#[derive(Deserialize)]
struct ExecCredential {
    #[serde(rename = "apiVersion")]
    api_version: Option<String>,
    status: Option<Status>,
}

#[derive(Deserialize)]
struct Status {
    #[serde(rename = "expirationTimestamp")]
    expiration: Option<String>,
    token: Option<String>,
    #[serde(rename = "clientCertificateData")]
    certificate: Option<String>,
    #[serde(rename = "clientKeyData")]
    key: Option<String>,
}

/// Reads JSON or YAML, as client-go's universal decoder does, ignoring
/// fields it does not know. An `apiVersion` that differs from the one
/// configured is refused; a missing one is not.
pub(super) fn parse(stdout: &[u8], configured: ApiVersion) -> Result<Credential, OutputError> {
    // serde-saphyr quotes the text around a fault, which holds the token.
    let credential: ExecCredential = serde_saphyr::from_slice(stdout).map_err(|_| {
        OutputError::Decode("it is neither JSON nor YAML of an ExecCredential".to_owned())
    })?;
    if let Some(returned) = credential.api_version.filter(|v| !v.is_empty())
        && returned != configured.as_str()
    {
        return Err(OutputError::ApiVersion {
            configured: configured.as_str(),
            returned,
        });
    }
    let status = credential.status.ok_or(OutputError::NoStatus)?;
    let present = |field: Option<String>| field.filter(|value| !value.is_empty());
    let token = present(status.token);
    let identity = match (present(status.certificate), present(status.key)) {
        (Some(certificate), Some(key)) => Some(identity(&certificate, &key)?),
        (None, None) => None,
        _ => return Err(OutputError::HalfPair),
    };
    if token.is_none() && identity.is_none() {
        return Err(OutputError::Empty);
    }
    let expires = present(status.expiration)
        .map(|value| value.parse().map_err(|_| OutputError::Expiry(value)))
        .transpose()?;
    Ok(Credential {
        token: token.map(SecretString::from),
        identity,
        expires,
    })
}

/// PEM, as client-go's `tls.X509KeyPair` takes them.
fn identity(certificate: &str, key: &str) -> Result<Identity, OutputError> {
    let pem = |error: rustls::pki_types::pem::Error| OutputError::Pem(error.to_string());
    let chain = CertificateDer::pem_slice_iter(certificate.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(pem)?;
    if chain.is_empty() {
        return Err(OutputError::Pem("no certificate".to_owned()));
    }
    let key = PrivateKeyDer::from_pem_slice(key.as_bytes()).map_err(pem)?;
    Ok(Identity { chain, key })
}
