import type { Platform, Workbench } from "@twigo/workbench";

/**
 * The commands that win over the shell on every platform, whatever their
 * modifiers: on Linux and Windows `mod` is Ctrl, which a shell uses itself,
 * so there only these are the workbench's, as VS Code's `commandsToSkipShell`
 * is a short list. They are quick access, the command palette, the toggle of
 * the panel, and the terminal's own new and toggle, which are Ctrl chords on
 * macOS too.
 */
const SKIP_SHELL: ReadonlySet<string> = new Set([
  "workbench.action.quickOpen",
  "workbench.action.showCommands",
  "workbench.action.togglePanel",
  "k8s.terminal.new",
  "k8s.terminal.toggle",
]);

/**
 * Whether a keydown in a terminal is the workbench's rather than the
 * shell's (ARCHITECTURE 4.6). The next key of a chord that waits always is.
 * So is a command of {@link SKIP_SHELL}. On macOS a ⌘ chord that is a
 * binding or starts one is too, since no shell takes ⌘; elsewhere every
 * other Ctrl chord stays with the shell.
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
  if (
    resolution.kind === "command" &&
    SKIP_SHELL.has(resolution.binding.command)
  ) {
    return true;
  }
  return platform === "mac" && event.metaKey && resolution.kind !== "none";
}
