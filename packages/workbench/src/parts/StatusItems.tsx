import { useChanges, useWorkbench } from "../react";
import type { StatusEntry } from "../views/registry";
import { onlyColor } from "./spaceBadge";

/** VS Code's hint while a chord waits for its next key. */
export function useChordEntries(): readonly StatusEntry[] {
  const { keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const { pending } = keybindings;
  if (pending.length === 0) return [];
  return [
    {
      id: "chord",
      text: `(${keybindings.label(pending)}) was pressed. Waiting for the next key…`,
    },
  ];
}

/**
 * The active space at the bar's left end, in its context's colour as the
 * rail's tile has it; a click switches spaces.
 */
export function useSpaceEntries(): readonly StatusEntry[] {
  const { spaces, catalog, quickAccess } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(catalog.changes);
  const space = spaces.active;
  if (!space) return [];
  const accent = onlyColor(space, catalog);
  return [
    {
      id: "space",
      text: space.contexts.join(" + "),
      ...(accent && { accent }),
      tooltip: "Switch space",
      run: () => {
        quickAccess.show("ctx ");
      },
    },
  ];
}
