//! Exec credential plugins (ARCHITECTURE 6.2), which Twigo runs rather than
//! kube: kube runs one with a blocking `Command::output`, no timeout and the
//! terminal's stdin and stderr, three times for each client it builds
//! (`kube-client/src/client/auth/mod.rs`, `client/builder.rs`).

mod exec;
mod output;
mod run;
mod sign_in;
mod source;
#[cfg(test)]
mod tests;

pub use exec::{ApiVersion, Exec, ExecError, Mode};
pub use output::{Credential, OutputError};
pub use run::RunError;
pub use source::{CredentialError, Registry, Source, Status, Timeouts};
