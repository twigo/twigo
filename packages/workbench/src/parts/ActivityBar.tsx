import { cn } from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { activeContainer } from "./activeContainer";

/**
 * The side bar's containers (ARCHITECTURE 4.1). Clicking the shown one hides
 * the side bar; clicking another shows it there.
 */
export function ActivityBar() {
  const workbench = useWorkbench();
  const { views, spaces } = workbench;
  useChanges(views.changes);
  useChanges(spaces.changes);
  const space = spaces.active;
  const visible = space ? spaces.state(space.id).parts.sidebar.visible : false;
  const shown = activeContainer(workbench, "sidebar");
  return (
    <nav
      aria-label="Activity Bar"
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar py-1.5"
    >
      {views.containers("sidebar").map((container) => {
        const Icon = container.icon;
        const active = visible && container.id === shown?.id;
        return (
          <button
            key={container.id}
            type="button"
            aria-label={container.title}
            aria-pressed={active}
            title={container.title}
            onClick={() => {
              if (!space) return;
              spaces.setPart(space.id, "sidebar", {
                visible: !active,
                container: container.id,
              });
            }}
            className={cn(
              "relative flex size-8 items-center justify-center rounded-md transition-colors duration-100",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-row-hover hover:text-foreground",
            )}
          >
            {active && (
              <span className="absolute inset-y-1.5 -left-1.5 w-0.5 rounded-full bg-brand" />
            )}
            <Icon className="size-[18px]" />
          </button>
        );
      })}
    </nav>
  );
}
