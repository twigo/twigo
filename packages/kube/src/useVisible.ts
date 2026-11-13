import { useSyncExternalStore } from "react";

function subscribe(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
  };
}

/** Whether the document is visible, as `visibilitychange` says; a hidden window reads no metrics. */
export function useVisible(): boolean {
  return useSyncExternalStore(subscribe, () => !document.hidden);
}
