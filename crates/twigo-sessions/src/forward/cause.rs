//! Why a forward fails, what starts it again, and which errors fail it
//! whoever asked for the proof.

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

/// What starts a failed forward again besides a person's start or resume
/// and a lifted refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Lift {
    /// Nothing else.
    Asked,
    /// Its target was gone: its next connection looks at it again.
    Connection,
    /// The cluster refused the credentials: its space connecting, which
    /// builds the context's clients anew, proves it. Trying again at each
    /// connection would run a credential plugin again and again.
    Clients,
}

impl Cause {
    /// A watch of the target itself lists nothing.
    pub(super) fn gone(label: &str, name: &str) -> Self {
        Self {
            error: IpcError::new(ErrorKind::NotFound, format!("{label} {name} is gone")),
            gone: true,
        }
    }

    /// The upgrade to the pod answered 404: that pod is gone.
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

    pub(super) fn lift(&self) -> Lift {
        if self.gone {
            Lift::Connection
        } else if self.error.kind == ErrorKind::Unauthorized {
            Lift::Clients
        } else {
            Lift::Asked
        }
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

/// Whether an error of the clients or of the upgrade fails a forward
/// whoever asked for the proof: the gate's refusal, a context that no source
/// lists, or a credential failure (a 401, a credential plugin that failed, a
/// plugin not trusted yet). Any other may pass, a 403 too, which an API
/// server answers for a while after it restarts (ARCHITECTURE 3.2).
pub(super) fn lasts(error: &IpcError) -> bool {
    matches!(
        error.kind,
        ErrorKind::Permissions | ErrorKind::NotFound | ErrorKind::Unauthorized
    )
}
