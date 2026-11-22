//! What the app does when Twigo cannot go on, and how a command meets a panic
//! (ARCHITECTURE 2.1).

use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use twigo_ipc::IpcError;

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

/// Runs a handler that answers sync commands under `catch_unwind`: one that
/// panics takes the fatal path through `fatal`, where it would otherwise
/// unwind into the webview's URL scheme handler and abort the process
/// (wry 0.57.1, `url_scheme_handler.rs`, `extern "C" fn start_task`). It is
/// the handler Tauri calls, not the command, that is caught, since a sync
/// command is a thin call into the state that the panic may have broken.
pub fn guarded<I>(
    handler: impl Fn(I) -> bool + Send + Sync + 'static,
    fatal: impl Fn() + Send + Sync + 'static,
) -> impl Fn(I) -> bool + Send + Sync + 'static {
    move |invoke| match catch_unwind(AssertUnwindSafe(|| handler(invoke))) {
        Ok(handled) => handled,
        Err(_) => {
            fatal();
            true
        }
    }
}

/// An async command that answers `internal.panic` where it would otherwise
/// leave the webview's promise pending for good, since Tauri answers only
/// once the command's future ends.
pub async fn contained<T>(
    command: impl Future<Output = Result<T, IpcError>>,
) -> Result<T, IpcError> {
    twigo_panic::contain("command", command)
        .await
        .unwrap_or_else(|_| Err(IpcError::panicked("this command")))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use twigo_ipc::ErrorCode;

    use super::*;

    #[tokio::test]
    async fn an_async_command_that_panics_answers_internal_panic() {
        let answered: Result<u8, IpcError> = contained(async { panic!("a command's bug") }).await;
        assert_eq!(answered.unwrap_err().code, ErrorCode::InternalPanic);
        assert_eq!(contained(async { Ok(3) }).await.unwrap(), 3);
        let refused: Result<u8, IpcError> =
            contained(async { Err(IpcError::new(ErrorCode::SpaceNotFound, "no")) }).await;
        assert_eq!(refused.unwrap_err().code, ErrorCode::SpaceNotFound);
    }

    #[test]
    fn a_sync_command_that_panics_takes_the_fatal_path() {
        let fatal = Arc::new(AtomicUsize::new(0));
        let handler = guarded(
            |panics: bool| {
                assert!(!panics, "a command's bug");
                true
            },
            {
                let fatal = Arc::clone(&fatal);
                move || {
                    fatal.fetch_add(1, Ordering::SeqCst);
                }
            },
        );
        assert!(handler(false));
        assert_eq!(fatal.load(Ordering::SeqCst), 0);
        assert!(handler(true), "handled: Tauri sends no answer of its own");
        assert_eq!(fatal.load(Ordering::SeqCst), 1);
    }
}
