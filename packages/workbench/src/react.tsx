import { createContext, useContext, useSyncExternalStore } from "react";
import type { Changes } from "./changes";
import type { Workbench } from "./services";

export const WorkbenchContext = createContext<Workbench | undefined>(undefined);

export function useWorkbench(): Workbench {
  const workbench = useContext(WorkbenchContext);
  if (!workbench) throw new Error("useWorkbench outside a WorkbenchContext");
  return workbench;
}

/**
 * Whether the editor that reads it is on screen: not behind another tab of
 * its group, and not under a maximized panel. A hidden editor keeps its
 * services and its place, but holds nothing the keyboard can reach.
 */
export const EditorShownContext = createContext(true);

export function useEditorShown(): boolean {
  return useContext(EditorShownContext);
}

/** Re-renders whenever the registry or store behind `changes` changes. */
export function useChanges(changes: Changes): void {
  useSyncExternalStore(changes.subscribe, () => changes.version);
}
