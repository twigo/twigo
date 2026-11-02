//! The commands the webview invokes. Each Tauri command takes its request as
//! the `request` argument, a subscription also its channel as `channel`, and
//! returns `Result<Response, IpcError>`.

use ts_rs::TS;

use crate::{
    Ack, ClusterVersion, Context, ContextAuth, Discovered, ExecReview, GetValues, KeyboardLayout,
    ListBatch, ListQuery, ObjectBatch, OpenObject, SetParts, SetWindow, ShellEnvironment, Space,
    StateEntry, StateSnapshot, SubscriptionId,
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

/// Opens a sign-in link in the person's browser: https, or a plugin's own
/// server on localhost or 127.0.0.1.
pub struct UrlOpen;

impl Command for UrlOpen {
    const NAME: &'static str = "url_open";
    type Request = String;
    type Response = ();
    type Message = ();
}
