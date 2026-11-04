//! The watch against a live Wayland compositor, sway, whose keyboard it
//! changes: it runs only on the compositor that `TWIGO_TEST_WAYLAND_DISPLAY`
//! names, such as the one `linux/wayland.sh` starts.
#![cfg(target_os = "linux")]

use std::io::Write;
use std::os::fd::AsFd;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use gtk::glib;
use gtk::prelude::*;
use twigo_keyboard::{KeyboardLayout, LayoutWatch, MainThread};
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::wl_keyboard::KeymapFormat;
use wayland_client::protocol::wl_registry::{self, WlRegistry};
use wayland_client::protocol::wl_seat::WlSeat;
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle, delegate_noop};
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1;
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1;
use xkbcommon::xkb;

/// The seat's keyboard, a virtual keyboard of the test's own whose keymap
/// and group it sets: sway 1.11 applies no input config to a virtual
/// keyboard (`sway_keyboard_configure` in `sway/input/keyboard.c`), and
/// headless sway has no other.
struct Keyboard {
    queue: EventQueue<Globals>,
    keyboard: ZwpVirtualKeyboardV1,
}

struct Globals;

impl Dispatch<WlRegistry, GlobalListContents> for Globals {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

delegate_noop!(Globals: ignore WlSeat);
delegate_noop!(Globals: ZwpVirtualKeyboardManagerV1);
delegate_noop!(Globals: ZwpVirtualKeyboardV1);

impl Keyboard {
    fn new() -> Self {
        let connection = Connection::connect_to_env().expect("connect to the compositor");
        let (globals, queue) = registry_queue_init::<Globals>(&connection).expect("its globals");
        let handle = queue.handle();
        let seat: WlSeat = globals.bind(&handle, 1..=1, ()).expect("a seat");
        let manager: ZwpVirtualKeyboardManagerV1 =
            globals.bind(&handle, 1..=1, ()).expect("virtual keyboards");
        let keyboard = manager.create_virtual_keyboard(&seat, &handle, ());
        Self { queue, keyboard }
    }

    /// Gives it the keymap of `layouts`, named as `setxkbmap -layout` names them.
    fn layouts(&mut self, layouts: &str) {
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let keymap = xkb::Keymap::new_from_names(
            &context,
            "",
            "",
            layouts,
            "",
            None,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
        .expect("the layouts compile");
        let mut text = keymap
            .get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1)
            .into_bytes();
        text.push(0);
        let mut file = tempfile::tempfile().expect("a file for the keymap");
        file.write_all(&text).expect("write the keymap");
        let size = u32::try_from(text.len()).expect("a keymap's size");
        self.keyboard
            .keymap(KeymapFormat::XkbV1.into(), file.as_fd(), size);
        self.queue
            .roundtrip(&mut Globals)
            .expect("the compositor takes the keymap");
    }

    /// Locks its layout `group`, as switching layouts does.
    fn group(&mut self, group: u32) {
        self.keyboard.modifiers(0, 0, 0, group);
        self.queue
            .roundtrip(&mut Globals)
            .expect("the compositor takes the group");
    }
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
    let mut keyboard = Keyboard::new();
    keyboard.layouts("fr");
    gtk::init().expect("GTK on the Wayland display");
    let watch = LayoutWatch::start(MainThread::new().expect("GTK runs on this thread"))
        .expect("start the watch");
    let (send, changes) = mpsc::channel();
    let (current, _subscription) = watch.subscribe(move |layout| {
        send.send(layout.clone()).expect("the test listens");
    });
    assert_eq!(current.id, "French");
    assert_eq!(current.keys["KeyQ"].value, "a");

    keyboard.layouts("us,ua");
    assert_eq!(next(&changes, "KeyK", "k").id, "English (US)");

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.show();
    until("focus on the window", || window.is_active());
    keyboard.group(1);
    assert_eq!(next(&changes, "KeyK", "л").id, "Ukrainian");
}
