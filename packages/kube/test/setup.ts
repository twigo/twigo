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
// xterm's DOM renderer measures glyphs, and the terminal's theme reads its colours, on an OffscreenCanvas, which jsdom lacks: a glyph is 8 wide, the cell's width under `withTerminalLayout`, and a colour paints the codes of its first three characters.
globalThis.OffscreenCanvas = class {
  getContext() {
    return {
      font: "",
      fillStyle: "",
      measureText: () => ({ width: 8 }),
      clearRect: () => undefined,
      fillRect: () => undefined,
      getImageData(this: { fillStyle: string }) {
        const codes = [0, 1, 2].map((i) => this.fillStyle.charCodeAt(i));
        return { data: Uint8ClampedArray.from([...codes, 255]) };
      },
    };
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
