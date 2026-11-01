//! TIS names the layout and `UCKeyTranslate` reads what its keys type.
//! objc2 has no bindings for either, because its header translator skips
//! HIToolbox (objc2-carbon) and CarbonCore (objc2-core-services), so the few
//! functions are declared here from `TextInputSources.h`, `Events.h` and
//! `UnicodeUtilities.h`.

use std::collections::BTreeMap;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::ptr::{self, NonNull};

use objc2::MainThreadMarker;
use objc2_core_foundation::{
    CFArray, CFData, CFDictionary, CFNotificationCenter, CFNotificationName,
    CFNotificationSuspensionBehavior, CFRetained, CFString, CFType,
};

use crate::keys::KEYS;
use crate::watch::Shared;
use crate::{Error, KeyMapping, KeyboardLayout, MainThread};

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    static kTISPropertyInputSourceID: &'static CFString;
    static kTISPropertyUnicodeKeyLayoutData: &'static CFString;
    static kTISNotifySelectedKeyboardInputSourceChanged: &'static CFString;

    fn TISCopyCurrentKeyboardLayoutInputSource() -> Option<NonNull<CFType>>;
    fn TISCreateInputSourceList(
        properties: &CFDictionary<CFString, CFString>,
        include_all_installed: u8,
    ) -> Option<NonNull<CFArray<CFType>>>;
    fn TISGetInputSourceProperty(source: &CFType, key: &CFString) -> *const c_void;
    fn LMGetKbdType() -> u8;
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn UCKeyTranslate(
        layout: *const c_void,
        virtual_key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        key_translate_options: u32,
        dead_key_state: *mut u32,
        max_string_length: usize,
        actual_string_length: *mut usize,
        unicode_string: *mut u16,
    ) -> i32;
}

const K_UC_KEY_ACTION_DOWN: u16 = 0;
const K_UC_KEY_TRANSLATE_NO_DEAD_KEYS_MASK: u32 = 1;
// `shiftKey` and `optionKey` of `Events.h`, shifted right by 8 as
// UCKeyTranslate takes them.
const SHIFT: u32 = 0x02;
const OPTION: u32 = 0x08;

pub(crate) fn is_main_thread() -> bool {
    MainThreadMarker::new().is_some()
}

pub(crate) fn observe(main: MainThread, shared: &'static Shared) -> Result<(), Error> {
    let center = CFNotificationCenter::distributed_center()
        .ok_or_else(|| Error::Unavailable("no distributed notification center".into()))?;
    let observer = ptr::from_ref(shared).cast::<c_void>();
    let name = unsafe { kTISNotifySelectedKeyboardInputSourceChanged };
    // SAFETY: `shared` lives for the process, and `selected_changed` reads
    // it back as one.
    unsafe {
        center.add_observer(
            observer,
            Some(selected_changed),
            Some(name),
            ptr::null(),
            CFNotificationSuspensionBehavior::DeliverImmediately,
        );
    }
    match current(main) {
        Ok(layout) => {
            shared.publish(layout);
            Ok(())
        }
        Err(error) => {
            // SAFETY: removes the registration made above.
            unsafe { center.remove_observer(observer, Some(name), ptr::null()) };
            Err(error)
        }
    }
}

unsafe extern "C-unwind" fn selected_changed(
    _center: *mut CFNotificationCenter,
    observer: *mut c_void,
    _name: *const CFNotificationName,
    _object: *const c_void,
    _user_info: *const CFDictionary,
) {
    // SAFETY: `observe` registered the process's `Shared` as the observer.
    let shared = unsafe { &*observer.cast::<Shared>() };
    // CF delivers distributed notifications on the main thread's run loop
    // (`CFNotificationCenter.h`).
    let main = MainThread(PhantomData);
    match current(main) {
        Ok(layout) => shared.publish(layout),
        Err(error) => eprintln!("keeping the previous keyboard layout: {error}"),
    }
}

/// The layout the selected input source types with: the selected keyboard
/// layout, or the one an input method uses.
fn current(main: MainThread) -> Result<KeyboardLayout, Error> {
    let source = unsafe { TISCopyCurrentKeyboardLayoutInputSource() }
        .ok_or_else(|| Error::Unavailable("TIS reports no keyboard layout".into()))?;
    // SAFETY: a TIS "Copy" function returns a +1 reference.
    let source = unsafe { CFRetained::from_raw(source) };
    read(main, &source)
}

/// An installed keyboard layout by its input source ID, such as
/// `com.apple.keylayout.German`, read without selecting it, whether or not
/// the user enabled it.
pub fn installed(main: MainThread, id: &str) -> Result<KeyboardLayout, Error> {
    let filter = CFDictionary::from_slices(
        &[unsafe { kTISPropertyInputSourceID }],
        &[&*CFString::from_str(id)],
    );
    let sources = unsafe { TISCreateInputSourceList(&filter, 1) }
        .ok_or_else(|| Error::Unavailable("TIS lists no input sources".into()))?;
    // SAFETY: a TIS "Create" function returns a +1 reference.
    let sources = unsafe { CFRetained::from_raw(sources) };
    let source = sources
        .get(0)
        .ok_or_else(|| Error::NotFound(id.to_owned()))?;
    read(main, &source)
}

fn read(_main: MainThread, source: &CFType) -> Result<KeyboardLayout, Error> {
    let id = property::<CFString>(source, unsafe { kTISPropertyInputSourceID })
        .ok_or_else(|| Error::Unavailable("an input source without an ID".into()))?
        .to_string();
    let data = property::<CFData>(source, unsafe { kTISPropertyUnicodeKeyLayoutData })
        .ok_or_else(|| Error::Unavailable(format!("{id} has no Unicode layout data")))?;
    let layout = data.byte_ptr().cast::<c_void>();
    let keyboard_type = u32::from(unsafe { LMGetKbdType() });
    let typed = |key, modifiers| {
        // SAFETY: `layout` points into `data`, which outlives this closure.
        unsafe { translate(layout, key, modifiers, keyboard_type) }.map_err(|status| {
            Error::Unavailable(format!("UCKeyTranslate failed on {id}: {status}"))
        })
    };
    let mut keys = BTreeMap::new();
    for &(code, key) in KEYS {
        let mapping = KeyMapping {
            value: typed(key, 0)?,
            with_shift: typed(key, SHIFT)?,
            with_alt_gr: typed(key, OPTION)?,
            with_shift_alt_gr: typed(key, SHIFT | OPTION)?,
        };
        keys.insert(code.to_owned(), mapping);
    }
    Ok(KeyboardLayout { id, keys })
}

/// A property under TIS's "Get" rule: borrowed from `source`.
fn property<'a, T: objc2_core_foundation::ConcreteType>(
    source: &'a CFType,
    key: &CFString,
) -> Option<&'a T> {
    let value = unsafe { TISGetInputSourceProperty(source, key) };
    // SAFETY: TIS returns a CF object or null.
    let value = unsafe { value.cast::<CFType>().as_ref() }?;
    value.downcast_ref()
}

/// What a key types: a dead key gives the character it shows on its own,
/// and a key that types a control character or nothing gives "".
///
/// # Safety
///
/// `layout` must point to `uchr` data.
unsafe fn translate(
    layout: *const c_void,
    key: u16,
    modifiers: u32,
    keyboard_type: u32,
) -> Result<String, i32> {
    // With no new dead-key states, a dead key types the character it shows
    // on its own and the state stays 0.
    let mut dead_key_state = 0;
    // The most UCKeyTranslate ever writes (`UnicodeUtilities.h`).
    let mut chars = [0u16; 255];
    let mut length = 0;
    let status = unsafe {
        UCKeyTranslate(
            layout,
            key,
            K_UC_KEY_ACTION_DOWN,
            modifiers,
            keyboard_type,
            K_UC_KEY_TRANSLATE_NO_DEAD_KEYS_MASK,
            &mut dead_key_state,
            chars.len(),
            &mut length,
            chars.as_mut_ptr(),
        )
    };
    if status != 0 {
        return Err(status);
    }
    let text = String::from_utf16_lossy(&chars[..length]);
    if text.chars().any(char::is_control) {
        return Ok(String::new());
    }
    Ok(text)
}
