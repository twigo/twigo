import { useState } from "react";
import { PanelsTopLeft } from "lucide-react";
import { cn, EmptyState, InlineActions, Section } from "@twigo/ui";
import type { Lookup } from "../contextkey/when";
import { useChanges, useWorkbench } from "../react";
import { LOCATION_TITLES, type Location, type View } from "../views/registry";
import { activeContainer } from "./activeContainer";
import { PanelBoundary } from "./PanelBoundary";

/** A side bar or the panel: a header with its containers, then the active one's views. */
export function PartView({ location }: { location: Location }) {
  const workbench = useWorkbench();
  const { views, spaces, keys } = workbench;
  useChanges(views.changes);
  useChanges(spaces.changes);
  useChanges(keys.changes);
  const space = spaces.active;
  const containers = views.containers(location);
  const container = activeContainer(workbench, location);
  const lookup = keys.lookup(null);
  const shown =
    container && space
      ? views.viewsIn(container.id, spaces.state(space.id).placement, lookup)
      : [];

  return (
    <section
      aria-label={LOCATION_TITLES[location]}
      className={cn(
        "flex h-full min-h-0 flex-col",
        location === "panel" ? "bg-panel" : "bg-sidebar",
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-1 px-3">
        {containers.length < 2 ? (
          <h2 className="text-xs font-medium">{container?.title}</h2>
        ) : (
          <div role="tablist" className="flex items-center gap-1">
            {containers.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={candidate.id === container?.id}
                onClick={() => {
                  if (space) {
                    spaces.setPart(space.id, location, {
                      container: candidate.id,
                    });
                  }
                }}
                className={cn(
                  "h-6 rounded px-1.5 text-xs font-medium transition-colors",
                  candidate.id === container?.id
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {candidate.title}
              </button>
            ))}
          </div>
        )}
        {shown.length === 1 && shown[0] && (
          <div className="ml-auto flex items-center">
            <ViewActions view={shown[0]} lookup={lookup} />
          </div>
        )}
      </header>
      {shown.length === 0 ? (
        <EmptyState
          icon={PanelsTopLeft}
          className="flex-1"
          title="No views here"
        >
          <p>Move a view here with View › Move View… or the command palette.</p>
        </EmptyState>
      ) : shown.length === 1 && shown[0] ? (
        <ViewBody view={shown[0]} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {shown.map((view) => (
            <ViewSection key={view.id} view={view} lookup={lookup} />
          ))}
        </div>
      )}
    </section>
  );
}

function ViewBody({ view }: { view: View }) {
  const Component = view.component;
  return (
    <div className="min-h-0 flex-1">
      <PanelBoundary label={view.title}>
        <Component />
      </PanelBoundary>
    </div>
  );
}

/** One of several views in a container: a header that folds it, VS Code's pane view. */
function ViewSection({ view, lookup }: { view: View; lookup: Lookup }) {
  const [open, setOpen] = useState(true);
  return (
    <Section
      title={view.title}
      size="sm"
      open={open}
      onToggle={() => {
        setOpen(!open);
      }}
      actions={<ViewActions view={view} lookup={lookup} />}
      className={cn("border-t border-border-subtle", open && "min-h-0 flex-1")}
    >
      <ViewBody view={view} />
    </Section>
  );
}

/** The view's `view/title` menu as icon buttons; `view` names the view in its `when`. */
function ViewActions({ view, lookup }: { view: View; lookup: Lookup }) {
  const workbench = useWorkbench();
  useChanges(workbench.menus.changes);
  const scoped: Lookup = (key) => (key === "view" ? view.id : lookup(key));
  return (
    <InlineActions actions={workbench.actions("view/title", scoped).flat()} />
  );
}
