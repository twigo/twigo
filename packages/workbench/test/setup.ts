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

Element.prototype.scrollIntoView = () => undefined;

// jsdom has no OffscreenCanvas: a character is 8 px wide, half an em at jsdom's 16 px.
globalThis.OffscreenCanvas = class {
  getContext() {
    return {
      font: "",
      measureText: (text: string) => ({ width: 8 * text.length }),
    };
  }
} as unknown as typeof OffscreenCanvas;
