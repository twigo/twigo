//! The commands the webview invokes. Each Tauri command takes its request as
//! the `request` argument, a subscription also its channel as `channel`, and
//! returns `Result<Response, IpcError>`.

use ts_rs::TS;

use crate::{
    Ack, Context, KeyboardLayout, ListBatch, ListQuery, Resource, SetWindow, Space, StateEntry,
    SubscriptionId,
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

/// Every context the catalog knows, with or without a space.
pub struct ContextsList;

impl Command for ContextsList {
    const NAME: &'static str = "contexts_list";
    type Request = ();
    type Response = Vec<Context>;
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

/// The resources a space serves, by its id.
pub struct ResourcesList;

impl Command for ResourcesList {
    const NAME: &'static str = "resources_list";
    type Request = String;
    type Response = Vec<Resource>;
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

/// Answers with the active keyboard layout, then sends it again on every change.
pub struct KeyboardLayoutWatch;

impl Command for KeyboardLayoutWatch {
    const NAME: &'static str = "keyboard_layout_watch";
    type Request = ();
    type Response = KeyboardLayout;
    type Message = KeyboardLayout;
}

/// A stored value, by key; none if nothing was stored.
pub struct StateGet;

impl Command for StateGet {
    const NAME: &'static str = "state_get";
    type Request = String;
    type Response = Option<String>;
    type Message = ();
}

pub struct StateSet;

impl Command for StateSet {
    const NAME: &'static str = "state_set";
    type Request = StateEntry;
    type Response = ();
    type Message = ();
}
