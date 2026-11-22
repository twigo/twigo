use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use tokio::sync::mpsc;
use tokio::task::{self, JoinSet};
use tokio::time::Instant;

use crate::{contain, inject};

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
/// duty cannot be kept, the fatal path runs, and the other duties go on. A
/// duty that ends without a panic is logged and not started again.
pub struct Supervisor {
    reports: Reports,
    tasks: Vec<Task>,
    threads: Vec<Thread>,
    tell: Tell,
}

impl Supervisor {
    /// A supervisor that reads `reports`, and calls `fatal` for each duty it
    /// cannot keep and for a panic of its own task.
    pub fn new(reports: Reports, fatal: impl Fn(Fatal) + Send + Sync + 'static) -> Self {
        Self {
            reports,
            tasks: Vec::new(),
            threads: Vec::new(),
            tell: Tell {
                fatal: Arc::new(fatal),
                #[cfg(feature = "inject")]
                unarmed: None,
            },
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

    /// Calls `seen` with the duty's name at each panic of a duty that the
    /// seam did not raise, so that a test fails on a panic nobody armed.
    #[cfg(feature = "inject")]
    pub fn unarmed(&mut self, seen: impl Fn(&'static str) + Send + 'static) {
        self.tell.unarmed = Some(Box::new(seen));
    }

    /// Runs the duties until every one has ended. A panic of its own task
    /// takes the fatal path, and the duties end with it.
    pub async fn run(self) {
        let fatal = Arc::clone(&self.tell.fatal);
        if contain("supervisor", self.supervise()).await.is_err() {
            give_up(&*fatal, "supervisor");
        }
    }

    async fn supervise(self) {
        let Self {
            mut reports,
            tasks,
            threads,
            tell,
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
                    #[cfg(feature = "inject")]
                    tell.unarmed(name);
                    match limits.restart(name) {
                        Some(count) => {
                            tracing::error!(duty = name, %id, restart = count, of = RESTARTS, "a duty panicked, so it starts again");
                            running.start(&tasks, index);
                        }
                        None => give_up(&*tell.fatal, name),
                    }
                }
                Some(report) = reports.0.recv() => match report {
                    Report::Panicked(name) => match threads.iter().find(|thread| thread.name == name) {
                        Some(thread) => {
                            #[cfg(feature = "inject")]
                            tell.unarmed(name);
                            restart(thread, &mut limits, &tell);
                        }
                        None => tracing::error!(duty = name, "a duty that nothing supervises reported a panic"),
                    },
                    Report::Fatal(name) => give_up(&*tell.fatal, name),
                },
            }
        }
    }
}

/// What the supervisor tells: the fatal path, and in a test the panics
/// nobody armed.
struct Tell {
    fatal: Arc<dyn Fn(Fatal) + Send + Sync>,
    #[cfg(feature = "inject")]
    unarmed: Option<Box<dyn Fn(&'static str) + Send>>,
}

#[cfg(feature = "inject")]
impl Tell {
    fn unarmed(&self, duty: &'static str) {
        if let Some(unarmed) = &self.unarmed
            && !inject::raised(duty)
        {
            unarmed(duty);
        }
    }
}

fn give_up(fatal: &dyn Fn(Fatal), duty: &'static str) {
    tracing::error!(duty, "a duty cannot be kept, so Twigo must restart");
    fatal(Fatal { duty });
}

/// Starts a thread of a duty again after its panic, within the limit: a
/// start that panics counts as another panic of the duty.
fn restart(thread: &Thread, limits: &mut Limits, tell: &Tell) {
    let name = thread.name;
    loop {
        let Some(count) = limits.restart(name) else {
            return give_up(&*tell.fatal, name);
        };
        match catch_unwind(AssertUnwindSafe(|| (thread.restart)())) {
            Ok(true) => {
                tracing::error!(
                    duty = name,
                    restart = count,
                    of = RESTARTS,
                    "a thread panicked, so it starts again"
                );
                return;
            }
            Ok(false) => return give_up(&*tell.fatal, name),
            Err(_) => {
                tracing::error!(duty = name, "a thread panicked as it started again");
                #[cfg(feature = "inject")]
                tell.unarmed(name);
            }
        }
    }
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

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

    struct Dropped(Arc<AtomicBool>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// A duty that waits, and says when it is dropped.
    fn healthy(dropped: &Arc<AtomicBool>) -> impl Fn() -> BoxFuture<'static, ()> + use<> {
        let dropped = Arc::clone(dropped);
        move || {
            let dropped = Dropped(Arc::clone(&dropped));
            async move {
                let _dropped = dropped;
                std::future::pending::<()>().await;
            }
            .boxed()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_fourth_panic_in_five_minutes_takes_the_fatal_path_and_the_other_duties_go_on() {
        let (mut supervisor, _reporter, told) = supervisor();
        let starts = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        supervisor.task("flaky", flaky(&starts, usize::MAX));
        supervisor.task("healthy", healthy(&dropped));
        let running = tokio::spawn(supervisor.run());
        sleep(Duration::from_secs(1)).await;
        assert_eq!(starts.load(Ordering::SeqCst), 4, "three restarts");
        assert_eq!(*told.lock().unwrap(), [Fatal { duty: "flaky" }]);
        assert!(!dropped.load(Ordering::SeqCst), "the healthy duty runs");
        assert!(!running.is_finished());
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
        sleep(Duration::from_secs(1)).await;
        assert_eq!(restarts.load(Ordering::SeqCst), 3);
        assert_eq!(*told.lock().unwrap(), [Fatal { duty: "writer" }]);
        assert!(!running.is_finished());
    }

    #[tokio::test(start_paused = true)]
    async fn a_thread_whose_start_panics_counts_it_as_a_panic_of_its_duty() {
        let (mut supervisor, reporter, told) = supervisor();
        let dropped = Arc::new(AtomicBool::new(false));
        supervisor.task("healthy", healthy(&dropped));
        let restarts = Arc::new(AtomicUsize::new(0));
        supervisor.thread("watch", {
            let restarts = Arc::clone(&restarts);
            move || {
                restarts.fetch_add(1, Ordering::SeqCst);
                panic!("the files' content");
            }
        });
        let running = tokio::spawn(supervisor.run());
        reporter.panicked("watch");
        sleep(Duration::from_secs(1)).await;
        assert_eq!(restarts.load(Ordering::SeqCst), 3);
        assert_eq!(*told.lock().unwrap(), [Fatal { duty: "watch" }]);
        assert!(!dropped.load(Ordering::SeqCst), "the healthy duty runs");
        assert!(!running.is_finished());
    }

    #[tokio::test(start_paused = true)]
    async fn a_thread_that_cannot_start_again_and_a_loop_that_cannot_wait_take_the_fatal_path() {
        let (mut supervisor, reporter, told) = supervisor();
        supervisor.task("waiting", std::future::pending::<()>);
        supervisor.thread("writer", || false);
        tokio::spawn(supervisor.run());
        reporter.panicked("writer");
        reporter.fatal("proxy");
        sleep(Duration::from_secs(1)).await;
        assert_eq!(
            *told.lock().unwrap(),
            [Fatal { duty: "writer" }, Fatal { duty: "proxy" }]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_panic_of_the_supervisor_s_own_task_takes_the_fatal_path() {
        inject::arm("supervisor", 1);
        let (mut supervisor, _reporter, told) = supervisor();
        supervisor.task("waiting", std::future::pending::<()>);
        tokio::spawn(supervisor.run()).await.unwrap();
        assert_eq!(*told.lock().unwrap(), [Fatal { duty: "supervisor" }]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_panic_nobody_armed_is_told_and_one_the_seam_raised_is_not() {
        inject::arm("armed", 1);
        let (mut supervisor, reporter, _told) = supervisor();
        let unarmed = Arc::new(Mutex::new(Vec::new()));
        supervisor.unarmed({
            let unarmed = Arc::clone(&unarmed);
            move |duty| unarmed.lock().unwrap().push(duty)
        });
        supervisor.task("bug", flaky(&Arc::new(AtomicUsize::new(0)), 1));
        supervisor.task("armed", std::future::pending::<()>);
        supervisor.thread("writer", || true);
        tokio::spawn(supervisor.run());
        reporter.panicked("writer");
        sleep(Duration::from_secs(1)).await;
        assert_eq!(inject::armed("armed"), 0, "the armed duty panicked");
        let mut unarmed = unarmed.lock().unwrap().clone();
        unarmed.sort_unstable();
        assert_eq!(unarmed, ["bug", "writer"]);
    }
}
