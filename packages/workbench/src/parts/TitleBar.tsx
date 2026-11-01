import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type { Space } from "@twigo/protocol";
import { useChanges, useWorkbench } from "../react";
import { onlyColor } from "./spaceBadge";

/**
 * Where you are (ARCHITECTURE 4.2): the space and its namespace scope as a
 * breadcrumb that opens their pickers, and a search button that opens
 * quick access. A space with one coloured context tints the bar's
 * left end, as JetBrains tints it with a project's colour.
 */
export function TitleBar() {
  const { spaces, catalog } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(catalog.changes);
  const space = spaces.active;
  const color = space && onlyColor(space, catalog);
  return (
    // 36 px pairs with trafficLightPosition in tauri.conf.json: change both or neither.
    <header
      data-tauri-drag-region="deep"
      data-color={color}
      style={
        color &&
        ({ "--twigo-context": `var(--context-${color})` } as CSSProperties)
      }
      className="twigo-titlebar flex h-9 shrink-0 items-center gap-3 border-b border-border bg-shell pr-2 pl-[92px]"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        {space && <Breadcrumb space={space} />}
      </div>
      <CommandCenter space={space} />
    </header>
  );
}

function Breadcrumb({ space }: { space: Space }) {
  const { spaces, quickAccess } = useWorkbench();
  const { namespaces } = spaces.state(space.id);
  return (
    <>
      <Crumb label="Switch space" onClick={() => quickAccess.show("ctx ")}>
        <span className="truncate font-medium">
          {space.contexts.join(" + ")}
        </span>
      </Crumb>
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground-2"
      />
      <Crumb label="Select namespace" onClick={() => quickAccess.show("ns ")}>
        <span className="truncate">
          {namespaces.length === 0 ? "All namespaces" : namespaces.join(", ")}
        </span>
      </Crumb>
    </>
  );
}

function Crumb({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] hover:bg-row-hover"
    >
      {children}
      <ChevronDown
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    </button>
  );
}

function CommandCenter({ space }: { space: Space | undefined }) {
  const { quickAccess, keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const binding = keybindings.primary("workbench.action.quickOpen");
  const label = `Search ${space?.name ?? "Twigo"}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={
        binding ? `${label} (${keybindings.label(binding.presses)})` : label
      }
      onClick={() => {
        quickAccess.show("");
      }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-row-hover hover:text-foreground"
    >
      <Search aria-hidden className="size-4" />
    </button>
  );
}
