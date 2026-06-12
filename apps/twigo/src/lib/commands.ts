import { useConnections } from "@/store/connections";
import { useUi } from "@/store/ui";
import { useHelp } from "@/store/help";
import { useJetStream } from "@/store/jetstream";
import { useKv } from "@/store/kv";
import { useObjStore } from "@/store/objstore";
import { newPublish, newResponder } from "@/lib/actions";
import {
  openSettings,
  splitActiveEditor,
  focusNextEditorGroup,
  resetEditorLayout,
  canSplitActiveEditor,
  editorGroupCount,
} from "@/lib/editor";
import { VIEWS, VIEW_ORDER } from "@/components/views/registry";

export interface Command {
  id: string;
  title: string;
  category: string;
  keywords?: string;
  keybinding?: string;
  when?: () => boolean;
  run: () => void;
}

const hasLive = () =>
  Object.values(useConnections.getState().connected).some((i) => i.connected);

const STATIC: Command[] = [
  {
    id: "publish.new",
    title: "New publish",
    category: "Create",
    keywords: "request reply",
    keybinding: "mod+n",
    when: hasLive,
    run: newPublish,
  },
  {
    id: "responder.new",
    title: "New responder (mock)",
    category: "Create",
    keywords: "mock service template",
    when: hasLive,
    run: newResponder,
  },
  {
    id: "connections.reload",
    title: "Reload nats contexts",
    category: "Connections",
    run: () => void useConnections.getState().load(),
  },
  {
    id: "jetstream.refresh",
    title: "JetStream: Refresh streams",
    category: "Connections",
    keywords: "jetstream stream consumer",
    when: () => {
      const { activeContext, connected } = useConnections.getState();
      return !!(activeContext && connected[activeContext]?.jetstream);
    },
    run: () => {
      const active = useConnections.getState().activeContext;
      if (active) void useJetStream.getState().load(active);
    },
  },
  {
    id: "kv.refresh",
    title: "KV: Refresh buckets",
    category: "Connections",
    keywords: "kv key value bucket",
    when: () => {
      const { activeContext, connected } = useConnections.getState();
      return !!(activeContext && connected[activeContext]?.jetstream);
    },
    run: () => {
      const active = useConnections.getState().activeContext;
      if (active) void useKv.getState().load(active);
    },
  },
  {
    id: "objstore.refresh",
    title: "Object Store: Refresh",
    category: "Connections",
    keywords: "object store bucket file",
    when: () => {
      const { activeContext, connected } = useConnections.getState();
      return !!(activeContext && connected[activeContext]?.jetstream);
    },
    run: () => {
      const active = useConnections.getState().activeContext;
      if (active) void useObjStore.getState().load(active);
    },
  },
  ...VIEW_ORDER.map(
    (v): Command => ({
      id: `view.${v}`,
      title: `Go to ${VIEWS[v].title}`,
      category: "Go",
      run: () => useUi.getState().setView(v),
    }),
  ),
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

function connectionCommands(): Command[] {
  const { contexts, connected } = useConnections.getState();
  return contexts.map((c): Command => {
    const isConnected = !!connected[c.name];
    return {
      id: `conn.${c.name}`,
      title: isConnected ? `Switch to ${c.name}` : `Connect to ${c.name}`,
      category: "Connections",
      keywords: c.name,
      run: isConnected
        ? () => useConnections.getState().setActive(c.name)
        : () => {
            // Connect to and switch to it, matching the connection switcher.
            useConnections.getState().setActive(c.name);
            void useConnections.getState().connect(c.name);
          },
    };
  });
}

// Open the palette with the familiar combos: VS Code (⇧⌘P), JetBrains (⇧⌘A),
// and the modern ⌘K alias.
export const PALETTE_BINDINGS = ["mod+shift+p", "mod+shift+a", "mod+k"];

/** The currently-available commands (static + dynamic, filtered by `when`). */
export function getCommands(): Command[] {
  return [...STATIC, ...connectionCommands()].filter(
    (c) => !c.when || c.when(),
  );
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
  const fromCommands = STATIC.flatMap((c) =>
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
