import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useNow } from "./useNow";

function setHidden(hidden: boolean) {
  vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("the time refreshes while the document is visible", () => {
  const { result } = renderHook(() => useNow(1000));
  advance(1000);
  expect(result.current).toBe(1000);
  advance(1000);
  expect(result.current).toBe(2000);
});

test("a hidden document renders nothing until it is visible again, and then shows the time at once", () => {
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useNow(1000);
  });
  setHidden(true);
  const before = renders;
  advance(5000);
  expect(renders).toBe(before);
  expect(vi.getTimerCount()).toBe(0);

  setHidden(false);
  expect(result.current).toBe(5000);
  advance(1000);
  expect(result.current).toBe(6000);
});

test("a hook mounted in a hidden document starts no timer", () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  renderHook(() => useNow(1000));
  expect(vi.getTimerCount()).toBe(0);
});

test("unmounting stops the timer and the listener", () => {
  const { unmount } = renderHook(() => useNow(1000));
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  setHidden(false);
  expect(vi.getTimerCount()).toBe(0);
});
