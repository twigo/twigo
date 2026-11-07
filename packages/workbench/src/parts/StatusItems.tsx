import { Lock, LockOpen } from "lucide-react";
import { useChanges, useWorkbench } from "../react";
import { accessOfSpace } from "../spaces/modes";
import type { StatusEntry } from "../views/registry";

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
 * rail's tile has it, with a lock while its mode holds writes back; a click
 * switches spaces.
 */
export function useSpaceEntries(): readonly StatusEntry[] {
  const { spaces, colors, quickAccess, catalog } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(colors.changes);
  const space = spaces.active;
  if (!space) return [];
  const accent = colors.ofSpace(space);
  const access = accessOfSpace(catalog, space);
  const icon = access?.unlockedUntil
    ? LockOpen
    : access?.mode === "read-only"
      ? Lock
      : undefined;
  return [
    {
      id: "space",
      text: space.contexts.join(" + "),
      ...(accent && { accent }),
      ...(icon && { icon }),
      tooltip: "Switch space",
      run: () => {
        quickAccess.show("ctx ");
      },
    },
  ];
}
