//! The bench mode of `bench/harness.sh` (ARCHITECTURE 3.8), in builds with the `bench` feature
//! only. `TWIGO_BENCH` names the directory the webview's driver writes into: `write` stores one
//! JSON file, and `idle` hides the window, says so in `idle.json`, and quits after `IDLE`, the
//! time the harness samples idle CPU in.
//!
//! A run leaves the desktop alone: the window has 40 pt on screen, at the left edge
//! (`tauri.bench.conf.json`), behind other windows, and the app takes no focus. WebKit paints
//! nothing in a window it counts as covered, so it is told not to look.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::ipc::CapabilityBuilder;
use tauri::plugin::{Builder, TauriPlugin};
#[cfg(target_os = "macos")]
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

const IDLE: Duration = Duration::from_secs(45);

struct Dir(PathBuf);

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("twigo-bench")
        .invoke_handler(tauri::generate_handler![write, idle])
        .setup(|app, _| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
                stay_awake();
            }
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
        .on_page_load(|webview, payload| {
            #[cfg(target_os = "macos")]
            if matches!(payload.event(), PageLoadEvent::Started)
                && let Err(error) = webview.with_webview(paint_when_covered)
            {
                eprintln!("could not keep the bench page visible: {error}");
            }
        })
        .build()
}

/// App Nap slows an app whose windows others cover.
#[cfg(target_os = "macos")]
fn stay_awake() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    const USER_INITIATED: u64 = 0x00FF_FFFF;
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let reason: *mut AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: c"bench".as_ptr()];
        let activity: *mut AnyObject =
            msg_send![&*info, beginActivityWithOptions: USER_INITIATED, reason: &*reason];
        let _: *mut AnyObject = msg_send![&*activity, retain];
    }
}

/// The setter only stores its flag, so the view hides and shows for WebKit to read it
/// (`WebViewImpl.h`, docs/bench.md).
#[cfg(target_os = "macos")]
fn paint_when_covered(platform: tauri::webview::PlatformWebview) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let view = platform.inner().cast::<AnyObject>();
    unsafe {
        let _: () = msg_send![&*view, _setWindowOcclusionDetectionEnabled: false];
        let _: () = msg_send![&*view, setHidden: true];
        let _: () = msg_send![&*view, setHidden: false];
    }
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
