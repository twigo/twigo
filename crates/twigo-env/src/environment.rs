use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::watch;
use twigo_ipc::ShellEnvironment;

use crate::{Failure, ShellEnv, login_shell, resolve};

/// Where the login shell's environment stands. Connecting to a cluster
/// waits for anything but `Resolving`.
#[derive(Debug, Clone)]
pub enum Status {
    Resolving,
    Resolved(Arc<ShellEnv>),
    /// Twigo proceeds with its own process environment.
    Failed {
        env: Arc<ShellEnv>,
        failure: Arc<Failure>,
    },
}

/// The login shell's environment for the whole app, resolved once at
/// startup and again when the user retries after a failure.
pub struct Environment {
    shell: PathBuf,
    status: watch::Sender<Status>,
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            shell: login_shell(),
            status: watch::Sender::new(Status::Resolving),
        }
    }
}

impl Environment {
    /// The first resolution, which the status starts out waiting for.
    pub async fn resolve(&self) {
        let status = match resolve(&self.shell).await {
            Ok(env) => Status::Resolved(Arc::new(env)),
            Err(failure) => {
                eprintln!("the login shell's environment is unknown: {failure}");
                Status::Failed {
                    env: Arc::new(ShellEnv::from_process()),
                    failure: Arc::new(failure),
                }
            }
        };
        self.status.send_replace(status);
    }

    /// Resolves again after a failure; does nothing otherwise.
    pub async fn retry(&self) {
        let failed = self.status.send_if_modified(|status| {
            let failed = matches!(status, Status::Failed { .. });
            if failed {
                *status = Status::Resolving;
            }
            failed
        });
        if failed {
            self.resolve().await;
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<Status> {
        self.status.subscribe()
    }
}

impl From<&Status> for ShellEnvironment {
    fn from(status: &Status) -> Self {
        match status {
            Status::Resolving => Self::Resolving,
            Status::Resolved(_) => Self::Resolved,
            Status::Failed { failure, .. } => Self::Failed {
                shell: failure.shell.display().to_string(),
                reason: failure.reason.to_string(),
                output: failure.output.clone(),
            },
        }
    }
}
