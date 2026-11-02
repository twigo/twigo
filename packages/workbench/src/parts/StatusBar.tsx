import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusDot,
} from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import type { Alignment, StatusBarItem, StatusEntry } from "../views/registry";
import { PanelBoundary, PartCrash } from "./PanelBoundary";

/**
 * Items that features contribute, ordered by priority on each side
 * (ARCHITECTURE 4.1), in the shell's colour: colour comes only from an
 * entry's tone and the context's accent.
 */
export function StatusBar() {
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border bg-shell px-1 text-xs text-muted-foreground">
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
    entry.accent && ACCENT[entry.accent],
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

/** The tint of a coloured context, as its rail tile has it. */
const ACCENT = {
  red: "bg-context-red/20 text-foreground font-medium",
  orange: "bg-context-orange/20 text-foreground font-medium",
  yellow: "bg-context-yellow/20 text-foreground font-medium",
  green: "bg-context-green/20 text-foreground font-medium",
  blue: "bg-context-blue/20 text-foreground font-medium",
  purple: "bg-context-purple/20 text-foreground font-medium",
} as const;
