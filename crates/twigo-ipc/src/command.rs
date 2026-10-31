//! The commands the webview invokes. Each Tauri command takes its request as
//! the `request` argument, a subscription also its channel as `channel`, and
//! returns `Result<Response, IpcError>`.

use ts_rs::TS;

use crate::{Ack, KeyboardLayout, ListBatch, ListQuery, SetWindow, Space, SubscriptionId};

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
