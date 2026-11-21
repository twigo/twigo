//! What the app does when Twigo cannot go on, and how a command meets a panic
//! (ARCHITECTURE 2.1).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const TITLE: &str = "Twigo must restart";
const MESSAGE: &str = "Twigo ran into an internal error that it cannot recover from.\n\nWhat happened is in its log. Restart brings back your spaces and your forwards.";
const RESTART: &str = "Restart";
const QUIT: &str = "Quit";

/// The fatal path: a native dialog, since the webview may be what the panic
/// broke, that says Twigo must restart, with Restart and Quit.
#[derive(Clone, Default)]
pub struct Path {
    app: Arc<OnceLock<AppHandle>>,
    shown: Arc<AtomicBool>,
}

impl Path {
    /// Makes the path ready, once the app exists.
    pub fn ready(&self, app: &AppHandle) {
        let _ = self.app.set(app.clone());
    }

    /// Shows the dialog, once however many panics reach it. The log has
    /// the panic's record already.
    pub fn run(&self, why: &str) {
        if self.shown.swap(true, Ordering::AcqRel) {
            return;
        }
        tracing::error!(why, "Twigo cannot go on, so it asks to restart");
        let Some(app) = self.app.get().cloned() else {
            return;
        };
        app.dialog()
            .message(MESSAGE)
            .title(TITLE)
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCancelCustom(
                RESTART.to_owned(),
                QUIT.to_owned(),
            ))
            .show(move |restart| {
                if restart {
                    app.request_restart();
                } else {
                    app.exit(1);
                }
            });
    }
}
