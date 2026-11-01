import type { Chord, Platform } from "../keybindings/chord";
import type { Workbench } from "../services";
import type { MenuId } from "./menus";

export interface NativeMenuItem {
  readonly command: string;
  readonly title: string;
  /** Tauri's accelerator string, such as `Cmd+Shift+P`. */
  readonly accelerator: string | undefined;
}

export interface NativeMenu {
  readonly title: string;
  readonly groups: readonly (readonly NativeMenuItem[])[];
}

const MENUBAR: readonly { readonly id: MenuId; readonly title: string }[] = [
  { id: "menubar/file", title: "File" },
  { id: "menubar/edit", title: "Edit" },
  { id: "menubar/view", title: "View" },
  { id: "menubar/go", title: "Go" },
  { id: "menubar/window", title: "Window" },
  { id: "menubar/help", title: "Help" },
];

/**
 * The menu bar from the menu registry (ARCHITECTURE 5.1). The OS takes an
 * accelerator before the webview sees the key, so only a single-chord
 * binding without a `when` gets one; the others stay in the menu and on
 * their keys.
 */
export function nativeMenus(workbench: Workbench): NativeMenu[] {
  const { menus, commands, keybindings, platform } = workbench;
  return MENUBAR.map(({ id, title }) => ({
    title,
    groups: menus
      .groups(id)
      .map((group) =>
        group.flatMap((item) => {
          const command = commands.get(item.command);
          if (!command) return [];
          const binding = keybindings.primary(item.command);
          const [only, ...more] = binding?.chords ?? [];
          return [
            {
              command: item.command,
              title: command.title,
              accelerator:
                only && more.length === 0 && binding?.when === undefined
                  ? accelerator(only, platform)
                  : undefined,
            },
          ];
        }),
      )
      .filter((group) => group.length > 0),
  }));
}

/** The US characters a key types with Shift, by the key's own character, for muda's code names. */
const SHIFTED: Readonly<Record<string, string>> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

const NAMED: Readonly<Record<string, string>> = {
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
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

/**
 * A chord as Tauri's menu accelerator. macOS matches a key equivalent by the
 * character typed, as the keybinding service does for letters, so the
 * accelerator names the binding's character, not its physical key.
 */
export function accelerator(
  chord: Chord,
  platform: Platform,
): string | undefined {
  const shifted = SHIFTED[chord.key];
  const key =
    NAMED[chord.key] ??
    (/^f([1-9]|1[0-9])$/.test(chord.key)
      ? chord.key.toUpperCase()
      : undefined) ??
    shifted ??
    (/^[a-z0-9`\\[\],=\-.'/;]$/.test(chord.key)
      ? chord.key.toUpperCase()
      : undefined);
  if (key === undefined) return undefined;
  return [
    chord.ctrl && "Ctrl",
    chord.alt && "Alt",
    (chord.shift || shifted !== undefined) && "Shift",
    chord.meta && (platform === "mac" ? "Cmd" : "Super"),
    key,
  ]
    .filter(Boolean)
    .join("+");
}
