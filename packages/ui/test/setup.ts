import "@testing-library/jest-dom/vitest";
import { ResizeObserver } from "./resize";

// jsdom has no layout; Radix ScrollArea (and friends) observe element size.
globalThis.ResizeObserver = ResizeObserver;
