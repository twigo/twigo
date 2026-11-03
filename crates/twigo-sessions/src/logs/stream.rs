//! A stream per pod's container: its log through the cluster's HTTP/2
//! client in the class of followed logs (ARCHITECTURE 3.2), reopened from
//! its latest line's second when the server ends it while the container
//! runs, its body breaks or its connection is retired, then each next
//! instance of the container, with an `Ended` entry between them.
//!
//! Which instance the kubelet reads follows the pod's status, as its
//! `validateContainerLogStatus` picks one (kubernetes v1.37.0,
//! `pkg/kubelet/kubelet_pods.go`): the running one, else the one that
//! ended last. It reads its own status, which the API server's follows a
//! moment later, so a reopened read may get a later instance's log, and
//! then the rest of the old one is the previous instance.

use std::sync::Arc;
use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use futures::AsyncBufReadExt;
use kube::api::LogParams;
use serde_json::Value;
use tokio::sync::watch;
use twigo_cache::hub::Hub;
use twigo_ipc::{ErrorKind, IpcError, Level, LogSource, Since, StreamState, TextStyle};
use twigo_kube::client::{Clients, Waiting};

use crate::logs::level::level;
use crate::logs::{line, now};

/// What a stream tells its session.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Line {
        at: i64,
        level: Option<Level>,
        text: String,
        styles: Vec<TextStyle>,
    },
    State(StreamState),
    /// An instance ended; `at` orders it after its last line.
    Ended {
        at: i64,
        time: String,
        exit_code: Option<i32>,
        reason: Option<String>,
        restarting: Option<String>,
    },
    /// It reads nothing more, so its place among the tab's streams is free.
    Finished,
}

/// Where a stream reads.
#[derive(Clone)]
pub struct Stream {
    pub hub: Hub,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub since: Since,
    pub previous: bool,
}

impl Stream {
    pub fn new(
        hub: Hub,
        context: &str,
        namespace: &str,
        pod: &str,
        container: &str,
        source: &LogSource,
    ) -> Self {
        Self {
            hub,
            context: context.to_owned(),
            namespace: namespace.to_owned(),
            pod: pod.to_owned(),
            container: container.to_owned(),
            since: source.since,
            previous: source.previous,
        }
    }
}

/// Where a read starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadFrom {
    /// The instance's last lines.
    Lines(u32),
    /// The instance's start.
    Start,
    /// A whole second, in nanoseconds since the Unix epoch, which
    /// kube-core's rounding of `sinceTime` to the second keeps.
    Time(i64),
}

impl ReadFrom {
    /// Where the source starts the first instance a stream reads: a
    /// number of seconds from the time it is first asked, so a read
    /// repeated before any line came reads the same lines.
    fn source(since: Since) -> Self {
        match since {
            Since::Lines { lines } => ReadFrom::Lines(lines),
            Since::Seconds { seconds } => {
                ReadFrom::Time(second(now() - i64::from(seconds) * SECOND))
            }
            Since::Start => ReadFrom::Start,
        }
    }
}

fn second(at: i64) -> i64 {
    at.div_euclid(SECOND) * SECOND
}

/// The lines a reopened read has delivered already. It starts at the
/// second of the latest line, since the server reads `sinceTime` to the
/// second (the API server passes it on as `time.RFC3339`, kubernetes
/// v1.37.0 `pkg/registry/core/pod/strategy.go`), and the kubelet sends each
/// line of the log at or after it, in the log's order (cri-client
/// `logWriter.write`), so the lines the stream admitted at or after that
/// second come first. Times may go back a little, as containerd stamps
/// stdout and stderr in goroutines of their own, so they are counted, none
/// later than the latest: a later line first says the log holds none of
/// them, as the next instance's does.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Resume {
    /// The latest time admitted, and how many admitted lines came at or
    /// after its second.
    latest: Option<(i64, u32)>,
    /// What a reopened read has still to skip.
    skip: Option<Skip>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Skip {
    left: u32,
    latest: i64,
    /// It reads the instance it read before, so a later line first says
    /// the kubelet reads another.
    same: bool,
}

/// What a line read is to the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admit {
    New,
    /// One it had.
    Again,
    /// A reread of the same instance found a log without what it had.
    Moved,
}

const SECOND: i64 = 1_000_000_000;

impl Resume {
    /// Where a read after a cut starts: the second of the latest line.
    fn from(&self) -> Option<i64> {
        self.latest.map(|(at, _)| second(at))
    }

    /// Starts a read that skips what came already, of the instance read
    /// before when `same`.
    fn reopen(&mut self, same: bool) {
        self.skip = self
            .latest
            .map(|(latest, left)| Skip { left, latest, same });
    }

    /// What a line read at `at` is, counting it if new.
    pub fn admit(&mut self, at: i64) -> Admit {
        if let Some(skip) = &mut self.skip {
            if at <= skip.latest {
                skip.left -= 1;
                if skip.left == 0 {
                    self.skip = None;
                }
                return Admit::Again;
            }
            let same = skip.same;
            self.skip = None;
            if same {
                return Admit::Moved;
            }
        }
        self.latest = match self.latest {
            Some((latest, count)) if second(at) == second(latest) => {
                Some((latest.max(at), count + 1))
            }
            Some((latest, count)) if at < latest => Some((latest, count)),
            _ => Some((at, 1)),
        };
        Admit::New
    }

    fn last_at(&self) -> Option<i64> {
        self.latest.map(|(at, _)| at)
    }
}

/// How a read ended.
enum Outcome {
    /// The server ended the log; `fresh` if it sent lines this read had
    /// not had.
    Ended {
        fresh: bool,
    },
    /// The connection was retired or its clients abandoned under it.
    Cut,
    /// A reread of the instance read before got a later instance's log,
    /// whose first line came at `at`: the kubelet's status had moved on
    /// before the one the stream was told of.
    Moved {
        at: i64,
    },
    /// The body broke, which says nothing of the instance.
    Broken,
    Failed(IpcError),
    /// The kubelet could not read the instance's log and said why in the
    /// body, after the zero-byte write that sends its headers
    /// (`GetKubeletContainerLogs`, kubernetes v1.37.0), as when it has
    /// removed the container already.
    Unreadable(IpcError),
    /// Rejected credentials: retrying would run a plugin by itself.
    Unauthorized(IpcError),
}

/// A container's status in the pod's: its instance now, the one before.
struct Status<'a>(&'a Value);

impl<'a> Status<'a> {
    fn of(pod: &'a Value, container: &str) -> Option<Self> {
        ["containerStatuses", "initContainerStatuses"]
            .iter()
            .flat_map(|key| pod["status"][key].as_array().into_iter().flatten())
            .find(|status| status["name"] == container)
            .map(Status)
    }

    /// The instance the kubelet reads, and whether it runs.
    fn current(&self) -> Option<(&'a str, bool)> {
        let state = &self.0["state"];
        let id = |value: &'a Value| value.as_str().filter(|id| !id.is_empty());
        if state["running"].is_object() {
            return Some((id(&self.0["containerID"])?, true));
        }
        let terminated = id(&state["terminated"]["containerID"]);
        terminated.or_else(|| self.previous()).map(|id| (id, false))
    }

    fn previous(&self) -> Option<&'a str> {
        self.0["lastState"]["terminated"]["containerID"]
            .as_str()
            .filter(|id| !id.is_empty())
    }

    /// How the instance `id` ended, once the status says it did.
    fn termination(&self, id: &str) -> Option<&'a Value> {
        [
            &self.0["state"]["terminated"],
            &self.0["lastState"]["terminated"],
        ]
        .into_iter()
        .find(|terminated| terminated["containerID"] == id)
    }

    fn waiting(&self) -> Option<String> {
        self.0["state"]["waiting"]["reason"]
            .as_str()
            .map(str::to_owned)
    }

    /// When the kubelet starts the ended instance again, in a crash loop's
    /// back-off.
    fn restarting(&self, finished: &str) -> Option<String> {
        let waiting = &self.0["state"]["waiting"];
        (waiting["reason"] == "CrashLoopBackOff")
            .then(|| twigo_describe::next_start(finished, waiting["message"].as_str()?))
            .flatten()
    }
}

/// Whether the kubelet runs the container again after it ended with
/// `exit_code`: as the pod's restart policy says, a sidecar always, an init
/// container only after a failure, none once the pod is done or deleted.
fn restarts(pod: &Value, container: &str, exit_code: Option<i64>) -> bool {
    let phase = pod["status"]["phase"].as_str();
    if matches!(phase, Some("Succeeded" | "Failed"))
        || pod["metadata"]["deletionTimestamp"].is_string()
    {
        return false;
    }
    let spec = &pod["spec"];
    let policy = spec["restartPolicy"].as_str().unwrap_or("Always");
    let failed = exit_code != Some(0);
    let init = spec["initContainers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|init| init["name"] == container);
    match init {
        Some(init) if init["restartPolicy"] == "Always" => true,
        Some(_) => failed && policy != "Never",
        None => match policy {
            "Never" => false,
            "OnFailure" => failed,
            _ => true,
        },
    }
}

/// Reads the container's log, as the pod it is told of says, until it has
/// nothing more to read; `pod` ends with the session.
pub async fn run(stream: Stream, mut pod: watch::Receiver<Arc<Value>>, send: impl Fn(Event)) {
    let mut reader = Reader {
        stream,
        backoff: backoff(),
        resume: Resume::default(),
    };
    if reader.stream.previous {
        reader.previous(&mut pod, &send).await;
    } else {
        reader.follow(&mut pod, &send).await;
    }
}

fn backoff() -> ExponentialBackoff {
    // Jitter adds up to the delay again: 0.5–5 s, the hub's (ARCHITECTURE 3.2).
    ExponentialBuilder::new()
        .with_min_delay(Duration::from_millis(500))
        .with_max_delay(Duration::from_millis(2_500))
        .with_jitter()
        .without_max_times()
        .build()
}

struct Reader {
    stream: Stream,
    backoff: ExponentialBackoff,
    resume: Resume,
}

impl Reader {
    async fn follow(&mut self, pod: &mut watch::Receiver<Arc<Value>>, send: &impl Fn(Event)) {
        // Where a read starts while the resume holds no line.
        let mut from = ReadFrom::source(self.stream.since);
        // The instance a read started on, and whether a cut left the rest
        // of its log unread; the last one read to its end; and one whose
        // reread found the kubelet reading a later one.
        let mut reading: Option<String> = None;
        let mut unfinished = false;
        let mut read: Option<String> = None;
        let mut moved: Option<String> = None;
        loop {
            let current = Arc::clone(&pod.borrow_and_update());
            let status = Status::of(&current, &self.stream.container);
            let instance = status.as_ref().and_then(Status::current);
            if let Some(old) = reading.take_if(|old| instance.map(|(id, _)| id) != Some(old)) {
                // It ended and the next began while its read was cut: the
                // kubelet reads its rest as the previous instance.
                if let Some(status) = &status {
                    if unfinished
                        && status.previous() == Some(old.as_str())
                        && !self.tail(None, pod, send).await
                    {
                        return;
                    }
                    if let Some(terminated) = status.termination(&old) {
                        send(self.ended(terminated, status));
                    }
                }
                read = Some(old);
                unfinished = false;
                from = ReadFrom::Start;
                continue;
            }
            let Some((id, _)) = instance else {
                send(Event::State(StreamState::Waiting {
                    reason: status.as_ref().and_then(Status::waiting),
                }));
                if pod.changed().await.is_err() {
                    return;
                }
                continue;
            };
            if read.as_deref() == Some(id) {
                let status = status.expect("its instance came from it");
                let exit_code = status
                    .termination(id)
                    .and_then(|ended| ended["exitCode"].as_i64());
                if !restarts(&current, &self.stream.container, exit_code) {
                    send(Event::State(StreamState::Ended));
                    send(Event::Finished);
                    return;
                }
                send(Event::State(StreamState::Waiting {
                    reason: status.waiting(),
                }));
                if pod.changed().await.is_err() {
                    return;
                }
                continue;
            }
            let id = id.to_owned();
            // A reread of the instance checks that the kubelet still reads
            // it, unless the last found it did not and the status still
            // says it runs, as after its log was rotated.
            let moved_on = moved.take().as_deref() == Some(id.as_str());
            let same = reading.as_deref() == Some(id.as_str());
            self.resume.reopen(same && !moved_on);
            let start = self.resume.from().map_or(from, ReadFrom::Time);
            reading = Some(id.clone());
            let outcome = self.read(false, start, None, send).await;
            if let Outcome::Ended { .. } | Outcome::Unreadable(_) = &outcome {
                let current = Arc::clone(&pod.borrow_and_update());
                let status = Status::of(&current, &self.stream.container);
                if let Some(status) = &status
                    && let Some(terminated) = status.termination(&id)
                {
                    if let Outcome::Unreadable(error) = outcome {
                        send(Event::State(StreamState::Error { error }));
                    }
                    send(self.ended(terminated, status));
                    reading = None;
                    read = Some(id);
                    unfinished = false;
                    from = ReadFrom::Start;
                    continue;
                }
            }
            match outcome {
                Outcome::Cut => unfinished = true,
                Outcome::Broken => {
                    unfinished = true;
                    if !self.pause(pod).await {
                        return;
                    }
                }
                Outcome::Moved { at } => {
                    if !self.tail(Some(at), pod, send).await {
                        return;
                    }
                    unfinished = false;
                    moved = Some(id);
                    if !self.pause(pod).await {
                        return;
                    }
                }
                Outcome::Ended { fresh } => {
                    // The status may not say yet that it ended; or the
                    // server ended the log of one that runs.
                    unfinished = false;
                    if fresh {
                        self.backoff = backoff();
                    }
                    if !self.pause(pod).await {
                        return;
                    }
                }
                Outcome::Failed(error) | Outcome::Unreadable(error) => {
                    send(Event::State(StreamState::Error { error }));
                    if !self.pause(pod).await {
                        return;
                    }
                }
                Outcome::Unauthorized(error) => {
                    send(Event::State(StreamState::Error { error }));
                    send(Event::Finished);
                    return;
                }
            }
        }
    }

    /// Reads the rest of the instance a read left, which the kubelet reads
    /// as the previous one once a later one runs, up to `before`, the time
    /// of the later one's first line; false once the session ended.
    async fn tail(
        &mut self,
        before: Option<i64>,
        pod: &mut watch::Receiver<Arc<Value>>,
        send: &impl Fn(Event),
    ) -> bool {
        loop {
            self.resume.reopen(false);
            let start = self.resume.from().map_or(ReadFrom::Start, ReadFrom::Time);
            match self.read(true, start, before, send).await {
                Outcome::Cut => {}
                Outcome::Broken => {
                    if !self.pause(pod).await {
                        return false;
                    }
                }
                _ => return true,
            }
        }
    }

    /// Reads the container's previous instance to its end.
    async fn previous(&mut self, pod: &mut watch::Receiver<Arc<Value>>, send: &impl Fn(Event)) {
        let from = ReadFrom::source(self.stream.since);
        loop {
            let current = Arc::clone(&pod.borrow_and_update());
            let status = Status::of(&current, &self.stream.container);
            let Some(id) = status.as_ref().and_then(Status::previous) else {
                send(Event::State(StreamState::Error {
                    error: IpcError {
                        kind: ErrorKind::NotFound,
                        message: format!("{} has no previous instance", self.stream.container),
                    },
                }));
                if pod.changed().await.is_err() {
                    return;
                }
                continue;
            };
            let id = id.to_owned();
            self.resume.reopen(true);
            let start = self.resume.from().map_or(from, ReadFrom::Time);
            match self.read(true, start, None, send).await {
                Outcome::Cut => {}
                Outcome::Broken => {
                    if !self.pause(pod).await {
                        return;
                    }
                }
                // It restarted meanwhile, so the instance read is no
                // longer the one the kubelet reads as the previous.
                Outcome::Moved { .. } => {
                    send(Event::State(StreamState::Ended));
                    send(Event::Finished);
                    return;
                }
                outcome @ (Outcome::Ended { .. } | Outcome::Unreadable(_)) => {
                    let current = Arc::clone(&pod.borrow_and_update());
                    let status = Status::of(&current, &self.stream.container);
                    if let Some(status) = &status
                        && let Some(terminated) = status.termination(&id)
                    {
                        send(self.ended(terminated, status));
                    }
                    send(Event::State(match outcome {
                        Outcome::Unreadable(error) => StreamState::Error { error },
                        _ => StreamState::Ended,
                    }));
                    send(Event::Finished);
                    return;
                }
                Outcome::Failed(error) => {
                    send(Event::State(StreamState::Error { error }));
                    if !self.pause(pod).await {
                        return;
                    }
                }
                Outcome::Unauthorized(error) => {
                    send(Event::State(StreamState::Error { error }));
                    send(Event::Finished);
                    return;
                }
            }
        }
    }

    fn ended(&self, terminated: &Value, status: &Status<'_>) -> Event {
        let time = terminated["finishedAt"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let finished = time
            .parse::<jiff::Timestamp>()
            .ok()
            .and_then(|at| i64::try_from(at.as_nanosecond()).ok());
        let at = match (finished, self.resume.last_at()) {
            (Some(finished), Some(last)) => finished.max(last),
            (finished, last) => finished.or(last).unwrap_or_else(now),
        };
        Event::Ended {
            at,
            restarting: status.restarting(&time),
            time,
            exit_code: terminated["exitCode"]
                .as_i64()
                .and_then(|code| i32::try_from(code).ok()),
            reason: terminated["reason"].as_str().map(str::to_owned),
        }
    }

    /// Waits for the pod to change, or the backoff; false once the session
    /// has ended.
    async fn pause(&mut self, pod: &mut watch::Receiver<Arc<Value>>) -> bool {
        let delay = self
            .backoff
            .next()
            .expect("the backoff has no maximum of attempts");
        tokio::select! {
            () = tokio::time::sleep(delay) => true,
            changed = pod.changed() => changed.is_ok(),
        }
    }

    /// Reads the log from `from` to its end, or up to a line at or after
    /// `before`.
    async fn read(
        &mut self,
        previous: bool,
        from: ReadFrom,
        before: Option<i64>,
        send: &impl Fn(Event),
    ) -> Outcome {
        send(Event::State(StreamState::Connecting));
        let clients = match self.stream.hub.clients(&self.stream.context).await {
            Ok(clients) => clients,
            Err(error) if error.kind == ErrorKind::Unauthorized => {
                return Outcome::Unauthorized(error);
            }
            Err(error) => return Outcome::Failed(error),
        };
        self.read_over(&clients, previous, from, before, send).await
    }

    async fn read_over(
        &mut self,
        clients: &Clients,
        previous: bool,
        from: ReadFrom,
        before: Option<i64>,
        send: &impl Fn(Event),
    ) -> Outcome {
        let mut params = LogParams {
            container: Some(self.stream.container.clone()),
            follow: !previous,
            previous,
            timestamps: true,
            ..LogParams::default()
        };
        match from {
            ReadFrom::Lines(lines) => params.tail_lines = Some(i64::from(lines)),
            ReadFrom::Start => {}
            ReadFrom::Time(at) => {
                params.since_time = jiff::Timestamp::from_nanosecond(i128::from(at)).ok();
            }
        }
        let path = format!("/api/v1/namespaces/{}/pods", self.stream.namespace);
        let mut request = match kube::core::Request::new(path).logs(&self.stream.pod, &params) {
            Ok(request) => request,
            Err(error) => {
                return Outcome::Failed(IpcError {
                    kind: ErrorKind::Internal,
                    message: format!("could not build the log request: {error}"),
                });
            }
        };
        let (queued, mut waiting) = watch::channel(false);
        request.extensions_mut().insert(Waiting(Arc::new(move |is| {
            queued.send_replace(is);
        })));
        // Tells the queue's state until the request is sent, when the
        // client drops the extension.
        let told = async {
            while waiting.changed().await.is_ok() {
                let state = if *waiting.borrow_and_update() {
                    StreamState::Queued
                } else {
                    StreamState::Connecting
                };
                send(Event::State(state));
            }
            std::future::pending::<()>().await;
        };
        let mut told = std::pin::pin!(told);
        let mut retired = clients.connections().retired();
        retired.borrow_and_update();
        let mut abandoned = clients.connections().abandoned();
        let mut abandoned = std::pin::pin!(async move {
            if abandoned.wait_for(|abandoned| *abandoned).await.is_err() {
                std::future::pending::<()>().await;
            }
        });
        let opening = clients.api.request_stream(request);
        let mut opening = std::pin::pin!(opening);
        let opened = tokio::select! {
            opened = &mut opening => opened,
            () = &mut told => unreachable!("it never ends"),
            _ = retired.changed() => return Outcome::Cut,
            () = &mut abandoned => return Outcome::Cut,
        };
        let lines = match opened {
            Ok(lines) => lines,
            Err(error) if twigo_kube::errors::no_credential(&error) => {
                return Outcome::Unauthorized(twigo_kube::errors::request(&error));
            }
            Err(error) => {
                let error = twigo_kube::errors::request(&error);
                if error.kind == ErrorKind::Unauthorized {
                    return Outcome::Unauthorized(error);
                }
                return Outcome::Failed(error);
            }
        };
        send(Event::State(StreamState::Following));
        let mut lines = std::pin::pin!(lines);
        let mut fresh = false;
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            let read = tokio::select! {
                read = lines.read_until(b'\n', &mut buffer) => read,
                _ = retired.changed() => return Outcome::Cut,
                () = &mut abandoned => return Outcome::Cut,
            };
            match read {
                Ok(0) => return Outcome::Ended { fresh },
                Ok(_) => {}
                Err(_) => return Outcome::Broken,
            }
            let parsed = line::parse(&buffer);
            // With timestamps every line the container wrote has its time.
            let Some(at) = parsed.at else {
                return Outcome::Unreadable(IpcError {
                    kind: ErrorKind::Unavailable,
                    message: parsed.text,
                });
            };
            if before.is_some_and(|before| at >= before) {
                return Outcome::Ended { fresh };
            }
            match self.resume.admit(at) {
                Admit::New => fresh = true,
                Admit::Again => continue,
                Admit::Moved => return Outcome::Moved { at },
            }
            send(Event::Line {
                at,
                level: level(&parsed.text),
                text: parsed.text,
                styles: parsed.styles,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;
    use tokio::task::JoinHandle;

    use super::*;
    use crate::logs::fake::{Fake, NAMESPACE};

    /// 2026-11-03T10:00:00Z.
    const T0: i64 = 1_793_700_000 * SECOND;

    /// A stream of `web-1`'s container `web` over the fake, and what it said.
    struct Followed {
        events: Arc<Mutex<Vec<Event>>>,
        told: watch::Sender<Arc<Value>>,
        clients: Arc<Clients>,
        task: JoinHandle<()>,
    }

    impl Followed {
        fn new(fake: &Fake, pod: Value, previous: bool) -> Self {
            let (hub, clients) = fake.hub();
            let stream = Stream {
                hub,
                context: "kind-test".to_owned(),
                namespace: NAMESPACE.to_owned(),
                pod: "web-1".to_owned(),
                container: "web".to_owned(),
                since: Since::Start,
                previous,
            };
            let (told, followed) = watch::channel(Arc::new(pod));
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&events);
            let task = tokio::spawn(run(stream, followed, move |event| {
                sink.lock().unwrap().push(event);
            }));
            Self {
                events,
                told,
                clients,
                task,
            }
        }

        fn tell(&self, pod: Value) {
            self.told.send_replace(Arc::new(pod));
        }

        fn cut(&self) {
            self.clients.connections().retire();
        }

        /// The lines and ends it sent, as `text` and `ended`.
        fn entries(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|event| match event {
                    Event::Line { text, .. } => Some(text.clone()),
                    Event::Ended { .. } => Some("ended".to_owned()),
                    _ => None,
                })
                .collect()
        }

        /// When its Ended entries stand.
        fn ends(&self) -> Vec<i64> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|event| match event {
                    Event::Ended { at, .. } => Some(*at),
                    _ => None,
                })
                .collect()
        }

        fn finished(&self) -> bool {
            self.events.lock().unwrap().contains(&Event::Finished)
        }

        async fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
            let reached = async {
                while !done(self) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            tokio::time::timeout(Duration::from_secs(600), reached)
                .await
                .unwrap_or_else(|_| panic!("{what}; it said {:?}", self.events.lock().unwrap()));
        }
    }

    impl Drop for Followed {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// `web-1` with its container `web` in `state` as `web-a`, after `last`.
    fn web(state: Value, last: Value) -> Value {
        json!({
            "metadata": { "name": "web-1" },
            "spec": { "containers": [{ "name": "web" }] },
            "status": { "phase": "Running", "containerStatuses": [
                { "name": "web", "containerID": "web-a", "state": state, "lastState": last },
            ] },
        })
    }

    fn running() -> Value {
        json!({ "running": { "startedAt": "2026-11-03T10:00:00Z" } })
    }

    fn crashed(instance: &str) -> Value {
        json!({ "terminated": { "containerID": instance, "exitCode": 1, "reason": "Error", "finishedAt": "2026-11-03T10:00:05Z" } })
    }

    /// `web-1` with `instance` running after `previous` crashed.
    fn restarted(instance: &str, previous: &str) -> Value {
        let mut pod = web(running(), crashed(previous));
        pod["status"]["containerStatuses"][0]["containerID"] = json!(instance);
        pod
    }

    /// Lines `<instance> <n>`, each `n` seconds after T0.
    fn numbered(fake: &Fake, instance: &str, lines: std::ops::RangeInclusive<i64>) {
        for n in lines {
            let text = format!("{instance} {n}");
            fake.write("web-1", "web", instance, T0 + n * SECOND, &text);
        }
    }

    fn has(entry: &str) -> impl Fn(&Followed) -> bool {
        move |followed| followed.entries().iter().any(|each| each == entry)
    }

    /// web-a writes lines 1 to 3 into an open follow, whose connection
    /// then dies; meanwhile web-a writes 4 and 5 and crashes, and the
    /// kubelet starts web-b, which writes 11 and 12.
    async fn cut_across_a_restart(fake: &Fake) -> Followed {
        fake.serve("web-1", "web", Some("web-a"), None);
        numbered(fake, "web-a", 1..=3);
        let followed = Followed::new(fake, web(running(), json!({})), false);
        followed.until("three lines", has("web-a 3")).await;
        fake.strand("web-1", "web");
        followed.cut();
        numbered(fake, "web-a", 4..=5);
        fake.stop("web-1", "web", "web-a");
        fake.serve("web-1", "web", Some("web-b"), Some("web-a"));
        numbered(fake, "web-b", 11..=12);
        followed
    }

    const ACROSS: [&str; 8] = [
        "web-a 1", "web-a 2", "web-a 3", "web-a 4", "web-a 5", "ended", "web-b 11", "web-b 12",
    ];

    #[tokio::test(start_paused = true)]
    async fn a_reopen_on_a_stale_status_reads_the_old_instance_to_its_end_and_the_new_one_once() {
        let fake = Fake::default();
        let followed = cut_across_a_restart(&fake).await;
        followed
            .until("the old instance's tail", has("web-a 5"))
            .await;
        followed.tell(restarted("web-b", "web-a"));
        followed.until("the new instance", has("web-b 12")).await;
        assert_eq!(followed.entries(), ACROSS);
        assert_eq!(followed.ends(), [T0 + 5 * SECOND]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_reopen_after_the_status_moved_on_reads_the_old_instance_to_its_end() {
        let fake = Fake::default();
        let followed = cut_across_a_restart(&fake).await;
        followed.tell(restarted("web-b", "web-a"));
        followed.until("the new instance", has("web-b 12")).await;
        assert_eq!(followed.entries(), ACROSS);
        assert_eq!(followed.ends(), [T0 + 5 * SECOND]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_broken_body_reads_on_to_the_end_of_a_crashed_instance() {
        let fake = Fake::default();
        fake.serve("web-1", "web", Some("web-a"), None);
        numbered(&fake, "web-a", 1..=3);
        let followed = Followed::new(&fake, web(running(), json!({})), false);
        followed
            .until("three lines", |followed| followed.entries().len() == 3)
            .await;
        followed.tell(web(crashed("web-a"), json!({})));
        fake.break_follows("web-1", "web");
        numbered(&fake, "web-a", 4..=5);
        fake.stop("web-1", "web", "web-a");
        followed
            .until("its end", |followed| {
                followed.entries().contains(&"ended".to_owned())
            })
            .await;
        assert_eq!(
            followed.entries(),
            [
                "web-a 1", "web-a 2", "web-a 3", "web-a 4", "web-a 5", "ended"
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_broken_body_reads_a_previous_instance_to_its_end() {
        let fake = Fake::default();
        fake.serve("web-1", "web", Some("web-b"), Some("web-a"));
        numbered(&fake, "web-a", 1..=5);
        fake.stop("web-1", "web", "web-a");
        fake.break_after("web-1", "web", 3);
        let followed = Followed::new(&fake, restarted("web-b", "web-a"), true);
        followed.until("finished", Followed::finished).await;
        assert_eq!(
            followed.entries(),
            [
                "web-a 1", "web-a 2", "web-a 3", "web-a 4", "web-a 5", "ended"
            ]
        );
    }

    use Admit::{Again, Moved, New};

    fn reread(resume: &mut Resume, times: &[i64]) -> Vec<Admit> {
        resume.reopen(true);
        times.iter().map(|at| resume.admit(*at)).collect()
    }

    #[test]
    fn a_reopened_read_skips_what_came_already() {
        let mut resume = Resume::default();
        for at in [1_500, 2_000, 2_000] {
            assert_eq!(resume.admit(at), New);
        }
        assert_eq!(resume.from(), Some(0));
        let again = reread(&mut resume, &[1_500, 2_000, 2_000, 2_000, 2_500]);
        assert_eq!(again, [Again, Again, Again, New, New]);
    }

    #[test]
    fn a_reopened_read_skips_exactly_what_came_at_or_after_its_second_when_times_go_back() {
        let ms = |ms: i64| ms * 1_000_000;
        let mut resume = Resume::default();
        for at in [ms(1_900), ms(2_200), ms(2_300), ms(2_100)] {
            assert_eq!(resume.admit(at), New);
        }
        assert_eq!(resume.from(), Some(2 * SECOND));
        let again = reread(
            &mut resume,
            &[ms(2_200), ms(2_300), ms(2_100), ms(2_250), ms(2_400)],
        );
        assert_eq!(again, [Again, Again, Again, New, New]);
        let again = reread(
            &mut resume,
            &[
                ms(2_200),
                ms(2_300),
                ms(2_100),
                ms(2_250),
                ms(2_400),
                ms(2_050),
            ],
        );
        assert_eq!(again, [Again, Again, Again, Again, Again, New]);
    }

    #[test]
    fn a_later_line_first_says_the_log_holds_none_of_what_came() {
        let mut resume = Resume::default();
        for at in [1_000, 2_000] {
            assert_eq!(resume.admit(at), New);
        }
        assert_eq!(reread(&mut resume, &[5_000, 6_000]), [Moved, New]);
        resume.reopen(false);
        assert_eq!(resume.admit(9_000), New);
        assert_eq!(resume.admit(9_500), New);
    }

    #[test]
    fn a_reopened_read_resumes_from_the_latest_lines_second() {
        let mut resume = Resume::default();
        assert_eq!(resume.admit(5 * SECOND + 700), New);
        assert_eq!(resume.from(), Some(5 * SECOND));
        assert_eq!(Resume::default().from(), None);
    }

    #[test]
    fn the_kubelet_reads_the_running_instance_else_the_last_that_ended() {
        let pod = json!({ "status": { "containerStatuses": [
            { "name": "api", "containerID": "containerd://b", "state": { "running": {} },
              "lastState": { "terminated": { "containerID": "containerd://a", "exitCode": 1 } } },
            { "name": "loop", "containerID": "containerd://d",
              "state": { "waiting": { "reason": "CrashLoopBackOff", "message": "back-off 10s restarting failed container=loop" } },
              "lastState": { "terminated": { "containerID": "containerd://c", "exitCode": 2, "finishedAt": "2026-11-03T10:00:00Z" } } },
            { "name": "new", "state": { "waiting": { "reason": "ContainerCreating" } } },
        ], "initContainerStatuses": [
            { "name": "init", "containerID": "containerd://e", "state": { "terminated": { "containerID": "containerd://e", "exitCode": 0 } } },
        ] } });
        let status = |name| Status::of(&pod, name).unwrap();
        assert_eq!(status("api").current(), Some(("containerd://b", true)));
        assert_eq!(status("api").previous(), Some("containerd://a"));
        assert_eq!(status("loop").current(), Some(("containerd://c", false)));
        assert_eq!(
            status("loop").restarting("2026-11-03T10:00:00Z").as_deref(),
            Some("2026-11-03T10:00:10Z")
        );
        assert_eq!(status("new").current(), None);
        assert_eq!(
            status("new").waiting().as_deref(),
            Some("ContainerCreating")
        );
        assert_eq!(status("init").current(), Some(("containerd://e", false)));
        assert!(status("init").termination("containerd://e").is_some());
        assert!(status("api").termination("containerd://b").is_none());
    }

    #[test]
    fn an_ended_container_runs_again_as_its_policy_says() {
        let pod = |policy: &str, phase: &str| {
            json!({
                "spec": {
                    "restartPolicy": policy,
                    "initContainers": [{ "name": "init" }, { "name": "proxy", "restartPolicy": "Always" }],
                    "containers": [{ "name": "app" }],
                },
                "status": { "phase": phase },
            })
        };
        assert!(restarts(&pod("Always", "Running"), "app", Some(0)));
        assert!(!restarts(&pod("Never", "Running"), "app", Some(1)));
        assert!(restarts(&pod("OnFailure", "Running"), "app", Some(1)));
        assert!(!restarts(&pod("OnFailure", "Running"), "app", Some(0)));
        assert!(!restarts(&pod("Always", "Running"), "init", Some(0)));
        assert!(restarts(&pod("Always", "Pending"), "init", Some(1)));
        assert!(!restarts(&pod("Never", "Pending"), "init", Some(1)));
        assert!(restarts(&pod("Never", "Running"), "proxy", Some(0)));
        assert!(!restarts(&pod("Always", "Succeeded"), "app", Some(0)));
        let mut deleted = pod("Always", "Running");
        deleted["metadata"] = json!({ "deletionTimestamp": "2026-11-03T10:00:00Z" });
        assert!(!restarts(&deleted, "app", Some(1)));
    }
}
