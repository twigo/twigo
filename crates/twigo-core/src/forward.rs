//! The port-forward manager (ARCHITECTURE 4.6): the forwards of every space,
//! kept in a table of their own that outlives the windows, which follow it.
//! A forward's data path is `twigo_sessions::forward`; this holds its spaces,
//! its policy and what is kept of it.

mod ports;
mod saved;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};
use twigo_cache::hub::Resource;
use twigo_ipc::{
    BusyWhy, ErrorKind, Forward, ForwardEvent, ForwardId, ForwardPort, ForwardPorts,
    ForwardStarted, ForwardState, ForwardTarget, IpcError, ResumeForward, StartForward,
};
use twigo_kube::client::Actor;
use twigo_policy::{Attributes, Policy};
use twigo_sessions::forward as data;
use twigo_sessions::forward::{BindError, Listeners, free_port, listen};

use saved::Remembered;
pub(crate) use saved::{Saved, SavedForward};

use crate::catalog::Contexts;
use crate::proxy::{Changes, blocked};
use crate::{ClientsError, Core, actions};

/// A forward's `Changed` goes out at most four times a second, unless its
/// state changed.
const BETWEEN: Duration = Duration::from_millis(250);

type Follower = Box<dyn FnMut(ForwardEvent) -> bool + Send>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    space: String,
    group: String,
    resource: String,
    namespace: String,
    name: String,
    port: u16,
}

impl Key {
    fn of(target: &ForwardTarget, port: u16) -> Self {
        Self {
            space: target.space.clone(),
            group: target.gvr.group.clone(),
            resource: target.gvr.resource.clone(),
            namespace: target.namespace.clone(),
            name: target.name.clone(),
            port,
        }
    }
}

struct Run {
    data: data::Forward,
    status: watch::Receiver<data::Status>,
    pump: JoinHandle<()>,
}

impl Drop for Run {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

struct Entry {
    /// Everything of the forward that its data path does not tell, and the
    /// bytes of the runs it had before.
    base: Forward,
    context: String,
    /// None while it is stopped, or its port could not be bound.
    run: Option<Run>,
    /// It should run, and could not listen: why.
    unbound: Option<IpcError>,
    /// Why its context's mode refuses it, or the catalog lacks the context,
    /// while one does.
    refused: Option<IpcError>,
    /// Its local port is the free one that was offered in place of a busy
    /// one, which is never remembered.
    detour: bool,
}

impl Entry {
    fn runs(&self) -> bool {
        self.run.is_some() || self.unbound.is_some()
    }

    /// Closes its port and connections, and keeps the bytes they carried.
    fn stop(&mut self) {
        if let Some(run) = self.run.take() {
            let (sent, received) = run.data.bytes();
            self.base.sent += sent;
            self.base.received += received;
        }
    }

    /// Tells its data path what changed: a refusal, other words for it, or
    /// none any more.
    fn check(&mut self, checks: &Checks) {
        let Some(run) = &self.run else {
            return;
        };
        let refusal = checks.refusal(&self.context, &self.base.target);
        match (refusal, &self.refused) {
            (Some(error), Some(was)) if error == *was => {}
            (Some(error), _) => {
                self.refused = Some(error.clone());
                run.data.refuse(error);
            }
            (None, Some(_)) => {
                self.refused = None;
                run.data.allow();
            }
            (None, None) => {}
        }
    }

    fn forward(&self) -> Forward {
        let mut forward = self.base.clone();
        match &self.run {
            Some(run) => apply(&mut forward, &run.status.borrow()),
            None => {
                if let Some(error) = &self.unbound {
                    forward.state = ForwardState::Failed {
                        error: error.clone(),
                    };
                }
            }
        }
        forward
    }
}

fn apply(forward: &mut Forward, status: &data::Status) {
    forward.state = status.state.clone();
    forward.pod = status.pod.clone();
    forward.pod_port = status.pod_port;
    forward.connections = status.connections;
    forward.queued = status.queued;
    forward.sent += status.sent;
    forward.received += status.received;
    forward.failure = status.failure.clone();
}

#[derive(Default)]
struct Table {
    /// By the number in the forward's id.
    entries: BTreeMap<u32, Entry>,
    remembered: HashMap<Key, Remembered>,
    /// The free port offered in place of one that was busy, by what was
    /// asked: starting on it is a detour, which is not remembered.
    detours: HashMap<Key, u16>,
    /// One per window: a later follower replaces the earlier.
    followers: HashMap<Arc<str>, Follower>,
    /// Until the saved forwards are in, the contexts whose clients were
    /// made, which then start theirs over.
    early: Option<HashSet<String>>,
}

impl Table {
    fn emit(&mut self, event: &ForwardEvent) {
        self.followers.retain(|_, send| send(event.clone()));
    }

    fn changed(&mut self, id: ForwardId) {
        if let Some(entry) = self.entries.get(&id.0) {
            let forward = Box::new(entry.forward());
            self.emit(&ForwardEvent::Changed { forward });
        }
    }

    fn find(&self, key: &Key) -> Option<ForwardId> {
        self.entries
            .iter()
            .find(|(_, entry)| {
                let target = &entry.base.target;
                Key::of(target, entry.base.port) == *key
            })
            .map(|(id, _)| ForwardId(*id))
    }

    /// Fills the `local` and the `forward` of the ports `target` declares:
    /// a forward's own local port where the port has a forward, else the one
    /// a start takes.
    fn describe(&self, target: &ForwardTarget, declared: &mut [ForwardPort]) {
        for port in declared {
            let key = Key::of(target, port.port);
            match self.find(&key) {
                Some(id) => {
                    port.forward = Some(id);
                    port.local = self.entries[&id.0].base.local;
                }
                None => {
                    port.local =
                        ports::local(self.remembered.get(&key).map(|r| r.local), port.port);
                }
            }
        }
    }

    fn saved(&self, space: &str) -> Saved {
        Saved {
            forwards: self
                .entries
                .values()
                .filter(|entry| entry.base.target.space == space)
                .map(|entry| SavedForward {
                    id: entry.base.id,
                    target: entry.base.target.clone(),
                    kind: entry.base.kind.clone(),
                    port: entry.base.port,
                    port_name: entry.base.port_name.clone(),
                    app_protocol: entry.base.app_protocol.clone(),
                    local: entry.base.local,
                    detour: entry.detour,
                    runs: entry.runs(),
                })
                .collect(),
            ports: self
                .remembered
                .iter()
                .filter(|(key, _)| key.space == space)
                .map(|(_, remembered)| remembered.clone())
                .collect(),
        }
    }

    fn holder(&self, local: u16) -> Option<(String, String)> {
        self.entries
            .values()
            .find(|entry| entry.run.is_some() && entry.base.local == local)
            .map(|entry| (entry.base.kind.clone(), entry.base.target.name.clone()))
    }

    fn detour(&mut self, key: &Key, local: u16) -> bool {
        self.detours.remove(key) == Some(local)
    }

    fn remember(&mut self, key: &Key, target: &ForwardTarget, local: u16) {
        self.remembered.insert(
            key.clone(),
            Remembered {
                target: target.clone(),
                port: key.port,
                local,
            },
        );
    }
}

/// What decides whether a forward may run, read under the table's lock, so
/// a check never lands with older answers than another.
struct Checks {
    policy: Arc<Policy>,
    catalog: watch::Receiver<Option<Arc<Contexts>>>,
}

impl Checks {
    /// Why `context` may not be forwarded to, if it may not: the catalog
    /// lacks it, or its mode refuses the request a connection sends. A
    /// catalog not loaded yet refuses nothing.
    fn refusal(&self, context: &str, target: &ForwardTarget) -> Option<IpcError> {
        let missing = self
            .catalog
            .borrow()
            .as_deref()
            .is_some_and(|contexts| contexts.find(context).is_none());
        if missing {
            return Some(IpcError::from(&ClientsError::NoContext(context.to_owned())));
        }
        blocked(&self.policy, context, &attributes(target), Actor::Ui)
            .map(|blocked| IpcError::from(*blocked))
    }
}

pub(crate) struct Forwards {
    table: Arc<Mutex<Table>>,
    checks: Checks,
    /// True once the saved forwards are in the table, which every command
    /// that reads or changes it waits for: a start before that would not
    /// see the ports and forwards not restored yet, and its save would
    /// replace what the space kept.
    restored: watch::Sender<bool>,
}

impl Forwards {
    pub(crate) fn new(
        policy: Arc<Policy>,
        catalog: watch::Receiver<Option<Arc<Contexts>>>,
    ) -> Self {
        Self {
            table: Arc::new(Mutex::new(Table {
                early: Some(HashSet::new()),
                ..Table::default()
            })),
            checks: Checks { policy, catalog },
            restored: watch::Sender::new(false),
        }
    }

    fn table(&self) -> MutexGuard<'_, Table> {
        self.table.lock().expect("forwards lock")
    }

    async fn after_restore(&self) {
        self.restored
            .subscribe()
            .wait_for(|restored| *restored)
            .await
            .expect("the manager holds the sender");
    }

    fn run(
        &self,
        context: &str,
        base: &Forward,
        listeners: Listeners,
        restored: bool,
        hub: twigo_cache::hub::Hub,
    ) -> Result<Run, IpcError> {
        let target = &base.target;
        let config = data::Config {
            context: context.to_owned(),
            target: data::Target::new(&target.gvr, target.namespace.clone(), target.name.clone())?,
            port: base.port,
            port_name: base.port_name.clone(),
        };
        let forward = data::Forward::spawn(hub, config, listeners, restored);
        let status = forward.status();
        let table = Arc::downgrade(&self.table);
        let id = base.id;
        let pump = tokio::spawn(pump(status.clone(), base.clone(), move |_| {
            if let Some(table) = table.upgrade() {
                // What goes out is the forward as it is now, if it still is.
                table.lock().expect("forwards lock").changed(id);
            }
        }));
        Ok(Run {
            data: forward,
            status,
            pump,
        })
    }

    /// `send` gets the forwards of every space now, in the answer, and then
    /// each change, until it says the window is gone; in place of what the
    /// window followed before. It must not call back into the manager.
    pub(crate) fn follow_window(
        &self,
        window: &str,
        send: impl FnMut(ForwardEvent) -> bool + Send + 'static,
    ) -> Vec<Forward> {
        let mut table = self.table();
        let forwards = table.entries.values().map(Entry::forward).collect();
        table.followers.insert(window.into(), Box::new(send));
        forwards
    }

    pub(crate) fn unfollow(&self, window: &str) {
        self.table().followers.remove(window);
    }

    /// Closes every port and connection, and leaves what the state says ran.
    pub(crate) fn shutdown(&self) {
        let mut table = self.table();
        for entry in table.entries.values_mut() {
            entry.stop();
        }
    }

    /// The clients of `context` were made: a forward of it that waits for
    /// its first connection starts over, unless it is refused. While the
    /// forwards are being restored it waits for them.
    pub(crate) fn connected(&self, context: &str) {
        let mut table = self.table();
        match &mut table.early {
            Some(early) => {
                early.insert(context.to_owned());
            }
            None => self.start_over(&mut table, context),
        }
    }

    /// Decided on what the manager knows, not on the status, which lags the
    /// controls it has sent: the queue applies a lifted refusal and then the
    /// start.
    fn start_over(&self, table: &mut Table, context: &str) {
        for entry in table
            .entries
            .values_mut()
            .filter(|entry| entry.context == context)
        {
            entry.check(&self.checks);
            if entry.refused.is_none()
                && let Some(run) = &entry.run
                && run.data.waits()
            {
                run.data.restart();
            }
        }
    }

    /// Asks the policy and the catalog again for each running forward's
    /// context: a forward whose mode now refuses it, or whose context the
    /// catalog lacks, ends its connections and fails, and goes back to what
    /// it was once that passes.
    pub(crate) fn recheck(&self) {
        let mut table = self.table();
        for entry in table.entries.values_mut() {
            entry.check(&self.checks);
        }
    }
}

/// The request a connection sends, which the gate reads.
fn attributes(target: &ForwardTarget) -> Attributes {
    let pod = (target.gvr.group.is_empty() && target.gvr.resource == "pods")
        .then_some(target.name.as_str());
    Attributes::action(
        "get",
        "pods",
        Some("portforward"),
        Some(&target.namespace),
        pod,
    )
}

/// Sends a forward as it changes: a change of its state at once, any other
/// no more than every [`BETWEEN`].
async fn pump(
    mut status: watch::Receiver<data::Status>,
    base: Forward,
    mut send: impl FnMut(Forward),
) {
    let shown = |status: &data::Status| {
        let mut forward = base.clone();
        apply(&mut forward, status);
        forward
    };
    let mut last = shown(&status.borrow_and_update());
    let mut sent = Instant::now();
    loop {
        if status.changed().await.is_err() {
            return;
        }
        loop {
            let current = shown(&status.borrow_and_update());
            if current == last {
                break;
            }
            let due = sent + BETWEEN;
            if current.state != last.state || Instant::now() >= due {
                send(current.clone());
                last = current;
                sent = Instant::now();
                break;
            }
            tokio::select! {
                () = sleep_until(due) => {}
                changed = status.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        }
    }
}

fn unbound(local: u16, why: BusyWhy, own: Option<(String, String)>) -> IpcError {
    let words = match (why, own) {
        (BusyWhy::InUse, Some((kind, name))) => {
            format!("port {local} is held by another forward of Twigo, to {kind} {name}")
        }
        (BusyWhy::InUse, None) => format!("port {local} is held by another process"),
        (BusyWhy::NotPermitted, _) => {
            format!("this system does not let Twigo listen on port {local}")
        }
    };
    IpcError::new(ErrorKind::Conflict, words)
}

/// A local port a person names: 0 would ask the system for any port.
fn named(local: Option<u16>) -> Result<(), IpcError> {
    if local == Some(0) {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            "port 0 is not a local port to listen on",
        ));
    }
    Ok(())
}

enum Bound {
    Listening(Listeners),
    Busy(ForwardStarted),
}

impl Core {
    pub async fn forward_ports(&self, target: ForwardTarget) -> Result<ForwardPorts, IpcError> {
        self.forwards.after_restore().await;
        let context = self.context(&target.space)?;
        let kind =
            data::Target::new(&target.gvr, target.namespace.clone(), target.name.clone())?.label();
        let object = self.read_target(&context, &target).await?;
        let mut declared = ports::declared(kind, &target.name, &object)?;
        self.forwards.table().describe(&target, &mut declared);
        let default = ports::default(&declared);
        Ok(ForwardPorts {
            kind: kind.to_owned(),
            ports: declared,
            default,
        })
    }

    async fn read_target(&self, context: &str, target: &ForwardTarget) -> Result<Value, IpcError> {
        let resource = Resource {
            group: target.gvr.group.clone(),
            version: target.gvr.version.clone(),
            resource: target.gvr.resource.clone(),
            namespaced: true,
        };
        let path = resource.object_path(Some(&target.namespace), &target.name)?;
        let clients = self
            .clients(context)
            .await
            .map_err(|error| IpcError::from(&error))?;
        actions::get(&clients, &path).await
    }

    async fn bind(&self, key: &Key, local: u16) -> Result<Bound, IpcError> {
        match listen(local).await {
            Ok(listeners) => Ok(Bound::Listening(listeners)),
            Err(BindError::Busy(why)) => {
                let free = free_port(local).await.map_err(|error| {
                    IpcError::new(
                        ErrorKind::Conflict,
                        format!("port {local} is busy, and no other is free: {error}"),
                    )
                })?;
                self.forwards.table().detours.insert(key.clone(), free);
                Ok(Bound::Busy(ForwardStarted::Busy { local, why, free }))
            }
            Err(BindError::Failed(error)) => Err(IpcError::new(
                ErrorKind::Internal,
                format!("could not listen on port {local}: {error}"),
            )),
        }
    }

    /// Binds a local port and forwards it to a port of the target. A port of
    /// a target that has a forward answers with that forward, started again
    /// if it was stopped, and moved if another `local` is asked.
    pub async fn forward_start(&self, request: StartForward) -> Result<ForwardStarted, IpcError> {
        let StartForward {
            target,
            port,
            local: asked,
        } = request;
        named(asked)?;
        self.forwards.after_restore().await;
        let context = self.context(&target.space)?;
        let kind = data::Target::new(&target.gvr, target.namespace.clone(), target.name.clone())?
            .label()
            .to_owned();
        self.authorize(&context, &[attributes(&target)])?;
        let key = Key::of(&target, port);
        let existing = self.forwards.table().find(&key);
        if let Some(id) = existing {
            return self
                .forward_resume(ResumeForward { id, local: asked })
                .await;
        }
        let local = asked.unwrap_or_else(|| {
            let remembered = self.forwards.table().remembered.get(&key).map(|r| r.local);
            ports::local(remembered, port)
        });
        let listeners = match self.bind(&key, local).await? {
            Bound::Listening(listeners) => listeners,
            Bound::Busy(busy) => return Ok(busy),
        };
        let found = self
            .forward_ports(target.clone())
            .await?
            .ports
            .into_iter()
            .find(|declared| declared.port == port)
            .ok_or_else(|| {
                IpcError::new(
                    ErrorKind::InvalidInput,
                    format!("{} declares no port {port}", target.name),
                )
            })?;
        let taken = self
            .forwards
            .table()
            .entries
            .keys()
            .copied()
            .max()
            .unwrap_or(0);
        let id = self.state.next_forward_id(taken);
        let base = Forward {
            id,
            target: target.clone(),
            kind,
            port,
            port_name: found.name,
            app_protocol: found.app_protocol,
            local,
            addresses: listeners.addresses(),
            state: ForwardState::Stopped,
            pod: None,
            pod_port: None,
            connections: 0,
            queued: 0,
            sent: 0,
            received: 0,
            failure: None,
        };
        let mut run =
            Some(
                self.forwards
                    .run(&context, &base, listeners, false, self.hub.clone())?,
            );
        let started = {
            let mut table = self.forwards.table();
            match table.find(&key) {
                // Another start of this port came in meanwhile and won.
                Some(existing) => Err(existing),
                None => {
                    let detour = table.detour(&key, local);
                    if !detour {
                        table.remember(&key, &target, local);
                    }
                    let mut entry = Entry {
                        base,
                        context,
                        run: run.take(),
                        unbound: None,
                        refused: None,
                        detour,
                    };
                    entry.check(&self.forwards.checks);
                    table.entries.insert(id.0, entry);
                    table.changed(id);
                    Ok(table.entries[&id.0].forward())
                }
            }
        };
        let started = match started {
            Ok(started) => started,
            Err(existing) => {
                drop(run);
                return self
                    .forward_resume(ResumeForward {
                        id: existing,
                        local: asked,
                    })
                    .await;
            }
        };
        self.save_forwards(&target.space);
        Ok(ForwardStarted::Started {
            forward: Box::new(started),
        })
    }

    /// Starts a stopped or failed forward again, on another local port when
    /// `local` names one, and moves a running one if another port is asked.
    pub async fn forward_resume(&self, request: ResumeForward) -> Result<ForwardStarted, IpcError> {
        let ResumeForward { id, local } = request;
        named(local)?;
        self.forwards.after_restore().await;
        let (context, target, base) = {
            let table = self.forwards.table();
            let entry = table.entries.get(&id.0).ok_or_else(|| {
                IpcError::new(ErrorKind::NotFound, format!("no forward {}", id.0))
            })?;
            (
                entry.context.clone(),
                entry.base.target.clone(),
                entry.base.clone(),
            )
        };
        self.authorize(&context, &[attributes(&target)])?;
        let key = Key::of(&target, base.port);
        let wanted = local.unwrap_or(base.local);
        {
            let mut table = self.forwards.table();
            let Some(entry) = table.entries.get_mut(&id.0) else {
                return Err(IpcError::new(
                    ErrorKind::NotFound,
                    format!("forward {} was removed", id.0),
                ));
            };
            if wanted == base.local && entry.run.is_some() {
                entry.check(&self.forwards.checks);
                if entry.refused.is_none()
                    && let Some(run) = &entry.run
                    && !run.data.waits()
                    && matches!(run.status.borrow().state, ForwardState::Failed { .. })
                {
                    run.data.restart();
                }
                let forward = Box::new(entry.forward());
                return Ok(ForwardStarted::Started { forward });
            }
        }
        let listeners = match self.bind(&key, wanted).await? {
            Bound::Listening(listeners) => listeners,
            Bound::Busy(busy) => return Ok(busy),
        };
        let mut moved = base;
        moved.local = wanted;
        moved.addresses = listeners.addresses();
        let started = {
            let mut table = self.forwards.table();
            let Some(was) = table
                .entries
                .get(&id.0)
                .map(|entry| (entry.base.local, entry.detour))
            else {
                return Err(IpcError::new(
                    ErrorKind::NotFound,
                    format!("forward {} was removed", id.0),
                ));
            };
            let waits = table.entries[&id.0]
                .run
                .as_ref()
                .is_some_and(|run| run.data.waits());
            let run = self
                .forwards
                .run(&context, &moved, listeners, waits, self.hub.clone())?;
            let detour = if was.0 == wanted {
                was.1
            } else {
                table.detour(&key, wanted)
            };
            if !detour {
                table.remember(&key, &target, wanted);
            }
            let entry = table.entries.get_mut(&id.0).expect("checked");
            entry.stop();
            entry.base.local = wanted;
            entry.base.addresses = moved.addresses;
            entry.run = Some(run);
            entry.unbound = None;
            entry.refused = None;
            entry.detour = detour;
            entry.check(&self.forwards.checks);
            let started = entry.forward();
            table.changed(id);
            started
        };
        self.save_forwards(&target.space);
        Ok(ForwardStarted::Started {
            forward: Box::new(started),
        })
    }

    /// Closes a forward's port and connections, and keeps it listed.
    pub async fn forward_stop(&self, id: ForwardId) -> Result<(), IpcError> {
        self.forwards.after_restore().await;
        let space = {
            let mut table = self.forwards.table();
            let entry = table.entries.get_mut(&id.0).ok_or_else(|| {
                IpcError::new(ErrorKind::NotFound, format!("no forward {}", id.0))
            })?;
            entry.stop();
            entry.unbound = None;
            entry.refused = None;
            let space = entry.base.target.space.clone();
            table.changed(id);
            space
        };
        self.save_forwards(&space);
        Ok(())
    }

    /// Stops a forward and forgets it; the local port its target's port had
    /// stays.
    pub async fn forward_remove(&self, id: ForwardId) -> Result<(), IpcError> {
        self.forwards.after_restore().await;
        let space = {
            let mut table = self.forwards.table();
            let entry = table.entries.remove(&id.0).ok_or_else(|| {
                IpcError::new(ErrorKind::NotFound, format!("no forward {}", id.0))
            })?;
            table.emit(&ForwardEvent::Removed { id });
            entry.base.target.space.clone()
        };
        self.save_forwards(&space);
        Ok(())
    }

    pub fn follow_forwards(
        &self,
        window: &str,
        send: impl FnMut(ForwardEvent) -> bool + Send + 'static,
    ) -> Vec<Forward> {
        self.forwards.follow_window(window, send)
    }

    /// Stores the space's forwards as the table has them now. The table stays
    /// locked until they are stored, so the order of writes is the order of
    /// snapshots.
    fn save_forwards(&self, space: &str) {
        let table = self.forwards.table();
        if let Err(error) = self.state.set_forwards(space, &table.saved(space)) {
            eprintln!("could not keep the forwards of {space}: {error}");
        }
    }

    /// Binds the port of each forward that ran when Twigo quit, and lets it
    /// wait for its first connection or its space's connecting: nothing asks
    /// a cluster. A forward whose port another process holds fails with
    /// that; the policy and the catalog are asked about the rest once they
    /// are loaded. The commands wait for it, and the spaces whose clients
    /// were made meanwhile start their forwards over at its end.
    pub(crate) async fn restore_forwards(&self) {
        for space in self.state.spaces() {
            let saved = self.state.forwards(&space.id);
            let Some(context) = space.contexts.first() else {
                continue;
            };
            {
                let mut table = self.forwards.table();
                for remembered in saved.ports {
                    let key = Key::of(&remembered.target, remembered.port);
                    table.remembered.insert(key, remembered);
                }
            }
            for saved in saved.forwards {
                self.restore_forward(context, saved).await;
            }
        }
        let mut table = self.forwards.table();
        for context in table.early.take().unwrap_or_default() {
            self.forwards.start_over(&mut table, &context);
        }
        self.forwards.restored.send_replace(true);
    }

    async fn restore_forward(&self, context: &str, saved: SavedForward) {
        let SavedForward {
            id,
            target,
            kind,
            port,
            port_name,
            app_protocol,
            local,
            detour,
            runs,
        } = saved;
        let mut entry = Entry {
            base: Forward {
                id,
                target,
                kind,
                port,
                port_name,
                app_protocol,
                local,
                addresses: Vec::new(),
                state: ForwardState::Stopped,
                pod: None,
                pod_port: None,
                connections: 0,
                queued: 0,
                sent: 0,
                received: 0,
                failure: None,
            },
            context: context.to_owned(),
            run: None,
            unbound: None,
            refused: None,
            detour,
        };
        if runs {
            match listen(local).await {
                Ok(listeners) => {
                    entry.base.addresses = listeners.addresses();
                    let run =
                        self.forwards
                            .run(context, &entry.base, listeners, true, self.hub.clone());
                    match run {
                        Ok(run) => entry.run = Some(run),
                        Err(error) => entry.unbound = Some(error),
                    }
                }
                Err(BindError::Busy(why)) => {
                    let own = self.forwards.table().holder(local);
                    entry.unbound = Some(unbound(local, why, own));
                }
                Err(BindError::Failed(error)) => {
                    entry.unbound = Some(IpcError::new(
                        ErrorKind::Internal,
                        format!("could not listen on port {local}: {error}"),
                    ));
                }
            }
        }
        let mut table = self.forwards.table();
        if table
            .find(&Key::of(&entry.base.target, entry.base.port))
            .is_some()
        {
            return;
        }
        table.entries.insert(id.0, entry);
        table.changed(id);
    }

    /// Restores the forwards, then asks the policy and the catalog for each
    /// again whenever either changes; never returns.
    pub(crate) async fn follow_forward_modes(&self) {
        let mut changes = Changes::new(&self.policy, &self.catalog.subscribe());
        self.restore_forwards().await;
        loop {
            self.forwards.recheck();
            changes.next().await;
        }
    }
}

#[cfg(test)]
mod tests;
