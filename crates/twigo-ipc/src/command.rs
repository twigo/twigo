//! The commands the webview invokes. Each Tauri command takes its request as
//! the `request` argument, a subscription also its channel as `channel`, and
//! returns `Result<Response, IpcError>`.

use ts_rs::TS;

use crate::{
    AccessQuery, Ack, AnswerApproval, AnswerKubeconfigOffer, ApplyPreviewed, ApplyRequest,
    ApprovalEvent, ClusterVersion, Context, ContextAuth, Discovered, DownloadLogs, ExecReview,
    Execute, GetValues, KeyboardLayout, KubeconfigOffer, KubeconfigOfferEvent, ListBatch,
    ListQuery, LogBatch, NewTerminal, ObjectBatch, OpenLogs, OpenObject, OpenShell, OperationEvent,
    Plan, PlanId, PlanRequest, SchemaQuery, SetContextEnvironment, SetContextMode, SetLogSource,
    SetLogView, SetLogWindow, SetParts, SetWindow, ShellAck, ShellContainers, ShellEnvironment,
    ShellInput, ShellMessage, ShellPod, ShellResize, Space, StateEntry, StateSnapshot,
    SubscriptionId, TerminalSession,
};

pub trait Command {
    const NAME: &'static str;
    type Request: TS + 'static;
    type Response: TS + 'static;
    /// What the command's channel carries; `()` when it has none.
    type Message: TS + 'static;
}

pub struct SpacesList;

impl Command for SpacesList {
    const NAME: &'static str = "spaces_list";
    type Request = ();
    type Response = Vec<Space>;
    type Message = ();
}

/// Answers with every context the catalog lists, with or without a space,
/// once its sources have been read, then sends the list again on every
/// change.
pub struct ContextsWatch;

impl Command for ContextsWatch {
    const NAME: &'static str = "contexts_watch";
    type Request = ();
    type Response = Vec<Context>;
    type Message = Vec<Context>;
}

/// The person's mode for a context (ARCHITECTURE 6.4), refused when the
/// policy file sets it. The contexts' watch says what follows.
pub struct ContextModeSet;

impl Command for ContextModeSet {
    const NAME: &'static str = "context_mode_set";
    type Request = SetContextMode;
    type Response = ();
    type Message = ();
}

/// What the person marks a context as.
pub struct ContextEnvironmentSet;

impl Command for ContextEnvironmentSet {
    const NAME: &'static str = "context_environment_set";
    type Request = SetContextEnvironment;
    type Response = ();
    type Message = ();
}

/// Lets a `read-only` context through as `guarded` for 15 minutes, by its
/// name, refused when the policy file sets it.
pub struct ContextUnlock;

impl Command for ContextUnlock {
    const NAME: &'static str = "context_unlock";
    type Request = String;
    type Response = ();
    type Message = ();
}

/// Ends a context's unlock now, by its name.
pub struct ContextRelock;

impl Command for ContextRelock {
    const NAME: &'static str = "context_relock";
    type Request = String;
    type Response = ();
    type Message = ();
}

/// Plans a command that changes a cluster or shows secret-grade data
/// (ARCHITECTURE 5.1, 6.4): what it will do and the friction it asks for,
/// or the gate's refusal before anything is asked.
pub struct CommandPlan;

impl Command for CommandPlan {
    const NAME: &'static str = "command_plan";
    type Request = PlanRequest;
    type Response = Plan;
    type Message = ();
}

/// Runs a plan once its friction is met, refused when it is not, when the
/// plan ran or was dropped, when its context names another cluster now, or
/// when the mode asks for more than the plan did. Answers once it starts,
/// and its channel tells how it goes.
pub struct CommandExecute;

impl Command for CommandExecute {
    const NAME: &'static str = "command_execute";
    type Request = Execute;
    type Response = ();
    type Message = OperationEvent;
}

/// Drops a plan that has not run, or stops one that runs at its next point
/// where stopping leaves what it sent standing, as a wait; nothing for a
/// plan already ended.
pub struct CommandCancel;

impl Command for CommandCancel {
    const NAME: &'static str = "command_cancel";
    type Request = PlanId;
    type Response = ();
    type Message = ();
}

/// Whether the person may do each check, by SelfSubjectAccessReviews kept
/// with the context's clients, a no for 30 s (ARCHITECTURE 5.1): the
/// `capability.*` context keys. A check of one object asks for its whole
/// resource first, and by name only when that says no. A check the cluster
/// cannot answer counts as allowed, so the server decides.
pub struct AccessReview;

impl Command for AccessReview {
    const NAME: &'static str = "access_review";
    type Request = AccessQuery;
    type Response = Vec<bool>;
    type Message = ();
}

/// Builds the apply configuration of an edit and dry-runs it (ARCHITECTURE
/// 6.5): it writes nothing, and a plan asked for by the answer's id sends
/// what it prepared.
pub struct ApplyPreview;

impl Command for ApplyPreview {
    const NAME: &'static str = "apply_preview";
    type Request = ApplyRequest;
    type Response = ApplyPreviewed;
    type Message = ();
}

/// The one-context space of a context, created if it has none (ARCHITECTURE 4.2).
pub struct SpaceOpen;

impl Command for SpaceOpen {
    const NAME: &'static str = "space_open";
    /// The context's name.
    type Request = String;
    type Response = Space;
    type Message = ();
}

/// Follows the resources a space's context serves, by the space's id
/// (ARCHITECTURE 3.6): answers at once, then sends them once discovery
/// answers and again on every change. Discovery may wait on the network or
/// a sign-in, which would hold up the watch of the next space.
pub struct ResourcesWatch;

impl Command for ResourcesWatch {
    const NAME: &'static str = "resources_watch";
    type Request = String;
    type Response = ();
    type Message = Discovered;
}

/// A context's Kubernetes version, by the context's name.
pub struct ClusterVersionGet;

impl Command for ClusterVersionGet {
    const NAME: &'static str = "cluster_version";
    type Request = String;
    type Response = ClusterVersion;
    type Message = ();
}

/// The namespaces of a space, by its id, from the namespace index (D7).
pub struct NamespacesList;

impl Command for NamespacesList {
    const NAME: &'static str = "namespaces_list";
    type Request = String;
    type Response = Vec<String>;
    type Message = ();
}

pub struct ListSubscribe;

impl Command for ListSubscribe {
    const NAME: &'static str = "list_subscribe";
    type Request = ListQuery;
    type Response = SubscriptionId;
    type Message = ListBatch;
}

pub struct ListSetWindow;

impl Command for ListSetWindow {
    const NAME: &'static str = "list_set_window";
    type Request = SetWindow;
    type Response = ();
    type Message = ();
}

pub struct ListAck;

impl Command for ListAck {
    const NAME: &'static str = "list_ack";
    type Request = Ack;
    type Response = ();
    type Message = ();
}

pub struct ListUnsubscribe;

impl Command for ListUnsubscribe {
    const NAME: &'static str = "list_unsubscribe";
    type Request = SubscriptionId;
    type Response = ();
    type Message = ();
}

/// Opens an object for the drawer or a resource editor, whose batches come
/// over the channel until it closes.
pub struct ObjectOpen;

impl Command for ObjectOpen {
    const NAME: &'static str = "object_open";
    type Request = OpenObject;
    type Response = SubscriptionId;
    type Message = ObjectBatch;
}

/// Says what the views of an open object show, which Rust follows.
pub struct ObjectSetParts;

impl Command for ObjectSetParts {
    const NAME: &'static str = "object_set_parts";
    type Request = SetParts;
    type Response = ();
    type Message = ();
}

pub struct ObjectAck;

impl Command for ObjectAck {
    const NAME: &'static str = "object_ack";
    type Request = Ack;
    type Response = ();
    type Message = ();
}

/// The values of an open ConfigMap's keys, None for a key it lacks or holds
/// as binary data.
pub struct ObjectValues;

impl Command for ObjectValues {
    const NAME: &'static str = "object_values";
    type Request = GetValues;
    type Response = Vec<Option<String>>;
    type Message = ();
}

pub struct ObjectClose;

impl Command for ObjectClose {
    const NAME: &'static str = "object_close";
    type Request = SubscriptionId;
    type Response = ();
    type Message = ();
}

/// The JSON Schema (draft-07) of a kind, as the JSON text that monaco-yaml
/// takes, from the OpenAPI document of its group/version in the space's
/// cluster (ARCHITECTURE 3.6): fetched when first asked for and kept on disk,
/// never in memory.
pub struct SchemaGet;

impl Command for SchemaGet {
    const NAME: &'static str = "schema_get";
    type Request = SchemaQuery;
    type Response = String;
    type Message = ();
}

/// Opens a logs tab's session (ARCHITECTURE 4.6), whose batches come over
/// the channel until it closes.
pub struct LogsOpen;

impl Command for LogsOpen {
    const NAME: &'static str = "logs_open";
    type Request = OpenLogs;
    type Response = SubscriptionId;
    type Message = LogBatch;
}

pub struct LogsSetSource;

impl Command for LogsSetSource {
    const NAME: &'static str = "logs_set_source";
    type Request = SetLogSource;
    type Response = ();
    type Message = ();
}

pub struct LogsSetView;

impl Command for LogsSetView {
    const NAME: &'static str = "logs_set_view";
    type Request = SetLogView;
    type Response = ();
    type Message = ();
}

pub struct LogsSetWindow;

impl Command for LogsSetWindow {
    const NAME: &'static str = "logs_set_window";
    type Request = SetLogWindow;
    type Response = ();
    type Message = ();
}

pub struct LogsAck;

impl Command for LogsAck {
    const NAME: &'static str = "logs_ack";
    type Request = Ack;
    type Response = ();
    type Message = ();
}

/// Saves a session's lines to a file the person picks in a save dialog;
/// answers with its path, or null when they cancel.
pub struct LogsDownload;

impl Command for LogsDownload {
    const NAME: &'static str = "logs_download";
    type Request = DownloadLogs;
    type Response = Option<String>;
    type Message = ();
}

pub struct LogsClose;

impl Command for LogsClose {
    const NAME: &'static str = "logs_close";
    type Request = SubscriptionId;
    type Response = ();
    type Message = ();
}

/// Answers with the active keyboard layout, then sends it again on every change.
pub struct KeyboardLayoutWatch;

impl Command for KeyboardLayoutWatch {
    const NAME: &'static str = "keyboard_layout_watch";
    type Request = ();
    type Response = KeyboardLayout;
    type Message = KeyboardLayout;
}

/// Every stored value.
pub struct StateLoad;

impl Command for StateLoad {
    const NAME: &'static str = "state_load";
    type Request = ();
    type Response = StateSnapshot;
    type Message = ();
}

/// Stores the entries, all or none.
pub struct StateSet;

impl Command for StateSet {
    const NAME: &'static str = "state_set";
    type Request = Vec<StateEntry>;
    type Response = ();
    type Message = ();
}

/// Answers with where the login shell's environment stands, then sends it
/// again on every change.
pub struct ShellEnvironmentWatch;

impl Command for ShellEnvironmentWatch {
    const NAME: &'static str = "shell_environment_watch";
    type Request = ();
    type Response = ShellEnvironment;
    type Message = ShellEnvironment;
}

/// Resolves the login shell's environment again after a failure.
pub struct ShellEnvironmentRetry;

impl Command for ShellEnvironmentRetry {
    const NAME: &'static str = "shell_environment_retry";
    type Request = ();
    type Response = ();
    type Message = ();
}

/// Answers with how a context gets its credentials, by the context's name,
/// then sends it again on every change.
pub struct ContextAuthWatch;

impl Command for ContextAuthWatch {
    const NAME: &'static str = "context_auth_watch";
    type Request = String;
    type Response = ContextAuth;
    type Message = ContextAuth;
}

/// Runs a context's plugin now, by the context's name: how the person signs
/// in, again after a failure too.
pub struct ContextSignIn;

impl Command for ContextSignIn {
    const NAME: &'static str = "context_sign_in";
    type Request = String;
    type Response = ();
    type Message = ();
}

/// Ends the run of a context's plugin, by the context's name.
pub struct ContextSignInCancel;

impl Command for ContextSignInCancel {
    const NAME: &'static str = "context_sign_in_cancel";
    type Request = String;
    type Response = ();
    type Message = ();
}

/// The plugins the person has not trusted yet.
pub struct ExecReviewGet;

impl Command for ExecReviewGet {
    const NAME: &'static str = "exec_review";
    type Request = ();
    type Response = ExecReview;
    type Message = ();
}

/// Trusts the plugins of these digests (`ExecPlugin::digest`) and marks the
/// review answered, an empty list included.
pub struct ExecTrust;

impl Command for ExecTrust {
    const NAME: &'static str = "exec_trust";
    type Request = Vec<String>;
    type Response = ();
    type Message = ();
}

/// Follows the asks of the processes that belong to this window
/// (ARCHITECTURE 6.4): sends each waiting ask, then every new one and every
/// one withdrawn. A window that follows none denies them all, and a later
/// follower of the same window replaces an earlier one.
pub struct ApprovalsWatch;

impl Command for ApprovalsWatch {
    const NAME: &'static str = "approvals_watch";
    type Request = ();
    type Response = ();
    type Message = ApprovalEvent;
}

/// The person's answer to an ask, refused when the ask is gone or belongs to
/// another window, or when a typed name does not match.
pub struct ApprovalAnswerSend;

impl Command for ApprovalAnswerSend {
    const NAME: &'static str = "approval_answer";
    type Request = AnswerApproval;
    type Response = ();
    type Message = ();
}

/// Opens a sign-in link in the person's browser: https, or a plugin's own
/// server on localhost or 127.0.0.1.
pub struct UrlOpen;

impl Command for UrlOpen {
    const NAME: &'static str = "url_open";
    type Request = String;
    type Response = ();
    type Message = ();
}

/// The containers of a pod a shell can reach; refused, in words, for a pod
/// that runs none.
pub struct ShellContainersGet;

impl Command for ShellContainersGet {
    const NAME: &'static str = "shell_containers";
    type Request = ShellPod;
    type Response = ShellContainers;
    type Message = ();
}

/// Starts a session a plan's run answered with; its output and events come
/// over the channel until it ends.
pub struct ShellOpen;

impl Command for ShellOpen {
    const NAME: &'static str = "shell_open";
    type Request = OpenShell;
    type Response = ();
    type Message = ShellMessage;
}

pub struct ShellSendInput;

impl Command for ShellSendInput {
    const NAME: &'static str = "shell_input";
    type Request = ShellInput;
    type Response = ();
    type Message = ();
}

pub struct ShellSetSize;

impl Command for ShellSetSize {
    const NAME: &'static str = "shell_resize";
    type Request = ShellResize;
    type Response = ();
    type Message = ();
}

pub struct ShellAcknowledge;

impl Command for ShellAcknowledge {
    const NAME: &'static str = "shell_ack";
    type Request = ShellAck;
    type Response = ();
    type Message = ();
}

/// Parks a terminal on this machine pinned to a context (ARCHITECTURE 4.6),
/// which starts once `shell_open` names it and runs over the shell commands.
pub struct TerminalCreate;

impl Command for TerminalCreate {
    const NAME: &'static str = "terminal_create";
    type Request = NewTerminal;
    type Response = TerminalSession;
    type Message = ();
}

/// Follows the offers of this window's terminals to move what a tool wrote
/// into a terminal's own kubeconfig into the user's: answers with those
/// waiting, then sends each new, changed and withdrawn one. A later follower
/// of the same window replaces an earlier one.
pub struct KubeconfigOffersWatch;

impl Command for KubeconfigOffersWatch {
    const NAME: &'static str = "kubeconfig_offers_watch";
    type Request = ();
    type Response = Vec<KubeconfigOffer>;
    type Message = KubeconfigOfferEvent;
}

/// Moves an offer's entries into the user's kubeconfig, or dismisses it;
/// refused for one that is gone or another window's.
pub struct KubeconfigOfferAnswerSend;

impl Command for KubeconfigOfferAnswerSend {
    const NAME: &'static str = "kubeconfig_offer_answer";
    type Request = AnswerKubeconfigOffer;
    type Response = ();
    type Message = ();
}

pub struct ShellClose;

impl Command for ShellClose {
    const NAME: &'static str = "shell_close";
    type Request = SubscriptionId;
    type Response = ();
    type Message = ();
}
