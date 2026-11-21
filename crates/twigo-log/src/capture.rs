//! The events of a test, in the shape of the log's own lines.

use std::io;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use tracing::dispatcher::{DefaultGuard, set_default};
use tracing_subscriber::fmt::writer::BoxMakeWriter;

use crate::{default_filter, subscriber};

/// The events this thread logs, from [`capture`] until this is dropped.
pub struct Captured {
    written: Arc<Mutex<Vec<u8>>>,
    _guard: DefaultGuard,
}

struct Shared(Arc<Mutex<Vec<u8>>>);

impl io::Write for Shared {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Makes this thread's events lines of memory, the log's default filter
/// letting them through, instead of the process's.
pub fn capture() -> Captured {
    let written = Arc::<Mutex<Vec<u8>>>::default();
    let sink = Arc::clone(&written);
    let (dispatch, _) = subscriber(
        BoxMakeWriter::new(move || Shared(Arc::clone(&sink))),
        default_filter(),
    );
    Captured {
        written,
        _guard: set_default(&dispatch),
    }
}

impl Captured {
    /// What was logged so far, one JSON object each: `level`, `target` and
    /// `fields`.
    pub fn lines(&self) -> Vec<Value> {
        let written = self.written.lock().unwrap_or_else(PoisonError::into_inner);
        String::from_utf8_lossy(&written)
            .lines()
            .map(|line| serde_json::from_str(line).expect("a JSON line"))
            .collect()
    }
}
