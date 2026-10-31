import "@testing-library/jest-dom/vitest";

// jsdom has no layout; Radix ScrollArea (and friends) observe element size.
globalThis.ResizeObserver = class {
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
};
