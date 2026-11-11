import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChanges, useEditorShown, useWorkbench } from "@twigo/workbench";
import type { ShellTerminal } from "./terminal";

/**
 * Puts a tab's terminal into the element the returned callback ref is given
 * while it shows, fits it to the element, and gives it the focus when the
 * panel is shown again with this tab active. `space` is the tab's, whose
 * panel decides whether the tab is on screen.
 */
export function useTerminalHost(
  tab: ShellTerminal | undefined,
  uri: string,
  space: string | undefined,
): (element: HTMLDivElement | null) => void {
  const { spaces, editors, quickAccess } = useWorkbench();
  useChanges(spaces.changes);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const editorShown = useEditorShown();
  const panelVisible = space ? spaces.state(space).parts.panel.visible : false;
  const shown = editorShown && panelVisible;

  useLayoutEffect(() => {
    if (!tab || !container) return;
    tab.attach(container);
    const observer = new ResizeObserver(() => {
      tab.layout();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [tab, container]);

  useEffect(() => {
    if (!tab || !container) return;
    tab.setShown(shown);
    return () => {
      tab.setShown(false);
    };
  }, [tab, container, shown]);

  const wasVisible = useRef(panelVisible);
  useEffect(() => {
    const shownNow = panelVisible && !wasVisible.current;
    wasVisible.current = panelVisible;
    if (
      shownNow &&
      shown &&
      editors.activeIn("panel") === uri &&
      quickAccess.session === undefined
    ) {
      tab?.focus();
    }
  }, [editors, panelVisible, quickAccess, shown, tab, uri]);

  return setContainer;
}
