// Without it, Windows opens a console next to the release app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "bench")]
mod bench;

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, State, Webview, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use twigo_core::{Core, PolicyFile, ShellFrame};
use twigo_env::Environment;
use twigo_ipc::{
    AccessQuery, Ack, AnswerApproval, AnswerKubeconfigOffer, ApplyPreviewed, ApplyRequest,
    ApprovalEvent, Catalog, ClusterVersion, ContextAuth, DiagnosticsEntry, DiagnosticsLevel,
    Discovered, DownloadLogs, ErrorCode, ExecReview, Execute, Forward, ForwardEvent, ForwardId,
    ForwardPorts, ForwardStarted, ForwardTarget, GetValues, IpcError, KeyboardLayout,
    KubeconfigOffer, KubeconfigOfferEvent, ListBatch, ListQuery, LogBatch, LogVerbosity,
    NewTerminal, ObjectBatch, OpenLogs, OpenObject, OpenShell, OperationEvent, Plan, PlanId,
    PlanRequest, ResumeForward, SchemaQuery, SetLogLevel, SetLogSource, SetLogView, SetLogWindow,
    SetParts, SetWindow, ShellAck, ShellContainers, ShellEnvironment, ShellInput, ShellPod,
    ShellResize, Space, StartForward, StateEntry, StateSnapshot, SubscriptionId, TerminalSession,
};
use twigo_keyboard::{LayoutWatch, MainThread, Subscription};
use twigo_log::{Facts, Level, Log};

/// The explicit mode's kubeconfig (ARCHITECTURE 5.5): the only source of
/// contexts, of which only `kind-*` and `kwok-*` count. Debug and bench
/// builds only.
#[cfg(any(debug_assertions, feature = "bench"))]
const EXPLICIT_KUBECONFIG: &str = "TWIGO_KUBECONFIG";

/// Whether `result` reached the webview. Tauri's send succeeds for a reloaded
/// page and a closed window alike, and fails only when the event loop is gone
/// (tauri 2.12.7), so a failure is for `debug` and whoever sent stops sending.
/// A follower of a window ends with its replacement or with the window.
fn sent(channel: &str, result: tauri::Result<()>) -> bool {
    result
        .inspect_err(|error| tracing::debug!(channel, %error, "could not send to the webview"))
        .is_ok()
}

/// The layout watch and one subscription per webview, which a reload
/// replaces.
struct Keyboard {
    watch: Result<LayoutWatch, twigo_keyboard::Error>,
    subscriptions: Mutex<HashMap<String, Subscription>>,
}

#[tauri::command]
fn keyboard_layout_watch(
    webview: Webview,
    keyboard: State<'_, Keyboard>,
    channel: Channel<KeyboardLayout>,
) -> Result<KeyboardLayout, IpcError> {
    let watch = keyboard.watch.as_ref().map_err(IpcError::from)?;
    let open = AtomicBool::new(true);
    let (layout, subscription) = watch.subscribe(move |layout| {
        if open.load(Ordering::Relaxed)
            && !sent("the keyboard layout", channel.send(layout.clone()))
        {
            open.store(false, Ordering::Relaxed);
        }
    });
    keyboard
        .subscriptions
        .lock()
        .expect("subscriptions lock")
        .insert(webview.label().to_owned(), subscription);
    Ok(layout)
}

/// One task per webview that sends a watched value's changes, which a
/// reload replaces.
#[derive(Default)]
struct Followers(Mutex<HashMap<String, JoinHandle<()>>>);

impl Followers {
    fn replace(&self, webview: &Webview, follower: JoinHandle<()>) {
        let replaced = self
            .0
            .lock()
            .expect("followers lock")
            .insert(webview.label().to_owned(), follower);
        if let Some(replaced) = replaced {
            replaced.abort();
        }
    }

    fn remove(&self, window: &str) {
        if let Some(follower) = self.0.lock().expect("followers lock").remove(window) {
            follower.abort();
        }
    }
}

/// The login shell's environment and its followers.
struct Shell {
    environment: Arc<Environment>,
    followers: Followers,
}

#[tauri::command]
fn shell_environment_watch(
    webview: Webview,
    shell: State<'_, Shell>,
    channel: Channel<ShellEnvironment>,
) -> Result<ShellEnvironment, IpcError> {
    let mut status = shell.environment.subscribe();
    let current = ShellEnvironment::from(&*status.borrow_and_update());
    let follower = tauri::async_runtime::spawn(async move {
        while status.changed().await.is_ok() {
            let next = ShellEnvironment::from(&*status.borrow_and_update());
            if !sent("the shell environment", channel.send(next)) {
                return;
            }
        }
    });
    shell.followers.replace(&webview, follower);
    Ok(current)
}

#[tauri::command]
async fn shell_environment_retry(shell: State<'_, Shell>) -> Result<(), IpcError> {
    shell.environment.retry().await;
    Ok(())
}

/// The core and the followers of its catalog, of the active context's
/// credentials and of the active space's resources.
struct App {
    core: Arc<Core>,
    contexts: Followers,
    auth: Followers,
    resources: Followers,
    /// The labels of the windows that have the focus, which moves from one
    /// to the next in either order of their events.
    focused: Mutex<HashSet<String>>,
}

impl App {
    /// A window is gone: its subscriptions and its followers end with it.
    fn close(&self, window: &str) {
        self.core.drop_window(window);
        for followers in [&self.contexts, &self.auth, &self.resources] {
            followers.remove(window);
        }
    }

    fn focus(&self, window: &str, focused: bool) {
        let mut windows = self.focused.lock().expect("focus lock");
        if focused {
            windows.insert(window.to_owned());
        } else {
            windows.remove(window);
        }
        self.core.set_focused(!windows.is_empty());
    }
}

#[tauri::command]
async fn contexts_watch(
    webview: Webview,
    app: State<'_, App>,
    channel: Channel<Catalog>,
) -> Result<Catalog, IpcError> {
    let mut contexts = app.core.catalog.subscribe();
    let mut access = app.core.policy.changes();
    // Marks what it answers with as seen, so the follower sends only what
    // comes after.
    contexts
        .wait_for(Option::is_some)
        .await
        .expect("the catalog lives as long as the app");
    access.borrow_and_update();
    let current = app.core.contexts().expect("waited for");
    let core = Arc::clone(&app.core);
    let follower = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                changed = contexts.changed() => if changed.is_err() { return },
                changed = access.changed() => if changed.is_err() { return },
            }
            if let Some(next) = core.contexts()
                && !sent("the contexts", channel.send(next))
            {
                return;
            }
        }
    });
    app.contexts.replace(&webview, follower);
    Ok(current)
}

#[tauri::command]
fn context_relock(app: State<'_, App>, request: String) {
    app.core.policy.relock(&request);
}

#[tauri::command]
async fn command_plan(
    webview: Webview,
    app: State<'_, App>,
    request: PlanRequest,
) -> Result<Plan, IpcError> {
    app.core.command_plan(webview.label(), request).await
}

#[tauri::command]
async fn command_execute(
    webview: Webview,
    app: State<'_, App>,
    request: Execute,
    channel: Channel<OperationEvent>,
) -> Result<(), IpcError> {
    app.core
        .command_execute(webview.label(), request, move |event| {
            sent("an operation's event", channel.send(event))
        })
        .await
}

#[tauri::command]
async fn apply_preview(
    webview: Webview,
    app: State<'_, App>,
    request: ApplyRequest,
) -> Result<ApplyPreviewed, IpcError> {
    app.core.apply_preview(webview.label(), request).await
}

#[tauri::command]
fn command_cancel(webview: Webview, app: State<'_, App>, request: PlanId) {
    app.core.command_cancel(webview.label(), request);
}

#[tauri::command]
async fn access_review(app: State<'_, App>, request: AccessQuery) -> Result<Vec<bool>, IpcError> {
    app.core.access_review(request).await
}

#[tauri::command]
fn spaces_list(app: State<'_, App>) -> Vec<Space> {
    app.core.state.spaces()
}

#[tauri::command]
async fn space_open(app: State<'_, App>, request: String) -> Result<Space, IpcError> {
    app.core.space_open(&request).await
}

#[tauri::command]
fn state_load(app: State<'_, App>) -> StateSnapshot {
    app.core.state.snapshot()
}

#[tauri::command]
fn state_set(app: State<'_, App>, request: Vec<StateEntry>) -> Result<(), IpcError> {
    app.core
        .state
        .set(request)
        .map_err(|error| IpcError::from(&error))
}

#[tauri::command]
async fn cluster_version(app: State<'_, App>, request: String) -> Result<ClusterVersion, IpcError> {
    app.core.cluster_version(&request).await
}

#[tauri::command]
async fn namespaces_list(app: State<'_, App>, request: String) -> Result<Vec<String>, IpcError> {
    app.core.namespaces(&request).await
}

#[tauri::command]
async fn context_auth_watch(
    webview: Webview,
    app: State<'_, App>,
    request: String,
    channel: Channel<ContextAuth>,
) -> Result<ContextAuth, IpcError> {
    // Commands run concurrently, so the follower replaced last is that of
    // the watch that answered last: the webview waits for an answer before
    // its next watch.
    let mut auth = app.core.follow_auth(request);
    let current = auth.next().await;
    let follower = tauri::async_runtime::spawn(async move {
        loop {
            let next = auth.next().await;
            if !sent("the context's credentials", channel.send(next)) {
                return;
            }
        }
    });
    app.auth.replace(&webview, follower);
    Ok(current)
}

#[tauri::command]
fn resources_watch(
    webview: Webview,
    app: State<'_, App>,
    request: String,
    channel: Channel<Discovered>,
) {
    // Replaced in the order the webview asks, which waits for this answer
    // before its next watch, so the follower is that of the last space.
    let core = Arc::clone(&app.core);
    let follower = tauri::async_runtime::spawn(async move {
        let send = |next: Discovered| sent("the resources", channel.send(next));
        let mut resources = match core.follow_resources(&request).await {
            Ok(resources) => resources,
            Err(error) => {
                send(Discovered::Failed { error });
                return;
            }
        };
        while send(resources.next().await) {}
    });
    app.resources.replace(&webview, follower);
}

#[tauri::command]
async fn list_subscribe(
    webview: Webview,
    app: State<'_, App>,
    request: ListQuery,
    channel: Channel<ListBatch>,
) -> Result<SubscriptionId, IpcError> {
    app.core
        .list_subscribe(webview.label(), request, move |batch| {
            sent("a list batch", channel.send(batch))
        })
        .await
}

#[tauri::command]
fn list_set_window(
    webview: Webview,
    app: State<'_, App>,
    request: SetWindow,
) -> Result<(), IpcError> {
    app.core.list_set_window(webview.label(), request)
}

#[tauri::command]
fn list_ack(webview: Webview, app: State<'_, App>, request: Ack) -> Result<(), IpcError> {
    app.core.list_ack(webview.label(), request)
}

#[tauri::command]
fn list_unsubscribe(
    webview: Webview,
    app: State<'_, App>,
    request: SubscriptionId,
) -> Result<(), IpcError> {
    app.core.list_unsubscribe(webview.label(), request)
}

#[tauri::command]
async fn object_open(
    webview: Webview,
    app: State<'_, App>,
    request: OpenObject,
    channel: Channel<ObjectBatch>,
) -> Result<SubscriptionId, IpcError> {
    app.core
        .object_open(webview.label(), request, move |batch| {
            sent("an object batch", channel.send(batch))
        })
        .await
}

#[tauri::command]
fn object_set_parts(
    webview: Webview,
    app: State<'_, App>,
    request: SetParts,
) -> Result<(), IpcError> {
    app.core.object_set_parts(webview.label(), request)
}

#[tauri::command]
fn object_ack(webview: Webview, app: State<'_, App>, request: Ack) -> Result<(), IpcError> {
    app.core.object_ack(webview.label(), request)
}

#[tauri::command]
fn object_values(
    webview: Webview,
    app: State<'_, App>,
    request: GetValues,
) -> Result<Vec<Option<String>>, IpcError> {
    app.core.object_values(webview.label(), request)
}

#[tauri::command]
fn object_close(
    webview: Webview,
    app: State<'_, App>,
    request: SubscriptionId,
) -> Result<(), IpcError> {
    app.core.object_close(webview.label(), request)
}

#[tauri::command]
async fn schema_get(app: State<'_, App>, request: SchemaQuery) -> Result<String, IpcError> {
    app.core.schema(request).await
}

#[tauri::command]
async fn logs_open(
    webview: Webview,
    app: State<'_, App>,
    request: OpenLogs,
    channel: Channel<LogBatch>,
) -> Result<SubscriptionId, IpcError> {
    app.core
        .logs_open(webview.label(), request, move |batch| {
            sent("a logs batch", channel.send(batch))
        })
        .await
}

#[tauri::command]
fn logs_set_source(
    webview: Webview,
    app: State<'_, App>,
    request: SetLogSource,
) -> Result<(), IpcError> {
    app.core.logs_set_source(webview.label(), request)
}

#[tauri::command]
fn logs_set_view(
    webview: Webview,
    app: State<'_, App>,
    request: SetLogView,
) -> Result<(), IpcError> {
    app.core.logs_set_view(webview.label(), request)
}

#[tauri::command]
fn logs_set_window(
    webview: Webview,
    app: State<'_, App>,
    request: SetLogWindow,
) -> Result<(), IpcError> {
    app.core.logs_set_window(webview.label(), request)
}

#[tauri::command]
fn logs_ack(webview: Webview, app: State<'_, App>, request: Ack) -> Result<(), IpcError> {
    app.core.logs_ack(webview.label(), request)
}

/// Asks where to save a session's lines, then has the core write them
/// there; None when the person cancels.
#[tauri::command]
async fn logs_download(
    webview: Webview,
    app: State<'_, App>,
    request: DownloadLogs,
) -> Result<Option<String>, IpcError> {
    let name = app.core.logs_file_name(webview.label(), request.id)?;
    let (answer, picked) = tokio::sync::oneshot::channel();
    webview
        .dialog()
        .file()
        .set_parent(&webview.window())
        .set_file_name(name)
        .add_filter("Logs", &["log", "txt"])
        .save_file(move |picked| {
            // Once the command is dropped, nothing waits for the answer.
            let _ = answer.send(picked);
        });
    let picked = picked.await.map_err(|error| {
        IpcError::new(
            ErrorCode::LogsDialogFailed,
            format!("the save dialog failed: {error}"),
        )
    })?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| {
        IpcError::new(
            ErrorCode::LogsNotAFile,
            format!("Twigo saves logs only to a file on this computer: {error}"),
        )
    })?;
    app.core.logs_write(webview.label(), request, &path).await?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
fn logs_close(
    webview: Webview,
    app: State<'_, App>,
    request: SubscriptionId,
) -> Result<(), IpcError> {
    app.core.logs_close(webview.label(), request)
}

#[tauri::command]
async fn shell_containers(
    app: State<'_, App>,
    request: ShellPod,
) -> Result<ShellContainers, IpcError> {
    app.core.shell_containers(request).await
}

#[tauri::command]
async fn shell_open(
    webview: Webview,
    app: State<'_, App>,
    request: OpenShell,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), IpcError> {
    app.core
        .shell_open(webview.label(), request, move |frame| {
            let body = match frame {
                ShellFrame::Output(bytes) => Ok(InvokeResponseBody::Raw(bytes)),
                ShellFrame::Event(event) => event.body(),
            };
            sent("a shell frame", body.and_then(|body| channel.send(body)))
        })
        .await
}

#[tauri::command]
async fn shell_input(
    webview: Webview,
    app: State<'_, App>,
    request: ShellInput,
) -> Result<(), IpcError> {
    app.core.shell_input(webview.label(), request).await
}

#[tauri::command]
fn shell_resize(
    webview: Webview,
    app: State<'_, App>,
    request: ShellResize,
) -> Result<(), IpcError> {
    app.core.shell_resize(webview.label(), request)
}

#[tauri::command]
fn shell_ack(webview: Webview, app: State<'_, App>, request: ShellAck) -> Result<(), IpcError> {
    app.core.shell_ack(webview.label(), request)
}

#[tauri::command]
async fn terminal_create(
    webview: Webview,
    app: State<'_, App>,
    request: NewTerminal,
) -> Result<TerminalSession, IpcError> {
    app.core.terminal_create(webview.label(), request).await
}

#[tauri::command]
fn kubeconfig_offers_watch(
    webview: Webview,
    app: State<'_, App>,
    channel: Channel<KubeconfigOfferEvent>,
) -> Vec<KubeconfigOffer> {
    app.core
        .follow_kubeconfig_offers(webview.label(), move |event| {
            sent("a kubeconfig offer", channel.send(event))
        })
}

#[tauri::command]
async fn kubeconfig_offer_answer(
    webview: Webview,
    app: State<'_, App>,
    request: AnswerKubeconfigOffer,
) -> Result<(), IpcError> {
    app.core
        .answer_kubeconfig_offer(webview.label(), request)
        .await
}

#[tauri::command]
fn shell_close(
    webview: Webview,
    app: State<'_, App>,
    request: SubscriptionId,
) -> Result<(), IpcError> {
    app.core.shell_close(webview.label(), request)
}

#[tauri::command]
async fn context_sign_in(app: State<'_, App>, request: String) -> Result<(), IpcError> {
    app.core.sign_in(&request).await
}

#[tauri::command]
async fn context_sign_in_cancel(app: State<'_, App>, request: String) -> Result<(), IpcError> {
    app.core.cancel_sign_in(&request).await
}

#[tauri::command]
async fn exec_review(app: State<'_, App>) -> Result<ExecReview, IpcError> {
    Ok(app.core.review().await)
}

#[tauri::command]
fn exec_trust(app: State<'_, App>, request: Vec<String>) -> Result<(), IpcError> {
    app.core.trust_plugins(request)
}

#[tauri::command]
fn approvals_watch(webview: Webview, app: State<'_, App>, channel: Channel<ApprovalEvent>) {
    app.core.follow_approvals(webview.label(), move |event| {
        sent("an approval's ask", channel.send(event))
    });
}

#[tauri::command]
fn approval_answer(
    webview: Webview,
    app: State<'_, App>,
    request: AnswerApproval,
) -> Result<(), IpcError> {
    app.core.answer_approval(webview.label(), request)
}

#[tauri::command]
async fn forward_ports(
    app: State<'_, App>,
    request: ForwardTarget,
) -> Result<ForwardPorts, IpcError> {
    app.core.forward_ports(request).await
}

#[tauri::command]
async fn forward_start(
    app: State<'_, App>,
    request: StartForward,
) -> Result<ForwardStarted, IpcError> {
    app.core.forward_start(request).await
}

#[tauri::command]
async fn forward_stop(app: State<'_, App>, request: ForwardId) -> Result<(), IpcError> {
    app.core.forward_stop(request).await
}

#[tauri::command]
async fn forward_resume(
    app: State<'_, App>,
    request: ResumeForward,
) -> Result<ForwardStarted, IpcError> {
    app.core.forward_resume(request).await
}

#[tauri::command]
async fn forward_remove(app: State<'_, App>, request: ForwardId) -> Result<(), IpcError> {
    app.core.forward_remove(request).await
}

#[tauri::command]
fn forwards_watch(
    webview: Webview,
    app: State<'_, App>,
    channel: Channel<ForwardEvent>,
) -> Vec<Forward> {
    app.core.follow_forwards(webview.label(), move |event| {
        sent("a forward's change", channel.send(event))
    })
}

#[tauri::command]
fn url_open(handle: AppHandle, request: String) -> Result<(), IpcError> {
    let url = twigo_core::sign_in_url(&request)?;
    handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|error| {
            IpcError::new(
                ErrorCode::LinkOpenFailed,
                format!("could not open {request}: {error}"),
            )
        })
}

/// Writes what the webview caught, or did not, to the diagnostics log under
/// the target `twigo::webview`, which the default filter's `twigo=info` covers.
#[tauri::command]
fn diagnostics_log(webview: Webview, request: DiagnosticsEntry) {
    let DiagnosticsEntry {
        level,
        message,
        stack,
        source,
    } = request;
    let (window, stack) = (webview.label(), stack.as_deref());
    match level {
        DiagnosticsLevel::Error => {
            tracing::error!(target: "twigo::webview", window, source, stack, "{message}");
        }
        DiagnosticsLevel::Warn => {
            tracing::warn!(target: "twigo::webview", window, source, stack, "{message}");
        }
        DiagnosticsLevel::Info => {
            tracing::info!(target: "twigo::webview", window, source, stack, "{message}");
        }
    }
}

/// Shows the current log file in the file manager. The opener plugin's own
/// command stays out of the webview's reach, as `url_open` leaves it.
#[tauri::command]
fn log_reveal(handle: AppHandle, log: State<'_, Log>) -> Result<(), IpcError> {
    handle
        .opener()
        .reveal_item_in_dir(log.path())
        .map_err(|error| {
            IpcError::new(
                ErrorCode::FileUnrevealed,
                format!("could not show the log file: {error}"),
            )
        })
}

#[tauri::command]
fn log_level_set(log: State<'_, Log>, request: SetLogLevel) {
    log.set_level(match request.level {
        LogVerbosity::Info => Level::INFO,
        LogVerbosity::Debug => Level::DEBUG,
        LogVerbosity::Trace => Level::TRACE,
    });
}

fn explicit_kubeconfig() -> Option<PathBuf> {
    #[cfg(any(debug_assertions, feature = "bench"))]
    if let Some(file) = std::env::var_os(EXPLICIT_KUBECONFIG).filter(|v| !v.is_empty()) {
        return Some(file.into());
    }
    None
}

fn main() {
    // Before Tauri, so that the single-instance plugin never sees the login
    // shell's copy of Twigo and no window opens.
    let args: Vec<OsString> = std::env::args_os().collect();
    if let [_, flag, head, tail] = &args[..]
        && flag == twigo_env::DUMP_ENV
    {
        if let Err(error) = twigo_env::dump(head, tail) {
            #[expect(
                clippy::print_stderr,
                reason = "the login shell reads this copy's stderr, and it never opens the log"
            )]
            {
                eprintln!("could not print the environment: {error}");
            }
            std::process::exit(1);
        }
        return;
    }

    // After the `--dump-env` copy has returned, which never opens the log.
    twigo_log::install_hook(env!("CARGO_PKG_VERSION"));

    let builder = tauri::Builder::default()
        // First: a second launch must hand over to the running app before any
        // other plugin touches shared state, such as the window-state file.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let shown = window
                    .unminimize()
                    .and_then(|()| window.show())
                    .and_then(|()| window.set_focus());
                if let Err(error) = shown {
                    tracing::warn!(%error, "could not bring the running window forward");
                }
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "bench")]
    let builder = builder.plugin(bench::plugin());
    #[cfg(all(feature = "bench", target_os = "macos"))]
    let builder = builder.activate_ignoring_other_apps(false);
    let app = builder
        .setup(|app| {
            // Before `Core::new` reads the policy, the state and the trust
            // file, so what it says of them is logged.
            let facts = Facts::detect(
                env!("CARGO_PKG_VERSION"),
                option_env!("TWIGO_COMMIT"),
                tauri::webview_version().ok(),
            );
            app.manage(Log::start(&app.path().app_log_dir()?, &facts));
            let main = MainThread::new().ok_or("Tauri ran setup off the main thread")?;
            app.manage(Keyboard {
                watch: LayoutWatch::start(main),
                subscriptions: Mutex::default(),
            });
            let environment = Arc::new(Environment::default());
            tauri::async_runtime::spawn({
                let environment = Arc::clone(&environment);
                async move { environment.resolve().await }
            });
            let core = Core::new(
                &app.path().app_data_dir()?,
                &app.path().app_cache_dir()?,
                &PolicyFile::default_path(),
            );
            tauri::async_runtime::spawn({
                let core = Arc::clone(&core);
                let environment = Arc::clone(&environment);
                let explicit = explicit_kubeconfig();
                async move { core.run(environment.subscribe(), explicit).await }
            });
            tauri::async_runtime::spawn({
                let core = Arc::clone(&core);
                async move { core.follow_network(twigo_netmon::Watch::start()).await }
            });
            app.manage(Shell {
                environment,
                followers: Followers::default(),
            });
            let app_state = App {
                core,
                contexts: Followers::default(),
                auth: Followers::default(),
                resources: Followers::default(),
                focused: Mutex::default(),
            };
            if let Some(window) = app.get_webview_window("main") {
                app_state.focus("main", window.is_focused().unwrap_or(false));
            }
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keyboard_layout_watch,
            shell_environment_watch,
            shell_environment_retry,
            contexts_watch,
            context_relock,
            command_plan,
            command_execute,
            command_cancel,
            apply_preview,
            access_review,
            spaces_list,
            space_open,
            state_load,
            state_set,
            cluster_version,
            namespaces_list,
            context_auth_watch,
            resources_watch,
            list_subscribe,
            list_set_window,
            list_ack,
            list_unsubscribe,
            object_open,
            object_set_parts,
            object_ack,
            object_values,
            object_close,
            schema_get,
            logs_open,
            logs_set_source,
            logs_set_view,
            logs_set_window,
            logs_ack,
            logs_download,
            logs_close,
            shell_containers,
            shell_open,
            shell_input,
            shell_resize,
            shell_ack,
            shell_close,
            terminal_create,
            kubeconfig_offers_watch,
            kubeconfig_offer_answer,
            context_sign_in,
            context_sign_in_cancel,
            exec_review,
            exec_trust,
            approvals_watch,
            approval_answer,
            forward_ports,
            forward_start,
            forward_stop,
            forward_resume,
            forward_remove,
            forwards_watch,
            url_open,
            diagnostics_log,
            log_reveal,
            log_level_set,
        ])
        // A page that starts to load, as on a reload, has none of the
        // subscriptions of the one it replaces.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started
                && let Some(app) = webview.try_state::<App>()
            {
                app.core.drop_window(webview.label());
            }
        })
        .on_window_event(|window, event| {
            let focused = match event {
                WindowEvent::Focused(focused) => *focused,
                WindowEvent::Destroyed => false,
                _ => return,
            };
            // Before setup the app is not managed yet; setup reads the
            // window's focus itself.
            if let Some(app) = window.app_handle().try_state::<App>() {
                app.focus(window.label(), focused);
                // A webview window's webview has the window's label.
                if let WindowEvent::Destroyed = event {
                    app.close(window.label());
                    if let Some(shell) = window.try_state::<Shell>() {
                        shell.followers.remove(window.label());
                    }
                    if let Some(keyboard) = window.try_state::<Keyboard>() {
                        keyboard
                            .subscriptions
                            .lock()
                            .expect("subscriptions lock")
                            .remove(window.label());
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Twigo");
    app.run(|app, event| {
        // macOS delivers ⌘Q, the Dock's Quit and logout as `terminate:`,
        // which ends the process without `ExitRequested`, but still with
        // `Exit`: the webview cannot be asked for anything by then, so it
        // sends every change at once and this writes them.
        if let RunEvent::Exit = event {
            let core = &app.state::<App>().core;
            core.shutdown();
            if let Err(error) = core.state.flush() {
                tracing::error!(%error, "could not save the state on exit");
            }
        }
    });
}
