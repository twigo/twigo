import { Settings } from "lucide-react";
import { cn } from "@twigo/ui";
import { useUi } from "@/store/ui";
import { openSettings } from "@/lib/editor";
import { getViews } from "@/shell/views";

export function ActivityBar() {
  const { activeView, setView } = useUi();
  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-12 shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-sidebar py-2"
    >
      <div className="flex flex-col items-center gap-1">
        {getViews().map(({ id, title, icon: Icon }) => {
          const active = activeView === id;
          return (
            <button
              key={id}
              type="button"
              aria-label={title}
              aria-current={active ? "page" : undefined}
              title={title}
              onClick={() => setView(id)}
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active && "text-foreground",
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
              )}
              <Icon className="size-5" />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        onClick={() => openSettings()}
        className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Settings className="size-5" />
      </button>
    </nav>
  );
}
