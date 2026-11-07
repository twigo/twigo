import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Kbd } from "@twigo/ui";
import type { Space } from "@twigo/protocol";
import { useChanges, useWorkbench } from "../react";
import { ModeChip } from "./ModeChip";

/**
 * Where you are (ARCHITECTURE 4.2): the space and its namespace scope as a
 * breadcrumb that opens their pickers, and in the middle the search that
 * opens quick access, as VS Code's Command Center. A space with one
 * coloured context tints the bar's left end, as JetBrains tints it with a
 * project's colour, and its mode's chip follows its name (6.4).
 */
export function TitleBar() {
  const { spaces, colors } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(colors.changes);
  const space = spaces.active;
  const color = space && colors.ofSpace(space);
  return (
    // 36 px pairs with trafficLightPosition in tauri.conf.json: change both or neither.
    <header
      data-tauri-drag-region="deep"
      data-color={color}
      style={
        color &&
        ({
          "--twigo-context": `var(--context-${color})`,
          "--twigo-context-ink": `var(--context-${color}-ink)`,
        } as CSSProperties)
      }
      className="twigo-titlebar grid h-9 shrink-0 grid-cols-[minmax(0,1.3fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-border bg-shell px-2"
    >
      <div className="flex min-w-0 items-center gap-0.5 pl-[84px]">
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
      <ModeChip />
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
      onClick={() => {
        quickAccess.show("");
      }}
      className="flex h-6 w-[min(36vw,300px)] items-center gap-2 rounded-md bg-foreground/5 pr-1 pl-2 text-xs text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:shadow-[var(--focus-ring)]"
    >
      <Search aria-hidden className="size-3.5 shrink-0" />
      <span className="flex-1 truncate text-left">{label}</span>
      {binding && <Kbd>{keybindings.label(binding.presses)}</Kbd>}
    </button>
  );
}
