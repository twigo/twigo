import { LoaderCircle } from "lucide-react";
import { useChanges, useWorkbench } from "../react";
import type { StatusEntry } from "../views/registry";

/** A run that waits, such as for a deleted object to go, until it ends; a click stops waiting. */
export function useOperationEntries(): readonly StatusEntry[] {
  const { operations } = useWorkbench();
  useChanges(operations.changes);
  return operations.running.map((running) => ({
    id: String(running.id),
    text: running.text,
    icon: LoaderCircle,
    spin: true,
    tooltip: `${running.context}: stop waiting`,
    run: running.stop,
  }));
}
