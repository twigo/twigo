//! What the keys of one layout (XKB group) of a keymap type.

use std::collections::BTreeMap;

use xkbcommon::xkb::{self, Keycode, compose};

use crate::keys::KEYS;
use crate::{Error, KeyMapping, KeyboardLayout};

/// A layout compiled from XKB names, as `setxkbmap -layout <layout> -variant
/// <variant>` would, without touching the session's keymap.
pub fn from_names(layout: &str, variant: &str) -> Result<KeyboardLayout, Error> {
    let reader = Reader::new();
    let keymap = xkb::Keymap::new_from_names(
        &reader.context,
        "",
        "",
        layout,
        variant,
        None,
        xkb::KEYMAP_COMPILE_NO_FLAGS,
    )
    .ok_or_else(|| Error::NotFound(format!("{layout}({variant})")))?;
    Ok(reader.read(&keymap, 0))
}

pub(crate) struct Reader {
    pub(crate) context: xkb::Context,
    /// Spells out dead keys, which type nothing by themselves; without a
    /// Compose table they stay empty.
    compose: Option<compose::Table>,
}

impl Reader {
    pub(crate) fn new() -> Self {
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let compose =
            compose::Table::new_from_locale(&context, "C".as_ref(), compose::COMPILE_NO_FLAGS).ok();
        Self { context, compose }
    }

    pub(crate) fn read(&self, keymap: &xkb::Keymap, group: xkb::LayoutIndex) -> KeyboardLayout {
        let shift = mask(keymap, xkb::MOD_NAME_SHIFT);
        // xkb_state_update_mask resolves a virtual modifier to the real ones
        // it maps to, whichever key the layout puts AltGr on.
        let alt_gr = mask(keymap, "LevelThree");
        let states = [0, shift, alt_gr, shift | alt_gr].map(|mods| {
            let mut state = xkb::State::new(keymap);
            state.update_mask(mods, 0, 0, 0, 0, group);
            state
        });
        let mut compose = self
            .compose
            .as_ref()
            .map(|table| compose::State::new(table, compose::STATE_NO_FLAGS));
        let mut keys = BTreeMap::new();
        for &(code, keycode) in KEYS {
            let key = Keycode::new(keycode);
            let [value, with_shift, with_alt_gr, with_shift_alt_gr] = states
                .each_ref()
                .map(|state| typed(state, key, compose.as_mut()));
            let mapping = KeyMapping {
                value,
                with_shift,
                with_alt_gr,
                with_shift_alt_gr,
            };
            keys.insert(code.to_owned(), mapping);
        }
        let effective = states[0].serialize_layout(xkb::STATE_LAYOUT_EFFECTIVE);
        KeyboardLayout {
            id: keymap.layout_get_name(effective).to_owned(),
            keys,
        }
    }
}

fn mask(keymap: &xkb::Keymap, name: &str) -> xkb::ModMask {
    match keymap.mod_get_index(name) {
        xkb::MOD_INVALID => 0,
        index => 1 << index,
    }
}

/// What a key types: a dead key gives what pressing it twice composes, and
/// a key that types a control character or nothing gives "".
fn typed(state: &xkb::State, key: Keycode, compose: Option<&mut compose::State>) -> String {
    let text = state.key_get_utf8(key);
    if text.chars().any(char::is_control) {
        return String::new();
    }
    if !text.is_empty() {
        return text;
    }
    let Some(compose) = compose else {
        return text;
    };
    let sym = state.key_get_one_sym(key);
    compose.reset();
    compose.feed(sym);
    compose.feed(sym);
    let composed = match compose.status() {
        compose::Status::Composed => compose.utf8().unwrap_or_default(),
        _ => String::new(),
    };
    compose.reset();
    composed
}
