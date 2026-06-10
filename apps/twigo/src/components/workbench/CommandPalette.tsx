import { useEffect, useMemo } from "react";
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
} from "@twigo/ui";
import {
  getCommands,
  matchKeybinding,
  fmtBinding,
  PALETTE_BINDINGS,
  type Command as Cmd,
} from "@/lib/commands";
import { usePalette } from "@/store/palette";

const CATEGORY_ORDER = ["Create", "Connections", "Go", "View"];

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

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const setOpen = usePalette((s) => s.setOpen);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (PALETTE_BINDINGS.some((b) => matchKeybinding(e, b))) {
        e.preventDefault();
        usePalette.getState().toggle();
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

  const groups = useMemo(() => (open ? group(getCommands()) : []), [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command>
          <CommandInput placeholder="Type a command…" />
          <CommandList>
            <CommandEmpty>No matching commands.</CommandEmpty>
            {groups.map(([category, cmds]) => (
              <CommandGroup key={category} heading={category}>
                {cmds.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`${c.title} ${c.keywords ?? ""}`}
                    onSelect={() => {
                      setOpen(false);
                      c.run();
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {c.keybinding && (
                      <span className="ml-auto shrink-0 text-[10px] tracking-wide text-muted-foreground">
                        {fmtBinding(c.keybinding)}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
