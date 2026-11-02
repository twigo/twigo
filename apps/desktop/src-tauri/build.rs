fn main() {
    let commands = tauri_build::AppManifest::new().commands(&[
        "keyboard_layout_watch",
        "shell_environment_watch",
        "shell_environment_retry",
        "contexts_watch",
        "spaces_list",
        "space_open",
        "state_load",
        "state_set",
        "cluster_version",
        "namespaces_list",
        "context_auth_watch",
        "resources_watch",
        "list_subscribe",
        "list_set_window",
        "list_ack",
        "list_unsubscribe",
        "object_open",
        "object_set_parts",
        "object_ack",
        "object_values",
        "object_close",
        "context_sign_in",
        "context_sign_in_cancel",
        "exec_review",
        "exec_trust",
        "url_open",
    ]);
    let mut attributes = tauri_build::Attributes::new().app_manifest(commands);
    // An inlined plugin keeps its permissions in OUT_DIR, so builds without the feature have no
    // trace of the bench's commands.
    if std::env::var_os("CARGO_FEATURE_BENCH").is_some() {
        attributes = attributes.plugin(
            "twigo-bench",
            tauri_build::InlinedPlugin::new().commands(&["write", "idle"]),
        );
    }
    tauri_build::try_build(attributes).expect("tauri-build");
}
