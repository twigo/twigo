import "@testing-library/jest-dom/vitest";
import { ResizeObserver } from "./resize";

// jsdom has none; Radix ScrollArea and the virtualizer observe sizes, which
// a test reports with `resize()`.
globalThis.ResizeObserver = ResizeObserver;
