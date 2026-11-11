//! A terminal on this machine (ARCHITECTURE 4.6): a program on a pty of its
//! own, parked until it is opened with the terminal's size. Its output goes
//! out by the same flow as a shell's in a pod, in the same frames; it ends
//! when the program exits, with what the pty still held, and dropping it
//! hangs up whatever runs on it.

mod hangup;
mod spawn;
#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::os::fd::AsFd;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::Mutex;
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::Signal;
use pty_process::{Pty, Size};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Child;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};
use twigo_ipc::{ErrorKind, IpcError, ShellEnd, ShellEvent};

use crate::flow::{FRAME_MAX, Flow};
use crate::shell::{Frame, INPUT_QUEUE};
use hangup::Hangup;

/// How long output may still come once the program exited, from a job that
/// holds the pty; VS Code waits 200 ms for it.
const DRAIN: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// The whole environment: nothing comes from Twigo's own.
    pub env: Vec<(OsString, OsString)>,
    pub cwd: PathBuf,
}

/// A terminal: parked until [`Terminal::open`], ended by its program, and
/// hung up when dropped.
pub struct Terminal {
    parked: Mutex<Option<Parked>>,
    running: Mutex<Option<Running>>,
    input: mpsc::Sender<Vec<u8>>,
    acks: watch::Sender<u64>,
    size: watch::Sender<(u16, u16)>,
}

struct Parked {
    spec: Spec,
    commands: Commands,
}

/// What the terminal is told by the webview.
struct Commands {
    input: mpsc::Receiver<Vec<u8>>,
    acks: watch::Receiver<u64>,
    size: watch::Receiver<(u16, u16)>,
}

struct Running {
    task: JoinHandle<()>,
    hangup: Hangup,
}

impl Terminal {
    pub fn park(spec: Spec) -> Self {
        let (input, input_rx) = mpsc::channel(INPUT_QUEUE);
        let (acks, acks_rx) = watch::channel(0);
        let (size, size_rx) = watch::channel((0, 0));
        Self {
            parked: Mutex::new(Some(Parked {
                spec,
                commands: Commands {
                    input: input_rx,
                    acks: acks_rx,
                    size: size_rx,
                },
            })),
            running: Mutex::default(),
            input,
            acks,
            size,
        }
    }

    /// Starts the program with the terminal's size, which says `Running`, or
    /// ends `Failed` in words when it cannot start. Needs the runtime, as it
    /// spawns.
    pub fn open(
        &self,
        cols: u16,
        rows: u16,
        mut send: impl FnMut(Frame) -> bool + Send + 'static,
    ) -> Result<(), IpcError> {
        let parked = self.parked.lock().expect("terminal lock").take();
        let Some(Parked { spec, commands }) = parked else {
            return Err(IpcError::new(
                ErrorKind::Conflict,
                "this terminal has started already",
            ));
        };
        self.size.send_replace((cols, rows));
        let spawned = match spawn::spawn(&spec, Size::new(rows, cols)) {
            Ok(spawned) => spawned,
            Err(error) => {
                let error = IpcError::new(
                    ErrorKind::Unavailable,
                    format!("could not start {}: {error}", spec.program.display()),
                );
                send(Frame::Event(ShellEvent::Ended {
                    end: ShellEnd::Failed { error },
                }));
                return Ok(());
            }
        };
        let spawn::Spawned { pty, child, hangup } = spawned;
        let task = tokio::spawn(async move {
            if send(Frame::Event(ShellEvent::Running)) {
                run(pty, child, commands, send).await;
            }
        });
        *self.running.lock().expect("terminal lock") = Some(Running { task, hangup });
        Ok(())
    }

    /// Queues what the person typed, waiting while it is full, so a paste
    /// never outruns the program. Nothing is sent once it has ended.
    pub fn input(&self, data: Vec<u8>) -> impl Future<Output = ()> + Send + use<> {
        let input = self.input.clone();
        async move {
            let _ = input.send(data).await;
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        self.size.send_replace((cols, rows));
    }

    /// Counts what the terminal has parsed.
    pub fn ack(&self, bytes: u32) {
        self.acks
            .send_modify(|total| *total = total.saturating_add(u64::from(bytes)));
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let running = self.running.get_mut().expect("terminal lock").take();
        if let Some(Running { task, hangup }) = running {
            hangup.hang_up();
            task.abort();
        }
    }
}

/// Runs the program until it exits: output goes out by [`Flow`], and input
/// and resizes stay live while output is stopped. Then what the pty still
/// holds goes out, as flow allows, until a read would block or [`DRAIN`]
/// after the exit, and the end comes last.
async fn run(
    mut pty: Pty,
    mut child: Child,
    commands: Commands,
    mut send: impl FnMut(Frame) -> bool,
) {
    let Commands {
        mut input,
        mut acks,
        mut size,
    } = commands;
    let mut flow = Flow::default();
    let mut buffer = vec![0; FRAME_MAX];
    let mut seen_acks = *acks.borrow_and_update();
    let mut writing: Vec<u8> = Vec::new();
    // Twigo holds a slave of its own, so the end of the output is the exit,
    // never a read's end.
    let mut readable = true;

    macro_rules! out {
        ($frames:expr) => {
            for frame in $frames {
                if !send(Frame::Output(frame)) {
                    return;
                }
            }
        };
    }
    macro_rules! acked {
        ($changed:expr) => {{
            if $changed.is_err() {
                return;
            }
            let total = *acks.borrow_and_update();
            flow.ack(total - seen_acks);
            seen_acks = total;
        }};
    }

    let exited = {
        let (mut reader, mut writer) = pty.split();
        loop {
            let reading = readable && flow.reading();
            let due = flow.due();
            tokio::select! {
                read = reader.read(&mut buffer), if reading => match read {
                    Ok(n) if n > 0 => out!(flow.read(&buffer[..n], Instant::now())),
                    _ => readable = false,
                },
                exited = child.wait() => break exited,
                () = sleep_until(due.unwrap_or_else(Instant::now)), if due.is_some() => {
                    out!(flow.flush(Instant::now()));
                }
                changed = acks.changed() => acked!(changed),
                data = input.recv(), if writing.is_empty() => match data {
                    Some(data) => writing = data,
                    None => return,
                },
                written = writer.write(&writing), if !writing.is_empty() => match written {
                    Ok(n) => { writing.drain(..n); }
                    Err(error) => {
                        eprintln!("could not write to a terminal: {error}");
                        writing.clear();
                    }
                },
                changed = size.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    let (cols, rows) = *size.borrow_and_update();
                    if let Err(error) = writer.resize(Size::new(rows, cols)) {
                        eprintln!("could not resize a terminal: {error}");
                    }
                }
            }
        }
    };
    let end = match exited {
        Ok(status) => ending(status),
        Err(error) => ShellEnd::Failed {
            error: IpcError::new(
                ErrorKind::Internal,
                format!("could not learn how the shell ended: {error}"),
            ),
        },
    };

    let deadline = Instant::now() + DRAIN;
    while readable && Instant::now() < deadline {
        if flow.reading() {
            match nix::unistd::read(pty.as_fd(), &mut buffer) {
                Ok(n) if n > 0 => out!(flow.read(&buffer[..n], Instant::now())),
                Err(Errno::EINTR) => {}
                // EAGAIN once it has given all that was written.
                _ => break,
            }
            continue;
        }
        let due = flow.due();
        tokio::select! {
            changed = acks.changed() => acked!(changed),
            () = sleep_until(due.unwrap_or_else(Instant::now)), if due.is_some() => {
                out!(flow.flush(Instant::now()));
            }
            () = sleep_until(deadline) => break,
        }
    }
    out!(flow.flush(Instant::now()));
    send(Frame::Event(ShellEvent::Ended { end }));
}

fn ending(status: ExitStatus) -> ShellEnd {
    match status.code() {
        Some(code) => ShellEnd::Exited { code },
        None => ShellEnd::Signaled {
            signal: name(
                status
                    .signal()
                    .expect("a status from wait is an exit or a signal"),
            ),
        },
    }
}

/// A signal as `kill -l` names it, `KILL`; by its number where Twigo knows
/// no name, as for Linux's real-time signals.
fn name(signal: i32) -> String {
    match Signal::try_from(signal) {
        Ok(signal) => signal.as_str().trim_start_matches("SIG").to_owned(),
        Err(_) => signal.to_string(),
    }
}
