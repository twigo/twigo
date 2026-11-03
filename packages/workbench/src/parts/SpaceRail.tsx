import { Plus } from "lucide-react";
import type { ContextColor, Space } from "@twigo/protocol";
import {
  ActionContextMenu,
  cn,
  StatusDot,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@twigo/ui";
import type { SpaceConnection } from "../spaces/status";
import { useChanges, useWorkbench } from "../react";
import { initials } from "./spaceBadge";

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
 * cluster, each with its connection as a dot, ⌘1..9 by position, and a
 * button that opens any context.
 */
export function SpaceRail() {
  const workbench = useWorkbench();
  const { spaces, colors, keybindings, quickAccess, spaceStatus, keys, menus } =
    workbench;
  useChanges(spaces.changes);
  useChanges(colors.changes);
  useChanges(keybindings.changes);
  useChanges(spaceStatus.changes);
  useChanges(menus.changes);
  const active = spaces.active?.id;
  return (
    <nav
      aria-label="Spaces"
      className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-shell py-1.5"
    >
      {spaces.list.map((space, index) => {
        const binding = keybindings.primary(
          `workbench.action.selectSpace${String(index + 1)}`,
        );
        return (
          <ActionContextMenu
            key={space.id}
            actions={workbench.actions(
              "space/context",
              keys.lookup(null),
              space.id,
            )}
          >
            <div className="w-full">
              <SpaceTile
                space={space}
                color={colors.ofSpace(space)}
                state={spaceStatus.get(space.id)}
                selected={space.id === active}
                shortcut={binding && keybindings.label(binding.presses)}
                onSelect={() => {
                  spaces.select(space.id);
                }}
              />
            </div>
          </ActionContextMenu>
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
  color,
  state,
  selected,
  shortcut,
  onSelect,
}: {
  space: Space;
  color: ContextColor | undefined;
  state: SpaceConnection | undefined;
  selected: boolean;
  shortcut: string | undefined;
  onSelect: () => void;
}) {
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
              "relative flex size-8 items-center justify-center rounded-md text-[11px] font-medium",
              tint ?? "bg-card text-muted-foreground",
              selected
                ? "ring-1 ring-foreground/60"
                : "group-hover:ring-1 group-hover:ring-border",
            )}
          >
            {initials(space.name)}
            {state && (
              <StatusDot
                tone={state.tone}
                pulse={state.tone === "warn"}
                size="md"
                className="absolute -right-0.5 -bottom-0.5 ring-2 ring-shell"
              />
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        <span>{space.contexts.join(" + ")}</span>
        {shortcut && <span className="text-muted-foreground">{shortcut}</span>}
        {state && <span className="text-muted-foreground">{state.label}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
