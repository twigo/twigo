fn main() {
    let commands = tauri_build::AppManifest::new().commands(&["keyboard_layout_watch"]);
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
