//! The bench mode of `bench/harness.sh` (ARCHITECTURE 3.8), in builds with the `bench` feature
//! only. `TWIGO_BENCH` names the directory the webview's driver writes into: `write` stores one
//! JSON file, and `idle` hides the window, says so in `idle.json`, and quits after `IDLE`, the
//! time the harness samples idle CPU in.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::ipc::CapabilityBuilder;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

const IDLE: Duration = Duration::from_secs(45);

struct Dir(PathBuf);

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("twigo-bench")
        .invoke_handler(tauri::generate_handler![write, idle])
        .setup(|app, _| {
            let dir = std::env::var_os("TWIGO_BENCH")
                .ok_or("a bench build runs only with TWIGO_BENCH set to a directory")?;
            app.manage(Dir(dir.into()));
            app.add_capability(
                CapabilityBuilder::new("bench")
                    .window("main")
                    .permission("twigo-bench:allow-write")
                    .permission("twigo-bench:allow-idle"),
            )?;
            Ok(())
        })
        .build()
}

fn store(dir: &Dir, name: &str, value: &serde_json::Value) -> Result<(), String> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
        return Err(format!("{name:?} is not a bench file name"));
    }
    let partial = dir.0.join(format!(".{name}.json"));
    let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&partial, json).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, dir.0.join(format!("{name}.json"))).map_err(|e| e.to_string())
}

#[tauri::command]
fn write(name: String, value: serde_json::Value, dir: State<'_, Dir>) -> Result<(), String> {
    store(&dir, &name, &value)
}

#[tauri::command]
fn idle<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    dir: State<'_, Dir>,
) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    let at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let marker = serde_json::json!({ "atMs": at_ms, "seconds": IDLE.as_secs() });
    store(&dir, "idle", &marker)?;
    std::thread::spawn(move || {
        std::thread::sleep(IDLE);
        app.exit(0);
    });
    Ok(())
}
