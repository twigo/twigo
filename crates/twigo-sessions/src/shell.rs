//! A shell in a container, or an attach to its main process (ARCHITECTURE
//! 4.6). The core keeps a session parked for the plan that made it, and
//! starting it holds one place of the cluster's sessions for its whole life
//! (3.2). The session's output comes in frames, sized for the terminal by what
//! it has acknowledged.

mod connect;
mod ending;
mod flow;

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use futures::future::BoxFuture;
use futures::{FutureExt, Stream, StreamExt};
use tokio::io::{AsyncWriteExt, SimplexStream, WriteHalf};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};
use tokio_util::io::ReaderStream;
use twigo_ipc::{ErrorKind, IpcError, ShellEnd, ShellEvent};
use twigo_kube::client::{Actor, Clients, Waiting};

use connect::{Connect, Kube};
use ending::ending;
use flow::{FRAME_MAX, Flow};

const INPUT_QUEUE: usize = 32;

/// `sh` exists wherever a shell can run at all; a person's `exit 1` can never
/// start a second shell, as it would after a retry on failure, because `exec`
/// replaces this one.
pub const SHELL: [&str; 3] = [
    "sh",
    "-c",
    "export TERM=xterm-256color; command -v bash >/dev/null && exec bash || exec sh",
];

/// What a session sends its window.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Output(Vec<u8>),
    Event(ShellEvent),
}

/// What it runs in the container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Join {
    Exec(Vec<String>),
    Attach,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub join: Join,
    pub stdin: bool,
    pub tty: bool,
}

impl Spec {
    /// A shell in the container, on a terminal.
    pub fn shell(namespace: String, pod: String, container: String) -> Self {
        Self {
            namespace,
            pod,
            container,
            join: Join::Exec(SHELL.map(str::to_owned).into()),
            stdin: true,
            tty: true,
        }
    }
}

/// A session: parked until [`Session::open`], ended by its process, by the
/// context turning read-only or the connection going, and for good when
/// dropped.
pub struct Session {
    parked: Mutex<Option<Parked>>,
    task: Mutex<Option<JoinHandle<()>>>,
    input: mpsc::Sender<Vec<u8>>,
    acks: watch::Sender<u64>,
    size: watch::Sender<(u16, u16)>,
}

struct Parked {
    clients: Arc<Clients>,
    connect: Box<dyn Connect>,
    spec: Spec,
    relocked: BoxFuture<'static, ()>,
    commands: Commands,
}

/// What the session is told by the webview.
struct Commands {
    input: mpsc::Receiver<Vec<u8>>,
    acks: watch::Receiver<u64>,
    size: watch::Receiver<(u16, u16)>,
}

/// What cuts a session short.
struct Cuts {
    relocked: BoxFuture<'static, ()>,
    abandoned: BoxFuture<'static, ()>,
    retired: watch::Receiver<u64>,
}

impl Session {
    /// Holds a session to start on `clients`. `relocked` ends once its
    /// context turns read-only.
    pub fn park(clients: Arc<Clients>, spec: Spec, relocked: BoxFuture<'static, ()>) -> Self {
        let connect = Box::new(Kube(clients.sessions.clone()));
        Self::parked(clients, spec, relocked, connect)
    }

    fn parked(
        clients: Arc<Clients>,
        spec: Spec,
        relocked: BoxFuture<'static, ()>,
        connect: Box<dyn Connect>,
    ) -> Self {
        let (input, input_rx) = mpsc::channel(INPUT_QUEUE);
        let (acks, acks_rx) = watch::channel(0);
        let (size, size_rx) = watch::channel((0, 0));
        Self {
            parked: Mutex::new(Some(Parked {
                clients,
                connect,
                spec,
                relocked,
                commands: Commands {
                    input: input_rx,
                    acks: acks_rx,
                    size: size_rx,
                },
            })),
            task: Mutex::default(),
            input,
            acks,
            size,
        }
    }

    /// Starts it with the terminal's size. Needs the runtime, as it spawns
    /// its task.
    pub fn open(
        &self,
        cols: u16,
        rows: u16,
        send: impl FnMut(Frame) -> bool + Send + 'static,
    ) -> Result<(), IpcError> {
        let parked = self.parked.lock().expect("shell lock").take();
        let Some(parked) = parked else {
            return Err(IpcError::new(
                ErrorKind::Conflict,
                "this shell has started already",
            ));
        };
        self.size.send_replace((cols, rows));
        let task = tokio::spawn(run(parked, send));
        *self.task.lock().expect("shell lock") = Some(task);
        Ok(())
    }

    /// Queues what the person typed, waiting while it is full, so a paste
    /// never outruns the process. Nothing is sent once it has ended.
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

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(task) = self.task.lock().expect("shell lock").take() {
            task.abort();
        }
    }
}

fn abandoned(clients: &Clients) -> impl Future<Output = ()> + Send + 'static {
    let mut abandoned = clients.connections().abandoned();
    async move {
        // Its sender lives as long as the clients this session holds.
        let _ = abandoned.wait_for(|abandoned| *abandoned).await;
    }
}

/// The session's life: in the queue, connecting, then running; every step
/// also ends on a relock or the clients going.
async fn run(parked: Parked, mut send: impl FnMut(Frame) -> bool + Send + 'static) {
    let Parked {
        clients,
        connect,
        spec,
        relocked,
        commands,
    } = parked;
    let mut cuts = Cuts {
        relocked,
        abandoned: abandoned(&clients).boxed(),
        retired: clients.connections().retired(),
    };
    macro_rules! end {
        ($end:expr) => {{
            send(Frame::Event(ShellEvent::Ended { end: $end }));
            return;
        }};
    }
    let (queued, mut waiting) = watch::channel(false);
    let told = Waiting(Arc::new(move |is| {
        queued.send_replace(is);
    }));
    let _permit = {
        let admit = clients.admit_session(Actor::Ui, Some(&told));
        let mut admit = std::pin::pin!(admit);
        loop {
            tokio::select! {
                biased;
                () = &mut cuts.relocked => end!(ShellEnd::Relocked),
                () = &mut cuts.abandoned => end!(ShellEnd::ConnectionLost),
                permit = &mut admit => break permit,
                Ok(()) = waiting.changed() => {
                    if *waiting.borrow_and_update()
                        && !send(Frame::Event(ShellEvent::Queued))
                    {
                        return;
                    }
                }
            }
        }
    };
    if !send(Frame::Event(ShellEvent::Connecting)) {
        return;
    }
    cuts.retired.borrow_and_update();
    let connected = tokio::select! {
        biased;
        () = &mut cuts.relocked => end!(ShellEnd::Relocked),
        () = &mut cuts.abandoned => end!(ShellEnd::ConnectionLost),
        _ = cuts.retired.changed() => end!(ShellEnd::ConnectionLost),
        connected = connect.connect(&spec) => connected,
    };
    let connected = match connected {
        Ok(connected) => connected,
        Err(error) => end!(ShellEnd::Failed {
            error: twigo_kube::errors::request(&error),
        }),
    };
    if !send(Frame::Event(ShellEvent::Running)) {
        return;
    }
    pump(connected, &spec, commands, cuts, send).await;
}

/// The stdout and stderr of a process as one stream of chunks.
fn output(
    stdout: tokio::io::ReadHalf<SimplexStream>,
    stderr: Option<tokio::io::ReadHalf<SimplexStream>>,
) -> impl Stream<Item = std::io::Result<Bytes>> + Send + Unpin {
    let stdout = ReaderStream::with_capacity(stdout, FRAME_MAX);
    match stderr {
        Some(stderr) => {
            futures::stream::select(stdout, ReaderStream::with_capacity(stderr, FRAME_MAX))
                .left_stream()
        }
        None => stdout.right_stream(),
    }
}

async fn write_some(
    stdin: &mut Option<WriteHalf<SimplexStream>>,
    data: &[u8],
) -> std::io::Result<usize> {
    match stdin {
        Some(stdin) => stdin.write(data).await,
        None => Ok(data.len()),
    }
}

type Resize = futures::channel::mpsc::Sender<kube::api::TerminalSize>;

async fn set_size(resize: &mut Option<Resize>, size: Option<(u16, u16)>) {
    if let (Some(resize), Some((width, height))) = (resize.as_mut(), size) {
        let size = kube::api::TerminalSize { width, height };
        let _ = futures::SinkExt::send(resize, size).await;
    }
}

/// Runs a connected process until it ends or is ended: output goes out by
/// [`Flow`], and everything else stays live while output is stopped, which
/// blocks kube's whole loop until the reader drains it.
async fn pump(
    connected: connect::Connected,
    spec: &Spec,
    commands: Commands,
    cuts: Cuts,
    mut send: impl FnMut(Frame) -> bool,
) {
    let Commands {
        mut input,
        mut acks,
        mut size,
    } = commands;
    let Cuts {
        mut relocked,
        mut abandoned,
        mut retired,
    } = cuts;
    let connect::Connected {
        stdout,
        stderr,
        mut stdin,
        mut resize,
        mut status,
        held,
    } = connected;
    let _held = held;
    let mut output = output(stdout, stderr);
    let mut flow = Flow::default();
    let mut printed = false;
    let mut seen_acks = *acks.borrow_and_update();
    let mut writing: Vec<u8> = Vec::new();
    let mut new_size = resize.is_some().then(|| *size.borrow_and_update());

    macro_rules! out {
        ($frames:expr) => {
            for frame in $frames {
                if !send(Frame::Output(frame)) {
                    return;
                }
            }
        };
    }
    macro_rules! end {
        ($end:expr) => {{
            out!(flow.flush());
            send(Frame::Event(ShellEvent::Ended { end: $end }));
            return;
        }};
    }

    let known = loop {
        let reading = flow.reading();
        let due = flow.due();
        tokio::select! {
            chunk = output.next(), if reading => match chunk {
                Some(Ok(bytes)) => {
                    printed |= !bytes.is_empty();
                    out!(flow.read(&bytes, Instant::now()));
                }
                Some(Err(_)) | None => break None,
            },
            status = &mut status => break Some(status),
            () = sleep_until(due.unwrap_or_else(Instant::now)), if due.is_some() => {
                out!(flow.flush());
            }
            changed = acks.changed() => {
                if changed.is_err() {
                    return;
                }
                let total = *acks.borrow_and_update();
                out!(flow.ack(total - seen_acks));
                seen_acks = total;
            }
            data = input.recv(), if writing.is_empty() => match data {
                Some(data) => writing = data,
                None => return,
            },
            written = write_some(&mut stdin, &writing), if !writing.is_empty() => match written {
                Ok(n) => { writing.drain(..n); }
                Err(_) => { stdin = None; writing.clear(); }
            },
            changed = size.changed() => {
                if changed.is_err() {
                    return;
                }
                if resize.is_some() {
                    new_size = Some(*size.borrow_and_update());
                }
            }
            () = set_size(&mut resize, new_size), if new_size.is_some() => new_size = None,
            _ = retired.changed() => end!(ShellEnd::ConnectionLost),
            () = &mut abandoned => end!(ShellEnd::ConnectionLost),
            () = &mut relocked => end!(ShellEnd::Relocked),
        }
    };

    // A status comes before the end of the output, and its absence after it
    // or never: kube drops its writers without closing them on an error.
    let status = match known {
        Some(status) => status,
        None => status.await,
    };
    let complete = status.is_some();
    loop {
        let chunk = if complete {
            output.next().await
        } else {
            match output.next().now_or_never() {
                Some(chunk) => chunk,
                None => break,
            }
        };
        match chunk {
            Some(Ok(bytes)) => {
                printed |= !bytes.is_empty();
                out!(flow.read(&bytes, Instant::now()));
            }
            Some(Err(_)) | None => break,
        }
    }
    let shell = matches!(spec.join, Join::Exec(_));
    end!(ending(status.as_ref(), printed, shell));
}

#[cfg(test)]
mod tests;
