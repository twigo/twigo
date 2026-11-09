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
window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }) as unknown as MediaQueryList;
