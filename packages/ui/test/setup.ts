import "@testing-library/jest-dom/vitest";
import { ResizeObserver } from "./resize";

// jsdom has none; Radix ScrollArea and the virtualizer observe sizes, which
// a test reports with `resize()`.
globalThis.ResizeObserver = ResizeObserver;

// jsdom has no OffscreenCanvas: a character is 8 px wide, half an em at jsdom's 16 px.
globalThis.OffscreenCanvas = class {
  getContext() {
    return {
      font: "",
      measureText: (text: string) => ({ width: 8 * text.length }),
    };
  }
} as unknown as typeof OffscreenCanvas;
