//! What the app does when Twigo cannot go on, and how a command meets a panic
//! (ARCHITECTURE 2.1).

use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};

use tauri::ipc::Invoke;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use twigo_core::Core;
use twigo_ipc::IpcError;

const TITLE: &str = "Twigo must restart";
const MESSAGE: &str = "Twigo ran into an internal error that it cannot recover from.\n\nWhat happened is in its log. Restart brings back your spaces and your forwards.";
const RESTART: &str = "Restart";
const QUIT: &str = "Quit";

/// The fatal path: it fails closed ([`Core::fail_closed`]), so that no unlock
/// and no forward outlives what the mode allows while Twigo waits for the
/// person, then asks in a native dialog, since the webview may be what the
/// panic broke, whether to restart or quit.
#[derive(Clone, Default)]
pub struct Path {
    ready: Arc<OnceLock<(AppHandle, Arc<Core>)>>,
    stage: Arc<Stage>,
}

impl Path {
    pub fn ready(&self, app: &AppHandle, core: &Arc<Core>) {
        let _ = self.ready.set((app.clone(), Arc::clone(core)));
    }

    /// Fails closed and asks, once however many panics reach it, and not
    /// once Twigo is ending. The log has the panic's record already.
    pub fn run(&self, why: &str) {
        if !self.stage.ask() {
            return;
        }
        tracing::error!(why, "Twigo cannot go on, so it asks to restart");
        let Some((app, core)) = self.ready.get().cloned() else {
            return;
        };
        core.fail_closed();
        let mut dialog = app
            .dialog()
            .message(MESSAGE)
            .title(TITLE)
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCancelCustom(
                RESTART.to_owned(),
                QUIT.to_owned(),
            ));
        // A sheet goes with its window and blocks it. Without one the alert
        // is the system's, which outlives Twigo and can answer with its
        // first button though nobody clicked (rfd 0.17.2,
        // `CFUserNotificationDisplayAlert`).
        if let Some(window) = window(&app) {
            dialog = dialog.parent(&window);
        }
        let stage = Arc::clone(&self.stage);
        dialog.show(move |restart| {
            if !stage.answer() {
                return;
            }
            flush(&core);
            if restart {
                app.request_restart();
            } else {
                app.exit(1);
            }
        });
    }

    /// Twigo is ending: an answer that comes after does nothing, so an exit
    /// never turns into a restart.
    pub fn ending(&self) {
        self.stage.end();
    }

    /// The invoke handler under [`Path::guarded`]: a command that panicked
    /// is handled, so Tauri sends no answer of its own.
    pub fn guarded_handler(
        &self,
        handler: impl Fn(Invoke) -> bool + Send + Sync + 'static,
    ) -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
        let fatal = self.clone();
        move |invoke| {
            fatal
                .guarded("a command panicked", || handler(invoke))
                .unwrap_or(true)
        }
    }

    /// Runs `body`, which the system calls on the main thread, where a panic
    /// would unwind into its frames: the invoke handler, called from wry's
    /// `extern "C"` URL scheme handler (wry 0.57.1, `url_scheme_handler.rs`,
    /// `start_task`), which aborts the process, and the page-load and window
    /// callbacks, after which tao stops the app with no `RunEvent::Exit`
    /// (tao 0.37.2, `stop_app_on_panic`). A panic takes the fatal path.
    pub fn guarded<T>(&self, why: &str, body: impl FnOnce() -> T) -> Option<T> {
        catch_unwind(AssertUnwindSafe(body))
            .inspect_err(|_| self.run(why))
            .ok()
    }
}

/// Twigo's focused window, its main one, or any.
fn window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next())
        .cloned()
}

/// Where the fatal path stands, so that it asks once and an answer that
/// comes after an exit has begun does nothing.
#[derive(Default)]
struct Stage(AtomicU8);

const RUNNING: u8 = 0;
const ASKING: u8 = 1;
const ANSWERED: u8 = 2;
const ENDING: u8 = 3;

impl Stage {
    fn ask(&self) -> bool {
        self.moved(RUNNING, ASKING)
    }

    fn answer(&self) -> bool {
        self.moved(ASKING, ANSWERED)
    }

    fn end(&self) {
        let _ = self
            .0
            .try_update(Ordering::AcqRel, Ordering::Acquire, |stage| {
                (stage != ANSWERED).then_some(ENDING)
            });
    }

    fn moved(&self, from: u8, to: u8) -> bool {
        self.0
            .compare_exchange(from, to, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

/// Writes the state now; a panic is logged, so that the exit or the restart
/// goes on.
pub fn flush(core: &Core) {
    match catch_unwind(AssertUnwindSafe(|| core.state.flush())) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::error!(%error, "could not save the state"),
        Err(_) => tracing::error!("could not save the state, which panicked"),
    }
}

/// An async command that answers `internal.panic` where it would otherwise
/// leave the webview's promise pending for good, since Tauri answers only
/// once the command's future ends.
pub async fn contained<T>(
    command: impl Future<Output = Result<T, IpcError>>,
) -> Result<T, IpcError> {
    let answered = twigo_panic::contain("command", command)
        .await
        .unwrap_or_else(|_| Err(IpcError::panicked("this command")));
    if let Err(error) = &answered {
        tracing::info!(code = %error.code, "a command answered an error");
    }
    answered
}

#[cfg(test)]
mod tests {
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

    #[tokio::test]
    async fn a_command_that_answers_an_error_leaves_one_line_with_its_code_and_none_of_its_words() {
        let events = twigo_log::capture();
        let refused: Result<u8, IpcError> = contained(async {
            Err(IpcError::new(
                ErrorCode::ServerInvalid,
                r#"Invalid value: "hunter2""#,
            ))
        })
        .await;
        assert!(refused.is_err());
        assert_eq!(contained(async { Ok(3) }).await.unwrap(), 3);
        let lines = events.lines();
        let [event] = &lines[..] else {
            panic!("one event for one error: {lines:?}");
        };
        assert_eq!(event["fields"]["code"], "server.invalid");
        assert!(!event.to_string().contains("hunter2"), "{event}");
    }

    #[test]
    fn a_panic_on_the_main_thread_takes_the_fatal_path() {
        let path = Path::default();
        assert_eq!(path.guarded("a command panicked", || 3), Some(3));
        assert!(path.stage.ask(), "nothing asked yet");

        let path = Path::default();
        let panicked = path.guarded("a command panicked", || -> u8 { panic!("a command's bug") });
        assert_eq!(panicked, None);
        assert!(!path.stage.ask(), "it asked");
    }

    #[test]
    fn an_answer_that_comes_after_an_exit_began_does_nothing() {
        let stage = Stage::default();
        assert!(stage.ask());
        assert!(!stage.ask(), "once");
        stage.end();
        assert!(!stage.answer(), "Twigo is ending");

        let stage = Stage::default();
        assert!(stage.ask());
        assert!(stage.answer());
        stage.end();
        assert!(!stage.answer(), "answered once");

        let stage = Stage::default();
        stage.end();
        assert!(!stage.ask(), "nothing is asked while Twigo ends");
    }
}
