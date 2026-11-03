//! A stream per pod's container: its log through the cluster's HTTP/2
//! client in the class of followed logs (ARCHITECTURE 3.2), reopened from
//! its last line's second when the server ends it while the container runs
//! or its connection is retired, then each next instance of the container
//! from its start, with an `Ended` entry between them.
//!
//! Which instance the kubelet reads follows the pod's status, as its
//! `validateContainerLogStatus` picks one (kubernetes v1.37.0,
//! `pkg/kubelet/kubelet_pods.go`): the running one, else the one that
//! ended last.

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

/// The lines a reopened read has delivered already: those before the last
/// one's time, and as many at that time as came before, since the server
/// reads `sinceTime` to the second (the API server passes it on as
/// `time.RFC3339`, kubernetes v1.37.0 `pkg/registry/core/pod/strategy.go`)
/// and the kubelet sends every line from it on (cri-client
/// `logWriter.write`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Resume {
    /// The last line's time, and how many lines came at it.
    last: Option<(i64, u32)>,
    /// What a reopened read has still to skip.
    skip: Option<(i64, u32)>,
}

const SECOND: i64 = 1_000_000_000;

impl Resume {
    /// Where a read after a cut starts: the second of the last line.
    fn from(&self) -> Option<i64> {
        self.last.map(|(at, _)| second(at))
    }

    /// Starts a reopened read, which skips what came already.
    fn reopen(&mut self) {
        self.skip = self.last;
    }

    /// Whether a line read at `at` is new, counting it if so.
    pub fn admit(&mut self, at: i64) -> bool {
        if let Some((time, left)) = &mut self.skip {
            if at < *time {
                return false;
            }
            if at == *time && *left > 0 {
                *left -= 1;
                return false;
            }
            self.skip = None;
        }
        self.last = match self.last {
            Some((time, count)) if time == at => Some((time, count + 1)),
            _ => Some((at, 1)),
        };
        true
    }

    fn last_at(&self) -> Option<i64> {
        self.last.map(|(at, _)| at)
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
    Failed(IpcError),
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
        let mut from = ReadFrom::source(self.stream.since);
        // The instance a read started on, and the last one read to its end.
        let mut reading: Option<String> = None;
        let mut read: Option<String> = None;
        loop {
            let current = Arc::clone(&pod.borrow_and_update());
            let status = Status::of(&current, &self.stream.container);
            let instance = status.as_ref().and_then(Status::current);
            if let Some(old) = reading.take_if(|old| instance.map(|(id, _)| id) != Some(old)) {
                // It ended and the next began while the read was cut.
                if let Some(status) = &status
                    && let Some(terminated) = status.termination(&old)
                {
                    send(self.ended(terminated, status));
                }
                read = Some(old);
                self.resume = Resume::default();
                from = ReadFrom::Start;
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
            reading = Some(id.clone());
            match self.read(false, from, send).await {
                Outcome::Cut => from = self.resumed(from),
                Outcome::Ended { fresh } => {
                    let current = Arc::clone(&pod.borrow_and_update());
                    let status = Status::of(&current, &self.stream.container);
                    if let Some(status) = &status
                        && let Some(terminated) = status.termination(&id)
                    {
                        send(self.ended(terminated, status));
                        reading = None;
                        read = Some(id);
                        self.resume = Resume::default();
                        from = ReadFrom::Start;
                        continue;
                    }
                    // The status may not say yet that it ended; or the
                    // server ended the log of one that runs.
                    if fresh {
                        self.backoff = backoff();
                    }
                    from = self.resumed(from);
                    if !self.pause(pod).await {
                        return;
                    }
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

    /// Reads the container's previous instance to its end.
    async fn previous(&mut self, pod: &mut watch::Receiver<Arc<Value>>, send: &impl Fn(Event)) {
        let mut from = ReadFrom::source(self.stream.since);
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
            match self.read(true, from, send).await {
                Outcome::Cut => from = self.resumed(from),
                Outcome::Ended { .. } => {
                    let current = Arc::clone(&pod.borrow_and_update());
                    let status = Status::of(&current, &self.stream.container);
                    if let Some(status) = &status
                        && let Some(terminated) = status.termination(&id)
                    {
                        send(self.ended(terminated, status));
                    }
                    send(Event::State(StreamState::Ended));
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

    /// Where a read after a cut starts: from the last line it kept, or
    /// where the read it repeats started when it kept none.
    fn resumed(&mut self, from: ReadFrom) -> ReadFrom {
        self.resume.reopen();
        self.resume.from().map_or(from, ReadFrom::Time)
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

    async fn read(&mut self, previous: bool, from: ReadFrom, send: &impl Fn(Event)) -> Outcome {
        send(Event::State(StreamState::Connecting));
        let clients = match self.stream.hub.clients(&self.stream.context).await {
            Ok(clients) => clients,
            Err(error) if error.kind == ErrorKind::Unauthorized => {
                return Outcome::Unauthorized(error);
            }
            Err(error) => return Outcome::Failed(error),
        };
        self.read_over(&clients, previous, from, send).await
    }

    async fn read_over(
        &mut self,
        clients: &Clients,
        previous: bool,
        from: ReadFrom,
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
                // The stream broke: read again after the pause, which a
                // server failing at once would otherwise not get.
                Err(_) => return Outcome::Ended { fresh },
            }
            let parsed = line::parse(&buffer);
            let at = parsed
                .at
                .or_else(|| self.resume.last_at())
                .unwrap_or_else(now);
            if !self.resume.admit(at) {
                continue;
            }
            fresh = true;
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
    use serde_json::json;

    use super::*;

    #[test]
    fn a_reopened_read_skips_what_came_already() {
        let mut resume = Resume::default();
        for at in [1_500, 2_000, 2_000] {
            assert!(resume.admit(at));
        }
        assert_eq!(resume.from(), Some(0));
        resume.reopen();
        let again: Vec<bool> = [1_000, 1_500, 2_000, 2_000, 2_000, 2_500, 2_500]
            .into_iter()
            .map(|at| resume.admit(at))
            .collect();
        assert_eq!(again, [false, false, false, false, true, true, true]);
    }

    #[test]
    fn a_reopened_read_resumes_from_the_last_lines_second() {
        let mut resume = Resume::default();
        assert!(resume.admit(5 * SECOND + 700));
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
