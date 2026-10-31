// Without it, Windows opens a console next to the release app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::ipc::Channel;
use tauri::{Manager, State, Webview};
use twigo_ipc::{IpcError, KeyboardLayout};
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

fn main() {
    tauri::Builder::default()
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
        .setup(|app| {
            let main = MainThread::new().ok_or("Tauri ran setup off the main thread")?;
            app.manage(Keyboard {
                watch: LayoutWatch::start(main),
                subscriptions: Mutex::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![keyboard_layout_watch])
        .run(tauri::generate_context!())
        .expect("error while running Twigo");
}
