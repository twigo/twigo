import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn, Popover, PopoverTrigger, PopoverContent, Kbd } from "@twigo/ui";
import { useSpaces } from "@/store/spaces";
import { getDomain, getDomains } from "@/shell/domains";
import { isTypingTarget, fmtBinding } from "@/lib/commands";

// Browser-style workspace tabs (switch: click or mod+digit; "+" adds one per
// registered domain). Under Tauri on macOS the strip IS the titlebar
// (titleBarStyle: Overlay): traffic lights float over its left edge, empty
// areas drag the window (data-tauri-drag-region fires only when the event
// target is the attributed element itself, so tab buttons stay clickable).
// macOS parks the lights for its own 28px title bar, so the strip's h-9 (36px)
// is paired with trafficLightPosition in tauri.conf.json - changing one without
// the other leaves them off-centre.
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
  // Non-null while the "+" picker is on its second step (choosing a target).
  const [pickerDomain, setPickerDomain] = useState<string | null>(null);

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

  // With a single registered technology tabs earn nothing: keep only the bare
  // draggable titlebar under Tauri. The tab UI returns with a second domain.
  const multiDomain = getDomains().length > 1;
  if (!multiDomain) {
    return inTitlebar ? (
      <div
        data-tauri-drag-region
        className="h-9 shrink-0 border-b border-border bg-sidebar"
      />
    ) : null;
  }

  // "NATS · prod-eu" when the space pins a target, "NATS" otherwise, and a
  // trailing counter only when two tabs would read identically.
  const labels = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const s of spaces) {
    const title = getDomain(s.domainId)?.title ?? s.domainId;
    const base = s.targetLabel ? `${title} · ${s.targetLabel}` : title;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    labels.set(s.id, n > 1 ? `${base} · ${n}` : base);
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
              active ? "border-border bg-background" : "hover:bg-row-hover",
            )}
          >
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              title={i < 9 ? fmtBinding(`mod+${i + 1}`) : undefined}
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
      <Popover
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setPickerDomain(null);
        }}
      >
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
          {pickerDomain === null ? (
            <>
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                New space
              </div>
              <ul className="flex flex-col gap-px">
                {getDomains().map((d) => {
                  const Icon = d.icon;
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => {
                          const targets = d.listTargets?.() ?? [];
                          if (targets.length === 0) {
                            addSpace(d.id);
                            setAdding(false);
                          } else {
                            setPickerDomain(d.id);
                          }
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-row-hover"
                      >
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">
                          {d.title}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <>
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {getDomain(pickerDomain)?.title} · pick a target
              </div>
              <ul className="flex flex-col gap-px">
                {(getDomain(pickerDomain)?.listTargets?.() ?? []).map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => {
                        addSpace(pickerDomain, t);
                        setAdding(false);
                        setPickerDomain(null);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-row-hover"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">
                        {t.label}
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      addSpace(pickerDomain);
                      setAdding(false);
                      setPickerDomain(null);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-row-hover hover:text-foreground"
                  >
                    No pinned target
                  </button>
                </li>
              </ul>
            </>
          )}
        </PopoverContent>
      </Popover>
      <span
        data-tauri-drag-region
        className="ml-auto hidden items-center gap-1 pr-1 text-[10px] text-muted-foreground sm:flex"
      >
        <Kbd>{fmtBinding("mod+1")}</Kbd>
        <Kbd>{fmtBinding("mod+2")}</Kbd>
        to switch
      </span>
    </div>
  );
}
