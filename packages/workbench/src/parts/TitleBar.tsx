import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import {
  cn,
  CutInTheMiddle,
  Kbd,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useWidth,
} from "@twigo/ui";
import type { Space } from "@twigo/protocol";
import { useChanges, useWorkbench } from "../react";
import { scopeWords } from "../spaces/scope";
import { variant } from "../variants";
import { ModeChip, ModeChipCopy } from "./ModeChip";
import {
  BAR_GAP,
  SEARCH_FIELD,
  titleBarColumns,
  titleBarStage,
  TRAFFIC_LIGHTS,
} from "./titleBarStage";

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
 * bar is too narrow the search folds to an icon, leaves the middle, and then
 * the chip folds to its icon. What each takes is measured on hidden copies
 * at their natural size, so that a fold never changes what decides it; the
 * copies stay mounted without a space, and the breadcrumb then takes
 * nothing, whatever its copy last measured.
 */
export function TitleBar() {
  const { spaces, colors } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(colors.changes);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [words, setWords] = useState<HTMLElement | null>(null);
  const [find, setFind] = useState<HTMLElement | null>(null);
  const space = spaces.active;
  const color = space && colors.ofSpace(space);
  const name = space?.contexts.join(" + ") ?? "";
  const namespaces = space ? spaces.state(space.id).namespaces : [];
  const width = useWidth(bar);
  const crumbs = useWidth(words);
  const { searchFolded, chipFolded, centred } = titleBarStage(width, {
    crumbs: space ? crumbs : 0,
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
          <Breadcrumb
            name={name}
            namespaces={namespaces}
            chipFolded={chipFolded}
          />
        )}
      </div>
      <CommandCenter space={space} folded={searchFolded} />
      <div
        aria-hidden
        className="invisible absolute top-0 left-0 h-0 overflow-hidden"
      >
        <div
          ref={setWords}
          data-copy="words"
          className={cn(BREADCRUMB, "w-max")}
        >
          {space && <Breadcrumb name={name} namespaces={namespaces} copy />}
        </div>
        <div ref={setFind} data-copy="search" className="w-max">
          <div className={SEARCH}>
            <SearchFace space={space} folded />
          </div>
        </div>
      </div>
    </header>
  );
}

function Breadcrumb({
  name,
  namespaces,
  chipFolded = false,
  copy = false,
}: {
  name: string;
  namespaces: readonly string[];
  chipFolded?: boolean;
  copy?: boolean;
}) {
  const { quickAccess } = useWorkbench();
  const scope = scopeWords(namespaces);
  // @todo: remove the variants the owner did not choose once he has chosen at the checkpoint
  const whole = variant("crumb") === "list";
  const spoken =
    scope.more > 0
      ? `${scope.name} and ${String(scope.more)} more`
      : scope.name;
  const opening = (prefix: string) =>
    copy
      ? undefined
      : () => {
          quickAccess.show(prefix);
        };
  return (
    <>
      <Crumb
        label={`Switch space, ${name}`}
        onClick={opening("ctx ")}
        className="font-medium"
      >
        <CutInTheMiddle text={name} floor={NAME_FLOOR} separator={/[:/]/} />
      </Crumb>
      {copy ? <ModeChipCopy /> : <ModeChip folded={chipFolded} />}
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-quiet" />
      <Crumb
        label={`Select namespace, ${spoken}`}
        tooltip={
          scope.more > 0 && !whole ? `Namespaces: ${scope.all}` : undefined
        }
        onClick={opening("ns ")}
        className={cn(!copy && "max-w-max flex-1 basis-0")}
      >
        <CutInTheMiddle
          text={whole ? scope.all : scope.name}
          floor={SCOPE_FLOOR}
          separator={whole ? ", " : "-"}
        />
        {scope.more > 0 && !whole && (
          <span className="shrink-0 text-label text-support tabular-nums">
            +{scope.more}
          </span>
        )}
      </Crumb>
    </>
  );
}

/** A crumb with no handler is the hidden copy that measures one. */
function Crumb({
  label,
  tooltip,
  onClick,
  className,
  children,
}: {
  label: string;
  /** What hover and focus show, where the crumb says less than its names. */
  tooltip?: string | undefined;
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
  if (!onClick) return <span className={classes}>{face}</span>;
  const button = (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(classes, "hover:bg-row-hover")}
    >
      {face}
    </button>
  );
  return tooltip === undefined ? (
    button
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent className="wrap-anywhere">{tooltip}</TooltipContent>
    </Tooltip>
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
            "bg-well outline-none hover:bg-well-hover hover:text-content focus-visible:shadow-[var(--focus-ring)]",
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
      {binding && (
        <Kbd className="rounded-[3px]">
          {keybindings.label(binding.presses)}
        </Kbd>
      )}
    </>
  );
}
