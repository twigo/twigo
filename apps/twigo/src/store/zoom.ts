import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { createPersistStorage } from "@/lib/persist-storage";

const MIN = 0.5;
const MAX = 2;
const STEP = 0.1;
export const DEFAULT_ZOOM = 1;

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Clamp to the supported range, rounded to a tenth to avoid float drift. */
export function clampZoom(factor: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(factor * 10) / 10));
}

interface ZoomState {
  factor: number;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

export const useZoom = create<ZoomState>()(
  persist(
    (set, get) => ({
      factor: DEFAULT_ZOOM,
      zoomIn: () => set({ factor: clampZoom(get().factor + STEP) }),
      zoomOut: () => set({ factor: clampZoom(get().factor - STEP) }),
      reset: () => set({ factor: DEFAULT_ZOOM }),
    }),
    {
      name: "twigo-zoom",
      storage: createPersistStorage(),
    },
  ),
);

/** Apply the zoom factor to the webview (native) or document (browser dev). */
export function applyZoom(factor: number): void {
  if (isTauri) {
    void getCurrentWebview()
      .setZoom(factor)
      .catch((e: unknown) => {
        console.error("Failed to set the webview zoom:", e);
      });
  } else if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("zoom", String(factor));
  }
}
