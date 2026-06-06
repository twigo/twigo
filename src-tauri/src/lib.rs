mod nats;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(nats::connection::ConnState::default())
        .invoke_handler(tauri::generate_handler![
            nats::context::list_contexts,
            nats::context::default_context_dir,
            nats::connection::connect,
            nats::connection::disconnect,
            nats::connection::list_connections
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
