use std::convert::Infallible;
use std::future::ready;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::channel::{mpsc, oneshot};
use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};
use http_body_util::Full;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::api::TerminalSize;
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, SimplexStream, WriteHalf, simplex};
use tokio::time::advance;
use twigo_ipc::{ErrorKind, ShellEnd, ShellEvent};
use twigo_kube::client::{Budgets, Clients};

use super::connect::{Connect, Connected};
use super::flow::FRAME_MAX;
use super::{Frame, Join, Session, Spec};

const KIB: usize = 1024;

fn clients(budgets: Budgets) -> Arc<Clients> {
    let service = tower::service_fn(|_| {
        ready(Ok::<_, Infallible>(http::Response::new(Full::new(
            Bytes::new(),
        ))))
    });
    Arc::new(Clients::over(service, budgets))
}

struct Fake(Mutex<Option<Result<Connected, kube::Error>>>);

impl Connect for Fake {
    fn connect(&self, _spec: &Spec) -> BoxFuture<'static, Result<Connected, kube::Error>> {
        ready(self.0.lock().unwrap().take().expect("connected once")).boxed()
    }
}

struct Process {
    stdout: WriteHalf<SimplexStream>,
    stderr: WriteHalf<SimplexStream>,
    stdin: ReadHalf<SimplexStream>,
    resize: mpsc::Receiver<TerminalSize>,
    status: oneshot::Sender<Status>,
}

fn spec(tty: bool, stdin: bool) -> Spec {
    Spec {
        namespace: "ns".to_owned(),
        pod: "web-1".to_owned(),
        container: "app".to_owned(),
        join: Join::Exec(vec!["sh".to_owned()]),
        stdin,
        tty,
    }
}

fn connected(tty: bool) -> (Connected, Process) {
    let (stdout_rx, stdout) = simplex(FRAME_MAX);
    let (stderr_rx, stderr) = simplex(FRAME_MAX);
    let (stdin, stdin_tx) = simplex(FRAME_MAX);
    let (resize_tx, resize) = mpsc::channel(10);
    let (status, status_rx) = oneshot::channel();
    (
        Connected {
            stdout: stdout_rx,
            stderr: (!tty).then_some(stderr_rx),
            stdin: Some(stdin_tx),
            resize: tty.then_some(resize_tx),
            status: status_rx.map(Result::ok).boxed(),
            held: Box::new(()),
        },
        Process {
            stdout,
            stderr,
            stdin,
            resize,
            status,
        },
    )
}

struct Harness {
    session: Session,
    clients: Arc<Clients>,
    frames: Arc<Mutex<Vec<Frame>>>,
    relock: Option<oneshot::Sender<()>>,
}

fn parked(tty: bool, budgets: Budgets, to: Result<Connected, kube::Error>) -> Harness {
    let (relock, relocked) = oneshot::channel();
    let clients = clients(budgets);
    let session = Session::parked(
        Arc::clone(&clients),
        spec(tty, true),
        relocked.map(|_| ()).boxed(),
        Box::new(Fake(Mutex::new(Some(to)))),
    );
    Harness {
        session,
        clients,
        frames: Arc::default(),
        relock: Some(relock),
    }
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

impl Harness {
    fn relock(&mut self) {
        self.relock.take().unwrap().send(()).unwrap();
    }

    fn open(&self, cols: u16, rows: u16) {
        let frames = Arc::clone(&self.frames);
        self.session
            .open(cols, rows, move |frame| {
                frames.lock().unwrap().push(frame);
                true
            })
            .unwrap();
    }

    /// The events so far, without the output.
    fn events(&self) -> Vec<ShellEvent> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|frame| match frame {
                Frame::Event(event) => Some(event.clone()),
                Frame::Output(_) => None,
            })
            .collect()
    }

    fn outputs(&self) -> Vec<Vec<u8>> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|frame| match frame {
                Frame::Output(bytes) => Some(bytes.clone()),
                Frame::Event(_) => None,
            })
            .collect()
    }

    fn sent(&self) -> usize {
        self.outputs().iter().map(Vec::len).sum()
    }

    fn ended(&self) -> Option<ShellEnd> {
        self.events().into_iter().find_map(|event| match event {
            ShellEvent::Ended { end } => Some(end),
            _ => None,
        })
    }

    fn held(&self) -> usize {
        self.clients.usage().borrow().sessions.held
    }
}

async fn running(tty: bool) -> (Harness, Process) {
    let (to, process) = connected(tty);
    let harness = parked(tty, Budgets::default(), Ok(to));
    harness.open(100, 40);
    settle().await;
    assert_eq!(
        harness.events(),
        vec![ShellEvent::Connecting, ShellEvent::Running]
    );
    (harness, process)
}

async fn write(process: &mut Process, data: &[u8]) {
    process.stdout.write_all(data).await.unwrap();
    settle().await;
}

fn status(json: &str) -> Status {
    serde_json::from_str(json).unwrap()
}

const EXIT_3: &str = r#"{"status":"Failure","reason":"NonZeroExitCode","details":{"causes":[{"reason":"ExitCode","message":"3"}]}}"#;
const NO_SHELL: &str = r#"{"status":"Failure","reason":"InternalError","code":500,"message":"Internal error occurred: exec: \"bash\": executable file not found in $PATH"}"#;

#[tokio::test(start_paused = true)]
async fn with_nothing_unacknowledged_output_goes_out_at_once() {
    let (harness, mut process) = running(true).await;
    write(&mut process, b"prompt$ ").await;
    assert_eq!(harness.outputs(), vec![b"prompt$ ".to_vec()]);
}

#[tokio::test(start_paused = true)]
async fn output_with_anything_unacknowledged_gathers_for_5_ms_into_one_frame() {
    let (harness, mut process) = running(true).await;
    write(&mut process, b"a").await;
    write(&mut process, b"b").await;
    write(&mut process, b"c").await;
    assert_eq!(harness.outputs(), vec![b"a".to_vec()]);
    advance(Duration::from_millis(4)).await;
    settle().await;
    assert_eq!(harness.outputs(), vec![b"a".to_vec()]);
    advance(Duration::from_millis(2)).await;
    settle().await;
    assert_eq!(harness.outputs(), vec![b"a".to_vec(), b"bc".to_vec()]);
}

#[tokio::test(start_paused = true)]
async fn an_ack_that_clears_what_is_unacknowledged_lets_output_out_at_once_again() {
    let (harness, mut process) = running(true).await;
    write(&mut process, b"a").await;
    harness.session.ack(1);
    settle().await;
    write(&mut process, b"b").await;
    assert_eq!(harness.outputs(), vec![b"a".to_vec(), b"b".to_vec()]);
}

#[tokio::test(start_paused = true)]
async fn an_ack_for_more_than_was_sent_is_clamped() {
    let (harness, mut process) = running(true).await;
    write(&mut process, b"a").await;
    harness.session.ack(u32::MAX);
    settle().await;
    write(&mut process, b"b").await;
    write(&mut process, b"c").await;
    assert_eq!(harness.outputs(), vec![b"a".to_vec(), b"b".to_vec()]);
    advance(Duration::from_millis(6)).await;
    settle().await;
    assert_eq!(
        harness.outputs(),
        vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()]
    );
}

#[tokio::test(start_paused = true)]
async fn a_frame_is_at_most_64_kib() {
    let (harness, process) = running(true).await;
    let mut stdout = process.stdout;
    tokio::spawn(async move { stdout.write_all(&vec![1; 200 * KIB]).await.unwrap() });
    settle().await;
    advance(Duration::from_millis(6)).await;
    settle().await;
    assert_eq!(harness.sent(), 200 * KIB);
    assert!(
        harness
            .outputs()
            .iter()
            .all(|frame| !frame.is_empty() && frame.len() <= FRAME_MAX)
    );
}

struct Flood {
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl Flood {
    fn abort(self) {
        self.task.abort();
    }

    async fn stop_and_close(self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
    }
}

async fn stopped_at_high_water() -> (Harness, Process, Flood) {
    let (harness, mut process) = running(true).await;
    let (_, placeholder) = simplex(1);
    let mut stdout = std::mem::replace(&mut process.stdout, placeholder);
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let flood = async {
            loop {
                if stdout.write_all(&[7; 32 * KIB]).await.is_err() {
                    return;
                }
                tokio::task::yield_now().await;
            }
        };
        tokio::select! {
            _ = stopped => {}
            () = flood => {}
        }
        let _ = stdout.shutdown().await;
    });
    let flood = Flood { stop, task };
    for _ in 0..60 {
        settle().await;
        advance(Duration::from_millis(6)).await;
    }
    settle().await;
    (harness, process, flood)
}

#[tokio::test(start_paused = true)]
async fn the_reader_stops_at_256_kib_unacknowledged() {
    let (harness, _process, flood) = stopped_at_high_water().await;
    let sent = harness.sent();
    assert!(
        (256 * KIB..=(256 + 64) * KIB).contains(&sent),
        "sent {sent}"
    );
    for _ in 0..200 {
        settle().await;
        advance(Duration::from_millis(6)).await;
    }
    assert_eq!(harness.sent(), sent, "stopped");
    flood.abort();
}

#[tokio::test(start_paused = true)]
async fn the_reader_starts_again_below_64_kib() {
    let (harness, _process, flood) = stopped_at_high_water().await;
    let sent = harness.sent();
    let acked = u32::try_from(sent - 65 * KIB).unwrap();
    harness.session.ack(acked);
    for _ in 0..20 {
        settle().await;
        advance(Duration::from_millis(6)).await;
    }
    assert_eq!(harness.sent(), sent, "65 KiB unacknowledged is not below");
    harness.session.ack(u32::try_from(2 * KIB).unwrap());
    for _ in 0..20 {
        settle().await;
        advance(Duration::from_millis(6)).await;
    }
    assert!(harness.sent() > sent, "resumes below the low mark");
    flood.abort();
}

#[tokio::test(start_paused = true)]
async fn input_passes_while_output_is_stopped_and_output_starts_again_as_acks_come() {
    let (harness, mut process, flood) = stopped_at_high_water().await;
    let sent = harness.sent();
    harness.session.input(vec![3]).await;
    settle().await;
    let mut interrupt = [0_u8; 1];
    tokio::time::timeout(
        Duration::from_secs(1),
        process.stdin.read_exact(&mut interrupt),
    )
    .await
    .expect("input reaches the process while the reader is stopped")
    .unwrap();
    assert_eq!(interrupt, [3]);

    harness.session.ack(u32::try_from(sent).unwrap());
    for _ in 0..20 {
        settle().await;
        advance(Duration::from_millis(6)).await;
    }
    assert!(harness.sent() > sent, "acks start the reader again");
    flood.abort();
}

#[tokio::test(start_paused = true)]
async fn input_is_delivered_in_order_and_a_large_paste_does_not_stall_output() {
    let (harness, mut process) = running(true).await;
    harness.session.input(b"one".to_vec()).await;
    harness.session.input(b"two".to_vec()).await;
    settle().await;
    let mut got = [0_u8; 6];
    process.stdin.read_exact(&mut got).await.unwrap();
    assert_eq!(&got, b"onetwo");

    harness.session.input(vec![b'x'; 3 * FRAME_MAX]).await;
    settle().await;
    write(&mut process, b"echo").await;
    assert_eq!(harness.outputs(), vec![b"echo".to_vec()]);
    let mut buffer = vec![0; 3 * FRAME_MAX];
    process.stdin.read_exact(&mut buffer).await.unwrap();
    assert!(buffer.iter().all(|byte| *byte == b'x'));
}

#[tokio::test(start_paused = true)]
async fn all_the_output_goes_before_the_end() {
    let (harness, mut process) = running(true).await;
    write(&mut process, b"first").await;
    write(&mut process, b"gathered").await;
    process.status.send(status(EXIT_3)).unwrap();
    settle().await;
    assert_eq!(harness.ended(), None, "the output has not ended yet");
    process.stdout.write_all(b" last").await.unwrap();
    process.stdout.shutdown().await.unwrap();
    settle().await;
    let frames = harness.frames.lock().unwrap().clone();
    assert_eq!(
        frames.last(),
        Some(&Frame::Event(ShellEvent::Ended {
            end: ShellEnd::Exited { code: 3 }
        }))
    );
    let output: Vec<u8> = harness.outputs().concat();
    assert_eq!(output, b"firstgathered last");
    drop(process.stderr);
}

#[tokio::test(start_paused = true)]
async fn its_end_with_the_reader_stopped_drains_the_rest_without_waiting_for_acks() {
    let (harness, process, flood) = stopped_at_high_water().await;
    let sent = harness.sent();
    process.status.send(status(EXIT_3)).unwrap();
    flood.stop_and_close().await;
    settle().await;
    assert_eq!(harness.ended(), Some(ShellEnd::Exited { code: 3 }));
    assert!(harness.sent() > sent, "what the pipe held went out first");
    let frames = harness.frames.lock().unwrap();
    assert!(matches!(
        frames.last(),
        Some(Frame::Event(ShellEvent::Ended { .. }))
    ));
}

#[tokio::test(start_paused = true)]
async fn a_failure_with_nothing_printed_is_no_shell_and_the_message_is_the_runtimes() {
    let (harness, mut process) = running(true).await;
    process.status.send(status(NO_SHELL)).unwrap();
    process.stdout.shutdown().await.unwrap();
    settle().await;
    assert_eq!(
        harness.ended(),
        Some(ShellEnd::NoShell {
            message: status(NO_SHELL).message.unwrap()
        })
    );
}

#[tokio::test(start_paused = true)]
async fn the_sender_dropped_with_the_pipes_left_open_ends_as_lost_with_no_hang() {
    let (harness, mut process) = running(true).await;
    write(&mut process, b"left over").await;
    drop(process.status);
    settle().await;
    assert_eq!(harness.ended(), Some(ShellEnd::ConnectionLost));
    assert_eq!(harness.outputs().concat(), b"left over");
}

#[tokio::test(start_paused = true)]
async fn a_failure_after_output_is_not_no_shell() {
    let (harness, mut process) = running(true).await;
    write(&mut process, b"bash: command not found\n").await;
    process.status.send(status(NO_SHELL)).unwrap();
    process.stdout.shutdown().await.unwrap();
    settle().await;
    assert!(matches!(harness.ended(), Some(ShellEnd::Failed { .. })));
}

#[tokio::test(start_paused = true)]
async fn the_output_of_a_session_without_a_tty_is_stdout_and_stderr_together() {
    let (harness, mut process) = running(false).await;
    process.stderr.write_all(b"oops").await.unwrap();
    settle().await;
    assert_eq!(harness.outputs(), vec![b"oops".to_vec()]);
    process.status.send(status(EXIT_3)).unwrap();
    process.stdout.shutdown().await.unwrap();
    process.stderr.shutdown().await.unwrap();
    settle().await;
    assert_eq!(harness.ended(), Some(ShellEnd::Exited { code: 3 }));
}

#[tokio::test(start_paused = true)]
async fn a_retired_connection_ends_the_session_as_lost_with_what_had_gathered() {
    let (harness, mut process) = running(true).await;
    write(&mut process, b"a").await;
    write(&mut process, b"gathered").await;
    harness.clients.connections().retire();
    settle().await;
    assert_eq!(harness.ended(), Some(ShellEnd::ConnectionLost));
    assert_eq!(harness.outputs().concat(), b"agathered");
}

#[tokio::test(start_paused = true)]
async fn abandoned_clients_end_the_session_as_lost() {
    let (harness, _process) = running(true).await;
    harness.clients.connections().abandon();
    settle().await;
    assert_eq!(harness.ended(), Some(ShellEnd::ConnectionLost));
}

#[tokio::test(start_paused = true)]
async fn clients_abandoned_before_it_starts_end_it_as_lost_without_connecting() {
    let (to, _process) = connected(true);
    let harness = parked(true, Budgets::default(), Ok(to));
    harness.clients.connections().abandon();
    harness.open(80, 24);
    settle().await;
    assert_eq!(harness.ended(), Some(ShellEnd::ConnectionLost));
    assert_eq!(
        harness.events(),
        vec![ShellEvent::Ended {
            end: ShellEnd::ConnectionLost
        }]
    );
}

#[tokio::test(start_paused = true)]
async fn a_relock_ends_the_session_visibly() {
    let (mut harness, _process) = running(true).await;
    harness.relock();
    settle().await;
    assert_eq!(harness.ended(), Some(ShellEnd::Relocked));
}

#[tokio::test(start_paused = true)]
async fn a_relock_before_it_starts_ends_it_without_connecting() {
    let (to, _process) = connected(true);
    let mut harness = parked(true, Budgets::default(), Ok(to));
    harness.relock();
    harness.open(80, 24);
    settle().await;
    assert_eq!(
        harness.events(),
        vec![ShellEvent::Ended {
            end: ShellEnd::Relocked
        }]
    );
}

#[tokio::test(start_paused = true)]
async fn dropping_the_session_releases_its_permit_at_once() {
    let (harness, process) = running(true).await;
    assert_eq!(harness.held(), 1);
    let usage = harness.clients.usage();
    let Harness { session, .. } = harness;
    drop(session);
    settle().await;
    assert_eq!(usage.borrow().sessions.held, 0);
    drop(process.stdout);
}

struct NeverConnects;

impl Connect for NeverConnects {
    fn connect(&self, _spec: &Spec) -> BoxFuture<'static, Result<Connected, kube::Error>> {
        futures::future::pending().boxed()
    }
}

#[tokio::test(start_paused = true)]
async fn dropping_a_session_still_connecting_releases_its_permit_at_once() {
    let clients = clients(Budgets::default());
    let usage = clients.usage();
    let session = Session::parked(
        clients,
        spec(true, true),
        futures::future::pending().boxed(),
        Box::new(NeverConnects),
    );
    session.open(80, 24, |_| true).unwrap();
    settle().await;
    assert_eq!(usage.borrow().sessions.held, 1);
    drop(session);
    settle().await;
    assert_eq!(usage.borrow().sessions.held, 0);
}

#[tokio::test(start_paused = true)]
async fn the_permit_is_held_until_the_session_ends_not_just_until_it_connects() {
    let (harness, mut process) = running(true).await;
    write(&mut process, b"x").await;
    assert_eq!(harness.held(), 1);
    process.status.send(status(EXIT_3)).unwrap();
    process.stdout.shutdown().await.unwrap();
    settle().await;
    assert_eq!(harness.held(), 0);
}

#[tokio::test(start_paused = true)]
async fn over_the_budget_it_says_queued_then_connecting_once_a_place_frees() {
    let budgets = Budgets {
        sessions: 1,
        ..Budgets::default()
    };
    let (first_to, _first_process) = connected(true);
    let first = parked(true, budgets, Ok(first_to));
    let first_clients = Arc::clone(&first.clients);
    first.open(80, 24);
    settle().await;

    let (second_to, _second_process) = connected(true);
    let (relock, relocked) = oneshot::channel::<()>();
    let second = Session::parked(
        first_clients,
        spec(true, true),
        relocked.map(|_| ()).boxed(),
        Box::new(Fake(Mutex::new(Some(Ok(second_to))))),
    );
    let events = Arc::new(Mutex::new(Vec::new()));
    let sent = Arc::clone(&events);
    second
        .open(80, 24, move |frame| {
            if let Frame::Event(event) = frame {
                sent.lock().unwrap().push(event);
            }
            true
        })
        .unwrap();
    settle().await;
    assert_eq!(*events.lock().unwrap(), vec![ShellEvent::Queued]);

    drop(first.session);
    settle().await;
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            ShellEvent::Queued,
            ShellEvent::Connecting,
            ShellEvent::Running
        ]
    );
    drop((relock, second));
}

#[tokio::test(start_paused = true)]
async fn a_refusal_from_the_connection_reads_as_its_error() {
    let refused = kube::Error::Api(
        kube::core::Status::failure("pods \"p\" is forbidden", "Forbidden")
            .with_code(403)
            .boxed(),
    );
    let harness = parked(true, Budgets::default(), Err(refused));
    harness.open(80, 24);
    settle().await;
    let Some(ShellEnd::Failed { error }) = harness.ended() else {
        panic!("{:?}", harness.events());
    };
    assert_eq!(error.kind, ErrorKind::Forbidden);
    assert_eq!(error.message, "pods \"p\" is forbidden");
    assert_eq!(harness.held(), 0);
}

#[tokio::test(start_paused = true)]
async fn the_size_goes_through_once_the_process_exists_and_after_that_every_change() {
    let (to, mut process) = connected(true);
    let harness = parked(true, Budgets::default(), Ok(to));
    harness.open(100, 40);
    harness.session.resize(120, 50);
    settle().await;
    let size = process.resize.next().await.unwrap();
    assert_eq!((size.width, size.height), (120, 50));
    harness.session.resize(80, 24);
    settle().await;
    let size = process.resize.next().await.unwrap();
    assert_eq!((size.width, size.height), (80, 24));
}

#[tokio::test(start_paused = true)]
async fn a_session_without_a_tty_ignores_resizes() {
    let (harness, mut process) = running(false).await;
    harness.session.resize(80, 24);
    settle().await;
    assert!(process.resize.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn input_of_a_session_whose_process_takes_none_is_dropped() {
    let (to, process) = connected(true);
    let Connected {
        stdout,
        stderr,
        resize,
        status,
        held,
        ..
    } = to;
    let harness = parked(
        true,
        Budgets::default(),
        Ok(Connected {
            stdout,
            stderr,
            stdin: None,
            resize,
            status,
            held,
        }),
    );
    harness.open(80, 24);
    settle().await;
    harness.session.input(b"nowhere".to_vec()).await;
    settle().await;
    assert_eq!(
        harness.events(),
        vec![ShellEvent::Connecting, ShellEvent::Running]
    );
    drop(process.stdout);
}

#[tokio::test(start_paused = true)]
async fn a_session_starts_once() {
    let (harness, _process) = running(true).await;
    let again = harness.session.open(80, 24, |_| true).unwrap_err();
    assert_eq!(again.kind, ErrorKind::Conflict);
}

#[tokio::test(start_paused = true)]
async fn a_window_gone_ends_the_session() {
    let (to, _process) = connected(true);
    let harness = parked(true, Budgets::default(), Ok(to));
    harness
        .session
        .open(80, 24, |frame| !matches!(frame, Frame::Event(_)))
        .unwrap();
    settle().await;
    assert_eq!(harness.held(), 0);
}
