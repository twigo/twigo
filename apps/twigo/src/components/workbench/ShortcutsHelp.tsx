import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  Kbd,
} from "@twigo/ui";
import { keybindingHelp, fmtBinding, type ShortcutHelp } from "@/lib/commands";
import { useHelp } from "@/store/help";

const CATEGORY_ORDER = [
  "General",
  "Create",
  "Editor",
  "Connections",
  "Go",
  "View",
  "Help",
];

function group(items: ShortcutHelp[]): [string, ShortcutHelp[]][] {
  const by = new Map<string, ShortcutHelp[]>();
  for (const s of items) {
    const list = by.get(s.category) ?? [];
    list.push(s);
    by.set(s.category, list);
  }
  return [...by.entries()].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]),
  );
}

export function ShortcutsHelp() {
  const open = useHelp((s) => s.open);
  const setOpen = useHelp((s) => s.setOpen);
  const groups = group(keybindingHelp());

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription className="sr-only">
          Every keyboard shortcut available in Twigo.
        </DialogDescription>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {groups.map(([category, items]) => (
            <section key={category}>
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {category}
              </h3>
              <ul className="space-y-1">
                {items.map((s) => (
                  <li
                    key={s.title}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="min-w-0 truncate text-foreground">
                      {s.title}
                    </span>
                    <Kbd>{fmtBinding(s.binding)}</Kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
