use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::future::Future;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use tokio::sync::mpsc;
use tokio::task::{self, JoinSet};
use tokio::time::Instant;

use crate::inject;

/// How many times a duty starts again after a panic within [`WITHIN`], and
/// how long that window is: VS Code's numbers for its extension host.
const RESTARTS: usize = 3;
const WITHIN: Duration = Duration::from_secs(5 * 60);

/// What the fatal path is told: the duty that cannot go on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fatal {
    pub duty: &'static str,
}

impl fmt::Display for Fatal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cannot go on", self.duty)
    }
}

enum Report {
    Panicked(&'static str),
    Fatal(&'static str),
}

/// What code outside the supervisor's tasks tells it: a thread of a duty
/// that ended on a panic, or a loop that cannot be started again.
#[derive(Clone)]
pub struct Reporter(mpsc::UnboundedSender<Report>);

impl Reporter {
    /// The thread of the duty `duty` panicked: the supervisor starts it
    /// again, within the limit.
    pub fn panicked(&self, duty: &'static str) {
        // Nobody reads it once the supervisor has ended with the app.
        let _ = self.0.send(Report::Panicked(duty));
    }

    /// Takes the fatal path at once.
    pub fn fatal(&self, duty: &'static str) {
        let _ = self.0.send(Report::Fatal(duty));
    }
}

/// What a [`Reporter`] says, read by the [`Supervisor`] built over it.
pub struct Reports(mpsc::UnboundedReceiver<Report>);

/// A reporter for the threads and loops that exist before the supervisor
/// does, and the reports it will read once it starts.
pub fn reports() -> (Reporter, Reports) {
    let (sender, receiver) = mpsc::unbounded_channel();
    (Reporter(sender), Reports(receiver))
}

struct Task {
    name: &'static str,
    start: Box<dyn Fn() -> BoxFuture<'static, ()> + Send>,
}

struct Thread {
    name: &'static str,
    restart: Box<dyn Fn() -> bool + Send>,
}

/// Runs the app-wide duties, each as a task of its own, and starts one again
/// when it panics, at most [`RESTARTS`] times in [`WITHIN`]; past that the
/// duty cannot be kept, and the fatal path runs. A duty that ends without a
/// panic is logged and not started again.
pub struct Supervisor {
    reports: Reports,
    fatal: Box<dyn Fn(Fatal) + Send>,
    tasks: Vec<Task>,
    threads: Vec<Thread>,
}

impl Supervisor {
    /// A supervisor that reads `reports` and calls `fatal` when it gives up.
    /// It stops supervising once `fatal` has been called.
    pub fn new(reports: Reports, fatal: impl Fn(Fatal) + Send + 'static) -> Self {
        Self {
            reports,
            fatal: Box::new(fatal),
            tasks: Vec::new(),
            threads: Vec::new(),
        }
    }

    /// A duty that is a task: `start` makes its future, at the start and
    /// after each panic.
    pub fn task<F>(&mut self, name: &'static str, start: impl Fn() -> F + Send + 'static)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.tasks.push(Task {
            name,
            start: Box::new(move || start().boxed()),
        });
    }

    /// A duty that is a thread reporting its panic through [`Reporter`]:
    /// `restart` starts it again and says whether it could.
    pub fn thread(&mut self, name: &'static str, restart: impl Fn() -> bool + Send + 'static) {
        self.threads.push(Thread {
            name,
            restart: Box::new(restart),
        });
    }

    /// Runs the duties until every one has ended without a panic, or the
    /// fatal path has run.
    pub async fn run(self) {
        let Self {
            mut reports,
            fatal,
            tasks,
            threads,
        } = self;
        let mut running = Running::default();
        let mut limits = Limits::default();
        for index in 0..tasks.len() {
            running.start(&tasks, index);
        }
        while !running.set.is_empty() {
            tokio::select! {
                Some(joined) = running.set.join_next_with_id() => {
                    let (id, panicked) = match joined {
                        Ok((id, ())) => (id, false),
                        Err(error) => (error.id(), error.is_panic()),
                    };
                    let index = running.ids.remove(&id).expect("every task is registered");
                    let name = tasks[index].name;
                    if !panicked {
                        tracing::info!(duty = name, %id, "a duty ended, and is not started again");
                        continue;
                    }
                    let Some(count) = limits.restart(name) else {
                        return give_up(&*fatal, name);
                    };
                    tracing::error!(duty = name, %id, restart = count, of = RESTARTS, "a duty panicked, so it starts again");
                    running.start(&tasks, index);
                }
                Some(report) = reports.0.recv() => match report {
                    Report::Panicked(name) => {
                        let Some(thread) = threads.iter().find(|thread| thread.name == name) else {
                            tracing::error!(duty = name, "a duty that nothing supervises reported a panic");
                            continue;
                        };
                        match limits.restart(name) {
                            Some(count) if (thread.restart)() => {
                                tracing::error!(duty = name, restart = count, of = RESTARTS, "a thread panicked, so it starts again");
                            }
                            _ => return give_up(&*fatal, name),
                        }
                    }
                    Report::Fatal(name) => return give_up(&*fatal, name),
                },
            }
        }
    }
}

fn give_up(fatal: &dyn Fn(Fatal), duty: &'static str) {
    tracing::error!(duty, "a duty cannot be kept, so Twigo must restart");
    fatal(Fatal { duty });
}

/// The duties' tasks, and the index of the duty each one runs.
#[derive(Default)]
struct Running {
    set: JoinSet<()>,
    ids: HashMap<task::Id, usize>,
}

impl Running {
    fn start(&mut self, tasks: &[Task], index: usize) {
        let Task { name, start } = &tasks[index];
        let (name, duty) = (*name, start());
        let id = self
            .set
            .spawn(async move {
                inject::check(name);
                duty.await;
            })
            .id();
        self.ids.insert(id, index);
    }
}

/// When each duty restarted within the window.
#[derive(Default)]
struct Limits(HashMap<&'static str, VecDeque<Instant>>);

impl Limits {
    /// Counts a restart of `duty` now and returns its number in the window,
    /// or None when the window holds [`RESTARTS`] already.
    fn restart(&mut self, duty: &'static str) -> Option<usize> {
        let now = Instant::now();
        let restarts = self.0.entry(duty).or_default();
        while restarts
            .front()
            .is_some_and(|at| now.duration_since(*at) >= WITHIN)
        {
            restarts.pop_front();
        }
        if restarts.len() >= RESTARTS {
            return None;
        }
        restarts.push_back(now);
        Some(restarts.len())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::time::sleep;

    use super::*;

    type Told = Arc<Mutex<Vec<Fatal>>>;

    fn supervisor() -> (Supervisor, Reporter, Told) {
        let (reporter, reports) = reports();
        let told = Told::default();
        let supervisor = Supervisor::new(reports, {
            let told = Arc::clone(&told);
            move |fatal| told.lock().unwrap().push(fatal)
        });
        (supervisor, reporter, told)
    }

    /// A duty that panics at each of its first `panics` starts, then waits.
    fn flaky(
        starts: &Arc<AtomicUsize>,
        panics: usize,
    ) -> impl Fn() -> BoxFuture<'static, ()> + use<> {
        let starts = Arc::clone(starts);
        move || {
            let started = starts.fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                if started <= panics {
                    panic!("a duty's bug");
                }
                std::future::pending::<()>().await;
            }
            .boxed()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_duty_that_panics_starts_again() {
        let (mut supervisor, _reporter, told) = supervisor();
        let starts = Arc::new(AtomicUsize::new(0));
        supervisor.task("flaky", flaky(&starts, 1));
        let running = tokio::spawn(supervisor.run());
        sleep(Duration::from_secs(1)).await;
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert!(told.lock().unwrap().is_empty());
        assert!(!running.is_finished(), "the second start waits");
    }

    #[tokio::test(start_paused = true)]
    async fn the_fourth_panic_in_five_minutes_takes_the_fatal_path() {
        let (mut supervisor, _reporter, told) = supervisor();
        let starts = Arc::new(AtomicUsize::new(0));
        supervisor.task("flaky", flaky(&starts, usize::MAX));
        tokio::spawn(supervisor.run()).await.unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 4, "three restarts");
        assert_eq!(*told.lock().unwrap(), [Fatal { duty: "flaky" }]);
    }

    #[tokio::test(start_paused = true)]
    async fn panics_that_the_window_has_left_behind_do_not_count() {
        let (mut supervisor, _reporter, told) = supervisor();
        let starts = Arc::new(AtomicUsize::new(0));
        supervisor.task("slow", {
            let starts = Arc::clone(&starts);
            move || {
                let started = starts.fetch_add(1, Ordering::SeqCst) + 1;
                async move {
                    sleep(Duration::from_secs(120)).await;
                    if started < 8 {
                        panic!("a duty's bug");
                    }
                    std::future::pending::<()>().await;
                }
            }
        });
        tokio::spawn(supervisor.run());
        sleep(Duration::from_secs(20 * 60)).await;
        assert_eq!(starts.load(Ordering::SeqCst), 8, "seven restarts in all");
        assert!(told.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_duty_that_ends_cleanly_is_not_started_again() {
        let (mut supervisor, _reporter, told) = supervisor();
        let starts = Arc::new(AtomicUsize::new(0));
        supervisor.task("done", {
            let starts = Arc::clone(&starts);
            move || {
                starts.fetch_add(1, Ordering::SeqCst);
                async {}
            }
        });
        tokio::spawn(supervisor.run()).await.unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert!(told.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_thread_that_reports_a_panic_is_started_again_within_the_limit() {
        let (mut supervisor, reporter, told) = supervisor();
        supervisor.task("waiting", std::future::pending::<()>);
        let restarts = Arc::new(AtomicUsize::new(0));
        supervisor.thread("writer", {
            let restarts = Arc::clone(&restarts);
            move || restarts.fetch_add(1, Ordering::SeqCst) < 100
        });
        let running = tokio::spawn(supervisor.run());
        for _ in 0..3 {
            reporter.panicked("writer");
        }
        sleep(Duration::from_secs(1)).await;
        assert_eq!(restarts.load(Ordering::SeqCst), 3);
        assert!(told.lock().unwrap().is_empty());
        reporter.panicked("writer");
        running.await.unwrap();
        assert_eq!(restarts.load(Ordering::SeqCst), 3);
        assert_eq!(*told.lock().unwrap(), [Fatal { duty: "writer" }]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_thread_that_cannot_start_again_and_a_loop_that_cannot_wait_take_the_fatal_path() {
        let (mut supervisor, reporter, told) = supervisor();
        supervisor.task("waiting", std::future::pending::<()>);
        supervisor.thread("writer", || false);
        let running = tokio::spawn(supervisor.run());
        reporter.panicked("writer");
        running.await.unwrap();
        assert_eq!(*told.lock().unwrap(), [Fatal { duty: "writer" }]);

        let (mut supervisor, reporter, told) = self::supervisor();
        supervisor.task("waiting", std::future::pending::<()>);
        let running = tokio::spawn(supervisor.run());
        reporter.fatal("proxy");
        running.await.unwrap();
        assert_eq!(*told.lock().unwrap(), [Fatal { duty: "proxy" }]);
    }
}
