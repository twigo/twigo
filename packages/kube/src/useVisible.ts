import { useSyncExternalStore } from "react";
import { useEditorShown } from "@twigo/workbench";

function subscribe(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
  };
}

/**
 * Whether what reads metrics is drawn: the document is visible, as
 * `visibilitychange` says, and the editor is on screen, behind no other tab
 * and under no maximized panel. A hidden window or editor reads no metrics.
 */
export function useVisible(): boolean {
  const shown = useEditorShown();
  const visible = useSyncExternalStore(subscribe, () => !document.hidden);
  return shown && visible;
}
