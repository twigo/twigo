const BASE = "Twigo";

/** Compose the window title from an optional suffix. The shell owns the base
 *  name; domains supply the suffix (e.g. the active connection). Pure - tested. */
export function composeTitle(suffix?: string | null): string {
  const s = suffix?.trim();
  return s ? `${BASE} - ${s}` : BASE;
}

// Document title only. Calling the native setTitle would work, but every call
// resets the macOS traffic lights to their default position (tauri#13044): wry
// insets them from the parent view's drawRect, which stops firing once the
// webview covers it, so nothing puts them back. The native title is invisible
// anyway under `hiddenTitle`, and with single-instance there is one window to
// name in Mission Control.
export function setWindowTitle(suffix?: string | null): void {
  if (typeof document !== "undefined") document.title = composeTitle(suffix);
}
