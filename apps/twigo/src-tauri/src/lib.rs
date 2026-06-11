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
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(nats::connection::ConnState::default())
        .manage(nats::subjects::SubjectWatch::default())
        .manage(nats::subscription::SubState::default())
        .invoke_handler(tauri::generate_handler![
            nats::context::list_contexts,
            nats::context::default_context_dir,
            nats::connection::connect,
            nats::connection::disconnect,
            nats::connection::list_connections,
            nats::connection::server_info,
            nats::connection::conn_info,
            nats::subjects::start_subject_watch,
            nats::subjects::stop_subject_watch,
            nats::subscription::subscribe,
            nats::subscription::unsubscribe,
            nats::publish::publish,
            nats::publish::request,
            nats::jetstream::js_list_streams,
            nats::jetstream::js_stream_detail,
            nats::jetstream::js_list_consumers,
            nats::jetstream::js_consumer_detail,
            nats::jetstream::js_get_messages,
            nats::jetstream::js_create_stream,
            nats::jetstream::js_update_stream,
            nats::jetstream::js_create_consumer,
            nats::jetstream::js_purge_stream,
            nats::jetstream::js_delete_stream,
            nats::jetstream::js_delete_consumer,
            nats::jetstream::js_pause_consumer,
            nats::jetstream::js_resume_consumer,
            nats::jetstream::js_delete_message,
            nats::kv::kv_list_buckets,
            nats::kv::kv_bucket_info,
            nats::kv::kv_list_keys,
            nats::kv::kv_get_entry,
            nats::kv::kv_history,
            nats::kv::kv_put,
            nats::kv::kv_create,
            nats::kv::kv_delete,
            nats::kv::kv_purge,
            nats::kv::kv_create_bucket,
            nats::kv::kv_delete_bucket,
            nats::obj::obj_list_buckets,
            nats::obj::obj_list_objects,
            nats::obj::obj_object_info,
            nats::obj::obj_get_object,
            nats::obj::obj_put_object,
            nats::obj::obj_delete,
            nats::obj::obj_create_bucket,
            nats::obj::obj_delete_bucket
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
