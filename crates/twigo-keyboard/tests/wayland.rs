//! The watch against a live Wayland compositor, sway, whose keyboard it
//! changes: it runs only on the compositor that `TWIGO_TEST_WAYLAND_DISPLAY`
//! names, such as the one `linux/wayland.sh` starts.
#![cfg(target_os = "linux")]

use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use gtk::glib;
use gtk::prelude::*;
use twigo_keyboard::{KeyboardLayout, LayoutWatch, MainThread};

fn swaymsg(command: &str) {
    let status = Command::new("swaymsg")
        .arg(command)
        .stdout(Stdio::null())
        .status()
        .expect("run swaymsg");
    assert!(status.success(), "swaymsg {command}: {status}");
}

/// Dispatches GDK's events, which carry the keyboard's, until `done` holds.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let context = glib::MainContext::default();
    while !done() {
        assert!(Instant::now() < deadline, "no {what}");
        if !context.iteration(false) {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn next(changes: &mpsc::Receiver<KeyboardLayout>, code: &str, value: &str) -> KeyboardLayout {
    let mut found = None;
    until(&format!("layout where {code} types {value}"), || {
        found = changes
            .try_iter()
            .find(|layout| layout.keys[code].value == value);
        found.is_some()
    });
    found.expect("found")
}

#[test]
#[ignore = "changes the compositor's keyboard: crates/twigo-keyboard/linux/wayland.sh cargo test -p twigo-keyboard --test wayland -- --ignored"]
fn follows_the_keymap_and_the_group() {
    let display = std::env::var("WAYLAND_DISPLAY").expect("WAYLAND_DISPLAY");
    assert_eq!(
        std::env::var("TWIGO_TEST_WAYLAND_DISPLAY").ok().as_deref(),
        Some(display.as_str()),
        "TWIGO_TEST_WAYLAND_DISPLAY must name the compositor this test may change"
    );
    swaymsg("input type:keyboard xkb_layout fr");
    gtk::init().expect("GTK on the Wayland display");
    let watch = LayoutWatch::start(MainThread::new().expect("GTK runs on this thread"))
        .expect("start the watch");
    let (send, changes) = mpsc::channel();
    let (current, _subscription) = watch.subscribe(move |layout| {
        send.send(layout.clone()).expect("the test listens");
    });
    assert_eq!(current.id, "French");
    assert_eq!(current.keys["KeyQ"].value, "a");

    swaymsg("input type:keyboard xkb_layout \"us,ua\"");
    assert_eq!(next(&changes, "KeyK", "k").id, "English (US)");

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.show();
    until("focus on the window", || window.is_active());
    swaymsg("input type:keyboard xkb_switch_layout 1");
    assert_eq!(next(&changes, "KeyK", "л").id, "Ukrainian");
}
