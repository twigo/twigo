import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStoresHydrated } from "./hydration";

function fakeStore() {
  let hydrated = false;
  const cbs = new Set<() => void>();
  return {
    finish() {
      hydrated = true;
      for (const cb of cbs) cb();
    },
    finishSilently() {
      hydrated = true;
    },
    persist: {
      hasHydrated: () => hydrated,
      onFinishHydration(cb: () => void) {
        cbs.add(cb);
        return () => cbs.delete(cb);
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useStoresHydrated", () => {
  it("is true immediately when every store is already hydrated", () => {
    const a = fakeStore();
    a.finish();
    const { result } = renderHook(() => useStoresHydrated([a]));
    expect(result.current).toBe(true);
  });

  it("waits for the last store to finish", () => {
    const a = fakeStore();
    const b = fakeStore();
    const { result } = renderHook(() => useStoresHydrated([a, b]));
    expect(result.current).toBe(false);

    act(() => a.finish());
    expect(result.current).toBe(false);
    act(() => b.finish());
    expect(result.current).toBe(true);
  });

  it("closes the render→subscribe race via the microtask check", async () => {
    const a = fakeStore();
    const { result } = renderHook(() => useStoresHydrated([a]));
    a.finishSilently();
    await act(() => Promise.resolve());
    expect(result.current).toBe(true);
  });

  it("watchdog opens the gate even if a store never hydrates", () => {
    vi.useFakeTimers();
    const stuck = fakeStore();
    const { result } = renderHook(() => useStoresHydrated([stuck]));
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(true);
  });
});
