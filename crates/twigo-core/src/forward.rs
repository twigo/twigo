//! The port-forward manager (ARCHITECTURE 4.6): the forwards of every space,
//! kept in a table of their own that outlives the windows, which follow it.
//! A forward's data path is `twigo_sessions::forward`; this holds its spaces,
//! its policy and what is kept of it.

mod ports;
mod saved;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};
use twigo_cache::hub::Resource;
use twigo_ipc::{
    BusyWhy, ErrorKind, Forward, ForwardEvent, ForwardId, ForwardPorts, ForwardStarted,
    ForwardState, ForwardTarget, IpcError, ResumeForward, StartForward,
};
use twigo_kube::client::Actor;
use twigo_policy::{Attributes, Policy};
use twigo_sessions::forward as data;
use twigo_sessions::forward::{BindError, Listeners, free_port, listen};

use saved::Remembered;
pub(crate) use saved::{Saved, SavedForward};

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
    /// Everything of the forward that its data path does not tell.
    base: Forward,
    context: String,
    /// None while it is stopped, or its port could not be bound.
    run: Option<Run>,
    /// It should run, and could not listen: why.
    unbound: Option<IpcError>,
    /// Its context's mode refuses it.
    refused: bool,
}

impl Entry {
    fn runs(&self) -> bool {
        self.run.is_some() || self.unbound.is_some()
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
    forward.sent = status.sent;
    forward.received = status.received;
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

    fn remember(&mut self, key: &Key, target: &ForwardTarget, local: u16) {
        if self.detours.remove(key) == Some(local) {
            return;
        }
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

#[derive(Default)]
pub(crate) struct Forwards(Arc<Mutex<Table>>);

impl Forwards {
    fn table(&self) -> MutexGuard<'_, Table> {
        self.0.lock().expect("forwards lock")
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
        let table = Arc::downgrade(&self.0);
        let pump = tokio::spawn(pump(status.clone(), base.clone(), move |forward| {
            if let Some(table) = table.upgrade() {
                let mut table = table.lock().expect("forwards lock");
                table.emit(&ForwardEvent::Changed {
                    forward: Box::new(forward),
                });
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
            entry.run = None;
        }
    }

    /// The clients of `context` were made: a forward of it that waits for
    /// its first connection starts over.
    pub(crate) fn connected(&self, context: &str) {
        let table = self.table();
        for entry in table.entries.values().filter(|e| e.context == context) {
            if let Some(run) = &entry.run
                && run.status.borrow().state == ForwardState::Restored
            {
                run.data.restart();
            }
        }
    }

    /// Asks the policy again for each running forward's context: a forward
    /// whose mode now refuses it ends its connections and fails, and starts
    /// over once the mode allows it again.
    pub(crate) fn recheck(&self, policy: &Policy) {
        let mut table = self.table();
        for entry in table.entries.values_mut() {
            let Some(run) = &entry.run else {
                continue;
            };
            let refusal = blocked(
                policy,
                &entry.context,
                &attributes(&entry.base.target),
                Actor::Ui,
            );
            match refusal {
                Some(blocked) if !entry.refused => {
                    entry.refused = true;
                    run.data.refuse(IpcError::from(*blocked));
                }
                None if entry.refused => {
                    entry.refused = false;
                    run.data.restart();
                }
                _ => {}
            }
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

fn unbound(local: u16, why: BusyWhy) -> IpcError {
    let words = match why {
        BusyWhy::InUse => format!("port {local} is held by another process"),
        BusyWhy::NotPermitted => format!("this system does not let Twigo listen on port {local}"),
    };
    IpcError::new(ErrorKind::Conflict, words)
}

enum Bound {
    Listening(Listeners),
    Busy(ForwardStarted),
}

impl Core {
    pub async fn forward_ports(&self, target: ForwardTarget) -> Result<ForwardPorts, IpcError> {
        let context = self.context(&target.space)?;
        let kind =
            data::Target::new(&target.gvr, target.namespace.clone(), target.name.clone())?.label();
        let object = self.read_target(&context, &target).await?;
        let mut declared = ports::declared(kind, &target.name, &object)?;
        {
            let table = self.forwards.table();
            for port in &mut declared {
                let key = Key::of(&target, port.port);
                port.local = ports::local(table.remembered.get(&key).map(|r| r.local), port.port);
                port.forward = table.find(&key);
            }
        }
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
            local,
        } = request;
        let context = self.context(&target.space)?;
        let kind = data::Target::new(&target.gvr, target.namespace.clone(), target.name.clone())?
            .label()
            .to_owned();
        self.authorize(&context, &[attributes(&target)])?;
        let key = Key::of(&target, port);
        let existing = self.forwards.table().find(&key);
        if let Some(id) = existing {
            return self.forward_resume(ResumeForward { id, local }).await;
        }
        let local = local.unwrap_or_else(|| {
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
                    table.remember(&key, &target, local);
                    table.entries.insert(
                        id.0,
                        Entry {
                            base,
                            context,
                            run: run.take(),
                            unbound: None,
                            refused: false,
                        },
                    );
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
                        local: None,
                    })
                    .await;
            }
        };
        self.save_forwards(&target.space);
        Ok(ForwardStarted::Started {
            forward: Box::new(started),
        })
    }

    /// Starts a stopped forward again, on another local port when `local`
    /// names one; a forward that failed starts over, and one that runs moves
    /// if another port is asked.
    pub async fn forward_resume(&self, request: ResumeForward) -> Result<ForwardStarted, IpcError> {
        let ResumeForward { id, local } = request;
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
            if let Some(run) = &entry.run
                && wanted == base.local
            {
                run.data.restart();
                entry.refused = false;
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
        let run = self
            .forwards
            .run(&context, &moved, listeners, false, self.hub.clone())?;
        let started = {
            let mut table = self.forwards.table();
            let Some(entry) = table.entries.get_mut(&id.0) else {
                return Err(IpcError::new(
                    ErrorKind::NotFound,
                    format!("forward {} was removed", id.0),
                ));
            };
            entry.base = moved;
            entry.run = Some(run);
            entry.unbound = None;
            entry.refused = false;
            let started = entry.forward();
            table.remember(&key, &target, wanted);
            table.changed(id);
            started
        };
        self.save_forwards(&target.space);
        Ok(ForwardStarted::Started {
            forward: Box::new(started),
        })
    }

    /// Closes a forward's port and connections, and keeps it listed.
    pub fn forward_stop(&self, id: ForwardId) -> Result<(), IpcError> {
        let space = {
            let mut table = self.forwards.table();
            let entry = table.entries.get_mut(&id.0).ok_or_else(|| {
                IpcError::new(ErrorKind::NotFound, format!("no forward {}", id.0))
            })?;
            entry.run = None;
            entry.unbound = None;
            entry.refused = false;
            let space = entry.base.target.space.clone();
            table.changed(id);
            space
        };
        self.save_forwards(&space);
        Ok(())
    }

    /// Stops a forward and forgets it; the local port its target's port had
    /// stays.
    pub fn forward_remove(&self, id: ForwardId) -> Result<(), IpcError> {
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

    fn save_forwards(&self, space: &str) {
        let saved = self.forwards.table().saved(space);
        if let Err(error) = self.state.set_forwards(space, &saved) {
            eprintln!("could not keep the forwards of {space}: {error}");
        }
    }

    /// Binds the port of each forward that ran when Twigo quit, and lets it
    /// wait for its first connection or its space's connecting: nothing asks
    /// a cluster. A forward whose port another process holds, or whose
    /// context the catalog lacks, fails with that; one the mode refuses is
    /// failed with the mode's words.
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
        self.lack_contexts().await;
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
            refused: false,
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
                Err(BindError::Busy(why)) => entry.unbound = Some(unbound(local, why)),
                Err(BindError::Failed(error)) => {
                    entry.unbound = Some(IpcError::new(
                        ErrorKind::Internal,
                        format!("could not listen on port {local}: {error}"),
                    ));
                }
            }
        }
        self.forwards.table().entries.insert(id.0, entry);
    }

    /// Fails the forwards whose context the catalog does not list, once it
    /// lists any.
    async fn lack_contexts(&self) {
        let contexts = self.catalog.contexts().await;
        let table = self.forwards.table();
        for entry in table.entries.values() {
            if let Some(run) = &entry.run
                && contexts.find(&entry.context).is_none()
            {
                run.data.refuse(IpcError::from(&ClientsError::NoContext(
                    entry.context.clone(),
                )));
            }
        }
    }

    /// Restores the forwards, then asks the policy for each again whenever
    /// it or the catalog changes; never returns.
    pub(crate) async fn follow_forward_modes(&self) {
        let mut changes = Changes::new(&self.policy, &self.catalog.subscribe());
        self.restore_forwards().await;
        self.forwards.recheck(&self.policy);
        loop {
            changes.next().await;
            self.forwards.recheck(&self.policy);
        }
    }
}

#[cfg(test)]
mod tests;
