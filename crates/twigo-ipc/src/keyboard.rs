use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What each key of the active keyboard layout types (ARCHITECTURE 5.2).
/// WebKit has no Keyboard Map API, so the keybinding service learns the
/// layout from Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct KeyboardLayout {
    /// The OS's name for the layout: the input source ID on macOS, such as
    /// `com.apple.keylayout.Ukrainian`, the XKB layout name on Linux, such as
    /// `Ukrainian`, and the keyboard layout handle (HKL) in hex on Windows.
    pub id: String,
    /// The writing-system keys, by `KeyboardEvent.code` (`KeyA`, `Slash`).
    pub keys: BTreeMap<String, KeyMapping>,
}

/// The characters one key types; empty where it types none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct KeyMapping {
    pub value: String,
    pub with_shift: String,
    /// With Option on macOS.
    pub with_alt_gr: String,
    pub with_shift_alt_gr: String,
}
