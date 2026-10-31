// Without it, Windows opens a console next to the release app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

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
        .run(tauri::generate_context!())
        .expect("error while running Twigo");
}
