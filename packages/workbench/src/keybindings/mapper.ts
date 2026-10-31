import type { KeyboardLayout } from "@twigo/protocol";
import { NAMED_KEYS, type Chord, type Platform } from "./chord";

/** A physical key press: what `KeyboardEvent` reports and dispatch matches on. */
export interface Press {
  readonly code: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

/** The US keys as `[code, unshifted, shifted]`: the fallback position of a character. */
const US: readonly (readonly [string, string, string])[] = [
  ...[
    "Backquote `~",
    "Digit1 1!",
    "Digit2 2@",
    "Digit3 3#",
    "Digit4 4$",
    "Digit5 5%",
    "Digit6 6^",
    "Digit7 7&",
    "Digit8 8*",
    "Digit9 9(",
    "Digit0 0)",
    "Minus -_",
    "Equal =+",
    "BracketLeft [{",
    "BracketRight ]}",
    "Backslash \\|",
    "Semicolon ;:",
    "Quote '\"",
    "Comma ,<",
    "Period .>",
    "Slash /?",
  ].map((row) => {
    const [code = "", chars = ""] = row.split(" ");
    return [code, chars.charAt(0), chars.charAt(1)] as const;
  }),
  ...Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode(0x61 + index);
    const upper = letter.toUpperCase();
    return [`Key${upper}`, letter, upper] as const;
  }),
];

const WRITING_CODES = new Set([
  ...US.map(([code]) => code),
  "Space",
  "IntlBackslash",
  "IntlRo",
  "IntlYen",
]);

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Fn",
]);

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  Enter: "↩",
  Escape: "⎋",
  Tab: "⇥",
  Space: "Space",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
};

const WORDS: Readonly<Record<string, string>> = {
  Escape: "Esc",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/**
 * Maps bindings onto the keys of a layout (ARCHITECTURE 5.2), after VS Code's
 * macLinuxKeyboardMapper at 1.144.0:
 * - a letter follows its character, and falls back to its US position where the
 *   layout types no such letter (Ukrainian);
 * - a digit keeps its position, so ⌘1 stays on the `1` key on AZERTY, where
 *   the digit itself needs Shift;
 * - any other character follows the key that types it, adding Shift where it
 *   needs it, and falls back to its US position.
 */
export class KeyboardMapper {
  readonly #byChar = new Map<string, { code: string; shift: boolean }>();
  readonly #labels = new Map<string, string>();

  constructor(
    layout: KeyboardLayout,
    readonly platform: Platform,
  ) {
    for (const [code, unshifted, shifted] of US) {
      this.#byChar.set(unshifted, { code, shift: false });
      this.#byChar.set(shifted, { code, shift: true });
      this.#labels.set(code, unshifted.toUpperCase());
    }
    const typed = new Map<string, { code: string; shift: boolean }>();
    for (const [code, mapping] of Object.entries(layout.keys)) {
      if (mapping.withShift && !typed.has(mapping.withShift)) {
        typed.set(mapping.withShift, { code, shift: true });
      }
      if (mapping.value) typed.set(mapping.value, { code, shift: false });
      if (isAscii(mapping.value) && !code.startsWith("Digit")) {
        this.#labels.set(code, mapping.value.toUpperCase());
      }
    }
    for (const [char, position] of typed) {
      // Digits keep their US position; uppercase letters are never looked up.
      if (/^[a-z]$|^[^0-9A-Z]$/.test(char)) this.#byChar.set(char, position);
    }
  }

  /** Undefined where no key of the layout types the chord's character. */
  press(chord: Chord): Press | undefined {
    const { ctrl, alt, meta } = chord;
    const named = NAMED_KEYS[chord.key];
    if (named) return { code: named, ctrl, shift: chord.shift, alt, meta };
    const position = this.#byChar.get(chord.key);
    if (!position) return undefined;
    return {
      code: position.code,
      ctrl,
      shift: chord.shift || position.shift,
      alt,
      meta,
    };
  }

  /** The press of a key event, unless the key is a modifier on its own. */
  fromEvent(event: KeyboardEvent): Press | undefined {
    if (MODIFIER_CODES.has(event.code) || event.code === "") return undefined;
    return {
      code: event.code,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey,
    };
  }

  /** What is printed on the keys: `⌘⇧K` on macOS, `Ctrl+Shift+K` elsewhere. */
  label(press: Press): string {
    const key = this.#labels.get(press.code) ?? this.#namedLabel(press.code);
    if (this.platform === "mac") {
      return [
        press.ctrl ? "⌃" : "",
        press.alt ? "⌥" : "",
        press.shift ? "⇧" : "",
        press.meta ? "⌘" : "",
        key,
      ].join("");
    }
    return [
      press.ctrl && "Ctrl",
      press.shift && "Shift",
      press.alt && "Alt",
      press.meta && (this.platform === "win" ? "Win" : "Super"),
      key,
    ]
      .filter(Boolean)
      .join("+");
  }

  #namedLabel(code: string): string {
    if (this.platform === "mac") return MAC_SYMBOLS[code] ?? code;
    return WORDS[code] ?? code;
  }
}

function isAscii(text: string): boolean {
  return /^[\x21-\x7e]$/.test(text);
}

export function pressId(press: Press): string {
  return [
    press.ctrl && "ctrl",
    press.shift && "shift",
    press.alt && "alt",
    press.meta && "meta",
    press.code,
  ]
    .filter(Boolean)
    .join("+");
}

/**
 * A press that types a character: such bindings fire only while a list has
 * the focus, never in an input (ARCHITECTURE 5.2).
 */
export function isBare(press: Press): boolean {
  return (
    !press.ctrl && !press.alt && !press.meta && WRITING_CODES.has(press.code)
  );
}
