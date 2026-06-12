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

    #[error("background task failed: {0}")]
    Task(String),

    #[error("jetstream error: {0}")]
    JetStream(String),

    #[error("monitoring unavailable: {0}")]
    Monitoring(String),

    #[error(transparent)]
    Connect(#[from] async_nats::ConnectError),

    #[error(transparent)]
    Subscribe(#[from] async_nats::SubscribeError),

    #[error(transparent)]
    Publish(#[from] async_nats::PublishError),

    #[error(transparent)]
    Request(#[from] async_nats::RequestError),

    #[error(transparent)]
    Flush(#[from] async_nats::client::FlushError),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Stable discriminant the frontend can branch on (retry vs config vs auth)
    /// without parsing the human-readable message. Keep in sync with the
    /// `IpcError["kind"]` values in `src/lib/api.ts`.
    pub fn kind(&self) -> &'static str {
        match self {
            Error::ContextNotFound(_) => "contextNotFound",
            Error::NotConnected(_) => "notConnected",
            Error::Io { .. } => "io",
            Error::Credentials(_) => "credentials",
            Error::Task(_) => "task",
            Error::JetStream(_) => "jetstream",
            Error::Monitoring(_) => "monitoring",
            Error::Connect(_) => "connect",
            Error::Subscribe(_) => "subscribe",
            Error::Publish(_) => "publish",
            Error::Request(_) => "request",
            Error::Flush(_) => "flush",
        }
    }
}

// Commands send a structured { kind, message } to the frontend so the UI can
// branch on `kind` while still showing `message`.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("Error", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

#[cfg(test)]
mod tests {
    use super::Error;

    #[test]
    fn serializes_to_kind_and_message() {
        let err = Error::NotConnected("dev".into());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "notConnected");
        assert_eq!(json["message"], "not connected to 'dev'");
    }

    #[test]
    fn kind_is_stable_per_variant() {
        assert_eq!(Error::Credentials("x".into()).kind(), "credentials");
        assert_eq!(Error::ContextNotFound("x".into()).kind(), "contextNotFound");
    }
}
