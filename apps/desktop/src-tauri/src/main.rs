// Without it, Windows opens a console next to the release app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "bench")]
mod bench;

use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tauri::{Manager, State, Webview};
use twigo_env::Environment;
use twigo_ipc::{IpcError, KeyboardLayout, ShellEnvironment};
use twigo_keyboard::{LayoutWatch, MainThread, Subscription};

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

/// The login shell's environment and one follower per webview, which a
/// reload replaces.
struct Shell {
    environment: Arc<Environment>,
    followers: Mutex<HashMap<String, JoinHandle<()>>>,
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
    let replaced = shell
        .followers
        .lock()
        .expect("followers lock")
        .insert(webview.label().to_owned(), follower);
    if let Some(replaced) = replaced {
        replaced.abort();
    }
    Ok(current)
}

#[tauri::command]
async fn shell_environment_retry(shell: State<'_, Shell>) -> Result<(), IpcError> {
    shell.environment.retry().await;
    Ok(())
}

fn main() {
    // Before Tauri, so that the single-instance plugin never sees the login
    // shell's copy of Twigo and no window opens.
    let args: Vec<OsString> = std::env::args_os().collect();
    if let [_, flag, marker] = &args[..]
        && flag == twigo_env::DUMP_ENV
    {
        if let Err(error) = twigo_env::dump(marker) {
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
        .plugin(tauri_plugin_window_state::Builder::default().build());
    #[cfg(feature = "bench")]
    let builder = builder.plugin(bench::plugin());
    builder
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
            app.manage(Shell {
                environment,
                followers: Mutex::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keyboard_layout_watch,
            shell_environment_watch,
            shell_environment_retry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Twigo");
}
