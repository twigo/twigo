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
      <DialogContent className="max-w-xl p-5">
        <DialogTitle className="mb-3 border-b border-border pb-2.5 text-sm font-semibold text-foreground">
          Keyboard shortcuts
        </DialogTitle>
        <DialogDescription className="sr-only">
          Every keyboard shortcut available in Twigo.
        </DialogDescription>
        {/* Multi-column so categories of different lengths balance instead of
            forcing ragged grid rows. */}
        <div className="max-h-[70vh] columns-2 gap-8 overflow-y-auto">
          {groups.map(([category, items]) => (
            <section key={category} className="mb-4 break-inside-avoid">
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {category}
              </h3>
              <ul className="space-y-1.5">
                {items.map((s) => (
                  <li
                    key={s.title}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="min-w-0 truncate text-foreground">
                      {s.title}
                    </span>
                    <Kbd className="shrink-0">{fmtBinding(s.binding)}</Kbd>
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
