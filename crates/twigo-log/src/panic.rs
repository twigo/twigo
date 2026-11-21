//! The panic hook (ARCHITECTURE 4.10): one record per panic, in the shape of
//! the log's own lines, written before the hook returns.

use std::backtrace::Backtrace;
use std::io::Write as _;
use std::panic::PanicHookInfo;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Map, Value};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::{FormatTime, SystemTime};

use crate::Rotating;

/// How long the hook waits for the log's lock, which the panicking thread
/// may hold itself.
const LOCK_WAIT: Duration = Duration::from_millis(100);

/// Where the hook writes once the log is open.
static LOG: OnceLock<Rotating> = OnceLock::new();

/// Writes each panic's record to stderr until [`Log::start`](crate::Log::start)
/// opens the log, and to the log after. Installed first in `main`, so a panic
/// of the setup is recorded too.
///
/// The record holds the time, the thread's name, the tokio task's id where
/// the panic is in one, the location, the message, a backtrace and Twigo's
/// version. A debug build also calls the hook it replaces, so the terminal
/// of `pnpm tauri dev` still prints.
///
/// The hook never panics: a panic inside a hook aborts the process.
pub fn install_hook(version: &'static str) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write(&record(info, version));
        if cfg!(debug_assertions) {
            previous(info);
        }
    }));
}

pub(crate) fn open(log: &Rotating) {
    // A second log in one process keeps the first as the hook's.
    let _ = LOG.set(log.clone());
}

fn record(info: &PanicHookInfo<'_>, version: &str) -> Vec<u8> {
    let mut at = String::new();
    // A formatting error leaves the time empty; nothing here may panic.
    let _ = SystemTime.format_time(&mut Writer::new(&mut at));

    let mut fields = Map::new();
    let mut field = |name: &str, value: String| fields.insert(name.to_owned(), Value::from(value));
    field("message", "panic".to_owned());
    field(
        "payload",
        info.payload_as_str().unwrap_or("<not a string>").to_owned(),
    );
    if let Some(location) = info.location() {
        field("location", location.to_string());
    }
    field(
        "thread",
        std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_owned(),
    );
    if let Some(task) = tokio::task::try_id() {
        field("task", task.to_string());
    }
    field("version", version.to_owned());
    // `RUST_BACKTRACE` is unset in a release build, which nobody starts from
    // a terminal.
    let backtrace = if cfg!(debug_assertions) {
        Backtrace::capture()
    } else {
        Backtrace::force_capture()
    };
    field("backtrace", backtrace.to_string());

    // In the order of the log's own lines.
    let mut line = br#"{"timestamp":"#.to_vec();
    let _ = serde_json::to_writer(&mut line, &at);
    line.extend_from_slice(br#","level":"ERROR","fields":"#);
    let _ = serde_json::to_writer(&mut line, &fields);
    line.extend_from_slice(br#","target":"#);
    let _ = serde_json::to_writer(&mut line, module_path!());
    line.extend_from_slice(b"}\n");
    line
}

fn write(line: &[u8]) {
    if LOG.get().is_some_and(|log| log.try_append(line, LOCK_WAIT)) {
        return;
    }
    // `eprintln!` panics when stderr is closed.
    let _ = std::io::stderr().write_all(line);
}
