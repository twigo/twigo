//! What the app does when Twigo cannot go on, and how a command meets a panic
//! (ARCHITECTURE 2.1).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};

use tauri::ipc::Invoke;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use twigo_core::Core;

const TITLE: &str = "Twigo must restart";
const MESSAGE: &str = "Twigo ran into an internal error that it cannot recover from.\n\nWhat happened is in its log. Restart brings back your spaces and your forwards.";
const RESTART: &str = "Restart";
const QUIT: &str = "Quit";

/// The fatal path: it fails closed ([`Core::fail_closed`]), so that no unlock
/// and no forward outlives what the mode allows while Twigo waits for the
/// person, then asks in a native dialog, since the webview may be what the
/// panic broke, whether to restart or quit.
pub struct Path<R: Runtime = Wry> {
    ready: Arc<OnceLock<(AppHandle<R>, Arc<Core>)>>,
    stage: Arc<Stage>,
}

impl<R: Runtime> Default for Path<R> {
    fn default() -> Self {
        Self {
            ready: Arc::default(),
            stage: Arc::default(),
        }
    }
}

impl<R: Runtime> Clone for Path<R> {
    fn clone(&self) -> Self {
        Self {
            ready: Arc::clone(&self.ready),
            stage: Arc::clone(&self.stage),
        }
    }
}

impl<R: Runtime> Path<R> {
    pub fn ready(&self, app: &AppHandle<R>, core: &Arc<Core>) {
        let _ = self.ready.set((app.clone(), Arc::clone(core)));
    }

    /// Fails closed and asks, once however many panics reach it, and not
    /// once Twigo is ending. The log has the panic's record already.
    pub fn run(&self, why: &str) {
        if !self.stage.ask() {
            return;
        }
        tracing::error!(why, "Twigo cannot go on");
        let Some((app, core)) = self.ready.get().cloned() else {
            return;
        };
        core.fail_closed();
        // Tauri forgets a window before its `Destroyed` handlers run, and
        // ends once the last is gone (tauri 2.12.7 `on_window_close`,
        // tauri-runtime-wry 2.12.5 `TaoWindowEvent::Destroyed`). A dialog
        // without a parent would be the system's alert, which outlives
        // Twigo and can answer with its first button though nobody clicked
        // (rfd 0.17.2, `CFUserNotificationDisplayAlert`).
        let Some(window) = window(&app) else {
            tracing::warn!("no window is left to ask in, so Twigo ends without asking");
            flush(&core);
            return;
        };
        let path = self.clone();
        app.dialog()
            .message(MESSAGE)
            .title(TITLE)
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCancelCustom(
                RESTART.to_owned(),
                QUIT.to_owned(),
            ))
            .parent(&window)
            .show(move |restart| {
                if !path.answered(&core, restart) {
                    return;
                }
                if restart {
                    app.request_restart();
                } else {
                    app.exit(1);
                }
            });
    }

    /// The person's answer to the sheet, which the log keeps before the state
    /// is written. False once Twigo is ending, when it counts for nothing.
    fn answered(&self, core: &Core, restart: bool) -> bool {
        if !self.stage.answer() {
            return false;
        }
        if restart {
            tracing::info!("the person chose Restart, so Twigo restarts");
        } else {
            tracing::info!("the person chose Quit, so Twigo quits");
        }
        flush(core);
        true
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
        handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
    ) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
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
fn window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
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

#[cfg(test)]
mod tests {
    use tauri::test::{MockRuntime, mock_app};
    use twigo_ipc::{Mode, StateEntry};

    use super::*;

    #[test]
    fn a_panic_on_the_main_thread_takes_the_fatal_path() {
        let path = Path::<MockRuntime>::default();
        assert_eq!(path.guarded("a command panicked", || 3), Some(3));
        assert!(path.stage.ask(), "nothing asked yet");

        let path = Path::<MockRuntime>::default();
        let panicked = path.guarded("a command panicked", || -> u8 { panic!("a command's bug") });
        assert_eq!(panicked, None);
        assert!(!path.stage.ask(), "it asked");
    }

    #[test]
    fn with_no_window_left_the_fatal_path_fails_closed_writes_the_state_and_asks_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::new(
            dir.path(),
            &dir.path().join("cache"),
            &dir.path().join("policy.json"),
        );
        let kubeconfig = dir.path().join("config");
        std::fs::write(
            &kubeconfig,
            "
clusters: [{ name: c, cluster: { server: 'http://127.0.0.1:1' } }]
contexts: [{ name: kind-a, context: { cluster: c } }]
",
        )
        .unwrap();
        core.catalog
            .follow(twigo_core::catalog::sources(Some(kubeconfig), None, None));
        core.policy
            .set_mode("kind-a", Some(Mode::ReadOnly))
            .unwrap();
        core.policy.unlock("kind-a").unwrap();
        core.state
            .set(vec![StateEntry {
                space: None,
                key: "kept".to_owned(),
                value: "1".to_owned(),
            }])
            .unwrap();
        let app = mock_app();
        let path = Path::default();
        path.ready(app.handle(), &core);

        path.run("a window event panicked");
        assert_eq!(core.policy.access("kind-a").unlocked_until, None);
        let state = std::fs::read_to_string(dir.path().join("state.json")).unwrap_or_default();
        assert!(state.contains("kept"), "{state}");
    }

    #[test]
    fn the_answer_to_the_sheet_is_logged_and_the_state_written_unless_twigo_is_ending() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::new(
            dir.path(),
            &dir.path().join("cache"),
            &dir.path().join("policy.json"),
        );
        core.state
            .set(vec![StateEntry {
                space: None,
                key: "kept".to_owned(),
                value: "1".to_owned(),
            }])
            .unwrap();
        let said = |restart| {
            let events = twigo_log::capture();
            let path = Path::<MockRuntime>::default();
            assert!(path.stage.ask());
            (path.answered(&core, restart), events.lines())
        };

        let (counts, lines) = said(true);
        assert!(counts);
        let [line] = &lines[..] else {
            panic!("one line for the answer: {lines:?}");
        };
        assert_eq!(line["target"], "twigo::fatal");
        assert_eq!(
            line["fields"]["message"],
            "the person chose Restart, so Twigo restarts"
        );
        let state = std::fs::read_to_string(dir.path().join("state.json")).unwrap_or_default();
        assert!(state.contains("kept"), "{state}");
        let (_, lines) = said(false);
        assert_eq!(
            lines[0]["fields"]["message"],
            "the person chose Quit, so Twigo quits"
        );

        let events = twigo_log::capture();
        let path = Path::<MockRuntime>::default();
        assert!(path.stage.ask());
        path.ending();
        assert!(!path.answered(&core, true));
        assert!(events.lines().is_empty());
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
