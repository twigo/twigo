import { useToasts } from "@/store/toasts";

// Async errors never reach a React boundary - surface them as a toast.
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
