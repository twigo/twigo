import { renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { LABEL_COLUMN } from "./ObjectContent";
import {
  FULL_PAGE,
  LABEL_WIDTH,
  stands,
  TWO_COLUMNS,
  useChildWidths,
  useClientWidth,
  useFits,
} from "./pageStage";

const unobserved = globalThis.ResizeObserver;
const framed = {
  request: globalThis.requestAnimationFrame,
  cancel: globalThis.cancelAnimationFrame,
};

afterEach(() => {
  globalThis.ResizeObserver = unobserved;
  globalThis.requestAnimationFrame = framed.request;
  globalThis.cancelAnimationFrame = framed.cancel;
});

function frames() {
  const pending = new Map<number, FrameRequestCallback>();
  let last = 0;
  globalThis.requestAnimationFrame = (callback) => {
    pending.set(++last, callback);
    return last;
  };
  globalThis.cancelAnimationFrame = (id) => {
    pending.delete(id);
  };
  return {
    pending: () => pending.size,
    run: () => {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback(0);
      }
    },
  };
}

function observers() {
  const callbacks: ResizeObserverCallback[] = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
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
  return () => {
    for (const callback of callbacks) callback([], {} as ResizeObserver);
  };
}

async function readAround<T>(
  result: { readonly current: T },
  deliver: () => void,
  frame: () => void,
): Promise<{ inDelivery: T; atFrame: T }> {
  const react = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  react.IS_REACT_ACT_ENVIRONMENT = false;
  deliver();
  await Promise.resolve();
  await Promise.resolve();
  const inDelivery = result.current;
  frame();
  const atFrame = result.current;
  react.IS_REACT_ACT_ENVIRONMENT = true;
  return { inDelivery, atFrame };
}

function sized(width: number) {
  const element = document.createElement("div");
  const sizes = { width };
  Object.defineProperty(element, "clientWidth", { get: () => sizes.width });
  return { element, sizes };
}

test("the full page comes at 900 px and, once drawn, stays down to 884", () => {
  expect(FULL_PAGE).toBe(900);
  expect(stands(899, false, FULL_PAGE)).toBe(false);
  expect(stands(900, false, FULL_PAGE)).toBe(true);
  expect(stands(884, true, FULL_PAGE)).toBe(true);
  expect(stands(883, true, FULL_PAGE)).toBe(false);
  expect(stands(890, false, FULL_PAGE)).toBe(false);
});

test("the page's two property columns follow the same margin", () => {
  expect(stands(TWO_COLUMNS - 1, false, TWO_COLUMNS)).toBe(false);
  expect(stands(TWO_COLUMNS, false, TWO_COLUMNS)).toBe(true);
  expect(stands(TWO_COLUMNS - 16, true, TWO_COLUMNS)).toBe(true);
  expect(stands(TWO_COLUMNS - 17, true, TWO_COLUMNS)).toBe(false);
});

test("two property columns start where each value gets 225 px: a page of 750", () => {
  expect(TWO_COLUMNS).toBe(750);
  expect(LABEL_COLUMN).toBe(`[--label-column:${String(LABEL_WIDTH)}px]`);
});

test("a form that measures 0 fits nowhere, and comes back only with the margin met", () => {
  const { result, rerender } = renderHook(
    ({ room, natural }) => useFits(room, natural),
    { initialProps: { room: 100, natural: 50 } },
  );
  expect(result.current).toBe(true);
  rerender({ room: 100, natural: 0 });
  expect(result.current).toBe(false);
  rerender({ room: 100, natural: 90 });
  expect(result.current).toBe(false);
  rerender({ room: 106, natural: 90 });
  expect(result.current).toBe(true);
  rerender({ room: 100, natural: 90 });
  expect(result.current).toBe(true);
  rerender({ room: 0, natural: 90 });
  expect(result.current).toBe(false);
  rerender({ room: 100, natural: 90 });
  expect(result.current).toBe(false);
});

test("a resize of an element is drawn at the start of the next frame, not in the observer's microtasks", async () => {
  const deliver = observers();
  const next = frames();
  const { element, sizes } = sized(100);
  const { result } = renderHook(() => useClientWidth(element));
  expect(result.current).toBe(100);
  sizes.width = 160;
  const read = await readAround(result, deliver, next.run);
  expect(read).toEqual({ inDelivery: 100, atFrame: 160 });
});

test("a resize of the children of a box is drawn at the start of the next frame, not in the observer's microtasks", async () => {
  const deliver = observers();
  const next = frames();
  const box = document.createElement("div");
  const children = [sized(100), sized(80)];
  for (const { element } of children) box.append(element);
  const { result } = renderHook(() => useChildWidths(box, "a pod"));
  expect(result.current).toEqual([100, 80]);
  const [first] = children;
  if (first) first.sizes.width = 130;
  const read = await readAround(result, deliver, next.run);
  expect(read).toEqual({ inDelivery: [100, 80], atFrame: [130, 80] });
});

test("a frame still waiting when the element of a hook goes is cancelled", () => {
  const deliver = observers();
  const next = frames();
  const { element, sizes } = sized(100);
  const box = document.createElement("div");
  const child = sized(80);
  box.append(child.element);
  const { unmount } = renderHook(() => [
    useClientWidth(element),
    useChildWidths(box, "a pod"),
  ]);
  sizes.width = 160;
  child.sizes.width = 130;
  deliver();
  expect(next.pending()).toBe(2);
  unmount();
  expect(next.pending()).toBe(0);
});
