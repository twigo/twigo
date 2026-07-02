import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn, Popover, PopoverTrigger, PopoverContent, Kbd } from "@twigo/ui";
import { useSpaces } from "@/store/spaces";
import { getDomain, getDomains } from "@/shell/domains";
import { isTypingTarget } from "@/lib/commands";

// Browser-style space tabs: the top strip of the window. One tab per
// technology workspace; switching is a click or mod+digit - the most
// practiced context switch there is. "+" opens a picker of registered
// domains, so a third technology is just another tab. Domain-free: renders
// purely from the domain registry and the spaces store.
//
// Under Tauri on macOS the strip IS the titlebar (titleBarStyle: Overlay):
// the traffic lights float over its left edge, empty areas drag the window
// (data-tauri-drag-region fires only when the event target is the attributed
// element itself, so tab buttons stay clickable), double-click maximizes.
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const isMac =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
const inTitlebar = isTauri && isMac;

export function SpaceTabs() {
  const spaces = useSpaces((s) => s.spaces);
  const activeId = useSpaces((s) => s.activeId);
  const setActive = useSpaces((s) => s.setActive);
  const addSpace = useSpaces((s) => s.addSpace);
  const closeSpace = useSpaces((s) => s.closeSpace);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key < "1" || e.key > "9" || isTypingTarget(e.target)) return;
      const target = useSpaces.getState().spaces[Number(e.key) - 1];
      if (target) {
        e.preventDefault();
        useSpaces.getState().setActive(target.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // "NATS", and "NATS · 2" when several spaces share a domain.
  const labels = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const s of spaces) {
    const n = (seen.get(s.domainId) ?? 0) + 1;
    seen.set(s.domainId, n);
    const title = getDomain(s.domainId)?.title ?? s.domainId;
    labels.set(s.id, n > 1 ? `${title} · ${n}` : title);
  }

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-9 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-1.5",
        inTitlebar && "pl-[78px]",
      )}
    >
      {spaces.map((s, i) => {
        const domain = getDomain(s.domainId);
        const Icon = domain?.icon;
        const active = s.id === activeId;
        return (
          <div
            key={s.id}
            className={cn(
              "group flex h-7 items-center rounded-md border border-transparent",
              active
                ? "border-border bg-background"
                : "hover:bg-row-hover",
            )}
          >
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              title={i < 9 ? `⌘${i + 1}` : undefined}
              onClick={() => setActive(s.id)}
              className={cn(
                "flex h-full items-center gap-1.5 pl-2.5 text-xs focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
                spaces.length > 1 ? "pr-1" : "pr-2.5",
                active
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {Icon && <Icon className="size-3.5 shrink-0" />}
              <span className="max-w-36 truncate">{labels.get(s.id)}</span>
            </button>
            {spaces.length > 1 && (
              <button
                type="button"
                aria-label={`Close ${labels.get(s.id) ?? "space"}`}
                onClick={() => closeSpace(s.id)}
                className="mr-1 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        );
      })}
      <Popover open={adding} onOpenChange={setAdding}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="New space"
            title="New space"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
          >
            <Plus className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1">
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            New space
          </div>
          <ul className="flex flex-col gap-px">
            {getDomains().map(({ id, title, icon: Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => {
                    addSpace(id);
                    setAdding(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-row-hover"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      <span
        data-tauri-drag-region
        className="ml-auto hidden items-center gap-1 pr-1 text-[10px] text-muted-foreground sm:flex"
      >
        <Kbd>⌘1</Kbd>
        <Kbd>⌘2</Kbd>
        to switch
      </span>
    </div>
  );
}
