//! Why a forward fails, whether that says its target is gone, and which
//! errors pass by themselves.

use twigo_ipc::{ErrorKind, IpcError};

/// An error that fails a forward. Only a watch of the target itself that
/// finds it missing and a 404 on the upgrade to a pod that is the target say
/// the target is gone, which a forward looks at again with its next
/// connection: no other error becomes one by its kind, since the hub answers
/// `NotFound` as well for a context that no source lists and for a list the
/// server does not have.
#[derive(Debug, Clone)]
pub(super) struct Cause {
    error: IpcError,
    gone: bool,
}

impl Cause {
    /// A watch of the target itself lists nothing.
    pub(super) fn gone(label: &str, name: &str) -> Self {
        Self {
            error: IpcError::new(ErrorKind::NotFound, format!("{label} {name} is gone")),
            gone: true,
        }
    }

    /// The upgrade to the pod that is the target answered 404. Behind a
    /// Service or a workload a 404 says only that pod is gone, which passes.
    pub(super) fn upgrade(error: &kube::Error) -> Option<Self> {
        match error {
            kube::Error::Api(status) if status.code == 404 => Some(Self {
                error: twigo_kube::errors::request(error),
                gone: true,
            }),
            _ => None,
        }
    }

    pub(super) fn is_gone(&self) -> bool {
        self.gone
    }

    pub(super) fn error(&self) -> &IpcError {
        &self.error
    }

    pub(super) fn into_error(self) -> IpcError {
        self.error
    }
}

impl From<IpcError> for Cause {
    fn from(error: IpcError) -> Self {
        Self { error, gone: false }
    }
}

/// Whether an error of the hub's or of the clients' may pass by itself: a
/// cluster or a pod that does not answer, or a fault of ours. A rejected
/// credential, a refusal, a missing context or an invalid kubeconfig does
/// not.
pub(super) fn passes(kind: ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::Unavailable | ErrorKind::Timeout | ErrorKind::Internal
    )
}
