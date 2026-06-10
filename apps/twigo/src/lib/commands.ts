import { useConnections } from "@/store/connections";
import { useUi } from "@/store/ui";
import { newPublish, newResponder } from "@/lib/actions";
import { openSettings } from "@/lib/editor";
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
    keywords: "dark light",
    run: () => useUi.getState().toggleTheme(),
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
        : () => void useConnections.getState().connect(c.name),
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

const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

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
