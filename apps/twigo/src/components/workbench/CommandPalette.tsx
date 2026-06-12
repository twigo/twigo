import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Kbd,
} from "@twigo/ui";
import {
  getCommands,
  matchKeybinding,
  fmtBinding,
  isTypingTarget,
  PALETTE_BINDINGS,
  type Command as Cmd,
} from "@/lib/commands";
import { usePalette } from "@/store/palette";
import { useHelp } from "@/store/help";
import { useCommandHistory } from "@/store/commandHistory";

const CATEGORY_ORDER = [
  "General",
  "Create",
  "Editor",
  "Connections",
  "Go",
  "View",
  "Help",
];

function group(cmds: Cmd[]): [string, Cmd[]][] {
  const by = new Map<string, Cmd[]>();
  for (const c of cmds) {
    const list = by.get(c.category) ?? [];
    list.push(c);
    by.set(c.category, list);
  }
  return [...by.entries()].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]),
  );
}

const RECENT_LIMIT = 5;

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const setOpen = usePalette((s) => s.setOpen);
  const [query, setQuery] = useState("");
  const recentIds = useCommandHistory((s) => s.recent);
  const record = useCommandHistory((s) => s.record);

  // Clear the query when the palette opens so a stale search never lingers
  // between opens — adjust-state-during-render (React-recommended), no effect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setQuery("");
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (PALETTE_BINDINGS.some((b) => matchKeybinding(e, b))) {
        e.preventDefault();
        usePalette.getState().toggle();
        return;
      }
      // "?" opens the shortcuts overlay (handled here, not as a keybinding,
      // since "?" carries an implicit shift a binding can't express).
      if (
        e.key === "?" &&
        !e.isComposing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !usePalette.getState().open &&
        !isTypingTarget(e.target)
      ) {
        e.preventDefault();
        useHelp.getState().toggle();
        return;
      }
      if (usePalette.getState().open) return;
      for (const c of getCommands()) {
        if (c.keybinding && matchKeybinding(e, c.keybinding)) {
          e.preventDefault();
          c.run();
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const cmds = useMemo(() => (open ? getCommands() : []), [open]);
  const isEmpty = query.trim() === "";

  // Recents only on an empty query, resolved to currently-available commands.
  const recentCmds = useMemo(() => {
    if (!isEmpty) return [];
    const byId = new Map(cmds.map((c) => [c.id, c]));
    const out: Cmd[] = [];
    for (const id of recentIds) {
      const c = byId.get(id);
      if (c) out.push(c);
      if (out.length >= RECENT_LIMIT) break;
    }
    return out;
  }, [isEmpty, cmds, recentIds]);

  const recentSet = new Set(recentCmds.map((c) => c.id));
  const groups = group(cmds.filter((c) => !recentSet.has(c.id)));

  function run(c: Cmd) {
    record(c.id);
    setOpen(false);
    c.run();
  }

  const item = (c: Cmd, keyPrefix = "") => (
    <CommandItem
      key={`${keyPrefix}${c.id}`}
      value={`${keyPrefix}${c.title} ${c.keywords ?? ""}`}
      onSelect={() => run(c)}
    >
      <span className="min-w-0 flex-1 truncate">{c.title}</span>
      {c.keybinding && (
        <Kbd className="ml-auto">{fmtBinding(c.keybinding)}</Kbd>
      )}
    </CommandItem>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command>
          <CommandInput
            placeholder="Type a command…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No matching commands.</CommandEmpty>
            {recentCmds.length > 0 && (
              <CommandGroup heading="Recently used">
                {recentCmds.map((c) => item(c, "recent:"))}
              </CommandGroup>
            )}
            {groups.map(([category, cmds]) => (
              <CommandGroup key={category} heading={category}>
                {cmds.map((c) => item(c))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
