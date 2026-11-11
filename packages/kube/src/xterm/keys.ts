import type { Platform, Workbench } from "@twigo/workbench";

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
 * shell's (ARCHITECTURE 4.6). The next key of a chord that waits always is.
 * On macOS a ⌘ chord that is a binding or starts one is, since no shell
 * takes ⌘; elsewhere only the commands of {@link SKIP_SHELL} are, and every
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
  if (platform === "mac") {
    return event.metaKey && resolution.kind !== "none";
  }
  return (
    resolution.kind === "command" && SKIP_SHELL.has(resolution.binding.command)
  );
}
