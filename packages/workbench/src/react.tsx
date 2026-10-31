import { createContext, useContext, useSyncExternalStore } from "react";
import type { Changes } from "./changes";
import type { Workbench } from "./services";

export const WorkbenchContext = createContext<Workbench | undefined>(undefined);

export function useWorkbench(): Workbench {
  const workbench = useContext(WorkbenchContext);
  if (!workbench) throw new Error("useWorkbench outside a WorkbenchContext");
  return workbench;
}

/** Re-renders whenever the registry or store behind `changes` changes. */
export function useChanges(changes: Changes): void {
  useSyncExternalStore(changes.subscribe, () => changes.version);
}
