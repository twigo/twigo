// Without it, Windows opens a console next to the release app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "bench")]
mod bench;

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent, State, Webview, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use twigo_core::Core;
use twigo_env::Environment;
use twigo_ipc::{
    ClusterVersion, Context, ContextAuth, Discovered, ErrorKind, ExecReview, IpcError,
    KeyboardLayout, ShellEnvironment, Space, StateEntry, StateSnapshot,
};
use twigo_keyboard::{LayoutWatch, MainThread, Subscription};

/// The explicit mode's kubeconfig (ARCHITECTURE 5.5): the only source of
/// contexts, of which only `kind-*` and `kwok-*` count. Debug and bench
/// builds only.
#[cfg(any(debug_assertions, feature = "bench"))]
const EXPLICIT_KUBECONFIG: &str = "TWIGO_KUBECONFIG";

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
    let (layout, subscription) = watch.subscribe(move |layout| {
        if let Err(error) = channel.send(layout.clone()) {
            eprintln!("could not send the keyboard layout: {error}");
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
            if let Err(error) = channel.send(next) {
                eprintln!("could not send the shell environment: {error}");
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
    channel: Channel<Vec<Context>>,
) -> Result<Vec<Context>, IpcError> {
    let mut contexts = app.core.catalog.subscribe();
    // Marks what it answers with as seen, so the follower sends only what
    // comes after.
    let current = contexts
        .wait_for(Option::is_some)
        .await
        .expect("the catalog lives as long as the app")
        .as_ref()
        .expect("waited for")
        .ipc();
    let follower = tauri::async_runtime::spawn(async move {
        while contexts.changed().await.is_ok() {
            let next = contexts.borrow_and_update().as_ref().map(|c| c.ipc());
            if let Some(next) = next
                && let Err(error) = channel.send(next)
            {
                eprintln!("could not send the contexts: {error}");
            }
        }
    });
    app.contexts.replace(&webview, follower);
    Ok(current)
}

#[tauri::command]
fn spaces_list(app: State<'_, App>) -> Vec<Space> {
    app.core.state.spaces()
}

#[tauri::command]
async fn space_open(app: State<'_, App>, request: String) -> Result<Space, IpcError> {
    if app.core.catalog.contexts().await.find(&request).is_none() {
        return Err(IpcError {
            kind: ErrorKind::NotFound,
            message: format!("no source lists the context {request:?}"),
        });
    }
    Ok(app.core.state.open_space(&request))
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
            if let Err(error) = channel.send(next) {
                eprintln!("could not send the context's credentials: {error}");
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
        let send = |next: Discovered| {
            if let Err(error) = channel.send(next) {
                eprintln!("could not send the resources: {error}");
            }
        };
        let mut resources = match core.follow_resources(&request).await {
            Ok(resources) => resources,
            Err(error) => return send(Discovered::Failed { error }),
        };
        loop {
            send(resources.next().await);
        }
    });
    app.resources.replace(&webview, follower);
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
fn url_open(handle: AppHandle, request: String) -> Result<(), IpcError> {
    let url = twigo_core::sign_in_url(&request)?;
    handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|error| IpcError {
            kind: ErrorKind::Internal,
            message: format!("could not open {request}: {error}"),
        })
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
            eprintln!("could not print the environment: {error}");
            std::process::exit(1);
        }
        return;
    }

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
                    eprintln!("could not bring the running window forward: {error}");
                }
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init());
    #[cfg(feature = "bench")]
    let builder = builder.plugin(bench::plugin());
    let app = builder
        .setup(|app| {
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
            let core = Core::new(&app.path().app_data_dir()?, &app.path().app_cache_dir()?);
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
            spaces_list,
            space_open,
            state_load,
            state_set,
            cluster_version,
            namespaces_list,
            context_auth_watch,
            resources_watch,
            context_sign_in,
            context_sign_in_cancel,
            exec_review,
            exec_trust,
            url_open,
        ])
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
                eprintln!("could not save the state: {error}");
            }
        }
    });
}
