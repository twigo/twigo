import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
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

/**
 * The `onCloseAutoFocus` of a dialog that a command opens, which gives the
 * focus back to the element that held it when `open` turned true, or to the
 * active editor when that cannot take it. Radix returns it only to a trigger,
 * and such a dialog has none, so it fell to the page's body, where no key
 * does anything. A focus that went elsewhere meanwhile stays there.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  const { editors } = useWorkbench();
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement;
  }, [open]);
  return useCallback(
    (event) => {
      event.preventDefault();
      if (document.activeElement === document.body) {
        editors.returnFocus(opener.current);
      }
    },
    [editors],
  );
}
