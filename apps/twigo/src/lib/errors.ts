import { useToasts } from "@/store/toasts";

// Async errors (store actions on timers, event-bridge callbacks) never reach a
// React error boundary - surface them as a toast instead of a silent console.
export function reportUnexpectedError(source: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${source}]`, err);
  useToasts
    .getState()
    .push("error", `Unexpected error: ${message}`, { key: `err:${message}` });
}

let installed = false;

export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("unhandledrejection", (e) => {
    reportUnexpectedError("unhandled rejection", e.reason);
  });
  window.addEventListener("error", (e) => {
    reportUnexpectedError("uncaught error", e.error ?? e.message);
  });
}
