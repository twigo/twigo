import { getCurrentWindow } from "@tauri-apps/api/window";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const BASE = "Twigo";

/** Compose the window title from an optional suffix. The shell owns the base
 *  name; domains supply the suffix (e.g. the active connection). Pure — tested. */
export function composeTitle(suffix?: string | null): string {
  const s = suffix?.trim();
  return s ? `${BASE} — ${s}` : BASE;
}

/** Set the document and (under Tauri) the native window title. */
export function setWindowTitle(suffix?: string | null): void {
  const title = composeTitle(suffix);
  if (typeof document !== "undefined") document.title = title;
  if (!isTauri) return;
  void getCurrentWindow()
    .setTitle(title)
    .catch((e: unknown) => {
      console.error("Failed to set the window title:", e);
    });
}
