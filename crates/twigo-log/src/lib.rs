//! The diagnostics log of ARCHITECTURE 4.10, and the file the audit log is
//! written to.
//!
//! Every crate logs through `tracing`, never `eprintln!`, and the target is
//! the module path. The log is JSON lines: an event's identifying values
//! travel as fields with these names, and the message stays words, so a
//! report can alias a value by the field that carries it without reading
//! sentences:
//!
//! - `context`, a context's name;
//! - `space`, a space's name;
//! - `cluster`, a cluster's name in a kubeconfig;
//! - `server`, an API server's address;
//! - `user`, a kubeconfig user's name;
//! - `namespace`;
//! - `object`, an object's name;
//! - `path`, a file or a directory;
//! - `url`.
//!
//! A change of state is logged once, a repeat of it counted; per-event
//! detail goes to `trace`. No event carries a token, a frame, an input, a
//! batch, an object's values, a kubeconfig's text or a server's message for
//! a failed request.

mod facts;
mod panic;
mod rotating;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Once;

pub use facts::Facts;
pub use panic::install_hook;
pub use rotating::{Limits, Rotating};
pub use tracing::Level;
use tracing::level_filters::LevelFilter;
use tracing_log::AsLog;
use tracing_subscriber::filter::ParseError;
use tracing_subscriber::fmt::writer::BoxMakeWriter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::reload;
use tracing_subscriber::{EnvFilter, Registry};

/// The file of the current run, in the log directory.
pub const FILE: &str = "twigo.log";

/// The environment variable that sets the filter at start, in `EnvFilter`'s
/// syntax.
pub const ENV: &str = "TWIGO_LOG";

/// Warnings of any library, and Twigo's own crates from info up.
const DEFAULT_FILTER: &str = "warn,twigo=info";

/// Each file of the log, and how many of the previous runs stay.
const LIMITS: Limits = Limits {
    size: 4 << 20,
    kept: 5,
};

/// The diagnostics log of this run: `twigo.log` in the log directory, a new
/// file at each launch with the previous runs' as `twigo.1.log` to
/// `twigo.5.log`, 4 MiB at most each, mode 0600.
pub struct Log {
    file: Option<Rotating>,
    path: PathBuf,
    filter: reload::Handle<EnvFilter, Registry>,
}

impl Log {
    /// Opens the log in `directory` and makes it the process's `tracing`
    /// subscriber and `log` logger, then writes the first line of the run.
    ///
    /// The filter is `warn,twigo=info`, or `TWIGO_LOG` where it is set. A file
    /// that cannot be opened is said on stderr, and the log goes there.
    pub fn start(directory: &Path, facts: &Facts) -> Self {
        let path = directory.join(FILE);
        let file = Rotating::open_new(&path, LIMITS)
            .inspect_err(|error| report(&path, error))
            .ok();
        let (spec, filter, invalid) = initial_filter();
        let writer = file
            .clone()
            .map_or_else(|| BoxMakeWriter::new(io::stderr), BoxMakeWriter::new);
        let (dispatch, handle) = subscriber(writer, filter);
        // The process's first and only: a second start in one process, as a
        // test binary makes, keeps the first's subscriber.
        let _ = tracing::dispatcher::set_global_default(dispatch);
        log_tracer();
        if let Some(file) = &file {
            panic::open(file);
        }
        facts.log(&spec);
        if let Some(error) = invalid {
            tracing::warn!(%error, "{ENV} is not a filter, so the default applies");
        }
        Self {
            file,
            path,
            filter: handle,
        }
    }

    /// Where the current run's file is, whether it opened.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the file is open: not once it could not be created.
    pub fn is_open(&self) -> bool {
        self.file.is_some()
    }

    /// Twigo's own crates log from `level` up and the libraries from warn,
    /// whatever `TWIGO_LOG` said, until the process ends.
    pub fn set_level(&self, level: Level) {
        let spec = format!("warn,twigo={level}");
        match self.filter.reload(EnvFilter::new(&spec)) {
            Ok(()) => tracing::info!(%level, "the log level changed"),
            Err(error) => tracing::warn!(%error, "the log level could not change"),
        }
    }
}

/// What `TWIGO_LOG` says, or the default and why not.
fn initial_filter() -> (String, EnvFilter, Option<ParseError>) {
    match std::env::var(ENV) {
        Ok(spec) if !spec.is_empty() => match EnvFilter::try_new(&spec) {
            Ok(filter) => (spec, filter, None),
            Err(error) => (DEFAULT_FILTER.to_owned(), default_filter(), Some(error)),
        },
        _ => (DEFAULT_FILTER.to_owned(), default_filter(), None),
    }
}

fn default_filter() -> EnvFilter {
    EnvFilter::new(DEFAULT_FILTER)
}

/// A registry with the filter behind a reload layer and a JSON-lines layer
/// into `writer`.
fn subscriber(
    writer: BoxMakeWriter,
    filter: EnvFilter,
) -> (tracing::Dispatch, reload::Handle<EnvFilter, Registry>) {
    let (filter, handle) = reload::Layer::new(filter);
    let lines = tracing_subscriber::fmt::layer()
        .json()
        .with_ansi(false)
        .with_current_span(false)
        .with_span_list(false)
        .with_writer(writer);
    (
        tracing::Dispatch::new(Registry::default().with(filter).with(lines)),
        handle,
    )
}

/// Makes the `log` records of Tauri and the other libraries events, those the
/// subscriber's filter can let through.
fn log_tracer() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let level = AsLog::as_log(&LevelFilter::current());
        // Another `log` logger already set is the application's to keep.
        let _ = tracing_log::LogTracer::builder()
            .with_max_level(level)
            .init();
    });
}

#[expect(
    clippy::print_stderr,
    reason = "the log's own failure has no log to go to"
)]
fn report(path: &Path, error: &io::Error) {
    eprintln!("the log {} cannot be opened: {error}", path.display());
}

#[cfg(test)]
mod tests;
