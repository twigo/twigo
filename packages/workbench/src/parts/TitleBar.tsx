import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { cn, Kbd, Tooltip, TooltipContent, TooltipTrigger } from "@twigo/ui";
import type { Space } from "@twigo/protocol";
import { useChanges, useWorkbench } from "../react";
import { cutText } from "./cutText";
import { ModeChip, ModeChipCopy } from "./ModeChip";
import {
  BAR_GAP,
  SEARCH_FIELD,
  titleBarColumns,
  titleBarStage,
  TRAFFIC_LIGHTS,
} from "./titleBarStage";
import { useWidth } from "./useWidth";

const NAME_FLOOR = 28;
const SCOPE_FLOOR = 16;

const BREADCRUMB = "flex items-center gap-0.5";
const SEARCH =
  "flex h-6 items-center gap-2 rounded-md pr-1 pl-2 text-xs text-support";

/**
 * Where you are (ARCHITECTURE 4.2): the space and its namespace scope as a
 * breadcrumb that opens their pickers, and in the middle the search that
 * opens quick access, as VS Code's Command Center. A space with one
 * coloured context tints the bar's left end, as JetBrains tints it with a
 * project's colour, and its mode's chip follows its name (6.4). Where the
 * bar is too narrow the search folds to an icon, then the chip to its icon.
 * What each takes is measured on hidden copies at their natural size, so
 * that a fold never changes what decides it.
 */
export function TitleBar() {
  const { spaces, colors } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(colors.changes);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [words, setWords] = useState<HTMLElement | null>(null);
  const [icon, setIcon] = useState<HTMLElement | null>(null);
  const [find, setFind] = useState<HTMLElement | null>(null);
  const space = spaces.active;
  const color = space && colors.ofSpace(space);
  const name = space?.contexts.join(" + ") ?? "";
  const scope = space ? scopeOf(spaces.state(space.id).namespaces) : "";
  const width = useWidth(bar);
  const { searchFolded, chipFolded, centred } = titleBarStage(width, {
    crumbs: useWidth(words),
    crumbsChipFolded: useWidth(icon),
    searchIcon: useWidth(find),
  });
  return (
    // 36 px pairs with trafficLightPosition in tauri.conf.json: change both or neither.
    <header
      ref={setBar}
      data-tauri-drag-region="deep"
      data-color={color}
      style={{
        gridTemplateColumns: titleBarColumns(centred),
        columnGap: BAR_GAP,
        ...(color && {
          "--twigo-context": `var(--context-${color})`,
          "--twigo-context-ink": `var(--context-${color}-ink)`,
        }),
      }}
      className="twigo-titlebar relative grid h-9 shrink-0 items-center border-b border-border bg-shell px-2"
    >
      <div
        style={{ paddingLeft: TRAFFIC_LIGHTS }}
        className={cn(BREADCRUMB, "min-w-0 overflow-hidden")}
      >
        {space && (
          <Breadcrumb name={name} scope={scope} chipFolded={chipFolded} />
        )}
      </div>
      <CommandCenter space={space} folded={searchFolded} />
      <div
        aria-hidden
        className="invisible absolute top-0 left-0 h-0 overflow-hidden"
      >
        {space && (
          <>
            <div
              ref={setWords}
              data-copy="words"
              className={cn(BREADCRUMB, "w-max")}
            >
              <Breadcrumb name={name} scope={scope} chipFolded={false} copy />
            </div>
            <div
              ref={setIcon}
              data-copy="icon"
              className={cn(BREADCRUMB, "w-max")}
            >
              <Breadcrumb name={name} scope={scope} chipFolded copy />
            </div>
          </>
        )}
        <div ref={setFind} data-copy="search" className="w-max">
          <div className={SEARCH}>
            <SearchFace space={space} folded />
          </div>
        </div>
      </div>
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
  copy = false,
}: {
  name: string;
  scope: string;
  chipFolded: boolean;
  copy?: boolean;
}) {
  const { quickAccess } = useWorkbench();
  const opening = (prefix: string) =>
    copy
      ? undefined
      : () => {
          quickAccess.show(prefix);
        };
  return (
    <>
      <Crumb
        label="Switch space"
        onClick={opening("ctx ")}
        className="font-medium"
      >
        <CutInTheMiddle text={name} floor={NAME_FLOOR} separator={/[:/]/} />
      </Crumb>
      {copy ? (
        <ModeChipCopy folded={chipFolded} />
      ) : (
        <ModeChip folded={chipFolded} />
      )}
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-quiet" />
      <Crumb
        label="Select namespace"
        onClick={opening("ns ")}
        className={cn(!copy && "max-w-max flex-1 basis-0")}
      >
        <CutInTheMiddle text={scope} floor={SCOPE_FLOOR} separator=", " />
      </Crumb>
    </>
  );
}

/** A text CSS can cut only at its end, cut in the middle instead, with the head and the tail fixed. */
function CutInTheMiddle({
  text,
  floor,
  separator,
}: {
  text: string;
  floor: number;
  separator: string | RegExp;
}) {
  const cut = cutText(text, floor, separator);
  if (!cut) return <span className="whitespace-pre">{text}</span>;
  return (
    <span className="grid grid-cols-[auto_minmax(1em,1fr)_auto] whitespace-pre">
      <span>{cut.head}</span>
      <span className="truncate">{cut.middle}</span>
      <span>{cut.tail}</span>
    </span>
  );
}

/** A crumb with no handler is the hidden copy that measures one. */
function Crumb({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: (() => void) | undefined;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn(
    "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-body",
    className,
  );
  const face = (
    <>
      {children}
      <ChevronDown aria-hidden className="size-3.5 shrink-0 text-support" />
    </>
  );
  return onClick ? (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(classes, "hover:bg-row-hover")}
    >
      {face}
    </button>
  ) : (
    <span className={classes}>{face}</span>
  );
}

function CommandCenter({
  space,
  folded,
}: {
  space: Space | undefined;
  folded: boolean;
}) {
  const { quickAccess } = useWorkbench();
  const label = searchLabel(space);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={() => {
            quickAccess.show("");
          }}
          style={folded ? undefined : { width: SEARCH_FIELD }}
          className={cn(
            SEARCH,
            "bg-content/5 shadow-[inset_0_0_0_1px_var(--border)] outline-none hover:bg-content/8 hover:text-content focus-visible:shadow-[var(--focus-ring)]",
          )}
        >
          <SearchFace space={space} folded={folded} />
        </button>
      </TooltipTrigger>
      {folded && <TooltipContent>{label}</TooltipContent>}
    </Tooltip>
  );
}

const searchLabel = (space: Space | undefined) =>
  `Search ${space?.name ?? "Twigo"}`;

function SearchFace({
  space,
  folded,
}: {
  space: Space | undefined;
  folded: boolean;
}) {
  const { keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const binding = keybindings.primary("workbench.action.quickOpen");
  return (
    <>
      <Search aria-hidden className="size-3.5 shrink-0" />
      {!folded && (
        <span className="flex-1 truncate text-left">{searchLabel(space)}</span>
      )}
      {binding && <Kbd>{keybindings.label(binding.presses)}</Kbd>}
    </>
  );
}
