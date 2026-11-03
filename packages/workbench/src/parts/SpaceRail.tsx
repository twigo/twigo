import { Plus } from "lucide-react";
import type { Space } from "@twigo/protocol";
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
import { SpaceTile } from "./SpaceTile";

/**
 * The open spaces as tiles, Lens's hotbar (ARCHITECTURE 4.2): one per
 * cluster, each with its connection as a dot, ⌘1..9 by position, and a
 * button that opens any context.
 */
export function SpaceRail() {
  const workbench = useWorkbench();
  const { spaces, keybindings, quickAccess, spaceStatus, keys, menus } =
    workbench;
  useChanges(spaces.changes);
  useChanges(menus.changes);
  useChanges(keybindings.changes);
  useChanges(spaceStatus.changes);
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
              <RailTile
                space={space}
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

function RailTile({
  space,
  state,
  selected,
  shortcut,
  onSelect,
}: {
  space: Space;
  state: SpaceConnection | undefined;
  selected: boolean;
  shortcut: string | undefined;
  onSelect: () => void;
}) {
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
          <SpaceTile
            space={space}
            className={
              selected
                ? "ring-1 ring-foreground/60"
                : "group-hover:ring-1 group-hover:ring-border"
            }
          >
            {state && (
              <StatusDot
                tone={state.tone}
                pulse={state.tone === "warn"}
                size="md"
                className="absolute -right-[3px] -bottom-[3px] size-[9px] ring-2 ring-shell"
              />
            )}
          </SpaceTile>
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
