mod nats;

use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("twigo=info,async_nats=warn")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(nats::connection::ConnState::default())
        .manage(nats::subjects::SubjectWatch::default())
        .manage(nats::subscription::SubState::default())
        .invoke_handler(tauri::generate_handler![
            nats::context::list_contexts,
            nats::context::default_context_dir,
            nats::connection::connect,
            nats::connection::disconnect,
            nats::connection::list_connections,
            nats::subjects::start_subject_watch,
            nats::subjects::stop_subject_watch,
            nats::subscription::subscribe,
            nats::subscription::unsubscribe
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
