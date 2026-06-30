import { Settings } from "lucide-react";
import { cn } from "@twigo/ui";
import { useUi } from "@/store/ui";
import { openSettings } from "@/shell/editorHost";
import { getViews, getDefaultViewId } from "@/shell/views";
import { getDefaultDomainId } from "@/shell/domains";

export function ActivityBar() {
  const activeView = useUi((s) => s.activeView);
  const activeDomain = useUi((s) => s.activeDomain);
  const setView = useUi((s) => s.setView);
  const domain = activeDomain || getDefaultDomainId();
  const views = getViews(domain);
  // Resolve to the domain's default when the persisted view isn't one of its
  // own (e.g. just after switching domain).
  const current = views.some((v) => v.id === activeView)
    ? activeView
    : getDefaultViewId(domain);
  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-12 shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-sidebar py-2"
    >
      <div className="flex flex-col items-center gap-0.5">
        {views.map(({ id, title, icon: Icon }) => {
          const active = current === id;
          return (
            <button
              key={id}
              type="button"
              aria-label={title}
              aria-current={active ? "page" : undefined}
              title={title}
              onClick={() => setView(id)}
              className={cn(
                "relative flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
                active && "bg-brand/10 text-brand",
              )}
            >
              {active && (
                <span className="absolute -left-2 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-brand" />
              )}
              <Icon className="size-4" />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        onClick={() => openSettings()}
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        <Settings className="size-4" />
      </button>
    </nav>
  );
}
