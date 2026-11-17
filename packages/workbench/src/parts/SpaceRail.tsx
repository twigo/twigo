import { Lock, LockOpen, Plus } from "lucide-react";
import type { ContextAccess, Space } from "@twigo/protocol";
import {
  ActionContextMenu,
  cn,
  StatusDot,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@twigo/ui";
import { accessOfSpace, chipLabel, lockOf } from "../spaces/modes";
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
  const {
    spaces,
    keybindings,
    quickAccess,
    spaceStatus,
    keys,
    menus,
    catalog,
  } = workbench;
  useChanges(spaces.changes);
  useChanges(catalog.changes);
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
                access={accessOfSpace(catalog, space)}
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
            className="flex size-8 items-center justify-center rounded-md text-support hover:bg-row-hover hover:text-content"
          >
            <Plus className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Open a space</TooltipContent>
      </Tooltip>
    </nav>
  );
}

/** A lock on the tile's bottom left corner, which the connection dot at the right one leaves free. */
function LockMark({ lock }: { lock: "shut" | "open" }) {
  const Icon = lock === "open" ? LockOpen : Lock;
  return (
    <span
      aria-hidden
      data-lock={lock}
      className="absolute -bottom-[5px] -left-[5px] flex size-[13px] items-center justify-center rounded-sm bg-shell text-content"
    >
      <Icon className="size-2.5" strokeWidth={2.5} />
    </span>
  );
}

function RailTile({
  space,
  state,
  access,
  selected,
  shortcut,
  onSelect,
}: {
  space: Space;
  state: SpaceConnection | undefined;
  access: ContextAccess | undefined;
  selected: boolean;
  shortcut: string | undefined;
  onSelect: () => void;
}) {
  const lock = lockOf(access);
  const words = lock && access && chipLabel(access);
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
              "absolute top-1/2 left-0 w-0.5 -translate-y-1/2 rounded-r-full bg-content",
              selected ? "h-5" : "h-0",
            )}
          />
          <SpaceTile
            space={space}
            className={
              selected
                ? "ring-1 ring-content/60"
                : "group-hover:ring-1 group-hover:ring-border"
            }
          >
            {lock && <LockMark lock={lock} />}
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
        {words && <span className="text-support">{words}</span>}
        {shortcut && <span className="text-support">{shortcut}</span>}
        {state && <span className="text-support">{state.label}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
