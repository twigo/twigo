//! Records the layouts of the mock backend from layouts installed on this
//! Mac, read without selecting them: the input source stays as it is.
//!
//! cargo run -p twigo-keyboard --example record

#[cfg(target_os = "macos")]
fn main() {
    use std::path::Path;

    use twigo_keyboard::{MainThread, macos};

    const LAYOUTS: [(&str, &str); 5] = [
        ("us", "com.apple.keylayout.US"),
        ("ukrainian", "com.apple.keylayout.Ukrainian"),
        ("german", "com.apple.keylayout.German"),
        ("french", "com.apple.keylayout.French"),
        ("dvorak", "com.apple.keylayout.Dvorak"),
    ];

    let main = MainThread::new().expect("an example's main runs on the main thread");
    let dir =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/src/mock/layouts");
    std::fs::create_dir_all(&dir).expect("create the layouts directory");
    for (name, id) in LAYOUTS {
        let layout = macos::installed(main, id).unwrap_or_else(|error| panic!("{name}: {error}"));
        let json = serde_json::to_string_pretty(&layout).expect("a layout serializes");
        let path = dir.join(format!("{name}.json"));
        std::fs::write(&path, json + "\n").expect("write the layout");
        println!("{}", path.display());
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("the layouts are recorded from macOS's installed layouts; run this on a Mac");
    std::process::exit(1);
}
