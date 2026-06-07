use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("context '{0}' not found")]
    ContextNotFound(String),

    #[error("not connected to '{0}'")]
    NotConnected(String),

    #[error("failed to read {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("invalid credentials: {0}")]
    Credentials(String),

    #[error(transparent)]
    Connect(#[from] async_nats::ConnectError),

    #[error(transparent)]
    Subscribe(#[from] async_nats::SubscribeError),
}

pub type Result<T> = std::result::Result<T, Error>;

// Commands send the message string to the frontend.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
