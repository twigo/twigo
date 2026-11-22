//! The events of a test, in the shape of the log's own lines.

use std::cell::RefCell;
use std::io;
use std::marker::PhantomData;
use std::sync::Once;

use serde_json::Value;
use tracing_subscriber::fmt::writer::BoxMakeWriter;

use crate::{default_filter, subscriber};

thread_local! {
    static WRITTEN: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// The events this thread has logged since [`capture`].
pub struct Captured(PhantomData<*const ()>);

struct ThreadBuffer;

impl io::Write for ThreadBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        WRITTEN.with_borrow_mut(|written| written.extend_from_slice(bytes));
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Starts keeping this thread's events, as the log's default filter lets them
/// through, and forgets those of an earlier test on the thread.
///
/// The subscriber is the process's, set once, and each thread keeps its own
/// lines. A scoped subscriber per test would lose events: `tracing` decides
/// whether a callsite is enabled once, on the thread that first reaches it,
/// and with one subscriber alive asks that thread's default alone, so a
/// parallel test that reaches the callsite first with none set disables it
/// for every thread.
///
/// The process must set no subscriber of its own.
pub fn capture() -> Captured {
    static GLOBAL: Once = Once::new();
    GLOBAL.call_once(|| {
        let (dispatch, _) = subscriber(BoxMakeWriter::new(|| ThreadBuffer), default_filter());
        tracing::dispatcher::set_global_default(dispatch)
            .expect("no other subscriber is set where events are captured");
    });
    WRITTEN.with_borrow_mut(Vec::clear);
    Captured(PhantomData)
}

impl Captured {
    /// What was logged so far, one JSON object each: `level`, `target` and
    /// `fields`.
    pub fn lines(&self) -> Vec<Value> {
        WRITTEN.with_borrow(|written| {
            String::from_utf8_lossy(written)
                .lines()
                .map(|line| serde_json::from_str(line).expect("a JSON line"))
                .collect()
        })
    }
}
