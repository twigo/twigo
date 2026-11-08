//! The command bus (ARCHITECTURE 5.1, 6.4). A command that changes a cluster
//! or shows secret-grade data is planned first: what it will do, in words and
//! as kubectl, and the friction that what it risks asks for in the context's
//! mode. The webview draws the friction and runs the plan by its id, with
//! what proves the friction was met: the typed name, the countdown passed. A
//! plan runs once, from the window it was made for, on the cluster it was
//! planned on; the policy decides again as it starts, and the gate below
//! every client as each request goes out.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use tokio::time::Instant;
use twigo_ipc::{
    Affected, ContextAccess, ErrorKind, Friction, IpcError, OperationEvent, Plan, PlanId,
};
use twigo_policy::Attributes;
use twigo_policy::friction::Risk;

use crate::actions::undo::Revert;

/// What a command will do, as its action planned it.
pub(crate) struct Planned {
    pub context: String,
    /// The context's connection it planned for, so it runs there only: a
    /// delete's, that of the clients it read the object with; a Reveal's,
    /// the context's as it planned.
    pub connection: Option<u64>,
    /// The space whose last action it is once it starts, which holds its
    /// undo; none for a Reveal, which changes nothing, and for an undo,
    /// which takes its own.
    pub space: Option<String>,
    pub risk: Risk,
    /// The requests it sends that change the cluster, as they go out, for
    /// the policy to decide on before anything is asked.
    pub writes: Vec<Attributes>,
    /// As the audit log names the command and its object.
    pub command: &'static str,
    pub target: String,
    pub question: String,
    pub confirm: String,
    /// Whether it takes something away for good.
    pub destructive: bool,
    pub consequences: Vec<String>,
    pub affected: Vec<Affected>,
    pub kubectl: String,
    pub doing: String,
    pub run: Run,
}

pub(crate) type Run = Box<
    dyn FnOnce(Progress) -> Pin<Box<dyn Future<Output = Result<Finished, IpcError>> + Send>> + Send,
>;

/// How a run ended.
pub(crate) enum Finished {
    Done(String),
    /// Done, and `revert` puts it back while its undo lasts.
    Undoable {
        text: String,
        revert: Box<Revert>,
    },
    Stopped(String),
    Revealed {
        value: String,
        binary: bool,
    },
}

impl Finished {
    /// What puts it back, if it can be undone.
    pub(crate) fn revert(&self) -> Option<Revert> {
        match self {
            Finished::Undoable { revert, .. } => Some(Revert::clone(revert)),
            _ => None,
        }
    }

    /// The event that tells it, with when its undo ends, and what the
    /// audit log says of it, which never holds a value.
    pub(crate) fn told(self, undo_until: Option<i64>) -> (OperationEvent, &'static str, String) {
        match self {
            Finished::Done(text) | Finished::Undoable { text, .. } => (
                OperationEvent::Done {
                    text: text.clone(),
                    undo_until,
                },
                "done",
                text,
            ),
            Finished::Stopped(text) => (
                OperationEvent::Stopped { text: text.clone() },
                "stopped",
                text,
            ),
            Finished::Revealed { value, binary } => (
                OperationEvent::Revealed { value, binary },
                "done",
                "revealed".to_owned(),
            ),
        }
    }
}

type Sender = Box<dyn FnMut(OperationEvent) -> bool + Send>;

/// What a run tells the webview while it goes, and how it hears to stop.
#[derive(Clone)]
pub(crate) struct Progress {
    send: Arc<Mutex<Sender>>,
    stop: watch::Receiver<bool>,
}

impl Progress {
    pub(crate) fn new(send: impl FnMut(OperationEvent) -> bool + Send + 'static) -> (Self, Stop) {
        let (stop, heard) = watch::channel(false);
        let progress = Self {
            send: Arc::new(Mutex::new(Box::new(send))),
            stop: heard,
        };
        (progress, Stop(stop))
    }

    pub(crate) fn running(&self, text: impl Into<String>) {
        self.tell(OperationEvent::Running { text: text.into() });
    }

    pub(crate) fn tell(&self, event: OperationEvent) {
        (self.send.lock().expect("progress lock"))(event);
    }

    /// Whether it was asked to stop.
    pub(crate) fn stopping(&self) -> bool {
        *self.stop.borrow()
    }

    /// Ends once it is asked to stop: a run awaits it only where stopping
    /// leaves what it sent standing.
    pub(crate) async fn stopped(&self) {
        let mut stop = self.stop.clone();
        // The sender lives in the bus until the run ends.
        let _ = stop.wait_for(|stop| *stop).await;
    }
}

/// Asks a run to stop.
pub(crate) struct Stop(watch::Sender<bool>);

impl Stop {
    fn stop(&self) {
        self.0.send_replace(true);
    }
}

/// A plan as it waits to run.
pub(crate) struct Waiting {
    pub planned: Planned,
    pub friction: Friction,
    pub since: Instant,
}

enum Entry {
    Waiting(Box<Waiting>),
    Running(Stop),
}

/// Every window's plans, keyed by the window and the plan, so a window runs
/// only its own and a reload drops its own.
#[derive(Default)]
pub(crate) struct Bus {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next: u32,
    windows: HashMap<String, Window>,
}

#[derive(Default)]
struct Window {
    /// Counts the drops, so a plan a dropped page asked for is not kept.
    generation: u64,
    entries: HashMap<PlanId, Entry>,
}

/// Where a window stood when it asked for a plan, which may wait on the
/// network.
pub(crate) struct Ticket {
    window: String,
    generation: u64,
}

impl Bus {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("bus lock")
    }

    pub(crate) fn ticket(&self, window: &str) -> Ticket {
        let generation = self
            .inner()
            .windows
            .get(window)
            .map_or(0, |window| window.generation);
        Ticket {
            window: window.to_owned(),
            generation,
        }
    }

    /// Keeps a plan to run, with the friction `access` asks for.
    pub(crate) fn keep(
        &self,
        ticket: Ticket,
        planned: Planned,
        access: &ContextAccess,
    ) -> Result<Plan, IpcError> {
        let friction = twigo_policy::friction::friction(&planned.risk, &planned.context, access);
        let mut inner = self.inner();
        inner.next += 1;
        let id = PlanId(inner.next);
        let window = inner.windows.entry(ticket.window).or_default();
        if window.generation != ticket.generation {
            return Err(IpcError::new(
                ErrorKind::Unavailable,
                "the page that asked for the plan is gone",
            ));
        }
        let plan = Plan {
            id,
            context: planned.context.clone(),
            environment: access.environment,
            mode: access.mode,
            friction: friction.clone(),
            question: planned.question.clone(),
            confirm: planned.confirm.clone(),
            destructive: planned.destructive,
            consequences: planned.consequences.clone(),
            affected: planned.affected.clone(),
            kubectl: planned.kubectl.clone(),
            doing: planned.doing.clone(),
        };
        window.entries.insert(
            id,
            Entry::Waiting(Box::new(Waiting {
                planned,
                friction,
                since: Instant::now(),
            })),
        );
        Ok(plan)
    }

    /// Takes a plan that waits to run, so none runs twice, and where its
    /// window stood.
    pub(crate) fn take(
        &self,
        window: &str,
        id: PlanId,
    ) -> Result<(Box<Waiting>, Ticket), IpcError> {
        let mut inner = self.inner();
        let held = inner.windows.get_mut(window).and_then(|held| {
            matches!(held.entries.get(&id), Some(Entry::Waiting(_))).then_some(held)
        });
        let Some(held) = held else {
            return Err(IpcError::new(
                ErrorKind::NotFound,
                format!("no plan {} waits to run", id.0),
            ));
        };
        let Some(Entry::Waiting(waiting)) = held.entries.remove(&id) else {
            unreachable!("looked at under the same lock");
        };
        let ticket = Ticket {
            window: window.to_owned(),
            generation: held.generation,
        };
        Ok((waiting, ticket))
    }

    /// Notes a plan as running, so a cancel or the window's drop stops it;
    /// refused once the window was dropped since it was taken.
    pub(crate) fn run(&self, ticket: Ticket, id: PlanId, stop: Stop) -> Result<(), IpcError> {
        let mut inner = self.inner();
        let window = inner.windows.entry(ticket.window).or_default();
        if window.generation != ticket.generation {
            return Err(IpcError::new(
                ErrorKind::Unavailable,
                "the page that ran the plan is gone",
            ));
        }
        window.entries.insert(id, Entry::Running(stop));
        Ok(())
    }

    pub(crate) fn ended(&self, window: &str, id: PlanId) {
        if let Some(window) = self.inner().windows.get_mut(window) {
            window.entries.remove(&id);
        }
    }

    /// Drops a plan that waits, or stops one that runs.
    pub(crate) fn cancel(&self, window: &str, id: PlanId) {
        let mut inner = self.inner();
        let Some(entries) = inner
            .windows
            .get_mut(window)
            .map(|window| &mut window.entries)
        else {
            return;
        };
        match entries.get(&id) {
            Some(Entry::Waiting(_)) => {
                entries.remove(&id);
            }
            Some(Entry::Running(stop)) => stop.stop(),
            None => {}
        }
    }

    /// Drops a reloading or closing window's plans and stops its runs.
    pub(crate) fn drop_window(&self, window: &str) {
        let dropped = {
            let mut inner = self.inner();
            let window = inner.windows.entry(window.to_owned()).or_default();
            window.generation += 1;
            std::mem::take(&mut window.entries)
        };
        for entry in dropped.into_values() {
            if let Entry::Running(stop) = entry {
                stop.stop();
            }
        }
    }
}

#[cfg(test)]
mod tests;
