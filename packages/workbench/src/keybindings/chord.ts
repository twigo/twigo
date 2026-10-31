export type Platform = "mac" | "linux" | "win";

/** A key as a binding names it: `mod+shift+k`, before the keyboard layout. */
export interface Chord {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  /** One character (`k`, `/`, `1`) or a named key (`enter`, `f5`). */
  readonly key: string;
}

export class KeySyntaxError extends Error {
  constructor(
    readonly source: string,
    reason: string,
  ) {
    super(`${reason} in "${source}"`);
    this.name = "KeySyntaxError";
  }
}

/** Named keys and the `KeyboardEvent.code` they sit on, whatever the layout. */
export const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ...Object.fromEntries(
    Array.from({ length: 19 }, (_, index) => [
      `f${index + 1}`,
      `F${index + 1}`,
    ]),
  ),
};

/**
 * Parses chords separated by spaces (`mod+k mod+s`), as in VS Code's
 * `keybindings.json`. `mod` is Cmd on macOS and Ctrl elsewhere; `cmd`,
 * `meta` and `win` name the same key.
 */
export function parseKeys(
  source: string,
  platform: Platform,
): readonly [Chord, ...Chord[]] {
  const [first = "", ...rest] = source.trim().toLowerCase().split(/\s+/);
  return [
    parseChord(first, source, platform),
    ...rest.map((part) => parseChord(part, source, platform)),
  ];
}

function parseChord(part: string, source: string, platform: Platform): Chord {
  const chord = { ctrl: false, shift: false, alt: false, meta: false };
  const pieces = part.split("+");
  const key = pieces.pop();
  if (key === undefined || key === "") {
    throw new KeySyntaxError(source, `no key in "${part}"`);
  }
  for (const modifier of pieces) {
    switch (modifier) {
      case "mod":
        chord[platform === "mac" ? "meta" : "ctrl"] = true;
        break;
      case "ctrl":
      case "shift":
      case "alt":
        chord[modifier] = true;
        break;
      case "cmd":
      case "meta":
      case "win":
        chord.meta = true;
        break;
      default:
        throw new KeySyntaxError(source, `unknown modifier "${modifier}"`);
    }
  }
  if (!(key in NAMED_KEYS) && key.length !== 1) {
    throw new KeySyntaxError(source, `unknown key "${key}"`);
  }
  return { ...chord, key };
}
