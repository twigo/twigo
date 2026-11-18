import { afterEach, beforeEach, vi } from "vitest";

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
// xterm's DOM renderer measures glyphs, and the terminal's theme reads its colours, on an OffscreenCanvas, which jsdom lacks: a character is 8 wide, the cell's width under `withTerminalLayout` and half an em at jsdom's 16 px, and a colour paints the codes of its first three characters.
globalThis.OffscreenCanvas = class {
  getContext() {
    return {
      font: "",
      fillStyle: "",
      measureText: (text: string) => ({ width: 8 * text.length }),
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

// jsdom loads no fonts: every face is in.
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: { check: () => true, load: () => Promise.resolve([]) },
});

// Vitest does not stop the body of a test that timed out: it runs on while the next tests start, and the act() it holds open overlaps theirs.
// The shared waits end at the test's signal; the hook below waits, with the clock down so that the body's next step fails, for that act to close, and ends the queue that a failed act leaves set.
let running: AbortSignal | undefined;

beforeEach(({ signal }) => {
  running = signal;
});

export function testSignal() {
  return running;
}

afterEach(async ({ signal }) => {
  if (!signal.aborted) return;
  vi.useRealTimers();
  const { act } = await import("@testing-library/react");
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const until = performance.now() + 2000;
  while (environment.IS_REACT_ACT_ENVIRONMENT === true) {
    if (performance.now() > until) {
      throw new Error("a test that timed out still holds an act scope");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await act(() => Promise.resolve());
});
