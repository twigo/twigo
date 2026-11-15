import { useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { cn, Kbd, Tooltip, TooltipContent, TooltipTrigger } from "@twigo/ui";
import type { Space } from "@twigo/protocol";
import { useChanges, useWorkbench } from "../react";
import { accessOfSpace, chipLabel } from "../spaces/modes";
import { ModeChip } from "./ModeChip";
import { NAME_FLOOR, titleBarStage } from "./titleBarStage";
import { useWidth } from "./useWidth";

/**
 * Where you are (ARCHITECTURE 4.2): the space and its namespace scope as a
 * breadcrumb that opens their pickers, and in the middle the search that
 * opens quick access, as VS Code's Command Center. A space with one
 * coloured context tints the bar's left end, as JetBrains tints it with a
 * project's colour, and its mode's chip follows its name (6.4). Where the
 * bar is too narrow the search folds to an icon, then the chip to its icon.
 */
export function TitleBar() {
  const { spaces, colors, catalog } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(colors.changes);
  useChanges(catalog.changes);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const width = useWidth(bar);
  const space = spaces.active;
  const color = space && colors.ofSpace(space);
  const name = space?.contexts.join(" + ") ?? "";
  const scope = space ? scopeOf(spaces.state(space.id).namespaces) : "";
  const access = space && accessOfSpace(catalog, space);
  const { searchFolded, chipFolded } = titleBarStage(width, {
    name,
    scope,
    chip: access && chipLabel(access),
  });
  return (
    // 36 px pairs with trafficLightPosition in tauri.conf.json: change both or neither.
    <header
      ref={setBar}
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
      <div className="flex min-w-0 items-center gap-0.5 overflow-hidden pl-[84px]">
        {space && (
          <Breadcrumb name={name} scope={scope} chipFolded={chipFolded} />
        )}
      </div>
      <CommandCenter space={space} folded={searchFolded} />
    </header>
  );
}

function scopeOf(namespaces: readonly string[]): string {
  return namespaces.length === 0 ? "All namespaces" : namespaces.join(", ");
}

function Breadcrumb({
  name,
  scope,
  chipFolded,
}: {
  name: string;
  scope: string;
  chipFolded: boolean;
}) {
  const { quickAccess } = useWorkbench();
  return (
    <>
      <Crumb
        label="Switch space"
        onClick={() => quickAccess.show("ctx ")}
        className="font-medium"
        style={{
          minWidth:
            name.length > NAME_FLOOR
              ? `calc(${String(NAME_FLOOR)}ch + 2rem)`
              : "max-content",
        }}
      >
        <span className="truncate">{name}</span>
      </Crumb>
      <ModeChip folded={chipFolded} />
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-quiet" />
      <Crumb
        label="Select namespace"
        onClick={() => quickAccess.show("ns ")}
        className="max-w-max min-w-28 flex-1 basis-0"
      >
        <CutInTheMiddle text={scope} />
      </Crumb>
    </>
  );
}

const TAIL = 8;

/** CSS cuts only at the end of a text: the head gives way, and the last characters stay. */
function CutInTheMiddle({ text }: { text: string }) {
  return (
    <span className="flex min-w-0 whitespace-pre">
      <span className="overflow-hidden text-ellipsis">
        {text.slice(0, -TAIL)}
      </span>
      <span className="shrink-0">{text.slice(-TAIL)}</span>
    </span>
  );
}

function Crumb({
  label,
  onClick,
  className,
  style,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={style}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-body hover:bg-row-hover",
        className,
      )}
    >
      {children}
      <ChevronDown aria-hidden className="size-3.5 shrink-0 text-support" />
    </button>
  );
}

function CommandCenter({
  space,
  folded,
}: {
  space: Space | undefined;
  folded: boolean;
}) {
  const { quickAccess, keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const binding = keybindings.primary("workbench.action.quickOpen");
  const label = `Search ${space?.name ?? "Twigo"}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={() => {
            quickAccess.show("");
          }}
          className={cn(
            "flex h-6 items-center gap-2 rounded-md bg-content/5 pr-1 pl-2 text-xs text-support shadow-[inset_0_0_0_1px_var(--border)] outline-none hover:bg-content/8 hover:text-content focus-visible:shadow-[var(--focus-ring)]",
            !folded && "w-[300px]",
          )}
        >
          <Search aria-hidden className="size-3.5 shrink-0" />
          {!folded && (
            <span className="flex-1 truncate text-left">{label}</span>
          )}
          {binding && <Kbd>{keybindings.label(binding.presses)}</Kbd>}
        </button>
      </TooltipTrigger>
      {folded && <TooltipContent>{label}</TooltipContent>}
    </Tooltip>
  );
}
