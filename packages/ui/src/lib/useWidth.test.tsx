import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useWidth } from "./useWidth";

const observed = globalThis.ResizeObserver;

afterEach(() => {
  globalThis.ResizeObserver = observed;
});

test("an element that stops being laid out keeps the width it had", () => {
  let report: ResizeObserverCallback = () => undefined;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      report = callback;
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
  const measure = (width: number) => {
    act(() => {
      report(
        [{ contentRect: new DOMRectReadOnly(0, 0, width, 100) }] as never,
        {} as ResizeObserver,
      );
    });
  };
  const element = document.createElement("div");
  const { result } = renderHook(() => useWidth(element));
  expect(result.current).toBe(0);
  measure(0);
  expect(result.current).toBe(0);
  measure(640.4);
  expect(result.current).toBe(640);
  measure(0);
  expect(result.current).toBe(640);
  measure(480);
  expect(result.current).toBe(480);
});
