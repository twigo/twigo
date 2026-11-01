import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type { Space } from "@twigo/protocol";
import { Kbd } from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { onlyColor } from "./spaceBadge";

/**
 * Where you are (ARCHITECTURE 4.2): the space and its namespace scope as a
 * breadcrumb that opens their pickers, and the search that opens quick
 * access. A space with one coloured context tints the bar's
 * left end, as JetBrains tints it with a project's colour.
 */
export function TitleBar() {
  const { spaces } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  const color = space && onlyColor(space);
  return (
    // 36 px pairs with trafficLightPosition in tauri.conf.json: change both or neither.
    <header
      data-tauri-drag-region="deep"
      data-color={color}
      style={
        color &&
        ({ "--twigo-context": `var(--context-${color})` } as CSSProperties)
      }
      className="twigo-titlebar grid h-9 shrink-0 grid-cols-[minmax(max-content,1fr)_minmax(0,28rem)_2fr] items-center gap-3 border-b border-border bg-shell pr-2 pl-[92px]"
    >
      <div className="flex min-w-0 items-center gap-0.5">
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
          {space.contexts.map((context) => context.name).join(" + ")}
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
  return (
    <button
      type="button"
      onClick={() => {
        quickAccess.show("");
      }}
      className="flex h-7 items-center gap-2 rounded-md border border-border bg-foreground/5 px-2.5 text-[13px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
    >
      <Search aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">Search {space?.name ?? "Twigo"}</span>
      {binding && (
        <Kbd className="ml-auto">{keybindings.label(binding.presses)}</Kbd>
      )}
    </button>
  );
}
