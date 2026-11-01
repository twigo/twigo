//! xkbcommon-x11 over a connection of our own. The X server keeps one XKB
//! state per keyboard for every client, so XKB events on any connection
//! report the keymap and group changes; a thread waits for them.

use std::ffi::CString;
use std::sync::mpsc;
use std::thread;

use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xkb::{
    ConnectionExt as _, EventType, MapPart, SelectEventsAux, SelectEventsAuxStateNotify, StatePart,
};
use x11rb::xcb_ffi::XCBConnection;
use xkbcommon::xkb::{self, x11 as xkb_x11};

use super::xkb::Reader;
use crate::Error;
use crate::watch::Shared;

pub(super) fn observe(display: &str, shared: &'static Shared) -> Result<(), Error> {
    let display = CString::new(display)
        .map_err(|_| Error::Unavailable(format!("an X display name with a NUL: {display:?}")))?;
    let (ready, started) = mpsc::channel();
    thread::Builder::new()
        .name("keyboard-layout".into())
        .spawn(move || {
            let mut keyboard = match Keyboard::connect(&display) {
                Ok(keyboard) => keyboard,
                Err(error) => {
                    ready
                        .send(Err(error))
                        .expect("observe waits for the thread");
                    return;
                }
            };
            shared.publish(keyboard.read());
            ready.send(Ok(())).expect("observe waits for the thread");
            keyboard.follow(shared);
        })
        .map_err(|error| Error::Unavailable(format!("cannot start the X11 thread: {error}")))?;
    started
        .recv()
        .map_err(|_| Error::Unavailable("the X11 thread ended before reading the keymap".into()))?
}

struct Keyboard {
    connection: XCBConnection,
    device: i32,
    reader: Reader,
    keymap: xkb::Keymap,
    group: xkb::LayoutIndex,
}

impl Keyboard {
    fn connect(display: &CString) -> Result<Self, Error> {
        let (connection, _) =
            XCBConnection::connect(Some(display)).map_err(|error| unavailable(&error))?;
        let (mut major, mut minor, mut base_event, mut base_error) = (0, 0, 0, 0);
        let supported = xkb_x11::setup_xkb_extension(
            &connection,
            xkb_x11::MIN_MAJOR_XKB_VERSION,
            xkb_x11::MIN_MINOR_XKB_VERSION,
            xkb_x11::SetupXkbExtensionFlags::NoFlags,
            &mut major,
            &mut minor,
            &mut base_event,
            &mut base_error,
        );
        if !supported {
            return Err(Error::Unavailable(
                "the X server has no XKB extension".into(),
            ));
        }
        let device = xkb_x11::get_core_keyboard_device_id(&connection);
        let device_spec = u16::try_from(device)
            .map_err(|_| Error::Unavailable("the X server has no core keyboard".into()))?;
        // Group changes only, rather than every modifier press.
        let group_parts = StatePart::GROUP_STATE
            | StatePart::GROUP_BASE
            | StatePart::GROUP_LATCH
            | StatePart::GROUP_LOCK;
        let details = SelectEventsAux::new().state_notify(SelectEventsAuxStateNotify {
            affect_state: group_parts,
            state_details: group_parts,
        });
        connection
            .xkb_select_events(
                device_spec,
                EventType::from(0u16),
                EventType::NEW_KEYBOARD_NOTIFY | EventType::MAP_NOTIFY,
                MapPart::from(0u16),
                MapPart::from(0u16),
                &details,
            )
            .map_err(|error| unavailable(&error))?
            .check()
            .map_err(|error| unavailable(&error))?;
        let reader = Reader::new();
        let keymap = keymap(&reader.context, &connection, device)?;
        let group = connection
            .xkb_get_state(device_spec)
            .map_err(|error| unavailable(&error))?
            .reply()
            .map_err(|error| unavailable(&error))?
            .group;
        Ok(Self {
            connection,
            device,
            reader,
            keymap,
            group: u8::from(group).into(),
        })
    }

    fn read(&self) -> crate::KeyboardLayout {
        self.reader.read(&self.keymap, self.group)
    }

    fn follow(&mut self, shared: &Shared) {
        loop {
            let event = match self.connection.wait_for_event() {
                Ok(event) => event,
                Err(error) => {
                    eprintln!("stopped following the keyboard layout: {error}");
                    return;
                }
            };
            match event {
                Event::XkbNewKeyboardNotify(_) | Event::XkbMapNotify(_) => {
                    match keymap(&self.reader.context, &self.connection, self.device) {
                        Ok(keymap) => self.keymap = keymap,
                        Err(error) => {
                            eprintln!("keeping the previous keyboard layout: {error}");
                            continue;
                        }
                    }
                }
                Event::XkbStateNotify(state) => self.group = u8::from(state.group).into(),
                _ => continue,
            }
            shared.publish(self.read());
        }
    }
}

fn keymap(
    context: &xkb::Context,
    connection: &XCBConnection,
    device: i32,
) -> Result<xkb::Keymap, Error> {
    // xkbcommon's safe wrapper does not check for NULL.
    let keymap = unsafe {
        xkb_x11::ffi::xkb_x11_keymap_new_from_device(
            context.get_raw_ptr(),
            connection.get_raw_xcb_connection().cast(),
            device,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
    };
    if keymap.is_null() {
        return Err(Error::Unavailable(
            "the X server's keymap does not compile".into(),
        ));
    }
    // SAFETY: a new keymap with its one reference.
    Ok(unsafe { xkb::Keymap::from_raw_ptr(keymap) })
}

fn unavailable(error: &dyn std::fmt::Display) -> Error {
    Error::Unavailable(format!("X11: {error}"))
}
