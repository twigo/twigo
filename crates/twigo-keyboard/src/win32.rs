//! `ToUnicodeEx` reads what the keys of a keyboard layout (HKL) type, and a
//! TSF profile activation sink hears when the thread switches layouts, as
//! VS Code's native-keymap does. Windows keeps an input language per GUI
//! thread, so both run on the one whose windows take keyboard input.

use std::cell::RefCell;
use std::collections::BTreeMap;

use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayout, HKL, MAPVK_VSC_TO_VK, MapVirtualKeyExW, ToUnicodeEx, VK_CONTROL, VK_MENU,
    VK_SHIFT,
};
use windows::Win32::UI::TextServices::{
    CLSID_TF_ThreadMgr, ITfInputProcessorProfileActivationSink,
    ITfInputProcessorProfileActivationSink_Impl, ITfSource, ITfThreadMgr, TF_IPSINK_FLAG_ACTIVE,
    TF_PROFILETYPE_KEYBOARDLAYOUT,
};
use windows::Win32::UI::WindowsAndMessaging::IsGUIThread;
use windows_core::{GUID, Interface, implement};

use crate::keys::KEYS;
use crate::watch::Shared;
use crate::{Error, KeyMapping, KeyboardLayout, MainThread};

// ToUnicodeEx's bit 2: leave the keyboard state, dead keys included, as it
// was (Windows 10 1607 and later).
const KEEP_KEYBOARD_STATE: u32 = 1 << 2;

thread_local! {
    /// The sink stays advised for the rest of the process.
    static SOURCE: RefCell<Option<ITfSource>> = const { RefCell::new(None) };
}

pub(crate) fn is_main_thread() -> bool {
    unsafe { IsGUIThread(false) }.as_bool()
}

pub(crate) fn observe(_main: MainThread, shared: &'static Shared) -> Result<(), Error> {
    let unavailable = |error: windows_core::Error| Error::Unavailable(format!("TSF: {error}"));
    // SAFETY: COM is initialised on the UI thread, which tao and wry make a
    // single-threaded apartment.
    let threads: ITfThreadMgr =
        unsafe { CoCreateInstance(&CLSID_TF_ThreadMgr, None, CLSCTX_INPROC_SERVER) }
            .map_err(unavailable)?;
    let source: ITfSource = threads.cast().map_err(unavailable)?;
    let sink: ITfInputProcessorProfileActivationSink = Activation { shared }.into();
    unsafe { source.AdviseSink(&ITfInputProcessorProfileActivationSink::IID, &sink) }
        .map_err(unavailable)?;
    SOURCE.set(Some(source));
    // SAFETY: 0 asks for the calling thread's layout.
    shared.publish(read(unsafe { GetKeyboardLayout(0) }));
    Ok(())
}

#[implement(ITfInputProcessorProfileActivationSink)]
struct Activation {
    shared: &'static Shared,
}

impl ITfInputProcessorProfileActivationSink_Impl for Activation_Impl {
    fn OnActivated(
        &self,
        profile_type: u32,
        _langid: u16,
        _clsid: *const GUID,
        _catid: *const GUID,
        _profile: *const GUID,
        hkl: HKL,
        flags: u32,
    ) -> windows_core::Result<()> {
        if flags & TF_IPSINK_FLAG_ACTIVE == 0 {
            return Ok(());
        }
        // An input method's profile carries no layout handle.
        let hkl = if profile_type == TF_PROFILETYPE_KEYBOARDLAYOUT {
            hkl
        } else {
            unsafe { GetKeyboardLayout(0) }
        };
        self.shared.publish(read(hkl));
        Ok(())
    }
}

fn read(hkl: HKL) -> KeyboardLayout {
    let state = |keys: &[u16]| {
        let mut state = [0u8; 256];
        for &key in keys {
            state[usize::from(key)] = 0x80;
        }
        state
    };
    // Windows types AltGr as Control and Alt together.
    let plain = state(&[]);
    let shift = state(&[VK_SHIFT.0]);
    let alt_gr = state(&[VK_CONTROL.0, VK_MENU.0]);
    let shift_alt_gr = state(&[VK_SHIFT.0, VK_CONTROL.0, VK_MENU.0]);
    let mut keys = BTreeMap::new();
    for &(code, scancode) in KEYS {
        let key = unsafe { MapVirtualKeyExW(scancode, MAPVK_VSC_TO_VK, Some(hkl)) };
        let typed = |state| translate(key, scancode, state, hkl);
        let mapping = KeyMapping {
            value: typed(&plain),
            with_shift: typed(&shift),
            with_alt_gr: typed(&alt_gr),
            with_shift_alt_gr: typed(&shift_alt_gr),
        };
        keys.insert(code.to_owned(), mapping);
    }
    KeyboardLayout {
        id: format!("{:08X}", hkl.0 as usize),
        keys,
    }
}

/// What a key types: a dead key gives its spacing character, and a key that
/// types a control character or nothing gives "".
fn translate(key: u32, scancode: u32, state: &[u8; 256], hkl: HKL) -> String {
    let mut chars = [0u16; 16];
    let written = unsafe {
        ToUnicodeEx(
            key,
            scancode,
            state,
            &mut chars,
            KEEP_KEYBOARD_STATE,
            Some(hkl),
        )
    };
    let length = match written {
        // A dead key: the buffer holds its spacing character.
        ..0 => usize::from(chars[0] != 0),
        length => usize::try_from(length).expect("a non-negative length"),
    };
    let text = String::from_utf16_lossy(&chars[..length.min(chars.len())]);
    if text.chars().any(char::is_control) {
        return String::new();
    }
    text
}
