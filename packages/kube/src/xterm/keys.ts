import type { Platform, Workbench } from "@twigo/workbench";

/**
 * The terminal's own new and toggle win over the shell on every platform,
 * whatever their modifiers, since their keys, ⌃⇧` and ⌃`, are Ctrl chords
 * on macOS too.
 */
const TERMINAL_KEYS: ReadonlySet<string> = new Set([
  "k8s.terminal.new",
  "k8s.terminal.toggle",
]);

/**
 * The commands that win over the shell on Linux and Windows, where `mod` is
 * Ctrl, which a shell uses itself: quick access, the command palette and the
 * toggle of the panel, as VS Code's `commandsToSkipShell` is a short list.
 */
const SKIP_SHELL: ReadonlySet<string> = new Set([
  "workbench.action.quickOpen",
  "workbench.action.showCommands",
  "workbench.action.togglePanel",
]);

/**
 * Whether a keydown in a terminal is the workbench's rather than the
 * shell's (ARCHITECTURE 4.6). The next key of a chord that waits always is,
 * and so is a command of {@link TERMINAL_KEYS}. On macOS a ⌘ chord that is a
 * binding or starts one is too, since no shell takes ⌘; elsewhere so is a
 * command of {@link SKIP_SHELL}, and every other Ctrl chord stays with the
 * shell.
 */
export function workbenchKey(
  keybindings: Pick<Workbench["keybindings"], "softDispatch">,
  platform: Platform,
  event: KeyboardEvent,
): boolean {
  const found = keybindings.softDispatch(event);
  if (!found) return false;
  if (found.waiting) return true;
  const { resolution } = found;
  if (resolution.kind === "command") {
    const { command } = resolution.binding;
    if (TERMINAL_KEYS.has(command)) return true;
    if (platform !== "mac" && SKIP_SHELL.has(command)) return true;
  }
  return platform === "mac" && event.metaKey && resolution.kind !== "none";
}
