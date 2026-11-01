fn main() {
    let commands = tauri_build::AppManifest::new().commands(&["keyboard_layout_watch"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))
        .expect("tauri-build");
}
