import { useUi } from "@/store/ui";
import { useHelp } from "@/store/help";
import {
  openSettings,
  splitActiveEditor,
  focusNextEditorGroup,
  resetEditorLayout,
  canSplitActiveEditor,
  editorGroupCount,
} from "@/lib/editor";
import { getViews } from "@/shell/views";

export interface Command {
  id: string;
  title: string;
  category: string;
  keywords?: string;
  keybinding?: string;
  when?: () => boolean;
  run: () => void;
}

// The workbench's own commands — view/editor/theme/help, no domain knowledge.
const SHELL_COMMANDS: Command[] = [
  {
    id: "settings.open",
    title: "Open settings",
    category: "Go",
    keybinding: "mod+,",
    run: openSettings,
  },
  {
    id: "layout.sidebar",
    title: "Toggle sidebar",
    category: "View",
    keybinding: "mod+b",
    run: () => useUi.getState().toggleSidebar(),
  },
  {
    id: "layout.inspector",
    title: "Toggle inspector",
    category: "View",
    keybinding: "mod+alt+b",
    run: () => useUi.getState().toggleDetail(),
  },
  {
    id: "theme.toggle",
    title: "Toggle theme",
    category: "View",
    keywords: "dark light system",
    run: () => useUi.getState().toggleTheme(),
  },
  {
    id: "help.shortcuts",
    title: "Keyboard shortcuts",
    category: "Help",
    keywords: "help keys cheatsheet bindings reference",
    // Displayed only; '?' is handled directly (a binding can't carry the
    // implicit shift the character needs). See CommandPalette's key handler.
    keybinding: "?",
    run: () => useHelp.getState().toggle(),
  },
  {
    id: "editor.splitRight",
    title: "Split editor right",
    category: "Editor",
    keywords: "split pane group side vertical",
    keybinding: "mod+\\",
    when: canSplitActiveEditor,
    run: () => splitActiveEditor("right"),
  },
  {
    id: "editor.splitDown",
    title: "Split editor down",
    category: "Editor",
    keywords: "split pane group below horizontal",
    keybinding: "mod+alt+\\",
    when: canSplitActiveEditor,
    run: () => splitActiveEditor("below"),
  },
  {
    id: "editor.focusNextGroup",
    title: "Focus next editor group",
    category: "Editor",
    keywords: "split pane cycle next",
    when: () => editorGroupCount() > 1,
    run: focusNextEditorGroup,
  },
  {
    id: "editor.resetLayout",
    title: "Reset editor layout",
    category: "Editor",
    keywords: "split pane merge unsplit single collapse",
    when: () => editorGroupCount() > 1,
    run: resetEditorLayout,
  },
];

// Domain modules contribute commands here: fixed ones via registerCommand, and
// dynamic sets (e.g. one per connection) via registerCommandProvider.
const staticCommands: Command[] = [...SHELL_COMMANDS];
const providers: (() => Command[])[] = [];

export function registerCommand(...cmds: Command[]): void {
  staticCommands.push(...cmds);
}

export function registerCommandProvider(provider: () => Command[]): void {
  providers.push(provider);
}

// Test-only: drop module contributions, leaving the shell's own commands.
export function clearRegisteredCommands(): void {
  staticCommands.length = 0;
  staticCommands.push(...SHELL_COMMANDS);
  providers.length = 0;
}

// Open the palette with the familiar combos: VS Code (⇧⌘P), JetBrains (⇧⌘A),
// and the modern ⌘K alias.
export const PALETTE_BINDINGS = ["mod+shift+p", "mod+shift+a", "mod+k"];

// "Go to X" for each registered view. Built at call time because views are
// registered by domain modules after this module is imported.
function viewCommands(): Command[] {
  return getViews().map((v) => ({
    id: `view.${v.id}`,
    title: `Go to ${v.title}`,
    category: "Go",
    run: () => useUi.getState().setView(v.id),
  }));
}

/** The currently-available commands (static + dynamic, filtered by `when`). */
export function getCommands(): Command[] {
  return [
    ...staticCommands,
    ...viewCommands(),
    ...providers.flatMap((p) => p()),
  ].filter((c) => !c.when || c.when());
}

export interface ShortcutHelp {
  category: string;
  title: string;
  binding: string;
}

/** Every keyboard shortcut for the help overlay — the static, always-true set
 *  (not filtered by `when`, so a user learns them even when inapplicable). */
export function keybindingHelp(): ShortcutHelp[] {
  const palette: ShortcutHelp = {
    category: "General",
    title: "Command palette",
    binding: PALETTE_BINDINGS[0] ?? "mod+shift+p",
  };
  const fromCommands = staticCommands.flatMap((c) =>
    c.keybinding
      ? [{ category: c.category, title: c.title, binding: c.keybinding }]
      : [],
  );
  return [palette, ...fromCommands];
}

const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

// True when a keyboard event targets an editable surface — native fields,
// CodeMirror, or a role-based widget (cmdk/Radix combobox etc.). Used to avoid
// hijacking bare keys (like "?") while the user is typing.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    target.closest(
      '.cm-editor, [role="textbox"], [role="searchbox"], [role="combobox"]',
    ) !== null
  );
}

export function matchKeybinding(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const hasMod = e.metaKey || e.ctrlKey;
  return (
    e.key.toLowerCase() === key &&
    hasMod === parts.includes("mod") &&
    e.altKey === parts.includes("alt") &&
    e.shiftKey === parts.includes("shift")
  );
}

export function fmtBinding(binding: string): string {
  const parts = binding.toLowerCase().split("+");
  const has = (m: string) => parts.includes(m);
  const key = (parts[parts.length - 1] ?? "").toUpperCase();
  // macOS convention orders modifiers ⌃⌥⇧⌘ (Command last); elsewhere Ctrl first.
  if (IS_MAC) {
    return (
      (has("alt") ? "⌥" : "") +
      (has("shift") ? "⇧" : "") +
      (has("mod") ? "⌘" : "") +
      key
    );
  }
  const mods: string[] = [];
  if (has("mod")) mods.push("Ctrl");
  if (has("alt")) mods.push("Alt");
  if (has("shift")) mods.push("Shift");
  return [...mods, key].join("+");
}
