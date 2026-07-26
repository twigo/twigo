const BASE = "Twigo";

/** Compose the window title from an optional suffix. The shell owns the base
 *  name; domains supply the suffix (e.g. the active connection). Pure - tested. */
export function composeTitle(suffix?: string | null): string {
  const s = suffix?.trim();
  return s ? `${BASE} - ${s}` : BASE;
}

// Document title only: every native setTitle resets the macOS traffic lights to
// their default position (tauri#13044) and nothing puts them back. The native
// title is hidden under `hiddenTitle` anyway.
export function setWindowTitle(suffix?: string | null): void {
  if (typeof document !== "undefined") document.title = composeTitle(suffix);
}
