//! A few telling keys of named layouts: macOS reads them from its installed
//! layouts, Linux compiles them from XKB names. Windows can read a layout
//! only once it is loaded into the session, so it has no cases. Without the
//! test harness, since TIS must run on the main thread.

#[cfg(any(target_os = "macos", target_os = "linux"))]
use twigo_keyboard::KeyboardLayout;

/// (layout, code, value, with Shift)
#[cfg(any(target_os = "macos", target_os = "linux"))]
const TYPED: &[(&str, &str, &str, &str)] = &[
    ("us", "KeyQ", "q", "Q"),
    ("us", "Slash", "/", "?"),
    ("french", "KeyQ", "a", "A"),
    ("french", "Digit1", "&", "1"),
    ("french", "BracketLeft", "^", "¨"),
    ("german", "KeyY", "z", "Z"),
    ("german", "Semicolon", "ö", "Ö"),
    ("ukrainian", "KeyK", "л", "Л"),
    ("ukrainian", "KeyQ", "й", "Й"),
    ("dvorak", "KeyK", "t", "T"),
    ("dvorak", "KeyQ", "'", "\""),
];

/// (layout, code, with AltGr, with Shift and AltGr): Option on macOS.
#[cfg(target_os = "macos")]
const WITH_ALT_GR: &[(&str, &str, &str, &str)] = &[
    ("us", "KeyQ", "œ", "Œ"),
    ("us", "KeyE", "´", "´"),
    ("german", "KeyL", "@", "ﬂ"),
    ("french", "KeyQ", "æ", "Æ"),
];
#[cfg(target_os = "linux")]
const WITH_ALT_GR: &[(&str, &str, &str, &str)] = &[
    ("german", "KeyQ", "@", "Ω"),
    ("german", "KeyE", "€", "€"),
    ("french", "Digit0", "@", "°"),
];

#[cfg(target_os = "macos")]
fn read(name: &str) -> KeyboardLayout {
    let id = match name {
        "us" => "com.apple.keylayout.US",
        "french" => "com.apple.keylayout.French",
        "german" => "com.apple.keylayout.German",
        "ukrainian" => "com.apple.keylayout.Ukrainian",
        "dvorak" => "com.apple.keylayout.Dvorak",
        _ => unreachable!("{name}"),
    };
    let main = twigo_keyboard::MainThread::new().expect("a test's main runs on the main thread");
    twigo_keyboard::macos::installed(main, id).unwrap_or_else(|error| panic!("{name}: {error}"))
}

#[cfg(target_os = "linux")]
fn read(name: &str) -> KeyboardLayout {
    let (layout, variant) = match name {
        "us" => ("us", ""),
        "french" => ("fr", ""),
        "german" => ("de", ""),
        "ukrainian" => ("ua", ""),
        "dvorak" => ("us", "dvorak"),
        _ => unreachable!("{name}"),
    };
    twigo_keyboard::linux::from_names(layout, variant)
        .unwrap_or_else(|error| panic!("{name}: {error}"))
}

#[cfg(windows)]
fn main() {
    println!("no named layouts on Windows");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn main() {
    let mut checked = 0;
    for name in ["us", "french", "german", "ukrainian", "dvorak"] {
        let layout = read(name);
        assert_eq!(layout.keys.len(), 50, "{name}: every writing-system key");
        let key = |code: &str| {
            layout
                .keys
                .get(code)
                .unwrap_or_else(|| panic!("{name} has no {code}"))
        };
        for &(_, code, value, shift) in TYPED.iter().filter(|case| case.0 == name) {
            let mapping = key(code);
            assert_eq!(
                (mapping.value.as_str(), mapping.with_shift.as_str()),
                (value, shift),
                "{name} {code}"
            );
            checked += 1;
        }
        for &(_, code, alt_gr, shift_alt_gr) in WITH_ALT_GR.iter().filter(|case| case.0 == name) {
            let mapping = key(code);
            assert_eq!(
                (
                    mapping.with_alt_gr.as_str(),
                    mapping.with_shift_alt_gr.as_str()
                ),
                (alt_gr, shift_alt_gr),
                "{name} {code} with AltGr"
            );
            checked += 1;
        }
        println!("{name}: {}", layout.id);
    }
    println!("{checked} keys as expected");
}
