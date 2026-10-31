//! The watch against a live X server, whose keymap and group it changes:
//! it runs only on the display that `TWIGO_TEST_X11_DISPLAY` names, such as
//! one `xvfb-run` starts.
#![cfg(target_os = "linux")]

use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use twigo_keyboard::{KeyboardLayout, LayoutWatch, MainThread};
use x11rb::protocol::xkb::{self, ConnectionExt as _};
use x11rb::xcb_ffi::XCBConnection;

fn setxkbmap(layout: &str) {
    let status = Command::new("setxkbmap")
        .args(["-layout", layout])
        .status()
        .expect("run setxkbmap");
    assert!(status.success(), "setxkbmap -layout {layout}: {status}");
}

fn next(changes: &mpsc::Receiver<KeyboardLayout>, code: &str, value: &str) -> KeyboardLayout {
    loop {
        let layout = changes
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| panic!("no layout where {code} types {value}"));
        if layout.keys[code].value == value {
            return layout;
        }
    }
}

#[test]
#[ignore = "changes the X server's keymap: xvfb-run sh -c 'TWIGO_TEST_X11_DISPLAY=$DISPLAY cargo test -p twigo-keyboard --test x11 -- --ignored'"]
fn follows_the_keymap_and_the_group() {
    let display = std::env::var("DISPLAY").expect("DISPLAY");
    assert_eq!(
        std::env::var("TWIGO_TEST_X11_DISPLAY").ok().as_deref(),
        Some(display.as_str()),
        "TWIGO_TEST_X11_DISPLAY must name the display this test may change"
    );
    setxkbmap("us");
    gtk::init().expect("GTK on the X display");
    let watch = LayoutWatch::start(MainThread::new().expect("GTK runs on this thread"))
        .expect("start the watch");
    let (send, changes) = mpsc::channel();
    let (current, _subscription) = watch.subscribe(move |layout| {
        send.send(layout.clone()).expect("the test listens");
    });
    assert_eq!(current.keys["KeyQ"].value, "q");

    setxkbmap("fr");
    assert_eq!(next(&changes, "KeyQ", "a").id, "French");

    setxkbmap("us,ua");
    assert_eq!(next(&changes, "KeyK", "k").id, "English (US)");
    let (connection, _) = XCBConnection::connect(None).expect("connect to the X display");
    connection
        .xkb_use_extension(1, 0)
        .expect("XKB")
        .reply()
        .expect("XKB 1.0");
    connection
        .xkb_latch_lock_state(
            xkb::ID::USE_CORE_KBD.into(),
            0u16.into(),
            0u16.into(),
            true,
            xkb::Group::M2,
            0u16.into(),
            false,
            0,
        )
        .expect("lock the second group")
        .check()
        .expect("the server locks the group");
    assert_eq!(next(&changes, "KeyK", "л").id, "Ukrainian");
}
