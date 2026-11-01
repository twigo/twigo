import { Plus } from "lucide-react";
import type { ContextColor, Space } from "@twigo/protocol";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { initials, onlyColor } from "./spaceBadge";

/** The tint of a space's tile, from its one context's colour. */
const TILE: Readonly<Record<ContextColor, string>> = {
  red: "bg-context-red/20 text-foreground",
  orange: "bg-context-orange/20 text-foreground",
  yellow: "bg-context-yellow/20 text-foreground",
  green: "bg-context-green/20 text-foreground",
  blue: "bg-context-blue/20 text-foreground",
  purple: "bg-context-purple/20 text-foreground",
};

/**
 * The open spaces as tiles, Lens's hotbar (ARCHITECTURE 4.2): one per
 * cluster, ⌘1..9 by position, and a button that opens any context.
 */
export function SpaceRail() {
  const { spaces, keybindings, quickAccess } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(keybindings.changes);
  const active = spaces.active?.id;
  return (
    <nav
      aria-label="Spaces"
      className="flex w-12 shrink-0 flex-col items-center gap-1.5 bg-shell py-1.5"
    >
      {spaces.list.map((space, index) => {
        const binding = keybindings.primary(
          `workbench.action.selectSpace${String(index + 1)}`,
        );
        return (
          <SpaceTile
            key={space.id}
            space={space}
            selected={space.id === active}
            shortcut={binding && keybindings.label(binding.presses)}
            onSelect={() => {
              spaces.select(space.id);
            }}
          />
        );
      })}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Open a space"
            onClick={() => {
              quickAccess.show("ctx ");
            }}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-row-hover hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Open a space</TooltipContent>
      </Tooltip>
    </nav>
  );
}

function SpaceTile({
  space,
  selected,
  shortcut,
  onSelect,
}: {
  space: Space;
  selected: boolean;
  shortcut: string | undefined;
  onSelect: () => void;
}) {
  const color = onlyColor(space);
  const tint = color && TILE[color];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={space.name}
          aria-current={selected}
          onClick={onSelect}
          className="group relative flex w-full justify-center"
        >
          <span
            aria-hidden
            className={cn(
              "absolute top-1/2 left-0 w-0.5 -translate-y-1/2 rounded-r-full bg-foreground",
              selected ? "h-5" : "h-0",
            )}
          />
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-md text-[11px] font-medium",
              tint ?? "bg-card text-muted-foreground",
              selected
                ? "ring-1 ring-foreground/60"
                : "group-hover:ring-1 group-hover:ring-border",
            )}
          >
            {initials(space.name)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        <span>{space.contexts.map((context) => context.name).join(" + ")}</span>
        {shortcut && <span className="text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
