// Without it, Windows opens a console next to the release app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "bench")]
mod bench;
mod fatal;

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
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
    ApprovalEvent, Catalog, ClusterVersion, CompareRevisions, ComparedRevisions, ContextAuth,
    DiagnosticsEntry, DiagnosticsLevel, Discovered, DownloadLogs, ErrorCode, ExecReview, Execute,
    Forward, ForwardEvent, ForwardId, ForwardPorts, ForwardStarted, ForwardTarget, GetValues,
    IpcError, KeyboardLayout, KubeconfigOffer, KubeconfigOfferEvent, ListBatch, ListQuery,
    LogBatch, LogVerbosity, NewTerminal, ObjectBatch, OpenIssue, OpenLogs, OpenObject, OpenRelease,
    OpenShell, OperationEvent, Plan, PlanId, PlanRequest, ReleaseBatch, ReleaseListQuery, Report,
    ResumeForward, SaveReport, SchemaQuery, SetLogLevel, SetLogSource, SetLogView, SetLogWindow,
    SetParts, SetReleaseView, SetView, SetWindow, ShellAck, ShellContainers, ShellEnvironment,
    ShellInput, ShellPod, ShellResize, Space, StartForward, StateEntry, StateSnapshot,
    SubscriptionId, TerminalSession,
};
use twigo_keyboard::{LayoutWatch, MainThread, Subscription};
use twigo_log::{Facts, Level, Log};

/// The explicit mode's kubeconfig (ARCHITECTURE 5.5): the only source of
/// contexts, of which only `kind-*` and `kwok-*` count. Debug and bench
/// builds only.
#[cfg(any(debug_assertions, feature = "bench"))]
const EXPLICIT_KUBECONFIG: &str = "TWIGO_KUBECONFIG";

/// The name of a duty or an item that panics each time it runs, for the check
/// build that has the `inject` feature, as `TWIGO_KUBECONFIG` is for the
/// kubeconfig.
#[cfg(feature = "inject")]
const INJECTED_PANIC: &str = "TWIGO_PANIC";

/// Whether `result` reached the webview. Tauri's send succeeds for a reloaded
/// page and a closed window alike, and fails only when the event loop is gone
/// (tauri 2.12.7), so a failure is for `debug` and whoever sent stops sending.
/// A follower of a window ends with its replacement or with the window.
fn sent(channel: &str, result: tauri::Result<()>) -> bool {
    result
        .inspect_err(|error| tracing::debug!(channel, %error, "could not send to the webview"))
        .is_ok()
}

/// An async command that answers `internal.panic` where it would otherwise
/// leave the webview's promise pending for good, since Tauri answers only
/// once the command's future ends.
async fn contained<T>(command: impl Future<Output = Result<T, IpcError>>) -> Result<T, IpcError> {
    let answered = twigo_panic::contain("command", command)
        .await
        .unwrap_or_else(|_| Err(IpcError::panicked("this command")));
    if let Err(error) = &answered {
        tracing::info!(code = %error.code, "a command answered an error");
    }
    answered
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
    resolving: JoinHandle<()>,
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
    contained(async {
        shell.environment.retry().await;
        Ok(())
    })
    .await
}

/// The core and the followers of its catalog, of the active context's
/// credentials and of the active space's resources.
struct App {
    core: Arc<Core>,
    supervisor: JoinHandle<()>,
    contexts: Followers,
    problems: Followers,
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
        for followers in [&self.contexts, &self.problems, &self.auth, &self.resources] {
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
fn problems_watch(
    webview: Webview,
    app: State<'_, App>,
    channel: Channel<Vec<IpcError>>,
) -> Vec<IpcError> {
    let mut problems = twigo_log::problems::watch();
    let current = problems.borrow_and_update().clone();
    let follower = tauri::async_runtime::spawn(async move {
        while problems.changed().await.is_ok() {
            let next = problems.borrow_and_update().clone();
            if !sent("the problems", channel.send(next)) {
                return;
            }
        }
    });
    app.problems.replace(&webview, follower);
    current
}

#[tauri::command]
async fn contexts_watch(
    webview: Webview,
    app: State<'_, App>,
    channel: Channel<Catalog>,
) -> Result<Catalog, IpcError> {
    contained(async {
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
    })
    .await
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
    contained(async { app.core.command_plan(webview.label(), request).await }).await
}

#[tauri::command]
async fn command_execute(
    webview: Webview,
    app: State<'_, App>,
    request: Execute,
    channel: Channel<OperationEvent>,
) -> Result<(), IpcError> {
    contained(async {
        app.core
            .command_execute(webview.label(), request, move |event| {
                sent("an operation's event", channel.send(event))
            })
            .await
    })
    .await
}

#[tauri::command]
async fn apply_preview(
    webview: Webview,
    app: State<'_, App>,
    request: ApplyRequest,
) -> Result<ApplyPreviewed, IpcError> {
    contained(async { app.core.apply_preview(webview.label(), request).await }).await
}

#[tauri::command]
fn command_cancel(webview: Webview, app: State<'_, App>, request: PlanId) {
    app.core.command_cancel(webview.label(), request);
}

#[tauri::command]
async fn access_review(app: State<'_, App>, request: AccessQuery) -> Result<Vec<bool>, IpcError> {
    contained(async { app.core.access_review(request).await }).await
}

#[tauri::command]
fn spaces_list(app: State<'_, App>) -> Vec<Space> {
    app.core.state.spaces()
}

#[tauri::command]
async fn space_open(app: State<'_, App>, request: String) -> Result<Space, IpcError> {
    contained(async { app.core.space_open(&request).await }).await
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
    contained(async { app.core.cluster_version(&request).await }).await
}

#[tauri::command]
async fn namespaces_list(app: State<'_, App>, request: String) -> Result<Vec<String>, IpcError> {
    contained(async { app.core.namespaces(&request).await }).await
}

#[tauri::command]
async fn context_auth_watch(
    webview: Webview,
    app: State<'_, App>,
    request: String,
    channel: Channel<ContextAuth>,
) -> Result<ContextAuth, IpcError> {
    contained(async {
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
    })
    .await
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
    contained(async {
        app.core
            .list_subscribe(webview.label(), request, move |batch| {
                sent("a list batch", channel.send(batch))
            })
            .await
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
async fn list_set_view(
    webview: Webview,
    app: State<'_, App>,
    request: SetView,
) -> Result<(), IpcError> {
    contained(async { app.core.list_set_view(webview.label(), request) }).await
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
async fn helm_list_subscribe(
    webview: Webview,
    app: State<'_, App>,
    request: ReleaseListQuery,
    channel: Channel<ListBatch>,
) -> Result<SubscriptionId, IpcError> {
    contained(async {
        app.core
            .helm_list_subscribe(webview.label(), request, move |batch| {
                sent("a list batch", channel.send(batch))
            })
            .await
    })
    .await
}

#[tauri::command]
async fn helm_release_open(
    webview: Webview,
    app: State<'_, App>,
    request: OpenRelease,
    channel: Channel<ReleaseBatch>,
) -> Result<SubscriptionId, IpcError> {
    contained(async {
        app.core
            .helm_release_open(webview.label(), request, move |batch| {
                sent("a release batch", channel.send(batch))
            })
            .await
    })
    .await
}

#[tauri::command]
fn helm_release_set_view(
    webview: Webview,
    app: State<'_, App>,
    request: SetReleaseView,
) -> Result<(), IpcError> {
    app.core.helm_release_set_view(webview.label(), request)
}

#[tauri::command]
fn helm_release_ack(webview: Webview, app: State<'_, App>, request: Ack) -> Result<(), IpcError> {
    app.core.helm_release_ack(webview.label(), request)
}

#[tauri::command]
fn helm_release_close(
    webview: Webview,
    app: State<'_, App>,
    request: SubscriptionId,
) -> Result<(), IpcError> {
    app.core.helm_release_close(webview.label(), request)
}

#[tauri::command]
async fn helm_compare(
    app: State<'_, App>,
    request: CompareRevisions,
) -> Result<ComparedRevisions, IpcError> {
    contained(async { app.core.helm_compare(request).await }).await
}

#[tauri::command]
async fn object_open(
    webview: Webview,
    app: State<'_, App>,
    request: OpenObject,
    channel: Channel<ObjectBatch>,
) -> Result<SubscriptionId, IpcError> {
    contained(async {
        app.core
            .object_open(webview.label(), request, move |batch| {
                sent("an object batch", channel.send(batch))
            })
            .await
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
    contained(async { app.core.schema(request).await }).await
}

#[tauri::command]
async fn logs_open(
    webview: Webview,
    app: State<'_, App>,
    request: OpenLogs,
    channel: Channel<LogBatch>,
) -> Result<SubscriptionId, IpcError> {
    contained(async {
        app.core
            .logs_open(webview.label(), request, move |batch| {
                sent("a logs batch", channel.send(batch))
            })
            .await
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
    contained(async {
        let name = app.core.logs_file_name(webview.label(), request.id)?;
        let Some(path) = save_path(&webview, name, ("Logs", &["log", "txt"])).await? else {
            return Ok(None);
        };
        app.core.logs_write(webview.label(), request, &path).await?;
        Ok(Some(path.display().to_string()))
    })
    .await
}

/// None when the person cancels the dialog.
async fn save_path(
    webview: &Webview,
    name: String,
    filter: (&str, &[&str]),
) -> Result<Option<PathBuf>, IpcError> {
    let (answer, picked) = tokio::sync::oneshot::channel();
    webview
        .dialog()
        .file()
        .set_parent(&webview.window())
        .set_file_name(name)
        .add_filter(filter.0, filter.1)
        .save_file(move |picked| {
            // Once the command is dropped, nothing waits for the answer.
            let _ = answer.send(picked);
        });
    let picked = picked.await.map_err(|error| {
        IpcError::new(
            ErrorCode::FileDialogFailed,
            format!("the save dialog failed: {error}"),
        )
    })?;
    picked
        .map(|picked| {
            picked.into_path().map_err(|error| {
                IpcError::new(
                    ErrorCode::FileNotLocal,
                    format!("Twigo saves only to a file on this computer: {error}"),
                )
            })
        })
        .transpose()
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
    contained(async { app.core.shell_containers(request).await }).await
}

#[tauri::command]
async fn shell_open(
    webview: Webview,
    app: State<'_, App>,
    request: OpenShell,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), IpcError> {
    contained(async {
        app.core
            .shell_open(webview.label(), request, move |frame| {
                let body = match frame {
                    ShellFrame::Output(bytes) => Ok(InvokeResponseBody::Raw(bytes)),
                    ShellFrame::Event(event) => event.body(),
                };
                sent("a shell frame", body.and_then(|body| channel.send(body)))
            })
            .await
    })
    .await
}

#[tauri::command]
async fn shell_input(
    webview: Webview,
    app: State<'_, App>,
    request: ShellInput,
) -> Result<(), IpcError> {
    contained(async { app.core.shell_input(webview.label(), request).await }).await
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
    contained(async { app.core.terminal_create(webview.label(), request).await }).await
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
    contained(async {
        app.core
            .answer_kubeconfig_offer(webview.label(), request)
            .await
    })
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
    contained(async { app.core.sign_in(&request).await }).await
}

#[tauri::command]
async fn context_sign_in_cancel(app: State<'_, App>, request: String) -> Result<(), IpcError> {
    contained(async { app.core.cancel_sign_in(&request).await }).await
}

#[tauri::command]
async fn exec_review(app: State<'_, App>) -> Result<ExecReview, IpcError> {
    contained(async { Ok(app.core.review().await) }).await
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
    contained(async { app.core.forward_ports(request).await }).await
}

#[tauri::command]
async fn forward_start(
    app: State<'_, App>,
    request: StartForward,
) -> Result<ForwardStarted, IpcError> {
    contained(async { app.core.forward_start(request).await }).await
}

#[tauri::command]
async fn forward_stop(app: State<'_, App>, request: ForwardId) -> Result<(), IpcError> {
    contained(async { app.core.forward_stop(request).await }).await
}

#[tauri::command]
async fn forward_resume(
    app: State<'_, App>,
    request: ResumeForward,
) -> Result<ForwardStarted, IpcError> {
    contained(async { app.core.forward_resume(request).await }).await
}

#[tauri::command]
async fn forward_remove(app: State<'_, App>, request: ForwardId) -> Result<(), IpcError> {
    contained(async { app.core.forward_remove(request).await }).await
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
    let url = twigo_core::openable_url(&request)?;
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

#[tauri::command]
async fn report_problem(app: State<'_, App>, log: State<'_, Log>) -> Result<Report, IpcError> {
    contained(async { Ok(app.core.report(log.facts(), &log.files()).await) }).await
}

/// Twigo builds the link, so it goes through no `openable_url` check.
#[tauri::command]
async fn report_open_issue(
    handle: AppHandle,
    app: State<'_, App>,
    log: State<'_, Log>,
    request: OpenIssue,
) -> Result<(), IpcError> {
    contained(async {
        let url = app
            .core
            .report_issue(log.facts(), &log.files(), request)
            .await;
        handle
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|error| {
                IpcError::new(
                    ErrorCode::LinkOpenFailed,
                    format!("could not open the new-issue form: {error}"),
                )
            })
    })
    .await
}

#[tauri::command]
async fn report_save(webview: Webview, request: SaveReport) -> Result<Option<String>, IpcError> {
    contained(async {
        let name = twigo_core::report::file_name();
        let Some(path) = save_path(&webview, name, ("Report", &["txt"])).await? else {
            return Ok(None);
        };
        twigo_core::report::write(&request.text, &path).await?;
        Ok(Some(path.display().to_string()))
    })
    .await
}

fn explicit_kubeconfig() -> Option<PathBuf> {
    #[cfg(any(debug_assertions, feature = "bench"))]
    if let Some(file) = std::env::var_os(EXPLICIT_KUBECONFIG).filter(|v| !v.is_empty()) {
        return Some(file.into());
    }
    None
}

#[cfg(feature = "inject")]
fn arm_panic() {
    if let Some(name) = std::env::var(INJECTED_PANIC)
        .ok()
        .filter(|name| !name.is_empty())
    {
        twigo_panic::inject::arm(&name, u32::MAX);
    }
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
    #[cfg(feature = "inject")]
    arm_panic();
    let fatal = fatal::Path::default();

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
        .setup({
            let fatal = fatal.clone();
            move |app| {
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
                let resolving = tauri::async_runtime::spawn({
                    let environment = Arc::clone(&environment);
                    async move { environment.resolve().await }
                });
                let core = Core::new(
                    &app.path().app_data_dir()?,
                    &app.path().app_cache_dir()?,
                    &PolicyFile::default_path(),
                );
                fatal.ready(app.handle(), &core);
                let supervisor = tauri::async_runtime::spawn(core.start(
                    environment.subscribe(),
                    explicit_kubeconfig(),
                    Some(twigo_netmon::Watch::start),
                    {
                        let fatal = fatal.clone();
                        move |why| fatal.run(&why.to_string())
                    },
                ));
                app.manage(Shell {
                    environment,
                    followers: Followers::default(),
                    resolving,
                });
                let app_state = App {
                    core,
                    supervisor,
                    contexts: Followers::default(),
                    problems: Followers::default(),
                    auth: Followers::default(),
                    resources: Followers::default(),
                    focused: Mutex::default(),
                };
                if let Some(window) = app.get_webview_window("main") {
                    app_state.focus("main", window.is_focused().unwrap_or(false));
                }
                app.manage(app_state);
                Ok(())
            }
        })
        .invoke_handler(fatal.guarded_handler(tauri::generate_handler![
            keyboard_layout_watch,
            shell_environment_watch,
            shell_environment_retry,
            contexts_watch,
            problems_watch,
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
            list_set_view,
            list_ack,
            list_unsubscribe,
            helm_list_subscribe,
            helm_release_open,
            helm_release_set_view,
            helm_release_ack,
            helm_release_close,
            helm_compare,
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
            report_problem,
            report_open_issue,
            report_save,
        ]))
        // A page that starts to load, as on a reload, has none of the
        // subscriptions of the one it replaces.
        .on_page_load({
            let fatal = fatal.clone();
            move |webview, payload| {
                fatal.guarded("a page load panicked", || {
                    if payload.event() == PageLoadEvent::Started
                        && let Some(app) = webview.try_state::<App>()
                    {
                        app.core.drop_window(webview.label());
                    }
                });
            }
        })
        .on_window_event({
            let fatal = fatal.clone();
            move |window, event| {
                fatal.guarded("a window event panicked", || {
                    window_event(window, event);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Twigo");
    app.run(move |app, event| match event {
        RunEvent::ExitRequested { .. } => fatal.ending(),
        // macOS delivers ⌘Q, the Dock's Quit and logout as `terminate:`,
        // which ends the process without `ExitRequested`, but still with
        // `Exit`: the webview cannot be asked for anything by then, so it
        // sends every change at once and this writes them.
        RunEvent::Exit => {
            fatal.ending();
            let state = app.state::<App>();
            state.supervisor.abort();
            if let Some(shell) = app.try_state::<Shell>() {
                shell.resolving.abort();
            }
            // On its own, so that a poisoned lock here leaves the flush to
            // run, for the restart a fatal path asked for too.
            if catch_unwind(AssertUnwindSafe(|| state.core.shutdown())).is_err() {
                tracing::error!("could not end the sessions on exit, which panicked");
            }
            fatal::flush(&state.core);
        }
        _ => {}
    });
}

/// A window's focus, and a window gone: its subscriptions and its followers
/// end with it.
fn window_event(window: &tauri::Window, event: &WindowEvent) {
    let focused = match event {
        WindowEvent::Focused(focused) => *focused,
        WindowEvent::Destroyed => false,
        _ => return,
    };
    // Before setup the app is not managed yet; setup reads the window's focus
    // itself.
    let Some(app) = window.app_handle().try_state::<App>() else {
        return;
    };
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

#[cfg(test)]
mod tests {
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
    async fn a_command_that_answers_an_error_leaves_one_line_of_the_commands_with_its_code_and_none_of_its_words()
     {
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
        assert_eq!(event["target"], "twigo");
        assert_eq!(event["fields"]["code"], "server.invalid");
        assert!(!event.to_string().contains("hunter2"), "{event}");
    }
}
