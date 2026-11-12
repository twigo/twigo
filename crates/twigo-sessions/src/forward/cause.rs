//! Why a forward fails, and whether that says its target is gone.

use twigo_ipc::{ErrorKind, IpcError};

/// An error that fails a forward. Only a watch of the target itself that
/// finds it missing and a 404 on the upgrade to its pod say the target is
/// gone, which a forward looks at again with its next connection: no other
/// error becomes one by its kind, since the hub answers `NotFound` as well
/// for a context that no source lists and for a list the server does not
/// have.
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

    /// The upgrade to a pod answered 404.
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
