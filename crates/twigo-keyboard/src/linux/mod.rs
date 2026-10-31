//! xkbcommon reads what the keys type, from the keymap of the display GDK
//! is on. GDK 3 exposes neither the active layout (XKB group) nor, on X11, a
//! signal when only the group changes, so the keymap and the group come
//! from the X server or the compositor directly.

mod wayland;
mod x11;
mod xkb;

use gtk::gdk;
use gtk::glib::translate::FromGlib;
use gtk::glib::{self, prelude::*};

use crate::watch::Shared;
use crate::{Error, MainThread};

pub use xkb::from_names;

pub(crate) fn is_main_thread() -> bool {
    gtk::is_initialized_main_thread()
}

pub(crate) fn observe(main: MainThread, shared: &'static Shared) -> Result<(), Error> {
    let display =
        gdk::Display::default().ok_or_else(|| Error::Unavailable("GDK has no display".into()))?;
    let backend = display.type_();
    // SAFETY: plain GType getters of GDK's backends.
    let (wayland, x11) = unsafe {
        (
            glib::Type::from_glib(gdk_wayland_sys::gdk_wayland_display_get_type()),
            glib::Type::from_glib(gdk_x11_sys::gdk_x11_display_get_type()),
        )
    };
    if backend.is_a(wayland) {
        wayland::observe(main, &display, shared)
    } else if backend.is_a(x11) {
        x11::observe(&display.name(), shared)
    } else {
        Err(Error::Unavailable(format!(
            "GDK's {} has no keymap to read",
            backend.name()
        )))
    }
}
