//! App services: the catalog, spaces, the state store, each context's
//! clients, and the policy proxy with its approval broker, which the Tauri
//! app turns into commands.

mod actions;
mod approvals;
mod auth;
mod bus;
pub mod catalog;
pub mod connections;
mod errors;
pub mod objects;
mod proxy;
pub mod state;
pub mod subscriptions;
pub mod trust;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use jiff::Timestamp;
use kube::core::GroupVersionKind;
use tokio::sync::watch;
use twigo_cache::batcher::Batcher;
use twigo_cache::discovery::Follower;
use twigo_cache::hub::{Connect, Hub, Query, Resource, RowFormat};
use twigo_cache::view::Spec;
use twigo_env::{ShellEnv, Status};
use twigo_ipc::{
    AccessQuery, Ack, AnswerApproval, ApplyPreviewed, ApplyRequest, ApprovalEvent, ClusterVersion,
    Context, DownloadLogs, ErrorKind, Execute, Friction, GetValues, IpcError, ListBatch, ListQuery,
    LogBatch, ObjectBatch, OpenLogs, OpenObject, OpenShell, OperationEvent, Plan, PlanId,
    PlanRequest, SchemaQuery, SetContextEnvironment, SetContextMode, SetLogSource, SetLogView,
    SetLogWindow, SetParts, SetWindow, ShellAck, ShellContainers, ShellInput, ShellPod,
    ShellResize, SubscriptionId, ViewState,
};
use twigo_kube::client::{Actor, Clients, ProxyEnv};
use twigo_kube::credentials::{ExecError, OidcError, Provider, Registry, Source, Timeouts};
use twigo_kube::discovery::Cache;
use twigo_kube::kubeconfig;
use twigo_kube::openapi::{self, Document};
use twigo_netmon::Event;
use twigo_policy::friction::{covers, friction};
use twigo_policy::{Audit, Entry, Policy};
use twigo_sessions::logs::Session;
pub use twigo_sessions::shell::Frame as ShellFrame;

use actions::undo::Undos;
use approvals::Approvals;
pub use auth::AuthFollower;
use bus::{Bus, Finished, Progress, Waiting};
use catalog::Catalog;
use connections::Connections;
use objects::{Opened, Target};
use proxy::Proxy;
pub use proxy::ProxyProcess;
use state::State;
use subscriptions::Subscriptions;
use trust::Trust;
pub use twigo_policy::PolicyFile;

pub struct Core {
    /// For the runs the bus spawns, which outlive a call.
    this: Weak<Core>,
    pub state: State,
    pub catalog: Catalog,
    pub connections: Connections,
    pub trust: Trust,
    pub hub: Hub,
    pub policy: Arc<Policy>,
    proxy: Arc<Proxy>,
    approvals: Arc<Approvals>,
    /// Held while a change of the person's choices is stored, so an earlier
    /// copy of them never lands after a later one.
    choosing: Mutex<()>,
    lists: Subscriptions<Batcher>,
    objects: Subscriptions<Opened>,
    logs: Subscriptions<Session>,
    shells: Subscriptions<twigo_sessions::shell::Session>,
    bus: Arc<Bus>,
    undos: Arc<Undos>,
    discovery: Arc<Cache>,
    openapi: openapi::Cache,
    credentials: Registry,
    /// Whether a Twigo window has the focus, which a plugin that may ask
    /// the person to sign in waits for.
    focused: watch::Sender<bool>,
    /// Both None until the login shell's environment is known.
    proxy_env: watch::Sender<Option<ProxyEnv>>,
    shell_env: watch::Sender<Option<Arc<ShellEnv>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientsError {
    #[error("no source lists the context {0:?}")]
    NoContext(String),
    #[error("the context {0:?}: {1}")]
    Invalid(String, #[source] ExecError),
    #[error("the context {0:?}: {1}")]
    Oidc(String, #[source] OidcError),
    #[error("Twigo runs {1} for the context {0:?} only once you trust it")]
    Untrusted(String, String),
    #[error("the context {0:?} has no credential plugin")]
    NoPlugin(String),
    #[error("the context {0:?}: {1}")]
    Connect(String, #[source] Box<connections::Error>),
}

impl Core {
    /// The core whose state, trusted plugins, audit log and processes'
    /// kubeconfigs live in `data`, the app's data directory, its clusters'
    /// discovery in `cache`, its cache directory, and whose admin's policy is
    /// the file at `policy_file`.
    pub fn new(data: &Path, cache: &Path, policy_file: &Path) -> Arc<Self> {
        let shell_env = watch::Sender::new(None);
        let focused = watch::Sender::new(false);
        let state = State::open(data.join("state.json"));
        let catalog = Catalog::default();
        let policy = Policy::new(
            PolicyFile::read(policy_file),
            catalog.metadata(),
            state.choices(),
            Audit::open(&data.join("audit.jsonl")),
        );
        let approvals = Arc::new(Approvals::new(Arc::clone(&policy), catalog.subscribe()));
        Arc::new_cyclic(|core| Self {
            this: core.clone(),
            hub: Hub::new(connect(core.clone())),
            policy,
            proxy: Arc::new(Proxy::new(data.join("proxy"))),
            approvals,
            choosing: Mutex::default(),
            lists: Subscriptions::new("list"),
            objects: Subscriptions::new("object"),
            logs: Subscriptions::new("logs"),
            shells: Subscriptions::new("shell"),
            bus: Arc::default(),
            undos: Arc::default(),
            discovery: Arc::new(Cache::new(cache.join("discovery"))),
            openapi: openapi::Cache::new(cache.join("openapi")),
            state,
            catalog,
            connections: Connections::default(),
            trust: Trust::open(data.join("trust.json")),
            credentials: Registry::new(
                shell_env.subscribe(),
                focused.subscribe(),
                Timeouts::default(),
            ),
            focused,
            proxy_env: watch::Sender::new(None),
            shell_env,
        })
    }

    pub fn set_focused(&self, focused: bool) {
        self.focused.send_replace(focused);
    }

    /// Kills the plugins under way, as the app quits.
    pub fn shutdown(&self) {
        self.credentials.shutdown();
    }

    /// The context's clients, once the catalog and the login shell's
    /// environment are known.
    pub async fn clients(&self, context: &str) -> Result<Arc<Clients>, ClientsError> {
        let contexts = self.catalog.contexts().await;
        let Some(found) = contexts.find(context) else {
            return Err(ClientsError::NoContext(context.to_owned()));
        };
        let provider = self.provider(found)?;
        let env = self
            .proxy_env
            .subscribe()
            .wait_for(Option::is_some)
            .await
            .expect("the core outlives its subscribers")
            .clone()
            .expect("waited for");
        self.connections
            .clients(
                found,
                &env,
                provider,
                // Of what the clients are built from, not of the catalog as
                // it may be by now.
                self.policy
                    .gate_for(context, Actor::Ui, found.fingerprint.value()),
            )
            .await
            .map_err(|error| ClientsError::Connect(context.to_owned(), Box::new(error)))
    }

    /// Where the context's credential comes from when Twigo gets it: its
    /// exec plugin, once the person trusts it, or its oidc provider.
    fn provider(&self, context: &kubeconfig::Context) -> Result<Option<Provider>, ClientsError> {
        if let Some(oidc) = context.entries.oidc() {
            let oidc = oidc.map_err(|error| ClientsError::Oidc(context.name.clone(), error))?;
            return Ok(Some(Provider::Oidc(self.credentials.oidc(
                oidc.origin,
                &oidc.user,
                oidc.entry,
            ))));
        }
        Ok(self.plugin(context)?.map(Provider::Exec))
    }

    /// The context's exec plugin, once the person trusts it.
    fn plugin(&self, context: &kubeconfig::Context) -> Result<Option<Arc<Source>>, ClientsError> {
        let exec = context
            .entries
            .exec()
            .map_err(|error| ClientsError::Invalid(context.name.clone(), error))?;
        let Some(exec) = exec else {
            return Ok(None);
        };
        if !self.trust.current().trusts(&exec.trust_digest()) {
            return Err(ClientsError::Untrusted(
                context.name.clone(),
                exec.command().to_owned(),
            ));
        }
        Ok(Some(self.credentials.source(exec)))
    }

    async fn trusted_plugin(&self, context: &str) -> Result<Arc<Source>, ClientsError> {
        let contexts = self.catalog.contexts().await;
        let found = contexts
            .find(context)
            .ok_or_else(|| ClientsError::NoContext(context.to_owned()))?;
        self.plugin(found)?
            .ok_or_else(|| ClientsError::NoPlugin(context.to_owned()))
    }

    /// Runs the context's plugin now: how the person signs in.
    pub async fn sign_in(&self, context: &str) -> Result<(), IpcError> {
        let plugin = self
            .trusted_plugin(context)
            .await
            .map_err(|e| IpcError::from(&e))?;
        plugin.sign_in();
        Ok(())
    }

    /// Ends the run of the context's plugin.
    pub async fn cancel_sign_in(&self, context: &str) -> Result<(), IpcError> {
        let plugin = self
            .trusted_plugin(context)
            .await
            .map_err(|e| IpcError::from(&e))?;
        plugin.cancel();
        Ok(())
    }

    /// The contexts the catalog lists, with what each lets through now.
    pub fn contexts(&self) -> Option<Vec<Context>> {
        // Out of the borrow: the policy reads the same channel for each
        // context, and a second borrow behind a waiting writer may deadlock
        // (tokio's `watch::Ref`).
        let listed = self.catalog.subscribe().borrow().clone();
        listed.map(|listed| listed.ipc(&self.policy))
    }

    /// The person's mode for a context, kept in the state.
    pub async fn set_context_mode(&self, request: SetContextMode) -> Result<(), IpcError> {
        self.listed(&request.context).await?;
        let _choosing = self.choosing.lock().expect("choosing lock");
        let choices = self
            .policy
            .set_mode(&request.context, request.mode)
            .map_err(|error| errors::refused(&error))?;
        self.state.set_choices(&choices);
        Ok(())
    }

    /// What the person marks a context as, kept in the state.
    pub async fn set_context_environment(
        &self,
        request: SetContextEnvironment,
    ) -> Result<(), IpcError> {
        self.listed(&request.context).await?;
        let _choosing = self.choosing.lock().expect("choosing lock");
        let choices = self
            .policy
            .set_environment(&request.context, request.environment);
        self.state.set_choices(&choices);
        Ok(())
    }

    pub async fn unlock_context(&self, context: &str) -> Result<(), IpcError> {
        self.listed(context).await?;
        self.policy
            .unlock(context)
            .map_err(|error| errors::refused(&error))
    }

    async fn listed(&self, context: &str) -> Result<(), IpcError> {
        match self.catalog.contexts().await.find(context) {
            Some(_) => Ok(()),
            None => Err(IpcError::from(&ClientsError::NoContext(context.to_owned()))),
        }
    }

    /// What a command will do and the friction it asks for (ARCHITECTURE
    /// 5.1, 6.4), refused by the policy before anything is asked.
    pub async fn command_plan(&self, window: &str, request: PlanRequest) -> Result<Plan, IpcError> {
        let ticket = self.bus.ticket(window);
        let planned = match request {
            PlanRequest::Delete { space, targets } => {
                actions::delete(self, &space, targets).await?
            }
            PlanRequest::Scale {
                space,
                target,
                replicas,
            } => actions::scale(self, &space, target, replicas).await?,
            PlanRequest::Restart { space, target } => {
                actions::restart(self, &space, target).await?
            }
            PlanRequest::Cordon {
                space,
                node,
                unschedulable,
            } => actions::cordon(self, &space, node, unschedulable).await?,
            PlanRequest::Drain { space, node } => actions::drain(self, &space, node).await?,
            PlanRequest::Trigger {
                space,
                namespace,
                name,
            } => actions::trigger(self, &space, namespace, name).await?,
            PlanRequest::Suspend {
                space,
                target,
                suspend,
            } => actions::suspend(self, &space, target, suspend).await?,
            PlanRequest::Undo { space } => actions::undo(self, &space).await?,
            PlanRequest::Reveal { object, key } => actions::reveal(self, window, object, key)?,
            PlanRequest::Apply { space, preview } => {
                actions::apply(self, window, space, preview).await?
            }
            PlanRequest::Shell { target, kind } => {
                actions::shell(self, window, target, kind).await?
            }
        };
        self.authorize(&planned.context, &planned.writes)?;
        let access = self.policy.access(&planned.context);
        self.bus.keep(ticket, planned, &access)
    }

    /// Runs a plan once its friction is met, whose events go through `send`.
    /// Async, as the run it spawns needs the runtime: Tauri runs a plain
    /// command on the main thread, outside it.
    pub async fn command_execute(
        &self,
        window: &str,
        request: Execute,
        send: impl FnMut(OperationEvent) -> bool + Send + 'static,
    ) -> Result<(), IpcError> {
        let (waiting, ticket) = self.bus.take(window, request.plan)?;
        let Waiting {
            planned,
            friction: planned_friction,
            since,
        } = *waiting;
        let context = planned.context.clone();
        if self.policy.connection(&context) != planned.connection {
            return Err(IpcError::new(
                ErrorKind::Conflict,
                format!(
                    "{context} names another cluster now than when Twigo asked, so it sent nothing"
                ),
            ));
        }
        let access = self.policy.access(&context);
        if !covers(
            &planned_friction,
            &friction(&planned.risk, &context, &access),
        ) {
            return Err(IpcError::new(
                ErrorKind::Conflict,
                format!(
                    "{context} is {} now, which asks for more than you confirmed, so Twigo sent nothing",
                    access.mode.name()
                ),
            ));
        }
        match &planned_friction {
            Friction::Countdown { seconds }
                if since.elapsed() < Duration::from_secs((*seconds).into()) =>
            {
                return Err(IpcError::new(
                    ErrorKind::InvalidInput,
                    "the countdown has not ended",
                ));
            }
            Friction::Typed { text } if request.typed.as_deref() != Some(text.as_str()) => {
                return Err(IpcError::new(
                    ErrorKind::InvalidInput,
                    format!("type {text} to confirm"),
                ));
            }
            _ => {}
        }
        self.authorize(&context, &planned.writes)?;

        let (progress, stop) = Progress::new(send);
        self.bus.run(ticket, request.plan, stop)?;
        let audit = |entry: &Entry<'_>| self.policy.audit().record(entry);
        audit(&Entry::Confirmed {
            context: &context,
            command: planned.command,
            target: &planned.target,
            mode: access.mode,
            friction: &planned_friction,
        });
        let (bus, undos, policy, window) = (
            Arc::clone(&self.bus),
            Arc::clone(&self.undos),
            Arc::clone(&self.policy),
            window.to_owned(),
        );
        let (command, target, space, connection, run) = (
            planned.command,
            planned.target,
            planned.space,
            planned.connection,
            planned.run,
        );
        let ticket = space.as_deref().map(|space| undos.started(space));
        tokio::spawn(async move {
            let ended = run(progress.clone()).await;
            let undo_until = space.zip(ticket).and_then(|(space, ticket)| {
                let revert = ended.as_ref().ok().and_then(Finished::revert);
                undos.ended(&space, ticket, revert.map(|revert| (revert, connection)))
            });
            let (event, outcome, message) = match ended {
                Ok(finished) => finished.told(undo_until),
                Err(error) => {
                    let message = error.message.clone();
                    (OperationEvent::Failed { error }, "failed", message)
                }
            };
            policy.audit().record(&Entry::Ended {
                context: &context,
                command,
                target: &target,
                outcome,
                message: &message,
            });
            progress.tell(event);
            bus.ended(&window, request.plan);
        });
        Ok(())
    }

    /// Builds an edit's apply configuration and dry-runs it (ARCHITECTURE
    /// 6.5), keeping what it prepared for this window; it writes nothing.
    pub async fn apply_preview(
        &self,
        window: &str,
        request: ApplyRequest,
    ) -> Result<ApplyPreviewed, IpcError> {
        actions::preview(self, window, request).await
    }

    /// Whether the person may do each check in a space's context, a check
    /// the cluster cannot answer counting as allowed (ARCHITECTURE 5.1).
    pub async fn access_review(&self, query: AccessQuery) -> Result<Vec<bool>, IpcError> {
        let context = self.context(&query.space)?;
        let namespace = query.namespace.as_deref();
        let answers = query
            .checks
            .iter()
            .map(|access| self.hub.may(&context, namespace, access));
        Ok(futures::future::join_all(answers)
            .await
            .into_iter()
            .map(|may| may.unwrap_or(true))
            .collect())
    }

    /// Drops a plan that has not run, or stops one that runs.
    pub fn command_cancel(&self, window: &str, id: PlanId) {
        self.bus.cancel(window, id);
    }

    /// Whether the UI may send `writes` on `context` now.
    pub(crate) fn authorize(
        &self,
        context: &str,
        writes: &[twigo_policy::Attributes],
    ) -> Result<(), IpcError> {
        for write in writes {
            self.policy
                .authorize(context, write, twigo_kube::client::Actor::Ui)
                .map_err(|blocked| IpcError::from(*blocked))?;
        }
        Ok(())
    }

    pub async fn cluster_version(&self, context: &str) -> Result<ClusterVersion, IpcError> {
        let clients = self
            .clients(context)
            .await
            .map_err(|e| IpcError::from(&e))?;
        let info = clients
            .api
            .apiserver_version()
            .await
            .map_err(|e| twigo_kube::errors::request(&e))?;
        Ok(ClusterVersion {
            git_version: info.git_version,
        })
    }

    /// The JSON Schema of a kind in a space's cluster, from the OpenAPI
    /// document of its group/version (ARCHITECTURE 3.6), which is dropped
    /// once the schema is made.
    pub async fn schema(&self, query: SchemaQuery) -> Result<String, IpcError> {
        let context = self.context(&query.space)?;
        let clients = self
            .clients(&context)
            .await
            .map_err(|e| IpcError::from(&e))?;
        let document = Document::load(&clients.api, &self.openapi, &query.group, &query.version)
            .await
            .map_err(|e| IpcError::from(&e))?;
        let gvk = GroupVersionKind::gvk(&query.group, &query.version, &query.kind);
        let schema = tokio::task::spawn_blocking(move || document.json_schema(&gvk))
            .await
            .expect("converting a schema does not panic");
        schema.ok_or_else(|| {
            IpcError::new(
                ErrorKind::NotFound,
                format!(
                    "the cluster's OpenAPI for {}/{} has no kind {}",
                    query.group, query.version, query.kind
                ),
            )
        })
    }

    /// The context of a space: M1 serves one-context spaces (ARCHITECTURE 4.2).
    fn context(&self, space: &str) -> Result<String, IpcError> {
        self.state
            .spaces()
            .into_iter()
            .find(|candidate| candidate.id == space)
            .and_then(|space| space.contexts.into_iter().next())
            .ok_or_else(|| IpcError::new(ErrorKind::NotFound, format!("no space {space:?}")))
    }

    /// The resources a space's context serves, followed as they change.
    pub async fn follow_resources(&self, space: &str) -> Result<Follower, IpcError> {
        let context = self.context(space)?;
        let entry = self.catalog.fingerprint(&context).await;
        Ok(Follower::new(
            self.hub.clone(),
            Arc::clone(&self.discovery),
            context,
            entry,
        )
        .await)
    }

    /// The namespaces of a space's context, from its namespace index
    /// (ARCHITECTURE 3.3), which lingers a while after each answer.
    pub async fn namespaces(&self, space: &str) -> Result<Vec<String>, IpcError> {
        let context = self.context(space)?;
        let mut index = self
            .hub
            .rows(Query {
                context,
                resource: Resource {
                    group: String::new(),
                    version: "v1".to_owned(),
                    resource: "namespaces".to_owned(),
                    namespaced: false,
                },
                format: RowFormat::Metadata,
                namespaces: Vec::new(),
                field_selector: None,
            })
            .await?;
        match index.whole().await {
            Ok(rows) => {
                let mut names: Vec<String> =
                    rows.iter().map(|row| row.meta.name.to_string()).collect();
                names.sort();
                Ok(names)
            }
            Err(ViewState::Forbidden { verb, resource }) => Err(IpcError::new(
                ErrorKind::Forbidden,
                format!("you may not {verb} {resource}"),
            )),
            Err(ViewState::Unauthorized) => Err(IpcError::new(
                ErrorKind::Unauthorized,
                "no credentials for this context that the cluster accepts".to_owned(),
            )),
            Err(ViewState::Error { error }) => Err(error),
            Err(_) => Err(IpcError::new(
                ErrorKind::Unavailable,
                "the cluster is unavailable".to_owned(),
            )),
        }
    }

    /// A list of a space's resource for a window, filtered, sorted and
    /// windowed in Rust (ARCHITECTURE 3.4), whose batches go through `send`
    /// until it says the window is gone.
    pub async fn list_subscribe(
        &self,
        window: &str,
        query: ListQuery,
        send: impl FnMut(ListBatch) -> bool + Send + 'static,
    ) -> Result<SubscriptionId, IpcError> {
        let ticket = self.lists.ticket(window);
        let context = self.context(&query.space)?;
        let spec = Spec::new(&context, &query)?;
        let rows = self
            .hub
            .rows(Query {
                context,
                resource: Resource {
                    group: query.gvr.group,
                    version: query.gvr.version,
                    resource: query.gvr.resource,
                    namespaced: query.namespaced,
                },
                format: RowFormat::Table,
                namespaces: query.namespaces,
                field_selector: query.field_selector,
            })
            .await?;
        self.lists.keep(ticket, Batcher::spawn(rows, spec, send))
    }

    pub fn list_set_window(&self, window: &str, request: SetWindow) -> Result<(), IpcError> {
        self.lists.with(window, request.id, |list| {
            list.set_window(request.start, request.end);
        })
    }

    pub fn list_ack(&self, window: &str, request: Ack) -> Result<(), IpcError> {
        self.lists
            .with(window, request.id, |list| list.ack(request.seq))
    }

    pub fn list_unsubscribe(&self, window: &str, id: SubscriptionId) -> Result<(), IpcError> {
        self.lists.remove(window, id)
    }

    /// An object of a space for a window: its Object upstream, and its
    /// events and owned objects while the parts that show them do, whose
    /// batches go through `send` until it says the window is gone.
    pub async fn object_open(
        &self,
        window: &str,
        request: OpenObject,
        send: impl FnMut(ObjectBatch) -> bool + Send + 'static,
    ) -> Result<SubscriptionId, IpcError> {
        let ticket = self.objects.ticket(window);
        let query = request.object;
        let context = self.context(&query.space)?;
        let resource = Resource {
            group: query.gvr.group,
            version: query.gvr.version,
            resource: query.gvr.resource,
            namespaced: query.namespaced,
        };
        if query.namespaced && query.namespace.is_none() {
            return Err(IpcError::new(
                ErrorKind::InvalidInput,
                format!("{} names no namespace", query.name),
            ));
        }
        let namespace = query.namespace.filter(|_| query.namespaced);
        let object = self
            .hub
            .object(&context, resource, namespace.clone(), &query.name)?;
        let target = Target { context, namespace };
        self.objects.keep(
            ticket,
            Opened::spawn(self.hub.clone(), target, object, request.parts, send),
        )
    }

    pub fn object_set_parts(&self, window: &str, request: SetParts) -> Result<(), IpcError> {
        self.objects
            .with(window, request.id, |object| object.set_parts(request.parts))
    }

    pub fn object_ack(&self, window: &str, request: Ack) -> Result<(), IpcError> {
        self.objects
            .with(window, request.id, |object| object.ack(request.seq))
    }

    pub fn object_values(
        &self,
        window: &str,
        request: GetValues,
    ) -> Result<Vec<Option<String>>, IpcError> {
        self.objects
            .with(window, request.id, |object| object.values(&request.keys))?
    }

    pub fn object_close(&self, window: &str, id: SubscriptionId) -> Result<(), IpcError> {
        self.objects.remove(window, id)
    }

    /// A logs tab's session for a window (ARCHITECTURE 4.6): a pod, or a
    /// workload's pods, followed through the hub, whose batches go through
    /// `send` until it says the window is gone.
    pub async fn logs_open(
        &self,
        window: &str,
        request: OpenLogs,
        send: impl FnMut(LogBatch) -> bool + Send + 'static,
    ) -> Result<SubscriptionId, IpcError> {
        let ticket = self.logs.ticket(window);
        let context = self.context(&request.target.space)?;
        let session = Session::open(self.hub.clone(), context, request, send).await?;
        self.logs.keep(ticket, session)
    }

    pub fn logs_set_source(&self, window: &str, request: SetLogSource) -> Result<(), IpcError> {
        self.logs.with(window, request.id, |session| {
            session.set_source(request.source)
        })
    }

    /// Refuses a view whose filter, search or range does not parse.
    pub fn logs_set_view(&self, window: &str, request: SetLogView) -> Result<(), IpcError> {
        self.logs.with(window, request.id, |session| {
            session.set_view(&request.view)
        })?
    }

    pub fn logs_set_window(&self, window: &str, request: SetLogWindow) -> Result<(), IpcError> {
        self.logs.with(window, request.id, |session| {
            session.set_window(request.window)
        })
    }

    pub fn logs_ack(&self, window: &str, request: Ack) -> Result<(), IpcError> {
        self.logs
            .with(window, request.id, |session| session.ack(request.seq))
    }

    pub fn logs_close(&self, window: &str, id: SubscriptionId) -> Result<(), IpcError> {
        self.logs.remove(window, id)
    }

    /// The file name a session's lines are offered under: its target's.
    pub fn logs_file_name(&self, window: &str, id: SubscriptionId) -> Result<String, IpcError> {
        self.logs
            .with(window, id, |session| format!("{}.log", session.name()))
    }

    /// Writes a session's lines to `path`, as `<pod> <container> <time>
    /// <text>` each: those its view keeps, or every one it holds.
    pub async fn logs_write(
        &self,
        window: &str,
        request: DownloadLogs,
        path: &Path,
    ) -> Result<(), IpcError> {
        let lines = self.logs.with(window, request.id, |session| {
            session.lines(request.filtered)
        })?;
        let lines = lines
            .await
            .map_err(|_| IpcError::new(ErrorKind::Unavailable, "the logs tab closed"))?;
        tokio::fs::write(path, lines).await.map_err(|error| {
            IpcError::new(
                ErrorKind::Internal,
                format!("could not write {}: {error}", path.display()),
            )
        })
    }

    /// The containers of a pod a shell can reach (ARCHITECTURE 4.6), refused
    /// in words for a pod that runs none.
    pub async fn shell_containers(&self, request: ShellPod) -> Result<ShellContainers, IpcError> {
        actions::containers(self, request).await
    }

    /// Starts a session a plan's run answered with, whose output and events
    /// go through `send` until it ends. Async, as it spawns: Tauri runs a
    /// plain command on the main thread, outside the runtime.
    pub async fn shell_open(
        &self,
        window: &str,
        request: OpenShell,
        send: impl FnMut(ShellFrame) -> bool + Send + 'static,
    ) -> Result<(), IpcError> {
        self.shells.with(window, request.id, |session| {
            session.open(request.cols, request.rows, send)
        })?
    }

    /// Queues what the person typed, waiting while the session's queue is
    /// full.
    pub async fn shell_input(&self, window: &str, request: ShellInput) -> Result<(), IpcError> {
        let queued = self
            .shells
            .with(window, request.id, |session| session.input(request.data))?;
        queued.await;
        Ok(())
    }

    pub fn shell_resize(&self, window: &str, request: ShellResize) -> Result<(), IpcError> {
        self.shells.with(window, request.id, |session| {
            session.resize(request.cols, request.rows);
        })
    }

    pub fn shell_ack(&self, window: &str, request: ShellAck) -> Result<(), IpcError> {
        self.shells
            .with(window, request.id, |session| session.ack(request.bytes))
    }

    pub fn shell_close(&self, window: &str, id: SubscriptionId) -> Result<(), IpcError> {
        self.shells.remove(window, id)
    }

    /// The asks of the processes whose window is `window` (ARCHITECTURE
    /// 6.4): `send` gets each one waiting, then each new one and each one
    /// withdrawn, until it says the window is gone, and in place of what the
    /// window followed before. It must not call back into the core.
    pub fn follow_approvals(
        &self,
        window: &str,
        send: impl FnMut(ApprovalEvent) -> bool + Send + 'static,
    ) {
        self.approvals.follow_window(window, send);
    }

    /// The person's answer to an ask of `window`'s, refused for one that is
    /// gone or another window's, and for a delete's without the context's
    /// name typed.
    pub fn answer_approval(&self, window: &str, answer: AnswerApproval) -> Result<(), IpcError> {
        self.approvals.answer(window, answer)
    }

    /// Ends the lists, open objects, logs sessions, shells, plans and asks of
    /// a window that reloads or closes: its asks are denied.
    pub fn drop_window(&self, window: &str) {
        self.lists.drop_window(window);
        self.objects.drop_window(window);
        self.logs.drop_window(window);
        self.shells.drop_window(window);
        self.bus.drop_window(window);
        self.approvals.drop_window(window);
    }

    /// Retires every connection on wake, and those whose route moved on a
    /// network change, which also tells the sessions of those (ARCHITECTURE
    /// 3.2, 4.6); never returns.
    pub async fn follow_network(&self, mut watch: twigo_netmon::Watch) {
        while let Some(event) = watch.next().await {
            self.network_event(event);
        }
    }

    fn network_event(&self, event: Event) {
        match event {
            Event::Woke => self.connections.wake(),
            Event::NetworkChanged => self.connections.retire_moved(),
        }
    }

    /// Follows the catalog's sources and the login shell's proxy variables,
    /// and tells the state store and the connections which contexts the
    /// sources list; never returns. In the explicit mode (ARCHITECTURE 5.5)
    /// `explicit` is the only source; otherwise the sources come from the
    /// login shell's environment, as `status` follows it, read again
    /// whenever it is resolved.
    pub async fn run(&self, mut status: watch::Receiver<Status>, explicit: Option<PathBuf>) {
        let sources = async {
            if let Some(file) = &explicit {
                self.catalog
                    .follow(catalog::sources(Some(file.clone()), None, None));
            }
            loop {
                let env = match &*status.borrow_and_update() {
                    Status::Resolving => None,
                    Status::Resolved(env) | Status::Failed { env, .. } => Some(env.clone()),
                };
                if let Some(env) = env {
                    let var = |name: &str| env.get(name)?.to_str().map(str::to_owned);
                    let proxy = ProxyEnv::from_vars(var);
                    // Published first, so a watch the retire re-opens builds
                    // with the new variables.
                    self.proxy_env.send_replace(Some(proxy.clone()));
                    self.connections.follow_env(&proxy);
                    self.shell_env.send_replace(Some(Arc::clone(&env)));
                    if explicit.is_none() {
                        let home = env.get("HOME").map(Path::new);
                        self.catalog
                            .follow(catalog::sources(None, env.get("KUBECONFIG"), home));
                    }
                }
                if status.changed().await.is_err() {
                    return;
                }
            }
        };
        let seen = async {
            let mut contexts = self.catalog.subscribe();
            loop {
                let listed = contexts.borrow_and_update().clone();
                if let Some(listed) = listed {
                    let names: HashSet<String> = listed.iter().map(|c| c.name.clone()).collect();
                    self.state.saw(&names, Timestamp::now());
                    self.connections.keep(listed.iter());
                }
                if contexts.changed().await.is_err() {
                    return;
                }
            }
        };
        tokio::join!(sources, seen, self.policy.follow_unlocks());
    }
}

/// How the hub gets a context's clients: through the core, while it lives.
fn connect(core: Weak<Core>) -> Connect {
    Arc::new(move |context| {
        let core = core.clone();
        Box::pin(async move {
            let Some(core) = core.upgrade() else {
                return Err(IpcError::new(
                    ErrorKind::Unavailable,
                    "Twigo is quitting".to_owned(),
                ));
            };
            core.clients(&context)
                .await
                .map_err(|error| IpcError::from(&error))
        })
    })
}

/// A link the sign-in panel may open: https, or a plugin's own server on
/// localhost or 127.0.0.1, without a user part, which would name another
/// host.
pub fn sign_in_url(url: &str) -> Result<String, IpcError> {
    let refused = || {
        IpcError::new(
            twigo_ipc::ErrorKind::InvalidInput,
            format!("Twigo opens only sign-in links: {url}"),
        )
    };
    let parsed: http::Uri = url.parse().map_err(|_| refused())?;
    let authority = parsed.authority().ok_or_else(refused)?;
    if authority.as_str().contains('@') {
        return Err(refused());
    }
    let local = matches!(authority.host(), "localhost" | "127.0.0.1");
    match parsed.scheme_str() {
        Some("https") => Ok(url.to_owned()),
        Some("http") if local => Ok(url.to_owned()),
        _ => Err(refused()),
    }
}

#[cfg(test)]
mod tests;
