//! A `wl_keyboard` of GDK's own connection, as Firefox keeps one. A
//! compositor sends the keymap to every keyboard object of a client, and
//! the modifiers event, which carries the active group, to every keyboard
//! object of the focused one (mutter's `meta-wayland-keyboard.c`, wlroots'
//! `wlr_seat_keyboard.c`); a second connection would never be focused. The
//! object stays on GDK's default queue, so GDK dispatches its events on the
//! main thread.

use std::cell::RefCell;
use std::ffi::{c_int, c_void};
use std::os::fd::{FromRawFd, OwnedFd};
use std::ptr;

use gtk::gdk;
use gtk::glib::object::ObjectType;
use gtk::prelude::*;
use wayland_sys::client::{
    wl_display, wl_display_roundtrip, wl_proxy, wl_proxy_add_listener, wl_proxy_get_version,
    wl_proxy_marshal_constructor_versioned,
};
use wayland_sys::common::{wl_array, wl_interface};
use xkbcommon::xkb;

use super::xkb::Reader;
use crate::watch::Shared;
use crate::{Error, MainThread};

#[link(name = "wayland-client")]
unsafe extern "C" {
    static wl_keyboard_interface: wl_interface;
}

// From `wayland-client-protocol.h`.
const WL_SEAT_GET_KEYBOARD: u32 = 1;
const WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1: u32 = 1;

/// `struct wl_keyboard_listener`. libwayland calls every slot, so each event
/// has a function, most of them empty.
#[repr(C)]
struct Listener {
    keymap: unsafe extern "C" fn(*mut c_void, *mut wl_proxy, u32, c_int, u32),
    enter: unsafe extern "C" fn(*mut c_void, *mut wl_proxy, u32, *mut wl_proxy, *mut wl_array),
    leave: unsafe extern "C" fn(*mut c_void, *mut wl_proxy, u32, *mut wl_proxy),
    key: unsafe extern "C" fn(*mut c_void, *mut wl_proxy, u32, u32, u32, u32),
    modifiers: unsafe extern "C" fn(*mut c_void, *mut wl_proxy, u32, u32, u32, u32, u32),
    repeat_info: unsafe extern "C" fn(*mut c_void, *mut wl_proxy, i32, i32),
}

static LISTENER: Listener = Listener {
    keymap,
    enter,
    leave,
    key,
    modifiers,
    repeat_info,
};

struct Keyboard {
    shared: &'static Shared,
    reader: Reader,
    keymap: Option<xkb::Keymap>,
    group: xkb::LayoutIndex,
    published: Option<xkb::LayoutIndex>,
}

impl Keyboard {
    fn publish(&mut self) {
        let Some(keymap) = &self.keymap else {
            return;
        };
        if self.published != Some(self.group) {
            self.shared.publish(self.reader.read(keymap, self.group));
            self.published = Some(self.group);
        }
    }
}

thread_local! {
    static KEYBOARD: RefCell<Option<Keyboard>> = const { RefCell::new(None) };
}

pub(super) fn observe(
    _main: MainThread,
    display: &gdk::Display,
    shared: &'static Shared,
) -> Result<(), Error> {
    if KEYBOARD.with_borrow(Option::is_some) {
        return Err(Error::Unavailable("the compositor sent no keymap".into()));
    }
    let seat = display
        .default_seat()
        .filter(|seat| {
            seat.capabilities()
                .contains(gdk::SeatCapabilities::KEYBOARD)
        })
        .ok_or_else(|| Error::Unavailable("the Wayland seat has no keyboard".into()))?;
    // SAFETY: GDK hands out its own seat and display, which live as long as
    // the display stays open, as the app's does.
    let (wl_seat, wl_display) = unsafe {
        (
            gdk_wayland_sys::gdk_wayland_seat_get_wl_seat(seat.as_ptr().cast()).cast::<wl_proxy>(),
            gdk_wayland_sys::gdk_wayland_display_get_wl_display(display.as_ptr().cast())
                .cast::<wl_display>(),
        )
    };
    KEYBOARD.set(Some(Keyboard {
        shared,
        reader: Reader::new(),
        keymap: None,
        group: 0,
        published: None,
    }));
    // SAFETY: `wl_seat_get_keyboard` of `wayland-client-protocol.h`; the new
    // proxy inherits the seat's queue, GDK's default one.
    let keyboard = unsafe {
        wl_proxy_marshal_constructor_versioned(
            wl_seat,
            WL_SEAT_GET_KEYBOARD,
            &raw const wl_keyboard_interface,
            wl_proxy_get_version(wl_seat),
            ptr::null_mut::<c_void>(),
        )
    };
    if keyboard.is_null() {
        return Err(Error::Unavailable("wl_seat.get_keyboard failed".into()));
    }
    // SAFETY: `LISTENER` matches `struct wl_keyboard_listener` and is static.
    let added = unsafe {
        wl_proxy_add_listener(
            keyboard,
            ptr::from_ref(&LISTENER).cast_mut().cast(),
            ptr::null_mut(),
        )
    };
    if added != 0 {
        return Err(Error::Unavailable(
            "cannot listen to the Wayland keyboard".into(),
        ));
    }
    // The compositor answers get_keyboard with the keymap and, if the app
    // has focus, the modifiers.
    if unsafe { wl_display_roundtrip(wl_display) } < 0 {
        return Err(Error::Unavailable("the Wayland roundtrip failed".into()));
    }
    if KEYBOARD.with_borrow(|keyboard| keyboard.as_ref().is_some_and(|k| k.keymap.is_none())) {
        return Err(Error::Unavailable("the compositor sent no keymap".into()));
    }
    Ok(())
}

unsafe extern "C" fn keymap(
    _data: *mut c_void,
    _keyboard: *mut wl_proxy,
    format: u32,
    fd: c_int,
    size: u32,
) {
    // SAFETY: the event hands the client this descriptor to own.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    KEYBOARD.with_borrow_mut(|keyboard| {
        let Some(keyboard) = keyboard else { return };
        if format != WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 {
            eprintln!("keeping the previous keyboard layout: a keymap in format {format}");
            return;
        }
        // SAFETY: `fd` and `size` describe the keymap as the event sent it.
        let compiled = unsafe {
            xkb::Keymap::new_from_fd(
                &keyboard.reader.context,
                fd,
                size as usize,
                xkb::KEYMAP_FORMAT_TEXT_V1,
                xkb::KEYMAP_COMPILE_NO_FLAGS,
            )
        };
        match compiled {
            Ok(Some(keymap)) => {
                keyboard.keymap = Some(keymap);
                keyboard.published = None;
                keyboard.publish();
            }
            Ok(None) => {
                eprintln!("keeping the previous keyboard layout: its keymap does not compile")
            }
            Err(error) => eprintln!("keeping the previous keyboard layout: {error}"),
        }
    });
}

unsafe extern "C" fn modifiers(
    _data: *mut c_void,
    _keyboard: *mut wl_proxy,
    _serial: u32,
    _depressed: u32,
    _latched: u32,
    _locked: u32,
    group: u32,
) {
    KEYBOARD.with_borrow_mut(|keyboard| {
        if let Some(keyboard) = keyboard {
            keyboard.group = group;
            keyboard.publish();
        }
    });
}

unsafe extern "C" fn enter(
    _data: *mut c_void,
    _keyboard: *mut wl_proxy,
    _serial: u32,
    _surface: *mut wl_proxy,
    _keys: *mut wl_array,
) {
}

unsafe extern "C" fn leave(
    _data: *mut c_void,
    _keyboard: *mut wl_proxy,
    _serial: u32,
    _surface: *mut wl_proxy,
) {
}

unsafe extern "C" fn key(
    _data: *mut c_void,
    _keyboard: *mut wl_proxy,
    _serial: u32,
    _time: u32,
    _key: u32,
    _state: u32,
) {
}

unsafe extern "C" fn repeat_info(
    _data: *mut c_void,
    _keyboard: *mut wl_proxy,
    _rate: i32,
    _delay: i32,
) {
}
