import type { CSSProperties } from "react";
import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusDot,
} from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { useModeCues } from "./modeCues";
import type { Alignment, StatusBarItem, StatusEntry } from "../views/registry";
import { PanelBoundary, PartCrash } from "./PanelBoundary";

/**
 * Items that features contribute, ordered by priority on each side
 * (ARCHITECTURE 4.1), in the shell's colour: colour comes only from an
 * entry's tone and the context's accent, and from the whole bar's tint in
 * a context whose mode wants to be seen (6.4).
 */
export function StatusBar() {
  const { spaces, colors } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(colors.changes);
  const { strong } = useModeCues();
  const color = spaces.active && colors.ofSpace(spaces.active);
  return (
    <footer
      data-strong={strong ? "" : undefined}
      style={
        color &&
        ({ "--twigo-context": `var(--context-${color})` } as CSSProperties)
      }
      className="twigo-statusbar flex h-6 shrink-0 items-center justify-between gap-2 bg-shell px-0.5 text-xs text-muted-foreground shadow-[inset_0_1px_0_var(--border)]"
    >
      <Side alignment="left" />
      <Side alignment="right" />
    </footer>
  );
}

function Side({ alignment }: { alignment: Alignment }) {
  const { views, keys } = useWorkbench();
  useChanges(views.changes);
  useChanges(keys.changes);
  return (
    <div className="flex h-full min-w-0 items-center">
      {views.statusBarItems(alignment, keys.lookup(null)).map((item) => (
        <PanelBoundary
          key={item.id}
          label={item.id}
          fallback={(crash) => <PartCrash crash={crash} iconOnly />}
        >
          <Entries item={item} />
        </PanelBoundary>
      ))}
    </div>
  );
}

function Entries({ item }: { item: StatusBarItem }) {
  return <StatusEntries useEntries={item.useEntries} />;
}

/** The entries of one item's hook, as the bar draws them. */
export function StatusEntries({
  useEntries,
}: {
  useEntries: () => readonly StatusEntry[];
}) {
  return useEntries().map((entry) => (
    <EntryView key={entry.id} entry={entry} />
  ));
}

function EntryView({ entry }: { entry: StatusEntry }) {
  const Icon = entry.icon;
  const body = (
    <>
      {entry.tone && <StatusDot tone={entry.tone} />}
      {Icon && (
        <Icon
          aria-hidden
          className={cn("size-3.5", entry.spin && "animate-spin")}
        />
      )}
      <span className="truncate">{entry.text}</span>
    </>
  );
  const className = cn(
    "flex h-full items-center gap-1.5 px-1.5 whitespace-nowrap tabular-nums",
    (entry.run !== undefined || entry.popover !== undefined) &&
      "outline-none hover:bg-row-hover hover:text-foreground focus-visible:shadow-[inset_var(--focus-ring)]",
    entry.accent && ["-ml-0.5 px-2.5", ACCENT[entry.accent]],
  );
  if (entry.popover) {
    const { open, onOpenChange, content } = entry.popover;
    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={entry.tooltip}
            aria-label={entry.tooltip ?? entry.text}
            className={className}
          >
            {body}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-96 p-3 text-xs">
          {content}
        </PopoverContent>
      </Popover>
    );
  }
  const control = entry.run ? (
    <button
      type="button"
      title={entry.tooltip}
      aria-expanded={entry.expanded}
      onClick={entry.run}
      className={className}
    >
      {body}
    </button>
  ) : (
    <span role="status" title={entry.tooltip} className={className}>
      {body}
    </span>
  );
  // The same element with or without its panel, so the control keeps its
  // focus as the panel opens and closes.
  return (
    <span className="relative flex h-full">
      {control}
      {entry.panel}
    </span>
  );
}

/**
 * A coloured context as a fill at the bar's start, flush with its edge, as
 * VS Code fills its remote indicator.
 */
const ACCENT = {
  red: "bg-context-red-solid text-context-solid-foreground font-medium hover:bg-context-red-solid/90",
  orange:
    "bg-context-orange-solid text-context-solid-foreground font-medium hover:bg-context-orange-solid/90",
  yellow:
    "bg-context-yellow-solid text-context-solid-foreground font-medium hover:bg-context-yellow-solid/90",
  green:
    "bg-context-green-solid text-context-solid-foreground font-medium hover:bg-context-green-solid/90",
  blue: "bg-context-blue-solid text-context-solid-foreground font-medium hover:bg-context-blue-solid/90",
  purple:
    "bg-context-purple-solid text-context-solid-foreground font-medium hover:bg-context-purple-solid/90",
} as const;
