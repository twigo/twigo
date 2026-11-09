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

HTMLElement.prototype.setPointerCapture = () => undefined;

Element.prototype.scrollIntoView = () => undefined;

// xterm asks for both, and jsdom has neither.
HTMLCanvasElement.prototype.getContext = () => null;
// xterm's DOM renderer measures glyphs on an OffscreenCanvas, which jsdom lacks: 8 is the cell's width under `withTerminalLayout`.
globalThis.OffscreenCanvas = class {
  getContext() {
    return { font: "", measureText: () => ({ width: 8 }) };
  }
} as unknown as typeof OffscreenCanvas;
window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }) as unknown as MediaQueryList;
