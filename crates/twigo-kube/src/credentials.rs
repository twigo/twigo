//! Exec credential plugins (ARCHITECTURE 6.2), which Twigo runs rather than
//! kube: kube runs one with a blocking `Command::output`, no timeout and the
//! terminal's stdin and stderr, three times for each client it builds
//! (`kube-client/src/client/auth/mod.rs`, `client/builder.rs`).

mod exec;
mod oidc;
mod output;
mod run;
mod sign_in;
mod source;
#[cfg(test)]
mod tests;

pub(crate) use exec::token_or_basic;
pub use exec::{ApiVersion, Exec, ExecError, Mode};
pub use oidc::{Oidc, OidcEntry, OidcError};
pub use output::{Credential, OutputError};
pub use run::RunError;
pub use source::{CredentialError, Registry, Source, Status, Timeouts};

/// Where a context's credential comes from when Twigo, not kube, gets it.
#[derive(Debug, Clone)]
pub enum Provider {
    Exec(std::sync::Arc<Source>),
    Oidc(std::sync::Arc<Oidc>),
}

impl Provider {
    pub(crate) async fn credential(&self) -> Result<std::sync::Arc<Credential>, tower::BoxError> {
        Ok(match self {
            Provider::Exec(source) => source.credential().await?,
            Provider::Oidc(oidc) => oidc.credential().await?,
        })
    }

    /// Drops `used`, which the server rejected.
    pub(crate) fn reject(&self, used: &std::sync::Arc<Credential>) {
        match self {
            Provider::Exec(source) => source.reject(used),
            Provider::Oidc(oidc) => oidc.reject(used),
        }
    }
}
